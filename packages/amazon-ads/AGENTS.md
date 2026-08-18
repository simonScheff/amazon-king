# packages/amazon-ads — `@amazon-king/amazon-ads`

The Amazon Ads gateway: the only place in the codebase that speaks to Amazon.
Read the root `AGENTS.md` for the **gateway boundary** rule.

## Boundary contract

Every Amazon payload is strictly validated with zod at the boundary and
translated into internal domain models. Raw Amazon field naming must not leak
past this package — the optimizer and the database never see it. Use stable
Reporting v3 for reports and prefer Unified API GA resources for campaign
operations, keeping product-specific Sponsored Products v3 adapters where they
are mature. Never build production reporting on beta endpoints.

## Contents

- `oauth.ts` — the LWA OAuth client.
- `token-manager.ts` — refresh serialized per connection, with a 5-minute early
  skew and a circuit breaker that flips a connection to `reconnect_required`.
- `http.ts` — regional transport honoring `Retry-After` with full-jitter
  backoff.
- `gateway.ts` — the plan §6 `AmazonAdsGateway`: profiles, Reporting v3
  request/poll/stream-download, SP v3 structure lists, keyword bid updates and
  negative keywords with per-item 207 mapping, and SP entity creation.

## Entity creation chain

`applyActions` applies campaign → ad group → product ad / keyword creation as an
ordered chain, substituting ids created in each phase into dependent actions.
An action whose parent failed must fail with `PARENT_FAILED` rather than being
attempted or silently skipped.

## Testing

Contract fixtures live in `test/fixtures/` as sanitized Amazon responses. Tests
inject `fetch` — this package never touches the network in tests, and new
adapters should follow the same pattern. Fixtures should tolerate unknown
additive fields and fail clearly when a required field changes.
