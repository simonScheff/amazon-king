# apps/mcp — `@amazon-king/mcp`

MCP (Model Context Protocol) server exposing the workspace's advertising data
and optimizer research to external AI agents. Draft-capable but never
applying — agents may read everything, draft change sets, and perform the
enumerated local mutations, but applying to Amazon stays in the dashboard.
See `docs/mcp-server-plan.md` for the design.

## Commands

`start` / `dev` (`tsx src/index.ts`), `typecheck`, `test` (vitest — no
network, no real database; the pool is stubbed).

## Structure

- `src/config.ts` — `DATABASE_URL`, `KILL_SWITCH`, `MCP_TRANSPORT`
  (`stdio` default, `http`), `MCP_HOST` (default `127.0.0.1`), `MCP_PORT`
  (default `3100`).
- `src/server.ts` — `buildMcpServer()`: the transport-agnostic tool set, a
  thin wrapper over `createReadService` from `@amazon-king/read-service`
  scoped to the single workspace. Tool inputs are Zod schemas; shared shapes
  come from `@amazon-king/contracts`.
- `src/http.ts` — Streamable HTTP transport: stateless (fresh server per
  request, JSON responses), bearer machine tokens (`api_tokens` table,
  SHA-256 hashes only), 120 req/min per-token rate limit, and an
  `mcp.tool_call` audit event per tool call.
- `src/index.ts` — composition root. In stdio mode logs must go to **stderr**
  (stdout is the protocol channel) — keep it that way.

## Rules

- **Write tools are drafting-only, enumerated, and validated.** Change-set
  drafting and the listed local mutations (recommendation dismissals,
  search-term exclusions, bid policies, campaign-state drafts) are allowed;
  apply, rollback, sync trigger, and disconnect are not — the apply path
  requires the owner's session in the dashboard (root `AGENTS.md`, guarded
  writes). Every write tool must mirror the equivalent API service's
  validations and record a domain audit event.
- Over HTTP, write tools require a machine token with scope `mcp:draft`
  (read tools keep `mcp:read`). Stdio is local and trusted.
- Every tool takes the workspace id resolved at startup; there is no
  per-request tenant selection.
- Tool descriptions carry the repo's metric semantics (ACoS ≠ profit, money
  as native-currency decimal strings) — keep them accurate when the read
  layer changes.
- Machine tokens are managed with `scripts/mcp-token.ts`
  (`issue` / `list` / `revoke`); the plaintext is shown once at issuance.
