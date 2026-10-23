# Sagamart — single entry point. Run `make help` for the list of targets.

SHELL := /bin/bash
.DEFAULT_GOAL := help

COMPOSE       := docker compose -f deploy/compose/infra.yml -f deploy/compose/services.yml --env-file deploy/compose/.env
BUF_IMAGE     := bufbuild/buf:1.45.0
BUF           := docker run --rm --user $(shell id -u):$(shell id -g) -e HOME=/tmp -v "$(CURDIR):/workspace" -w /workspace/contracts $(BUF_IMAGE)

AJV           := npx --yes -p ajv-cli@5.0.0 -p ajv-formats@3.0.1 ajv --spec=draft2020 -c ajv-formats --strict=false
EVENTS        := contracts/events

SERVICES := $(notdir $(wildcard services/*))

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z_-]+:.*##/ {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

deploy/compose/.env:
	cp deploy/compose/.env.example deploy/compose/.env

## ---- Local environment ----

.PHONY: up
up: deploy/compose/.env ## Start local infrastructure only (databases, broker, observability); run services from source
	$(COMPOSE) up -d --wait

.PHONY: down
down: deploy/compose/.env ## Stop everything (keeps volumes)
	$(COMPOSE) --profile services down

.PHONY: clean
clean: deploy/compose/.env ## Stop everything and delete volumes
	$(COMPOSE) --profile services down -v

.PHONY: ps
ps: deploy/compose/.env ## Show container status
	$(COMPOSE) --profile services ps

.PHONY: logs
logs: deploy/compose/.env ## Follow logs
	$(COMPOSE) --profile services logs -f --tail=100

.PHONY: demo
demo: deploy/compose/.env ## Build and start the full system: infrastructure plus every service (needs make identity-keys once)
	$(COMPOSE) --profile services up -d --build --wait
	@echo "Sagamart is up."
	@echo "  Gateway           public API http://localhost:8100  (POST /v1/dev/token for a token)"
	@echo "  Inventory         gRPC localhost:9110, probes and metrics http://localhost:8110"
	@echo "  Catalog           internal API, probes and metrics http://localhost:8120"
	@echo "  Redpanda console  http://localhost:8080"
	@echo "  Grafana           http://localhost:3001  (admin / admin)"
	@echo "  Jaeger            http://localhost:16686"
	@echo "  Prometheus        http://localhost:9090"

## ---- Contracts ----

.PHONY: contracts-lint
contracts-lint: ## Lint protobuf contracts with buf
	$(BUF) lint

.PHONY: contracts-breaking
contracts-breaking: ## Check protobuf contracts for breaking changes against main
	$(BUF) breaking --against '/workspace/.git#branch=main,subdir=contracts'

.PHONY: contracts-generate
contracts-generate: ## Regenerate code from protobuf contracts (committed under contracts/gen)
	$(BUF) generate
	cd contracts/gen/go && go mod tidy

.PHONY: contracts-events
contracts-events: ## Compile event schemas and validate every example against its schema
	$(AJV) compile -s $(EVENTS)/envelope.schema.json
	@set -e; for schema in $(EVENTS)/schemas/*.schema.json; do \
		name=$$(basename $$schema .schema.json); \
		example=$(EVENTS)/examples/$$name.json; \
		if [ ! -f $$example ]; then echo "missing example for $$name: $$example"; exit 1; fi; \
		$(AJV) validate -s $$schema -r $(EVENTS)/envelope.schema.json -d $$example; \
	done
	@set -e; for example in $(EVENTS)/examples/*.json; do \
		name=$$(basename $$example .json); \
		if [ ! -f $(EVENTS)/schemas/$$name.schema.json ]; then echo "example without a schema: $$example"; exit 1; fi; \
	done

.PHONY: contracts-openapi
contracts-openapi: ## Lint the OpenAPI specs and validate every example against its schema
	cd contracts && npx --yes @redocly/cli@2.67.1 lint --config redocly.yaml

.PHONY: identity-keys
identity-keys: deploy/compose/.env ## Generate a local Ed25519 key pair for x-sagamart-identity and a dev JWT secret into deploy/compose/.env (JSON single-quoted so both bash and Compose read it)
	@kid="local-$$(date +%Y%m%d%H%M%S)"; \
	priv=$$(openssl genpkey -algorithm ed25519 -outform DER | base64 -w0); \
	pub=$$(printf '%s' "$$priv" | base64 -d | openssl pkey -inform DER -pubout -outform DER | base64 -w0); \
	secret=$$(openssl rand -hex 32); \
	sed -i '/^IDENTITY_\(KEY_ID\|PRIVATE_KEY\|PUBLIC_KEYS\)=/d; /^GATEWAY_DEV_JWT_SECRET=/d' deploy/compose/.env; \
	printf 'IDENTITY_KEY_ID=%s\nIDENTITY_PRIVATE_KEY=%s\nIDENTITY_PUBLIC_KEYS='"'"'{"%s":"%s"}'"'"'\n' "$$kid" "$$priv" "$$kid" "$$pub" >> deploy/compose/.env; \
	printf 'GATEWAY_DEV_JWT_SECRET=%s\n' "$$secret" >> deploy/compose/.env; \
	echo "wrote identity key $$kid and a dev JWT secret to deploy/compose/.env"

.PHONY: contracts-format
contracts-format: ## Format protobuf contracts in place
	$(BUF) format -w

## ---- Quality ----

.PHONY: e2e
e2e: ## End-to-end flows through the public API on the running stack (make demo first); stops and restarts Inventory
	pnpm --filter @sagamart/contract-testing build
	pnpm --filter @sagamart/e2e e2e

.PHONY: test
test: ## Run unit tests for every service that has a Makefile
	@set -e; for s in $(SERVICES); do \
		if [ -f services/$$s/Makefile ]; then echo "==> $$s"; $(MAKE) -C services/$$s test; fi; \
	done

.PHONY: lint
lint: contracts-lint contracts-events contracts-openapi ## Run all linters
	@set -e; for s in $(SERVICES); do \
		if [ -f services/$$s/Makefile ]; then echo "==> $$s"; $(MAKE) -C services/$$s lint; fi; \
	done
