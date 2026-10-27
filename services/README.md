# Services

One folder per backend service, each with its own `README.md`, `CHANGELOG.md`, `Dockerfile`, `.env.example` and a `Makefile` exposing `test` and `lint` (picked up by the root `make test` / `make lint`).

| Service | Language | Lands in |
|---|---|---|
| `inventory` | Go | Stage 1 (after RFC-0001) |
| `catalog` | NestJS | Stage 1 |
| `gateway` | NestJS | Stage 1 |
| `order` | Java / Spring Boot | Stage 2 (RFC-0002; skeleton in place) |
| `payment` | Go | Stage 2 |
| `mock-payment-provider` | Go | Stage 2 |
| `event-workers` | Go | Stage 3 (after RFC-0003) |
