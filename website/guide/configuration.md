---
title: Configuration
description: Task-oriented guide to configuring amazon-king for local development and production — validation rules, SMTP, secrets, and the kill switch.
---

# Configuration

All runtime configuration lives in environment variables, loaded from `.env`
in development (created by `make setup` from `.env.example`) or from
`.env.production` for the production Compose stack (`make prod-config`).

Both processes validate their configuration at boot:

- The API parses its environment with a Zod schema in
  `apps/api/src/config.ts`. Invalid or missing values fail startup with a
  validation error — the server never runs on a half-valid config.
- The worker does the same in `apps/worker/src/config.ts`. Only
  `DATABASE_URL` is strictly required there; every worker tunable has a safe
  default. The worker boots without LWA credentials so non-Amazon jobs still
  run, but any Amazon call (including token refresh) fails until they are
  set.

This page covers the decisions you need to make. For the complete,
variable-by-variable table with defaults, see
[Environment variables](/reference/environment-variables).

## Minimal development setup

The smallest working `.env` for `make run`:

```ini
DATABASE_URL=postgres://postgres:postgres@localhost:5432/amazon_king
SESSION_SECRET=dev-only-change-me-session-secret
WEB_ORIGIN=http://localhost:5173
AMAZON_REDIRECT_URI=http://localhost:3000/api/integrations/amazon/callback
LWA_CLIENT_ID=amzn1.application-oa2-client.xxxx
LWA_CLIENT_SECRET=your-lwa-client-secret
```

Notes:

- `SESSION_SECRET` must be at least 16 characters (32+ and non-default in
  production — see below).
- Without SMTP, magic sign-in links are printed to the API log in development
  only. Production requires SMTP.
- `TOKEN_ENCRYPTION_KEY` is required to store Amazon refresh tokens. The
  example file ships an all-zeros key that is fine for a disposable dev
  database; generate a real one for anything you care about (see
  [Token encryption key](#token-encryption-key)).
- Leave `KILL_SWITCH=true` while developing.

## Production-only requirements

Setting `NODE_ENV=production` turns on `Secure` session cookies (HTTPS is
mandatory) and makes the boot validation stricter. The API refuses to start
unless:

- `OWNER_EMAIL` is set — the only address allowed to sign in
  (single-owner lock),
- `API_PUBLIC_URL` is set — the public base URL of the API, used as the
  target of magic sign-in links,
- `SMTP_HOST` and `SMTP_FROM` are set, and
- `SESSION_SECRET` is at least 32 characters and does not contain
  `change-me` (case-insensitive).

Also set `WEB_ORIGIN` and `AMAZON_REDIRECT_URI` to your public HTTPS origin,
and `TRUST_PROXY=true` if the API sits behind your reverse proxy (see below).

## SMTP

Magic-link sign-in is the only login mechanism, so working email delivery is
a hard requirement in production.

- `SMTP_PORT=465` with `SMTP_SECURE=true` — implicit TLS.
- `SMTP_PORT=587` (the default) with `SMTP_SECURE=false` — STARTTLS. Use the
  port your provider documents for STARTTLS.

Authentication is optional for a trusted local relay. If you use credentials,
`SMTP_USER` and `SMTP_PASSWORD` must be set **together** — setting only one
fails boot validation.

```ini
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=amazon-king@example.com
SMTP_PASSWORD=...
SMTP_FROM="amazon-king <no-reply@example.com>"
```

## Reverse proxy: `TRUST_PROXY`

`TRUST_PROXY=true` tells Fastify to trust `X-Forwarded-*` headers, which the
API needs for correct client IPs (rate limiting, audit logs) when it sits
behind your HTTPS terminator.

::: warning
Only enable this when the API is reachable **exclusively** through your own
reverse proxy. On a directly exposed API, trusting forwarding headers lets
clients spoof their IP and defeat rate limits. The production Compose stack
binds its web entrypoint to `127.0.0.1:8080` by default for this reason; see
[Self-hosting](/guide/self-hosting).
:::

## Kill switch semantics

`KILL_SWITCH` is the global write kill switch, honored by both the API and
the worker:

- **Fail-closed by default.** Unset means `true` — writes disabled.
- **Only the exact string `"false"` disables it.** Any other value —
  `0`, `no`, `off`, a typo like `flase` — leaves writes disabled.

```ini
# Writes enabled (only when you have completed live validation):
KILL_SWITCH=false
```

This is deliberate: a misconfiguration can never silently turn writes on.
Keep it `true` until you have completed the read-only validation checklist
and the live-write validation sequence with a test account or a dedicated
low-risk campaign. See [Applying & rolling back changes](/guide/applying-changes).

## Token encryption key

`TOKEN_ENCRYPTION_KEY` is the master key for envelope-encrypting Amazon
refresh tokens (AES-256-GCM) before they are stored in the database. It must
be **64 hex characters** (32 bytes), for example from:

```sh
openssl rand -hex 32
```

Key rotation is supported without decrypting everything at once: set
`TOKEN_ENCRYPTION_KEY_V2` (then `_V3`, …) to the new key. New encryptions use
the latest version; the ciphertext embeds the key version, so older rows stay
decryptable as long as their version's key is still configured. The incident
runbook uses this when rotating keys after a suspected exposure — see
[Operations](/guide/operations#suspected-credential-or-data-exposure).

::: danger
Losing every configured key version makes all stored Amazon refresh tokens
unrecoverable — every connection must be reconnected through OAuth. Back up
keys separately in a secret manager, never beside database backups.
:::
