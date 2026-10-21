#!/usr/bin/env python3
"""Summarise a reservation-strategy benchmark run into Markdown tables.

Reads the files written by run-strategy-matrix.sh (on the bench/reservation-strategies branch): <strategy>-<scenario>[-r<rep>].json (k6 --summary-export),
.cpu (docker stats samples) and .check (check-inventory.sql output).

    python3 deploy/k6/summarize-reservations.py bench-results/2026-10-21
"""
import json
import pathlib
import re
import statistics
import sys

STRATEGIES = {"a": "A. Conditional UPDATE", "b": "B. Row lock", "c": "C. Redis Lua"}


def metric(summary, name, stat):
    m = summary["metrics"].get(name)
    return None if m is None else m.get(stat)


def cpu(path):
    """Mean CPU % per container over the samples taken while k6 ran."""
    per = {}
    if path.exists():
        for line in path.read_text().splitlines():
            name, pct, _ = line.split("|")
            per.setdefault(name, []).append(float(pct.rstrip("%")))
    return {n.replace("sagamart-", "").removesuffix("-1"): statistics.mean(v) for n, v in per.items() if v}


def invariants_ok(path):
    rows = [r.split("|") for r in path.read_text().splitlines() if r.count("|") == 2]
    return all(ok == "t" for _, ok, _ in rows) and len(rows) == 3


def hot_row(out, st, shape):
    runs = []
    for rep in (1, 2, 3):
        base = out / f"{st}-hot{shape}-r{rep}"
        if not (base.with_suffix(".json")).exists():
            continue
        s = json.loads(base.with_suffix(".json").read_text())
        runs.append({
            "reserved": metric(s, "reservations_reserved", "count") or 0,
            "sold_out": metric(s, "reservations_sold_out", "count") or 0,
            "failed": metric(s, "reservations_failed", "count") or 0,
            "rate": metric(s, "iterations", "rate"),
            "med": metric(s, "grpc_req_duration", "med"),
            "p99": metric(s, "grpc_req_duration", "p(99)"),
            "ok_p99": metric(s, "grpc_req_duration{status:0}", "p(99)"),
            "rej_med": metric(s, "grpc_req_duration{status:9}", "med"),
            "rej_p99": metric(s, "grpc_req_duration{status:9}", "p(99)"),
            "invariants": invariants_ok(base.with_suffix(".check")),
            "cpu": cpu(base.with_suffix(".cpu")),
        })
    if not runs:
        return None
    pick = sorted(runs, key=lambda r: r["p99"])[len(runs) // 2]  # median run by p99
    exact = all(r["reserved"] == 100 and r["failed"] == 0 for r in runs)
    return runs, pick, exact


def fmt_ms(v):
    return "–" if v is None else f"{v:.1f}"


def main(out):
    out = pathlib.Path(out)
    for shape, title in (("5000", "Hot SKU: 5,000 VUs × 1 attempt for 100 units"),
                         ("500", "Hot SKU: 500 VUs × 10 attempts for 100 units")):
        print(f"\n### {title}\n")
        print("Median of 3 runs by p99. Latency in ms.\n")
        print("| Strategy | Sold (all runs) | Attempts/s | p50 | p99 | p99 sold | p50 / p99 sold out | Invariants | CPU inventory / db / redis |")
        print("|---|---|---|---|---|---|---|---|---|")
        for st, label in STRATEGIES.items():
            row = hot_row(out, st, shape)
            if row is None:
                continue
            runs, r, exact = row
            sold = "/".join(str(int(x["reserved"])) for x in runs) + (" ✅" if exact else " ❌")
            inv = "✅" if all(x["invariants"] for x in runs) else "❌"
            c = r["cpu"]
            cpus = " / ".join(f"{c.get(k, 0):.0f}%" for k in ("inventory", "inventory-db", "redis"))
            print(f"| {label} | {sold} | {r['rate']:.0f} | {fmt_ms(r['med'])} | {fmt_ms(r['p99'])} | {fmt_ms(r['ok_p99'])} | "
                  f"{fmt_ms(r['rej_med'])} / {fmt_ms(r['rej_p99'])} | {inv} | {cpus} |")

    print("\n### Spread: 2,000 reservations/s for 60 s, 2–3 lines across 1,000 SKUs\n")
    print("| Strategy | Reserved | Failed | Dropped iterations | Achieved/s | p50 ms | p90 ms | p99 ms | Invariants | CPU inventory / db / redis |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    for st, label in STRATEGIES.items():
        base = out / f"{st}-spread"
        if not base.with_suffix(".json").exists():
            continue
        s = json.loads(base.with_suffix(".json").read_text())
        c = cpu(base.with_suffix(".cpu"))
        cpus = " / ".join(f"{c.get(k, 0):.0f}%" for k in ("inventory", "inventory-db", "redis"))
        print(f"| {label} | {int(metric(s, 'reservations_reserved', 'count') or 0)} | {int(metric(s, 'reservations_failed', 'count') or 0)} | "
              f"{int(metric(s, 'dropped_iterations', 'count') or 0)} | {metric(s, 'iterations', 'rate'):.0f} | "
              f"{fmt_ms(metric(s, 'grpc_req_duration', 'med'))} | {fmt_ms(metric(s, 'grpc_req_duration', 'p(90)'))} | "
              f"{fmt_ms(metric(s, 'grpc_req_duration', 'p(99)'))} | {'✅' if invariants_ok(base.with_suffix('.check')) else '❌'} | {cpus} |")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "bench-results/latest")
