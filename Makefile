.DEFAULT_GOAL := help

# Load local environment (DATABASE_URL, PORT, ...) into every recipe.
ifneq (,$(wildcard .env))
include .env
export
endif

.PHONY: help install setup preflight db-up db-wait migrate run dev test typecheck lint build check prod-config prod-preflight prod-up prod-logs prod-stop stop clean

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install workspace dependencies
	pnpm install

setup: install ## Install deps and create .env from .env.example if missing
	@test -f .env || (cp .env.example .env && echo "Created .env from .env.example — set LWA_CLIENT_ID/LWA_CLIENT_SECRET when you have Amazon credentials")

preflight: ## Validate required local configuration before starting services
	@test -n "$(DATABASE_URL)" || (echo "DATABASE_URL is required in .env" >&2; exit 1)
	@test -n "$(SESSION_SECRET)" || (echo "SESSION_SECRET is required in .env" >&2; exit 1)
	@test -n "$(LWA_CLIENT_ID)" || (echo "LWA_CLIENT_ID is required in .env" >&2; exit 1)
	@test -n "$(LWA_CLIENT_SECRET)" || (echo "LWA_CLIENT_SECRET is required in .env" >&2; exit 1)

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

run: setup preflight db-up migrate ## Run the entire application (db + api + worker + web)
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

check: ## Run formatting, typechecks, tests, and the production web build
	pnpm check

prod-config: ## Create the ignored production environment file if missing
	@test -f .env.production || (cp .env.production.example .env.production && echo "Created .env.production — replace every change-me value before starting")

prod-preflight: ## Reject missing or placeholder production configuration
	@test -f .env.production || (echo ".env.production is missing; run make prod-config" >&2; exit 1)
	@! grep -Eq '^[A-Z0-9_]+=.*change-me' .env.production || (echo "Replace every change-me value in .env.production" >&2; exit 1)

prod-up: prod-preflight ## Build and start the self-hosted production stack
	docker compose --env-file .env.production -f compose.production.yml up -d --build

prod-logs: ## Follow production stack logs
	docker compose --env-file .env.production -f compose.production.yml logs -f

prod-stop: ## Stop the production stack without deleting persistent data
	docker compose --env-file .env.production -f compose.production.yml down

stop: ## Stop local PostgreSQL
	docker compose down

clean: stop ## Stop db and delete its data volume (destroys local data)
	docker compose down -v
	rm -rf .data
