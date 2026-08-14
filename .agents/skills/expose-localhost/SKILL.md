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

## This repo: sign-in redirect must match the tunnel URL

The API builds the magic link from `API_PUBLIC_URL` and redirects to `WEB_ORIGIN` after verifying it (`apps/api/src/services/session.ts`, `apps/api/src/server.ts`). If these still point at localhost/LAN, sign-in through the tunnel ends with a redirect back to the LAN URL. Fix when the user reports this:

1. Point both at the tunnel URL in `.env`:
   `WEB_ORIGIN=https://<random>.trycloudflare.com` and `API_PUBLIC_URL=https://<random>.trycloudflare.com`
   (use `sed -i ''` on `.env`; do not print the file's other contents).
2. The API reads env only at process start (`make run` sources `.env`), so ask the user to restart `make run` — do not kill their terminal's process tree yourself.
3. Remind the user: if the tunnel restarts with a new URL, both vars must be updated again and the API restarted.
