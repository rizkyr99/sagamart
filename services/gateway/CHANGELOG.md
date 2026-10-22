# Changelog — gateway

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Releases are tagged `gateway/vX.Y.Z`.

## [Unreleased]

### Added

- Service skeleton (#30, RFC-0005 §4.2, §4.5, §8):
  - zod-validated configuration that refuses dev auth in `prod`;
  - development JWTs (`POST /v1/dev/token`, HS256, one hour) only when `GATEWAY_DEV_AUTH=true`;
  - bearer-token verification and `@Roles`;
  - an internal client that signs `x-sagamart-identity` per target service and enforces per-call deadlines capped by the request's own;
  - token-bucket rate limiting per user or IP in Redis (one Lua script, a 50 ms deadline, fails open), with `429` and `Retry-After`;
  - Problem Details for every error, `/healthz`, `/readyz`, `/metrics` and OpenTelemetry;
  - a Dockerfile and a Compose service.
