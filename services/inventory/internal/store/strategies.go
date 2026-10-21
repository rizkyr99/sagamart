package store

// BENCHMARK BRANCH ONLY (issue #11): alternative reservation strategies for ADR-0008. Not merged to main.

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"

	"github.com/rizkyr99/sagamart/services/inventory/internal/domain"
)

// Strategy selects how Reserve takes stock (RFC-0001 §5).
type Strategy string

const (
	StrategyConditionalUpdate Strategy = "a" // single atomic UPDATE ... WHERE on_hand - reserved >= qty
	StrategyRowLock           Strategy = "b" // SELECT ... FOR UPDATE, check in Go, then UPDATE
	StrategyRedisLua          Strategy = "c" // Lua check-and-decrement in Redis first, then Postgres
)

// WithStrategy selects the reservation strategy.
func WithStrategy(st Strategy, rdb *redis.Client) Option {
	return func(o *options) { o.strategy, o.redis = st, rdb }
}

func availKey(sku string) string { return "inv:avail:" + sku }

// reserveScript checks every line, then decrements them all, atomically. Returns {0, 0} on success or
// {index, available} for the first line (1-based) that doesn't fit.
var reserveScript = redis.NewScript(`
for i, k in ipairs(KEYS) do
  local v = tonumber(redis.call('GET', k) or '0')
  if v < tonumber(ARGV[i]) then return {i, v} end
end
for i, k in ipairs(KEYS) do redis.call('DECRBY', k, ARGV[i]) end
return {0, 0}
`)

// redisReserve runs the Lua fast path. A shortfall is answered from Redis without touching Postgres.
func (s *Store) redisReserve(ctx context.Context, lines []domain.Line) error {
	keys := make([]string, len(lines))
	args := make([]any, len(lines))
	for i, l := range lines {
		keys[i], args[i] = availKey(l.SKU), l.Quantity
	}
	res, err := reserveScript.Run(ctx, s.redis, keys, args...).Int64Slice()
	if err != nil {
		return fmt.Errorf("redis reserve: %w", err)
	}
	if res[0] != 0 {
		failed := lines[res[0]-1]
		return &domain.InsufficientStockError{Shortfalls: []domain.Shortfall{{SKU: failed.SKU, Requested: failed.Quantity, Available: res[1]}}}
	}
	return nil
}

// redisRestore gives units back after the Postgres part didn't keep them (failure or idempotent retry).
func (s *Store) redisRestore(ctx context.Context, lines []domain.Line) {
	pipe := s.redis.Pipeline()
	for _, l := range lines {
		pipe.IncrBy(context.WithoutCancel(ctx), availKey(l.SKU), l.Quantity)
	}
	_, _ = pipe.Exec(context.WithoutCancel(ctx))
}
