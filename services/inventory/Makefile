# Inventory service. The root Makefile calls `test` and `lint` here.

GOLANGCI := go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.15.0

.PHONY: test
test: ## Unit and integration tests with the race detector (integration tests need Docker)
	go test -race -count=1 ./...

.PHONY: test-unit
test-unit: ## Unit tests only
	go test -race -short ./...

.PHONY: lint
lint: ## gofmt, go vet and golangci-lint
	@test -z "$$(gofmt -l .)" || { gofmt -l .; echo "run gofmt -w ."; exit 1; }
	go vet ./...
	$(GOLANGCI) run ./...

.PHONY: run
run: ## Run from source against `make up` infrastructure (reads .env if present)
	@set -a; [ -f .env ] && . ./.env; set +a; go run ./cmd/inventory
