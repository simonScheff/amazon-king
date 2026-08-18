---
title: Self-hosting in Production
description: Deploy amazon-king on your own Docker host — requirements, secrets, HTTPS proxying, startup, read-only validation, and safe updates.
---

# Self-hosting in Production

This guide deploys the single-owner alpha on one Docker host using the
included production Compose stack: PostgreSQL, a migration runner, the API,
the worker, and a web service serving the built dashboard. It does not turn
the application into a multi-tenant service, and it does not provide Amazon
Ads API approval.

## Safety and responsibility

You — the operator — control the database, OAuth credentials, encryption
keys, SMTP account, backups, retention, and ad spend. The current release has
not completed the live validation gates in the product plan: **keep
`KILL_SWITCH=true`** until the full live-write checklist has been performed
against an Amazon test environment or a dedicated low-risk campaign.

Each deployment needs its own approved Login with Amazon application and
Amazon Ads API access. Never copy the maintainer's or another operator's
credentials — see [Connecting Amazon Ads](/guide/connecting-amazon).

## Requirements

- A Linux host with current Docker Engine and Docker Compose
- A domain name pointing to the host
- An HTTPS reverse proxy (Caddy, nginx, or a managed load balancer)
- An SMTP account or trusted SMTP relay
- Amazon Ads API approval and a Login with Amazon application
- Encrypted off-host backups

The Docker host should not expose PostgreSQL or the API container directly.
The provided web service binds to `127.0.0.1:8080` by default; override with
`APP_BIND_ADDRESS` / `APP_PORT` only if you know why.

## Configure

Create the gitignored production configuration:

```sh
make prod-config
```

Generate independent secrets — use a URL-safe password for PostgreSQL because
it is embedded in a connection URL:

```sh
openssl rand -hex 24     # POSTGRES_PASSWORD
openssl rand -base64 48  # SESSION_SECRET
openssl rand -hex 32     # TOKEN_ENCRYPTION_KEY
```

Set those three values in `.env.production`, replace every remaining
`change-me` value, and set:

- `OWNER_EMAIL` — the only address allowed to sign in
- `WEB_ORIGIN` and `API_PUBLIC_URL` — the public HTTPS origin
- `AMAZON_REDIRECT_URI` — `<origin>/api/integrations/amazon/callback`,
  registered **exactly** in the Login with Amazon app
- `LWA_CLIENT_ID` / `LWA_CLIENT_SECRET` — this deployment's own LWA app
- working SMTP settings with a verified sender address — port 465 with
  `SMTP_SECURE=true` for implicit TLS, or the provider's STARTTLS port
  (commonly 587) with `SMTP_SECURE=false`

Boot-time validation refuses to start on a bad production config; the rules
are in [Configuration](/guide/configuration#production-only-requirements) and
every variable is listed in the
[environment variable reference](/reference/environment-variables).

## HTTPS proxy

Terminate HTTPS in a host reverse proxy and forward to `127.0.0.1:8080`. A
minimal Caddy site:

```text
ads.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

The public origin must use HTTPS: production sessions use `Secure` cookies
and will not work correctly over plain HTTP. Set `TRUST_PROXY=true` so the
API sees real client IPs through your proxy.

## Start and inspect

```sh
make prod-up
make prod-logs
```

The migration container must complete before the API and worker start. Then:

1. Check `https://<your-origin>/api/health`.
2. Request a sign-in link for `OWNER_EMAIL` — and verify that other
   addresses receive no link.

Keep the host firewall closed except SSH and the HTTPS reverse proxy. Do not
expose ports 3000 or 5432.

## Validate read-only operation

Before enabling any write capability, work through this checklist:

1. Confirm `KILL_SWITCH=true` in both the API and worker containers.
2. Connect the Amazon account and enable only the intended profile.
3. Complete profile discovery, structure sync, and metrics sync.
4. Reconcile dashboard totals against the Amazon Ads console.
5. Confirm that missing KDP economics suppress profit recommendations.
6. Exercise your backup and restore procedures on an isolated host.
7. Review logs for accidentally leaked tokens, codes, or report URLs.

Do not set `KILL_SWITCH=false` merely to explore the interface. When you are
ready to test writes, follow the live validation sequence: a test account or
dedicated low-risk campaign, one profile, one explicitly approved small
change.

## Install on a phone

On phones the app is install-only: the production build is an installable PWA,
and a phone browser tab shows install instructions instead of the dashboard.
Sign in first in the phone browser, then install when the gate appears — on
iOS an installed web app gets its own cookie storage, copied from Safari at the
moment you add it to the home screen, so installing while signed in is what
carries your session across.

Installing means the browser menu's **Install app** action on Android
Chromium-based browsers, or **Share → Add to Home Screen** in iOS Safari. The
installed app launches in standalone mode, without the browser's address and
navigation bars. If you previously added the site as a plain home-screen
shortcut, remove that shortcut and install again after deploying the
PWA-enabled build. The service worker is network-only — no Amazon data is
cached on the device.

Inside the installed app, sign-in links have to come back by hand. Tapping a
link in your mail app opens the browser, and on iOS the installed app cannot see
the session created there, so the sign-in screen and the "Confirm it's you"
dialog both accept a pasted link: press and hold the link in the email, choose
**Copy Link**, and paste it into the app. On Android the installed app shares
the browser's cookies, so tapping the link and reopening the app is enough.

Tablets and desktops are unaffected and keep normal browser access.

## Updating

Back up PostgreSQL and the report volume, review the release notes and
migrations, then fetch and rebuild:

```sh
git pull --ff-only
make prod-up
```

Do not track a moving branch automatically on a production advertiser
account. Pin and review releases once versioned releases are available.

## Next steps

Day-two work — backups, monitoring, incidents, and data deletion — is in the
[Operations runbook](/guide/operations).
