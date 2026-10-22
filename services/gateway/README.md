# API gateway (BFF)

NestJS 12 service: the only public entry point. It authenticates callers, rate-limits them, and calls internal services with a signed identity. From #31 it also composes responses (Catalog data plus Inventory stock), so the browser makes one call per screen. It owns no business data. Design: [RFC-0005](../../docs/rfc/0005-catalog-cart-gateway.md). Contract: [`public-v1.yaml`](../../contracts/openapi/public-v1.yaml).

> **Status:** skeleton: auth, internal identity, rate limiting, deadlines and probes. Browse, product and cart routes come in #31; admin routes in #32.

## Run it

```bash
make up && make identity-keys   # repo root: infrastructure, then keys and the dev JWT secret (once)
pnpm install
cp services/gateway/.env.example services/gateway/.env   # paste the values from deploy/compose/.env
pnpm --filter @sagamart/gateway build
cd services/gateway && set -a && . ./.env && set +a && pnpm start
```

Or with everything else: `make demo`, then:

```bash
curl -s -X POST localhost:8100/v1/dev/token -H 'content-type: application/json' \
  -d '{"role":"admin","userId":"0199f2e0-0000-7000-8000-000000000001"}'
```

| Endpoint | Purpose |
|---|---|
| `POST /v1/dev/token` | A development JWT for `buyer` or `admin` (one hour). **Exists only with `GATEWAY_DEV_AUTH=true`**, and the gateway refuses to start with that in `prod`. |
| `GET /healthz`, `GET /readyz` | Liveness and readiness. Readiness checks nothing downstream: the gateway degrades per dependency instead (RFC-0005 §4.5). |
| `GET /metrics` | Prometheus metrics |

## How a request is handled

1. **Deadline.** Every request gets a budget (`GATEWAY_REQUEST_DEADLINE_MS`, 5 s).
2. **Authentication.** No `Authorization` header means anonymous: guests and browsing need no token. A bearer token must be a valid development JWT: HS256 only, our issuer and audience, unexpired with 5 s of skew, a UUID subject and a known role. Anything else is `401` with `WWW-Authenticate`, never silently anonymous. With dev auth off, no bearer token is accepted until OIDC arrives (Core complete).
3. **Rate limiting.** A token bucket per user (signed in) or per IP (anonymous): 20 requests/s with a burst of 40 by default. It runs as one Lua script in Redis, so the refill and take are atomic and use Redis's clock, shared by every gateway instance.
   - An empty bucket is `429 RATE_LIMITED` with `Retry-After`.
   - Each Redis command has a **50 ms** deadline and nothing queues while disconnected. If Redis is down or slow, the request is **allowed** and `rate_limit_fail_open` is counted: rate limiting must never take the API down. At startup the gateway waits up to 1 s for Redis, so it doesn't start out unlimited.
4. **Roles.** `@Roles('admin')` routes need the role (`401` anonymous, `403` otherwise). Services check again from the signed identity.
5. **Internal calls.** `InternalClient` attaches a fresh `x-sagamart-identity` ([contract](../../contracts/identity.md)) signed for that one service, with `sub` and `roles` from the caller.
   - Each call has its own deadline (RFC-0005 §4.5: Catalog reads 1 s, writes 3 s), capped by what the request has left, and is aborted when it passes.
   - A late or unreachable service is `503 DEPENDENCY_UNAVAILABLE` with `Retry-After`. Services' own responses, errors included, come back to the caller to relay.
   - For Inventory (#31), the capped deadline becomes the gRPC deadline, which Go propagates through `context`.

Errors are RFC 9457 Problem Details with a stable `code` and the request's `traceId`.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `GATEWAY_IDENTITY_KEY_ID`, `GATEWAY_IDENTITY_PRIVATE_KEY` | — (required) | Ed25519 key that signs identities (PKCS#8 DER, base64); `make identity-keys` |
| `GATEWAY_DEV_AUTH` | `false` | `true` enables dev tokens; refused in `prod` |
| `GATEWAY_DEV_JWT_SECRET` | — | Required with dev auth; at least 32 characters |
| `GATEWAY_ENV` | `local` | `local`, `test` or `prod` |
| `GATEWAY_HTTP_PORT` | `8100` | |
| `GATEWAY_CATALOG_URL` | `http://localhost:8120` | |
| `GATEWAY_REDIS_URL` | `redis://localhost:6380` | Rate limits only; nothing durable |
| `GATEWAY_RATE_LIMIT_PER_SECOND`, `GATEWAY_RATE_LIMIT_BURST` | `20`, `40` | Per user or per IP |
| `GATEWAY_REQUEST_DEADLINE_MS` | `5000` | Budget for one incoming request |
| `GATEWAY_TRUST_PROXY` | `false` | Client IP from `X-Forwarded-For`; only behind a proxy we run |
| `GATEWAY_LOG_LEVEL`, `GATEWAY_VERSION`, `OTEL_EXPORTER_OTLP_ENDPOINT` | `info`, `dev`, empty | |

## Metrics

`sagamart_gateway_rate_limited_total`, `..._rate_limit_fail_open_total`, `..._auth_rejections_total` by reason, `..._dependency_failures_total` by service and reason, plus HTTP server metrics from OpenTelemetry.

## Layout

| Path | Contents |
|---|---|
| `src/instrument.ts`, `src/main.ts` | Telemetry first, then bootstrap |
| `src/app.module.ts` | Wiring: logging, Redis, middleware order, roles |
| `src/config.ts` | Environment configuration |
| `src/dev-auth.ts`, `src/dev.controller.ts` | Development JWTs |
| `src/auth.ts` | `AuthMiddleware`, `RateLimitMiddleware`, `RolesGuard`, `@Roles` |
| `src/rate-limit.ts` | The token-bucket script and fail-open limiter |
| `src/deadline.ts` | Deadlines and the RFC's per-call budgets |
| `src/internal-client.ts` | Calls to internal services with identity and deadlines |
| `src/request-context.ts` | The caller and deadline of a request |
| `src/problem.filter.ts`, `src/validation.ts` | Problem Details and request validation (as in Catalog) |
| `src/testing/` | Test support, not built: the contract checker |

## Tests

```bash
pnpm --filter @sagamart/gateway test   # needs Docker: Testcontainers Redis
```

- **Unit:** configuration (dev auth refused in prod), deadlines, dev tokens (expiry and skew, another secret, HS512, `alg: none`, wrong issuer or audience, bad roles and subjects), and the limiter's fail-open handling.
- **Integration:** a real Redis and a stub internal service that verifies the identity exactly as Catalog does. It covers probes, the dev-token route (present or absent), bad and expired tokens, roles, identity contents and forwarded headers, a call missing its deadline, an unreachable service, a burst then `429` then refill, separate buckets per user and IP, and failing open with Redis down and with Redis paused. The paused case then checks that the empty bucket is enforced once Redis answers again.
