---
name: expose-localhost
description: Expose a local dev server (default the web app on :5173) publicly over HTTPS using a cloudflared quick tunnel
type: prompt
whenToUse: When the user asks to make a localhost URL public, share the dev server, get a public/HTTPS URL, set up a tunnel, or test the app from a phone or other device
arguments:
  - port
---

Expose a local port publicly over HTTPS with a cloudflared quick tunnel.

Port: use `$port` if the user provided one; otherwise default to `5173` (this project's Vite dev server). The API does not need its own tunnel — Vite proxies `/api` to `localhost:3000` same-origin.

Steps:

1. Verify cloudflared exists: `which cloudflared`. If missing, ask the user before installing (`brew install cloudflared`).
2. Verify the target responds: `curl -s -o /dev/null -w '%{http_code}' http://localhost:$port/`. If it is not running, tell the user (or start the dev server in the background if asked).
3. Start the tunnel as a background task with no timeout:
   `cloudflared tunnel --url http://localhost:$port --no-autoupdate`
4. Read the task log and extract the `https://<random>.trycloudflare.com` URL.
5. Verify it end-to-end: `curl -s -o /dev/null -w '%{http_code}' <tunnel-url>/` — expect 200.
   - If the response is `403 Blocked request. This host ... is not allowed`, the dev server rejects the tunnel hostname. For this repo, `apps/web/vite.config.ts` already allows `.trycloudflare.com` via `server.allowedHosts`; for other servers, add the equivalent host allowlist and retry.
6. Give the user the URL and mention:
   - The tunnel runs as a background task in this session; offer to stop it on request.
   - Quick-tunnel URLs are throwaway: a restart produces a new random URL. For a stable public URL, use a named Cloudflare tunnel on the user's own domain or deploy behind TLS.

Notes:

- HTTPS via the tunnel enables secure-context browser features (e.g. PWA install prompts, service workers) that plain-HTTP LAN URLs like `http://10.0.0.x:5173` cannot use.
- Do not tunnel ports serving secrets or unauthenticated admin panels without warning the user — a quick-tunnel URL is reachable by anyone who has it.

## This repo: sign-in works on localhost and tunnel alike

Since migration `0006_login_token_origin.sql`, the API remembers the browser
origin each login was started from (`Origin` header on
`POST /api/session/login`, allowlisted in `apps/api/src/services/session.ts`:
the configured `WEB_ORIGIN`, plus localhost and `https://*.trycloudflare.com`
in development). The magic link is built from that origin and
`GET /api/session/verify` redirects back to it, so no `.env` changes are
needed when opening or closing a tunnel.

Keep `WEB_ORIGIN` and `API_PUBLIC_URL` in `.env` pointed at
`http://localhost:5173` as the default; they remain the fallback when a
request carries no origin. Note the Amazon _connect_ (OAuth) callback still
redirects to `WEB_ORIGIN` only — connecting the Amazon account is best done
from localhost.

## This repo: no email on localhost — links are dev-delivered

Local development has no SMTP configured, so **no real email is ever sent**.
`POST /api/session/login` instead returns the magic link as `devLoginUrl` in
the JSON response (the login page and the re-auth "Confirm it's you" dialog
render it as a "Continue sign-in" link), and the API process also logs it.
This is intentional (`apps/api/src/services/session.ts` `startLogin`); do not
treat the missing email as a bug.

Related sign-in facts worth knowing when working locally:

- Spend-changing actions (apply, rollback, max-cpc, campaign creation)
  require an app session created within the last 15 minutes
  (`RECENT_AUTH_MS` in `apps/api/src/config.ts`). When it lapses, the web app
  opens the re-auth dialog — on localhost, one click on the dev link
  re-signs you in and returns you to the same page (the link carries the
  path as `next`, stored in `login_tokens.next_path`, migration `0008`).
- **After pulling or writing schema changes, run `make migrate`.** A missing
  migration surfaces only as a generic "Internal server error" in the UI —
  e.g. the re-auth dialog failed with a 500 until `0008_login_token_next_path.sql`
  was applied to the running Docker Postgres. If a login or mutation 500s
  locally, check `docker compose ps`, then pending migrations first.
