# Sagamart — single entry point. Run `make help` for the list of targets.

SHELL := /bin/bash
.DEFAULT_GOAL := help

COMPOSE_INFRA := docker compose -f deploy/compose/infra.yml --env-file deploy/compose/.env
BUF_IMAGE     := bufbuild/buf:1.45.0
BUF           := docker run --rm -v "$(CURDIR):/workspace" -w /workspace/contracts $(BUF_IMAGE)

SERVICES := $(notdir $(wildcard services/*))

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z_-]+:.*##/ {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

deploy/compose/.env:
	cp deploy/compose/.env.example deploy/compose/.env

## ---- Local environment ----

.PHONY: up
up: deploy/compose/.env ## Start local infrastructure (databases, broker, observability)
	$(COMPOSE_INFRA) up -d --wait

.PHONY: down
down: deploy/compose/.env ## Stop local infrastructure (keeps volumes)
	$(COMPOSE_INFRA) down

.PHONY: clean
clean: deploy/compose/.env ## Stop local infrastructure and delete its volumes
	$(COMPOSE_INFRA) down -v

.PHONY: ps
ps: deploy/compose/.env ## Show container status
	$(COMPOSE_INFRA) ps

.PHONY: logs
logs: deploy/compose/.env ## Follow infrastructure logs
	$(COMPOSE_INFRA) logs -f --tail=100

.PHONY: demo
demo: up ## Bring up the full system (services are added as they land)
	@echo "Infrastructure is up. Services will be added to the demo stack from Stage 1."
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

.PHONY: contracts-format
contracts-format: ## Format protobuf contracts in place
	$(BUF) format -w

## ---- Quality ----

.PHONY: test
test: ## Run unit tests for every service that has a Makefile
	@set -e; for s in $(SERVICES); do \
		if [ -f services/$$s/Makefile ]; then echo "==> $$s"; $(MAKE) -C services/$$s test; fi; \
	done

.PHONY: lint
lint: contracts-lint ## Run all linters
	@set -e; for s in $(SERVICES); do \
		if [ -f services/$$s/Makefile ]; then echo "==> $$s"; $(MAKE) -C services/$$s lint; fi; \
	done
