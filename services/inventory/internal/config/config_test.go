package config_test

import (
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/rizkyr99/sagamart/services/inventory/internal/config"
)

func env(kv map[string]string) func(string) string {
	return func(k string) string { return kv[k] }
}

func TestLoadDefaults(t *testing.T) {
	cfg, err := config.Load(env(map[string]string{
		"INVENTORY_DB_URL": "postgres://u:p@localhost:5436/inventory",
	}), "1.2.3")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	want := config.Config{
		Env:             "local",
		Version:         "1.2.3",
		LogLevel:        slog.LevelInfo,
		DatabaseURL:     "postgres://u:p@localhost:5436/inventory",
		HTTPAddr:        ":8110",
		GRPCAddr:        ":9110",
		MigrateOnStart:  true,
		MaxLineQuantity: 100,
		ShutdownTimeout: 15 * time.Second,
		ExpiryInterval:  5 * time.Second,
	}
	if cfg != want {
		t.Errorf("Load defaults:\n got %+v\nwant %+v", cfg, want)
	}
}

func TestLoadOverrides(t *testing.T) {
	cfg, err := config.Load(env(map[string]string{
		"INVENTORY_ENV":               "prod",
		"INVENTORY_VERSION":           "abc123",
		"INVENTORY_LOG_LEVEL":         "debug",
		"INVENTORY_DB_URL":            "postgres://db/inventory",
		"INVENTORY_HTTP_ADDR":         ":18110",
		"INVENTORY_GRPC_ADDR":         ":19110",
		"INVENTORY_MAX_LINE_QUANTITY": "10",
		"INVENTORY_SHUTDOWN_TIMEOUT":  "5s",
		"OTEL_EXPORTER_OTLP_ENDPOINT": "http://otel-collector:4317",
	}), "dev")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.Env != "prod" || cfg.Version != "abc123" || cfg.LogLevel != slog.LevelDebug ||
		cfg.HTTPAddr != ":18110" || cfg.GRPCAddr != ":19110" || cfg.MaxLineQuantity != 10 ||
		cfg.ShutdownTimeout != 5*time.Second || cfg.OTLPEndpoint != "http://otel-collector:4317" {
		t.Errorf("overrides not applied: %+v", cfg)
	}
	if cfg.MigrateOnStart {
		t.Error("MigrateOnStart defaults to false outside local and test")
	}
}

func TestLoadMigrateOnStartExplicit(t *testing.T) {
	cfg, err := config.Load(env(map[string]string{
		"INVENTORY_ENV":              "prod",
		"INVENTORY_DB_URL":           "postgres://db/inventory",
		"INVENTORY_MIGRATE_ON_START": "true",
	}), "dev")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.MigrateOnStart {
		t.Error("explicit INVENTORY_MIGRATE_ON_START=true ignored")
	}
}

func TestLoadRejectsInvalidValues(t *testing.T) {
	tests := []struct {
		name    string
		env     map[string]string
		wantErr string
	}{
		{"missing db url", map[string]string{}, "INVENTORY_DB_URL is required"},
		{"unknown env", map[string]string{"INVENTORY_ENV": "staging"}, "INVENTORY_ENV"},
		{"bad log level", map[string]string{"INVENTORY_LOG_LEVEL": "loud"}, "INVENTORY_LOG_LEVEL"},
		{"non-numeric max quantity", map[string]string{"INVENTORY_MAX_LINE_QUANTITY": "lots"}, "INVENTORY_MAX_LINE_QUANTITY"},
		{"max quantity too small", map[string]string{"INVENTORY_MAX_LINE_QUANTITY": "0"}, "INVENTORY_MAX_LINE_QUANTITY"},
		{"bad duration", map[string]string{"INVENTORY_SHUTDOWN_TIMEOUT": "soon"}, "INVENTORY_SHUTDOWN_TIMEOUT"},
		{"bad bool", map[string]string{"INVENTORY_MIGRATE_ON_START": "maybe"}, "INVENTORY_MIGRATE_ON_START"},
		{"bad expiry interval", map[string]string{"INVENTORY_EXPIRY_INTERVAL": "often"}, "INVENTORY_EXPIRY_INTERVAL"},
		{"expiry interval too long for FR-06", map[string]string{"INVENTORY_EXPIRY_INTERVAL": "30s"}, "INVENTORY_EXPIRY_INTERVAL"},
		{"zero expiry interval", map[string]string{"INVENTORY_EXPIRY_INTERVAL": "0s"}, "INVENTORY_EXPIRY_INTERVAL"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := config.Load(env(tt.env), "dev")
			if err == nil {
				t.Fatal("expected an error")
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("error %q does not mention %q", err, tt.wantErr)
			}
		})
	}
}

func TestLoadReportsEveryProblemAtOnce(t *testing.T) {
	_, err := config.Load(env(map[string]string{
		"INVENTORY_ENV":       "staging",
		"INVENTORY_LOG_LEVEL": "loud",
	}), "dev")
	if err == nil {
		t.Fatal("expected an error")
	}
	for _, want := range []string{"INVENTORY_ENV", "INVENTORY_LOG_LEVEL", "INVENTORY_DB_URL"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %s", err, want)
		}
	}
}
