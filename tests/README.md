# Tests

- `e2e/` (`@sagamart/e2e`): flows through the public API on the running Compose stack. Run `make demo`, then `make e2e`. The browse-and-cart journey covers dev token, admin product and stock, then a buyer listing, opening and adding to guest and signed-in carts. It is followed by the same pages with Inventory stopped (the browsing half of chaos experiment C6). Every response is checked against `public-v1.yaml`. CI runs it on `main`, on demand, and on PRs that change the flows or the stack (`.github/workflows/e2e.yml`).
  - There's no web app yet, so these are API flows with Vitest. Playwright journeys come with the storefront.
- `acceptance/`: Gherkin features (one per critical FR) and Cucumber step definitions, run against the Compose stack. Not started yet.

See the [testing strategy](../docs/engineering/testing-strategy.md).
