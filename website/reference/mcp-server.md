# MCP Server

amazon-king ships an [MCP](https://modelcontextprotocol.io) server
(`apps/mcp`) so any MCP-compatible AI agent — Claude, Kimi, Cursor, or your
own scripts — can query your advertising data and the optimizer's research
directly: campaign performance, search-term analysis, recommendations with
their evidence, and sync freshness.

The server is **read-only by design**. It has no apply, rollback, or sync
tools; applying a change always requires you in the
[dashboard](../guide/applying-changes) with a recent sign-in. Agents get the
same numbers the dashboard shows because both are served by the same read
layer.

## Running it

### Local agents (stdio, default)

```sh
make mcp
```

Register the server in your agent client, e.g.:

```sh
claude mcp add amazon-king -- make -C /path/to/amazon-king mcp
```

`make mcp` loads your `.env` and starts the server quietly over stdio — do
not register `pnpm --filter @amazon-king/mcp start` directly, because the
pnpm script banner would corrupt the stdio protocol.

stdio needs no tokens or network exposure — the client launches the process
and talks to it over standard I/O. `DATABASE_URL` from your `.env` is the
only requirement.

### Remote agents (Streamable HTTP)

1. Set `MCP_TRANSPORT=http` (optionally `MCP_HOST` / `MCP_PORT`, default
   `127.0.0.1:3100`).
2. Issue a machine token — the plaintext is shown once:

   ```sh
   pnpm exec tsx scripts/mcp-token.ts issue my-agent
   ```

3. Point the client at `http://127.0.0.1:3100/mcp` with an
   `Authorization: Bearer <token>` header.

Manage tokens with `scripts/mcp-token.ts list` and
`scripts/mcp-token.ts revoke <id>`. Only SHA-256 hashes are stored
(`api_tokens` table), every token is limited to 120 requests per minute, and
every tool call is written to the [audit log](../guide/operations). To expose
the endpoint beyond localhost, put it behind your own HTTPS-terminating
reverse proxy.

## Tools

| Tool | What it returns |
| ---- | --------------- |
| `list_profiles` | Connected Amazon Ads profiles (marketplace, currency, write-enabled flag). |
| `get_dashboard_summary` | Overview KPIs and daily trend for a window; `country="all"` gives the FX-converted all-market view. |
| `get_country_spend` | Spend per marketplace, optionally converted to a display currency. |
| `list_campaigns` | Campaigns with metrics for a window. |
| `get_campaign` | One campaign: metrics, trend, ad groups, targets, negatives. |
| `list_search_terms` | Shopper search terms with aggregated performance — the main research surface. |
| `get_search_term` | One term broken down by campaign, with trend and negative coverage. |
| `list_books` | Books with KDP economics and advertised-product mappings. |
| `list_recommendations` | Optimizer findings filterable by type and state, with rationale and evidence windows. |
| `get_recommendation` | One finding in full, including cannibalization or conversion context. |
| `list_change_sets` | Guarded change sets and their status (read-only view of the write pipeline). |
| `get_sync_status` | Recent sync runs and per-dataset data freshness. |

All monetary values are decimal strings in the marketplace's native currency,
and ACoS is ad spend over ad-attributed retail revenue — not author profit.
Profit figures exist only where [book economics](../guide/book-economics) are
entered. Tool descriptions tell agents the same, and `get_sync_status` lets
an agent state how fresh its answers are.
