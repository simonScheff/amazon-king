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
2. Verify the target responds: `curl -s -o /dev/null -w '%{http_code}' http://localhost:$port/`. If it is not running, tell the user (or start the dev server in the background if asked — see the `local-stack` skill).
3. Start the tunnel as a background task with no timeout:
   `cloudflared tunnel --url http://localhost:$port --no-autoupdate`
4. Read the task log and extract the `https://<random>.trycloudflare.com` URL.
5. Verify it end-to-end: `curl -s -o /dev/null -w '%{http_code}' <tunnel-url>/` — expect 200.
   - If the response is `403 Blocked request. This host ... is not allowed`, the dev server rejects the tunnel hostname. For this repo, `apps/web/vite.config.ts` already allows `.trycloudflare.com` via `server.allowedHosts`; for other servers, add the equivalent host allowlist and retry.
6. Give the user the URL and mention:
   - The tunnel runs as a background task in this session; offer to stop it on request.
   - Quick-tunnel URLs are throwaway: a restart produces a new random URL. For a stable public URL, use a named Cloudflare tunnel on the user's own domain or deploy behind TLS.

Notes:

- HTTPS via the tunnel enables secure-context browser features (e.g. PWA install prompts, service workers) that plain-HTTP LAN URLs like `http://10.0.0.x:5173` cannot use. Testing the phone install gate requires this.
- Do not tunnel ports serving secrets or unauthenticated admin panels without warning the user — a quick-tunnel URL is reachable by anyone who has it.

## Sign-in works on localhost and tunnel alike

The API remembers the browser origin each login was started from (the `Origin`
header on `POST /api/session/login`, allowlisted in
`apps/api/src/services/session.ts`: the configured `WEB_ORIGIN`, plus localhost
and `https://*.trycloudflare.com` in development). The magic link is built from
that origin and `GET /api/session/verify` redirects back to it, so **no `.env`
changes are needed when opening or closing a tunnel**.

Keep `WEB_ORIGIN` and `API_PUBLIC_URL` in `.env` pointed at
`http://localhost:5173` as the default; they remain the fallback when a request
carries no origin.

Two caveats:

- The Amazon **connect** (OAuth) callback redirects to `WEB_ORIGIN` only, so
  connecting the Amazon account is best done from localhost.
- No email is sent locally — the magic link is returned in the login response
  and logged. See the `local-stack` skill for dev sign-in and for why a local
  500 usually means a pending migration.
