#!/usr/bin/env python3
"""Summarises run-browse.sh output: latency per endpoint, request rate and failures (k6 --summary-export), and mean
CPU per container while the run was at full load (docker stats samples).
Usage: summarize-browse.py <dir>"""
import csv
import json
import sys
from pathlib import Path

out = Path(sys.argv[1])


def trend(metrics, key):
    m = metrics.get(key, {})
    return m.get("values", m)  # k6 1.x summary-export puts values at the top level


for summary in sorted(out.glob("*-summary.json")):
    name = summary.name.removesuffix("-summary.json")
    metrics = json.loads(summary.read_text())["metrics"]
    reqs = trend(metrics, "http_reqs")
    failed = trend(metrics, "http_req_failed")
    print(f"## {name}: {reqs.get('rate', 0):.0f} req/s, {reqs.get('count', 0):.0f} requests, "
          f"failed {100 * failed.get('value', failed.get('rate', 0)):.3f}%")
    print("| Endpoint | p50 | p95 | p99 | max |")
    print("|---|---|---|---|---|")
    for label in ("list", "detail", "cart"):
        t = trend(metrics, f"http_req_duration{{name:{label}}}")
        if not t:
            # Untagged-threshold trends are only exported for names with a threshold; fall back to the overall one.
            continue
        print(f"| {label} | {t.get('med', 0):.1f} ms | {t.get('p(95)', 0):.1f} ms | {t.get('p(99)', 0):.1f} ms | "
              f"{t.get('max', 0):.1f} ms |")
    t = trend(metrics, "http_req_duration")
    print(f"| all | {t.get('med', 0):.1f} ms | {t.get('p(95)', 0):.1f} ms | {t.get('p(99)', 0):.1f} ms | {t.get('max', 0):.1f} ms |")

    stats = out / f"{name}-stats.csv"
    if stats.exists():
        rows = [r for r in csv.reader(stats.open()) if len(r) >= 3]
        if rows:
            # Full load: skip the first 40 s (setup and ramp-up) and the last 15 s (ramp-down).
            start, end = int(rows[0][0]) + 40, int(rows[-1][0]) - 15
            cpu = {}
            for ts, container, pct, *_ in rows:
                if start <= int(ts) <= end:
                    cpu.setdefault(container.removeprefix("sagamart-").removesuffix("-1"), []).append(float(pct.rstrip("%")))
            print("CPU at full load (mean, 100% = one thread): " +
                  ", ".join(f"{c} {sum(v) / len(v):.0f}%" for c, v in sorted(cpu.items(), key=lambda kv: -sum(kv[1]) / len(kv[1]))))
    print()
