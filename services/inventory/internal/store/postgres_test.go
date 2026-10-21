package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	"github.com/rizkyr99/sagamart/services/inventory/internal/store"
)

// startPostgres runs a throwaway Postgres for one test (testing strategy §3: real database, never mocks).
func startPostgres(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("integration test: needs Docker")
	}
	ctx := context.Background()
	ctr, err := postgres.Run(ctx, "postgres:17.2-alpine",
		postgres.WithDatabase("inventory"),
		postgres.BasicWaitStrategies(),
	)
	if err != nil {
		t.Fatalf("start postgres: %v", err)
	}
	t.Cleanup(func() { _ = ctr.Terminate(context.Background()) })

	url, err := ctr.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("connection string: %v", err)
	}
	return url
}

func TestMigrateIsIdempotent(t *testing.T) {
	url := startPostgres(t)

	for i := range 2 {
		if err := store.Migrate(url); err != nil {
			t.Fatalf("Migrate run %d: %v", i+1, err)
		}
	}
}

func TestSchemaRejectsOversell(t *testing.T) {
	url := startPostgres(t)
	if err := store.Migrate(url); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := store.Connect(ctx, url)
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer pool.Close()

	if _, err := pool.Exec(ctx, `INSERT INTO stock_levels (sku, on_hand) VALUES ('KAOS-001', 5)`); err != nil {
		t.Fatalf("insert stock: %v", err)
	}

	tests := []struct {
		name string
		sql  string
	}{
		{"reserved above on hand", `UPDATE stock_levels SET reserved = 6 WHERE sku = 'KAOS-001'`},
		{"negative reserved", `UPDATE stock_levels SET reserved = -1 WHERE sku = 'KAOS-001'`},
		{"on hand below reserved", `UPDATE stock_levels SET reserved = 3, on_hand = 2 WHERE sku = 'KAOS-001'`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := pool.Exec(ctx, tt.sql)
			var pgErr *pgconn.PgError
			if !errors.As(err, &pgErr) || pgErr.ConstraintName != "stock_never_oversold" {
				t.Fatalf("want stock_never_oversold violation, got %v", err)
			}
		})
	}
}
