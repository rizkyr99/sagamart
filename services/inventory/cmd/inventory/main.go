// Command inventory runs the Inventory service (RFC-0001): stock levels and reservations over gRPC,
// probes and metrics over HTTP. "inventory healthcheck" probes a running instance, for container health checks.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"golang.org/x/sync/errgroup"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"

	inventoryv1 "github.com/rizkyr99/sagamart/contracts/gen/go/sagamart/inventory/v1"

	"github.com/rizkyr99/sagamart/services/inventory/internal/config"
	"github.com/rizkyr99/sagamart/services/inventory/internal/domain"
	"github.com/rizkyr99/sagamart/services/inventory/internal/expiry"
	"github.com/rizkyr99/sagamart/services/inventory/internal/grpcapi"
	"github.com/rizkyr99/sagamart/services/inventory/internal/identity"
	"github.com/rizkyr99/sagamart/services/inventory/internal/outbox"
	"github.com/rizkyr99/sagamart/services/inventory/internal/server"
	"github.com/rizkyr99/sagamart/services/inventory/internal/store"
	"github.com/rizkyr99/sagamart/services/inventory/internal/telemetry"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

const serviceName = "inventory"

// expiryBatch is how many due reservations the worker expires before checking for more (RFC-0001 §4.4).
const expiryBatch = 100

// outboxBatch is how many events the relay publishes per transaction (ADR-0006).
const outboxBatch = 100

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		if err := healthcheck(os.Getenv("INVENTORY_HTTP_ADDR")); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}

	// Until the config is loaded, log as JSON with what is known so startup errors stay machine-readable.
	slog.SetDefault(telemetry.NewLogger(os.Stdout, slog.LevelInfo, serviceName, os.Getenv("INVENTORY_ENV"), version))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := run(ctx); err != nil {
		slog.Error("inventory stopped", "error", err)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	cfg, err := config.Load(os.Getenv, version)
	if err != nil {
		return err
	}

	log := telemetry.NewLogger(os.Stdout, cfg.LogLevel, serviceName, cfg.Env, cfg.Version)
	slog.SetDefault(log)

	shutdownTelemetry, err := telemetry.Setup(ctx, telemetry.Options{
		Service: serviceName, Env: cfg.Env, Version: cfg.Version, OTLPEndpoint: cfg.OTLPEndpoint,
	})
	if err != nil {
		return err
	}
	defer func() {
		// The parent context is already cancelled at shutdown; keep its values but not its cancellation.
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), cfg.ShutdownTimeout)
		defer cancel()
		if err := shutdownTelemetry(ctx); err != nil {
			log.Warn("telemetry shutdown", "error", err)
		}
	}()

	if cfg.MigrateOnStart {
		if err := store.Migrate(cfg.DatabaseURL); err != nil {
			return err
		}
		log.Info("migrations applied")
	}

	connectCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	pool, err := store.Connect(connectCtx, cfg.DatabaseURL)
	cancel()
	if err != nil {
		return err
	}
	defer pool.Close()

	reservations := store.New(pool)
	verifier, err := identity.NewVerifier(cfg.IdentityPublicKeys, "inventory")
	if err != nil {
		return fmt.Errorf("INVENTORY_IDENTITY_PUBLIC_KEYS: %w", err)
	}
	grpcSrv, health := server.NewGRPCServer(cfg.Env, grpcapi.IdentityInterceptor(verifier, log))
	inventoryv1.RegisterInventoryServiceServer(grpcSrv,
		grpcapi.New(reservations, domain.NewLimits(cfg.MaxLineQuantity), log))
	httpSrv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           server.NewHTTPHandler(pool),
		ReadHeaderTimeout: 5 * time.Second,
	}

	grpcLis, err := (&net.ListenConfig{}).Listen(ctx, "tcp", cfg.GRPCAddr)
	if err != nil {
		return fmt.Errorf("listen gRPC: %w", err)
	}

	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		log.Info("gRPC server listening", "addr", cfg.GRPCAddr)
		return grpcSrv.Serve(grpcLis)
	})
	g.Go(func() error {
		log.Info("HTTP server listening", "addr", cfg.HTTPAddr)
		if err := httpSrv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	})
	g.Go(func() error {
		log.Info("expiry worker started", "interval", cfg.ExpiryInterval.String())
		expiry.New(reservations, cfg.ExpiryInterval, expiryBatch, log).Run(gctx)
		return nil
	})
	// The relay connects lazily: commands keep working while the broker is down, and events wait in the outbox.
	publisher, err := outbox.NewKafkaPublisher(cfg.KafkaBrokers, 10*time.Second)
	if err != nil {
		return err
	}
	defer publisher.Close()
	g.Go(func() error {
		log.Info("outbox relay started", "topic", cfg.EventsTopic, "interval", cfg.OutboxInterval.String())
		outbox.New(reservations, publisher, cfg.EventsTopic, cfg.OutboxInterval, outboxBatch, log).Run(gctx)
		return nil
	})
	health.SetServingStatus("", healthpb.HealthCheckResponse_SERVING)

	// Graceful shutdown: stop advertising readiness, drain in-flight calls, then close.
	g.Go(func() error {
		<-gctx.Done()
		log.Info("shutting down")
		health.Shutdown()

		ctx, cancel := context.WithTimeout(context.WithoutCancel(gctx), cfg.ShutdownTimeout)
		defer cancel()
		stopped := make(chan struct{})
		go func() { grpcSrv.GracefulStop(); close(stopped) }()
		select {
		case <-stopped:
		case <-ctx.Done():
			grpcSrv.Stop()
		}
		return httpSrv.Shutdown(ctx)
	})

	return g.Wait()
}

// healthcheck exits non-zero unless the local instance reports ready. The distroless image has no curl.
func healthcheck(addr string) error {
	if addr == "" {
		addr = ":8110"
	}
	_, portText, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("parse INVENTORY_HTTP_ADDR: %w", err)
	}
	port, err := strconv.ParseUint(portText, 10, 16)
	if err != nil {
		return fmt.Errorf("parse INVENTORY_HTTP_ADDR port: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	url := fmt.Sprintf("http://127.0.0.1:%d/readyz", port)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil) //nolint:gosec // G704: fixed loopback host, numeric port from our own config
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req) //nolint:gosec // G704: see above
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("readyz returned %d", resp.StatusCode)
	}
	return nil
}
