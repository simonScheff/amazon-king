ifeq ($(OS),Windows_NT)
  SHELL := C:/Program Files/Git/bin/bash.exe
  .SHELLFLAGS := -c
  export PATH := C:\Program Files\Git\usr\bin;C:\Program Files\Git\bin;$(PATH)
endif

.DEFAULT_GOAL := help

# Load local environment (DATABASE_URL, PORT, ...) into every recipe.
ifneq (,$(wildcard .env))
include .env
export
endif

.PHONY: help install setup preflight db-up db-wait migrate mcp mcp-token run dev test typecheck lint build check prod-config prod-preflight prod-up prod-logs prod-stop stop clean backup restore

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

db-up: ## Start local PostgreSQL (docker compose or existing local server)
	@if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then \
		docker compose up -d db; \
		echo "Waiting for PostgreSQL..."; \
		for i in $$(seq 1 30); do \
			if docker exec amazon-king-db pg_isready -U postgres -d amazon_king -q 2>/dev/null; then echo "PostgreSQL is ready"; exit 0; fi; \
			sleep 1; \
		done; \
		echo "PostgreSQL did not become ready in time" >&2; exit 1; \
	else \
		echo "Docker not found or daemon not running; checking native PostgreSQL connection..."; \
		pnpm exec tsx -e "import { createPool } from '@amazon-king/database'; (async () => { const pool = createPool(process.env.DATABASE_URL!); await pool.query('SELECT 1'); await pool.end(); console.log('PostgreSQL is ready'); })().catch(err => { console.error('Could not connect to PostgreSQL:', err.message); process.exit(1); })"; \
	fi

migrate: ## Apply database migrations
	@set -a; [ ! -f .env ] || . ./.env; set +a; \
	pnpm exec tsx scripts/migrate.ts

mcp: ## Start the MCP server (stdio; set MCP_TRANSPORT=http for remote agents)
	@set -a; [ ! -f .env ] || . ./.env; set +a; \
	pnpm exec tsx apps/mcp/src/index.ts

mcp-token: ## Manage MCP machine tokens: make mcp-token ARGS="issue <label>"
	@set -a; [ ! -f .env ] || . ./.env; set +a; \
	pnpm exec tsx scripts/mcp-token.ts $(ARGS)

run: setup preflight db-up migrate ## Run the entire application (db + api + worker + web)
	@$(MAKE) --no-print-directory backup || echo "Warning: database backup failed; starting anyway"
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

backup: ## Dump the local database to backups/ (keeps the last 14; db must be running)
	@mkdir -p backups
	@if command -v docker >/dev/null 2>&1 && docker ps -q -f name=amazon-king-db | grep -q .; then \
		docker exec amazon-king-db pg_dump -U postgres -Fc amazon_king > backups/amazon_king-$$(date +%Y%m%d-%H%M%S).dump; \
	elif command -v pg_dump >/dev/null 2>&1; then \
		pg_dump -d "$$DATABASE_URL" -Fc > backups/amazon_king-$$(date +%Y%m%d-%H%M%S).dump; \
	elif [ -f "/c/Program Files/PostgreSQL/16/bin/pg_dump.exe" ]; then \
		"/c/Program Files/PostgreSQL/16/bin/pg_dump.exe" -d "$$DATABASE_URL" -Fc > backups/amazon_king-$$(date +%Y%m%d-%H%M%S).dump; \
	else \
		echo "pg_dump / docker not available; skipping backup" >&2; exit 1; \
	fi
	@ls -t backups/amazon_king-*.dump 2>/dev/null | tail -n +15 | xargs rm -f 2>/dev/null || true
	@echo "Backup written: $$(ls -t backups/amazon_king-*.dump 2>/dev/null | head -1)"

restore: ## Restore a dump over the local database: make restore DUMP=backups/<file>.dump
	@test -n "$(DUMP)" || (echo "Usage: make restore DUMP=backups/amazon_king-YYYYMMDD-HHMMSS.dump" >&2; exit 1)
	@test -f "$(DUMP)" || (echo "$(DUMP) does not exist" >&2; exit 1)
	@read -p "This OVERWRITES the local amazon_king database with $(DUMP). Type yes to continue: " ans; \
		[ "$$ans" = yes ] || (echo "Aborted" >&2; exit 1)
	@docker exec -i amazon-king-db pg_restore -U postgres -d amazon_king --clean --if-exists < "$(DUMP)"
	@echo "Restored $(DUMP)"

clean: stop ## Stop db and delete its data volume (destroys local data; asks first)
	@read -p "This permanently deletes the local database volume and .data. Type yes to continue: " ans; \
		[ "$$ans" = yes ] || (echo "Aborted" >&2; exit 1)
	docker compose down -v
	rm -rf .data
