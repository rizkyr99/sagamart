package store_test

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	"github.com/rizkyr99/sagamart/services/inventory/internal/store"
)

// One Postgres container serves the whole package (testing strategy §3: a real database, never mocks).
// Each test owns its data through unique SKUs and order IDs, so tests can run in parallel.
var (
	dbURL string
	pool  *pgxpool.Pool
)

func TestMain(m *testing.M) {
	flag.Parse()
	if testing.Short() {
		os.Exit(m.Run()) // integration tests skip themselves through needDB
	}

	ctx := context.Background()
	ctr, err := postgres.Run(ctx, "postgres:17.2-alpine",
		postgres.WithDatabase("inventory"),
		postgres.BasicWaitStrategies(),
	)
	if err != nil {
		log.Fatalf("start postgres: %v", err)
	}
	code := func() int {
		defer func() { _ = ctr.Terminate(ctx) }()
		if dbURL, err = ctr.ConnectionString(ctx, "sslmode=disable"); err != nil {
			log.Printf("connection string: %v", err)
			return 1
		}
		if err := store.Migrate(dbURL); err != nil {
			log.Printf("migrate: %v", err)
			return 1
		}
		cfg, err := pgxpool.ParseConfig(dbURL)
		if err != nil {
			log.Printf("parse config: %v", err)
			return 1
		}
		cfg.MaxConns = 20
		if pool, err = pgxpool.NewWithConfig(ctx, cfg); err != nil {
			log.Printf("pool: %v", err)
			return 1
		}
		defer pool.Close()
		return m.Run()
	}()
	os.Exit(code)
}

// needDB skips integration tests in -short mode.
func needDB(t *testing.T) {
	t.Helper()
	if testing.Short() {
		t.Skip("integration test: needs Docker")
	}
}

func newOrderID(t testing.TB) string {
	t.Helper()
	id, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}
	return id.String()
}

// newSKU returns a SKU no other test uses.
func newSKU(t testing.TB, prefix string) string {
	t.Helper()
	return fmt.Sprintf("%s-%s", prefix, uuid.NewString()[:8])
}

func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func TestMigrateIsIdempotent(t *testing.T) {
	needDB(t)
	if err := store.Migrate(dbURL); err != nil {
		t.Fatalf("Migrate on an up-to-date database: %v", err)
	}
}

func TestSchemaRejectsOversell(t *testing.T) {
	needDB(t)
	t.Parallel()
	ctx := testContext(t)
	sku := newSKU(t, "OVERSELL")

	if _, err := pool.Exec(ctx, `INSERT INTO stock_levels (sku, on_hand) VALUES ($1, 5)`, sku); err != nil {
		t.Fatalf("insert stock: %v", err)
	}

	tests := []struct {
		name string
		sql  string
	}{
		{"reserved above on hand", `UPDATE stock_levels SET reserved = 6 WHERE sku = $1`},
		{"negative reserved", `UPDATE stock_levels SET reserved = -1 WHERE sku = $1`},
		{"on hand below reserved", `UPDATE stock_levels SET reserved = 3, on_hand = 2 WHERE sku = $1`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := pool.Exec(ctx, tt.sql, sku)
			var pgErr *pgconn.PgError
			if !errors.As(err, &pgErr) || pgErr.ConstraintName != "stock_never_oversold" {
				t.Fatalf("want stock_never_oversold violation, got %v", err)
			}
		})
	}
}
