.DEFAULT_GOAL := help
.PHONY: help install typecheck lint test check

help: ## List targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  %-12s %s\n", $$1, $$2}'

install: ## Install pinned dependencies from the lockfile
	npm ci

typecheck: ## TypeScript strict typecheck
	npm run typecheck

lint: ## ESLint + Prettier (Spectral joins with the contract)
	npm run lint

test: ## Unit and integration tests
	npm test

check: typecheck lint test ## Everything CI runs
