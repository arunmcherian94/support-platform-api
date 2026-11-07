.DEFAULT_GOAL := help
.PHONY: help install typecheck lint test check mocks run api postman

# Fixture clock (S1 §4). Override with NOW=... on the command line.
NOW ?= 2026-11-06T12:00:00Z

help: ## List targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  %-12s %s\n", $$1, $$2}'

install: ## Install pinned dependencies from the lockfile
	npm ci

typecheck: ## TypeScript strict typecheck
	npm run typecheck

lint: ## ESLint, Prettier and Spectral (API contract)
	npm run lint

test: ## Unit and integration tests
	npm test

check: typecheck lint test ## Everything CI runs

mocks: ## Mock upstreams on :8081 (faults: MOCK_FAULTS='{"warehouse":{"down":true}}')
	NOW=$(NOW) npx tsx mocks/server.ts

run: ## Mocks + API on :8081/:8080 at the fixture clock
	npx tsx scripts/run.ts

api: ## API only (expects mocks on :8081)
	NOW=$(NOW) DEV_ISSUER=true npx tsx src/server.ts

postman: ## Postman functional and regression checks (expects make run)
	npx -y newman@6.2.3 run postman/support-platform-api.postman_collection.json
