package server_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/rizkyr99/sagamart/services/inventory/internal/server"
)

type pinger struct{ err error }

func (p pinger) Ping(context.Context) error { return p.err }

func TestProbes(t *testing.T) {
	tests := []struct {
		name   string
		path   string
		dbErr  error
		status int
	}{
		{"healthz ignores the database", "/healthz", errors.New("down"), http.StatusOK},
		{"readyz ok when database answers", "/readyz", nil, http.StatusOK},
		{"readyz fails when database is down", "/readyz", errors.New("down"), http.StatusServiceUnavailable},
		{"metrics exposed", "/metrics", nil, http.StatusOK},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			server.NewHTTPHandler(pinger{tt.dbErr}).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tt.path, nil))
			if rec.Code != tt.status {
				t.Errorf("GET %s = %d, want %d", tt.path, rec.Code, tt.status)
			}
		})
	}
}
