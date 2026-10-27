# Order service. The root Makefile calls `test` and `lint` here. Needs only Java 25: ./mvnw fetches Maven.

.PHONY: test
test: ## Unit and integration tests (integration tests need Docker for Testcontainers)
	./mvnw -B -q test

.PHONY: lint
lint: ## Spotless (google-java-format) and Checkstyle
	./mvnw -B -q spotless:check checkstyle:check

.PHONY: format
format: ## Apply google-java-format
	./mvnw -B -q spotless:apply

.PHONY: verify
verify: ## Everything CI runs: format, lint and all tests
	./mvnw -B verify

.PHONY: run
run: ## Run from source against `make up` infrastructure (reads .env if present)
	@set -a; [ -f .env ] && . ./.env; set +a; ./mvnw -B -q spring-boot:run
