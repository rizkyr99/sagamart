# @sagamart/node-common

Shared building blocks for Sagamart's Node services (Catalog + Cart, gateway), so they follow the [conventions](../../docs/engineering/conventions.md) in exactly the same way.

| Export | What it does |
|---|---|
| `createLogger(opts)` | pino logger with the conventions §7 fields (`ts`, `level`, `service`, `env`, `version`, `msg`, plus `trace_id` and `span_id` inside a span); redacts `authorization`, `cookie`, `x-sagamart-identity` and `x-cart-token` request headers |
| `loadConfig(schema, env)` | Validates environment variables with a zod schema and throws a `ConfigError` listing **every** problem; empty values count as unset |
| `uuidv7(now?)` | A UUIDv7 (RFC 9562) for new entity IDs (conventions: UUIDv7 everywhere): 48 bits of Unix milliseconds, then random bits, so IDs from different milliseconds sort by time (not within one millisecond) |
| `problem(init)`, `ProblemError` | RFC 9457 Problem Details: `type` derived from the `code`, default titles, extensions that can't replace standard members |
| `signIdentity(opts)`, `verifyIdentity(token, opts)`, `hasRole` | The `x-sagamart-identity` token from [`contracts/identity.md`](../../contracts/identity.md): EdDSA (Ed25519) on `node:crypto`. Verification fixes the algorithm, checks `typ`, `kid`, signature, `iss`, `aud`, expiry and issue time (5 s skew) and claim types, and throws `IdentityError` with the reason. |
| `@sagamart/node-common/telemetry`: `startTelemetry(opts)` | OpenTelemetry SDK with auto-instrumentation, OTLP trace export when an endpoint is set (spans are real either way), and a Prometheus `metricsHandler` to mount on `GET /metrics`. Start it before anything else loads. |

## Tests

```bash
pnpm --filter @sagamart/node-common test
```

The identity tests check every rejection reason in the contract, the 5 s clock skew in both directions, and interoperability with [jose](https://github.com/panva/jose): jose verifies our tokens, and we verify tokens jose signs. A mutation check (removing each verification step in turn) fails the suite every time.
