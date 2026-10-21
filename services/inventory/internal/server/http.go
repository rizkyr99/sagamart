// Package server wires Inventory's network endpoints: an HTTP server for probes and metrics, and the gRPC server.
package server

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Pinger reports whether a dependency is reachable. *pgxpool.Pool satisfies it.
type Pinger interface {
	Ping(ctx context.Context) error
}

// NewHTTPHandler serves /healthz (process alive), /readyz (dependencies reachable) and /metrics (conventions §8).
func NewHTTPHandler(db Pinger) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeStatus(w, http.StatusOK, "ok")
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		if err := db.Ping(ctx); err != nil {
			writeStatus(w, http.StatusServiceUnavailable, "database unreachable")
			return
		}
		writeStatus(w, http.StatusOK, "ok")
	})
	mux.Handle("GET /metrics", promhttp.Handler())
	return mux
}

func writeStatus(w http.ResponseWriter, code int, status string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": status})
}
