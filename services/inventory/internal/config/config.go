// Package config loads the Inventory service configuration from environment variables.
// Every problem is reported at once so a misconfigured deployment fails fast with one clear error.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"time"
)

// Config is the validated service configuration.
type Config struct {
	Env             string // local, test or prod
	Version         string
	LogLevel        slog.Level
	DatabaseURL     string
	HTTPAddr        string // /healthz, /readyz, /metrics
	GRPCAddr        string
	OTLPEndpoint    string // empty disables trace export; trace IDs are still generated for logs
	MigrateOnStart  bool
	MaxLineQuantity int // RFC-0001 §4.2: a sanity limit, not a purchase policy
	ShutdownTimeout time.Duration
}

// Load reads the configuration through getenv. version is the build version, used unless INVENTORY_VERSION is set.
func Load(getenv func(string) string, version string) (Config, error) {
	var errs []error
	get := func(key, def string) string {
		if v := getenv(key); v != "" {
			return v
		}
		return def
	}

	cfg := Config{
		Env:          get("INVENTORY_ENV", "local"),
		Version:      get("INVENTORY_VERSION", version),
		DatabaseURL:  getenv("INVENTORY_DB_URL"),
		HTTPAddr:     get("INVENTORY_HTTP_ADDR", ":8110"),
		GRPCAddr:     get("INVENTORY_GRPC_ADDR", ":9110"),
		OTLPEndpoint: getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
	}

	switch cfg.Env {
	case "local", "test", "prod":
	default:
		errs = append(errs, fmt.Errorf("INVENTORY_ENV must be local, test or prod, got %q", cfg.Env))
	}

	if err := cfg.LogLevel.UnmarshalText([]byte(get("INVENTORY_LOG_LEVEL", "info"))); err != nil {
		errs = append(errs, fmt.Errorf("INVENTORY_LOG_LEVEL: %w", err))
	}

	if cfg.DatabaseURL == "" {
		errs = append(errs, errors.New("INVENTORY_DB_URL is required"))
	}

	// Migrations run on start in local and test; deployments run them as a separate step (conventions §9).
	migrateDefault := strconv.FormatBool(cfg.Env == "local" || cfg.Env == "test")
	migrate, err := strconv.ParseBool(get("INVENTORY_MIGRATE_ON_START", migrateDefault))
	if err != nil {
		errs = append(errs, fmt.Errorf("INVENTORY_MIGRATE_ON_START must be true or false: %w", err))
	}
	cfg.MigrateOnStart = migrate

	maxQty, err := strconv.Atoi(get("INVENTORY_MAX_LINE_QUANTITY", "100"))
	switch {
	case err != nil:
		errs = append(errs, fmt.Errorf("INVENTORY_MAX_LINE_QUANTITY must be an integer: %w", err))
	case maxQty < 1:
		errs = append(errs, fmt.Errorf("INVENTORY_MAX_LINE_QUANTITY must be at least 1, got %d", maxQty))
	}
	cfg.MaxLineQuantity = maxQty

	timeout, err := time.ParseDuration(get("INVENTORY_SHUTDOWN_TIMEOUT", "15s"))
	if err != nil {
		errs = append(errs, fmt.Errorf("INVENTORY_SHUTDOWN_TIMEOUT must be a duration such as 15s: %w", err))
	}
	cfg.ShutdownTimeout = timeout

	if len(errs) > 0 {
		return Config{}, fmt.Errorf("invalid configuration: %w", errors.Join(errs...))
	}
	return cfg, nil
}
