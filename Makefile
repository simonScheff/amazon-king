.DEFAULT_GOAL := help

# Load local environment (DATABASE_URL, PORT, ...) into every recipe.
ifneq (,$(wildcard .env))
include .env
export
endif

.PHONY: help install setup db-up db-wait migrate run dev test typecheck lint build stop clean

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install workspace dependencies
	pnpm install

setup: install ## Install deps and create .env from .env.example if missing
	@test -f .env || (cp .env.example .env && echo "Created .env from .env.example — set LWA_CLIENT_ID/LWA_CLIENT_SECRET when you have Amazon credentials")

db-up: ## Start local PostgreSQL (docker compose)
	docker compose up -d db
	@echo "Waiting for PostgreSQL..."
	@for i in $$(seq 1 30); do \
		if docker exec amazon-king-db pg_isready -U postgres -d amazon_king -q; then echo "PostgreSQL is ready"; exit 0; fi; \
		sleep 1; \
	done; \
	echo "PostgreSQL did not become ready in time" >&2; exit 1

migrate: ## Apply database migrations
	@set -a; [ ! -f .env ] || . ./.env; set +a; \
	pnpm exec tsx scripts/migrate.ts

run: setup db-up migrate ## Run the entire application (db + api + worker + web)
	@echo "Starting api (http://localhost:3000), worker, and web (http://localhost:5173) — Ctrl-C stops all"
	@set -a; [ ! -f .env ] || . ./.env; set +a; \
	trap 'kill $$(jobs -p) 2>/dev/null || true' INT TERM EXIT; \
	pnpm --filter @amazon-king/api dev & \
	pnpm --filter @amazon-king/worker dev & \
	pnpm --filter @amazon-king/web dev & \
	wait

dev: run ## Alias for run

test: ## Run all tests
	pnpm -r test

typecheck: ## Typecheck all packages
	pnpm -r typecheck

lint: ## Check formatting
	pnpm lint

build: ## Build the web app
	pnpm --filter @amazon-king/web build

stop: ## Stop local PostgreSQL
	docker compose down

clean: stop ## Stop db and delete its data volume (destroys local data)
	docker compose down -v
	rm -rf .data
