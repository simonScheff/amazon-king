---
name: update-website-screenshots
description: Refresh the documentation screenshots in website/public/screenshots with the current UI, using a seeded demo dataset with fictional books and generated covers. Use when the dashboard UI changes, when screenshots look stale, or when docs need images of a screen.
whenToUse: When updating or adding images under website/public/screenshots, or when a UI change makes the docs screenshots out of date
---

Screenshots on the public docs site must show the **current UI** with **mock
data** — never the owner's real books, campaigns, or Amazon covers. The mock
dataset lives in a scratch database so the developer's real local data is
untouched.

The seven committed screenshots are 2880×1800 PNGs (1440×900 viewport at
deviceScaleFactor 2) in `website/public/screenshots/`:

| File                    | Page (demo stack URL)                              | Show                                                              |
| ----------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| `login.png`             | `/login` **after** submitting the email            | the dev "Continue sign-in" link state                             |
| `overview.png`          | `/`                                                | KPI cards, daily charts, pending recommendations                  |
| `recommendations.png`   | `/recommendations`                                 | mixed states (pending/approved/applied/expired)                   |
| `recommendation-detail` | `/recommendations/5`                               | a bid-change finding: current-vs-proposed comparison and evidence |
| `campaign-detail.png`   | `/campaigns/490700000000091`                       | KPIs, profit chart, ad groups tab                                 |
| `change-center.png`     | `/changes`                                         | draft/previewed/failed/applied mix                                |
| `settings.png`          | `/settings?tab=books` with the first book expanded | book covers plus the per-country economics form                   |

## 1. Seed the scratch database

`scripts/seed-demo-data.ts` fills a dedicated scratch DB with a fictional KDP
author (Ellis Marlowe): 4 books with generated SVG covers
(`apps/web/public/demo-covers/`), 4 profiles (US/GB/DE/CA), 8 campaigns, 60
days of metrics at every grain, recommendations of every rule type and state,
and change sets in every status. It is deterministic and idempotent (full wipe

- reseed), and **refuses to run against any database not named
  `amazon_king_demo`** — do not bypass that check.

```bash
docker compose up -d db   # if Postgres is not already running
docker exec amazon-king-db psql -U postgres -c "CREATE DATABASE amazon_king_demo"
DATABASE_URL=postgres://postgres:postgres@localhost:5432/amazon_king_demo \
  pnpm exec tsx scripts/seed-demo-data.ts
```

## 2. Run the demo stack alongside the real one

Never point the demo stack at the real `amazon_king` database. Use a second
API and a second Vite dev server on their own ports:

```bash
set -a; . ./.env; set +a
DATABASE_URL=postgres://postgres:postgres@localhost:5432/amazon_king_demo \
  PORT=3100 OWNER_EMAIL=author@example.com \
  pnpm --filter @amazon-king/api dev

VITE_API_PROXY_TARGET=http://localhost:3100 \
  pnpm --filter @amazon-king/web exec vite --port 5174 --strictPort
```

`OWNER_EMAIL` must be overridden because the repo `.env` locks logins to the
owner's address; the seeded user is `author@example.com`. No worker is needed
— the data is static.

## 3. Sign in and capture

Browse `http://localhost:5174`. Sign in as `author@example.com`; the login
page renders the dev "Continue sign-in" link (no SMTP locally). Capture with
Playwright at 1440×900, `deviceScaleFactor: 2` (e.g. via CDP
`Emulation.setDeviceMetricsOverride`), `scale: "device"` PNGs, then move the
files into `website/public/screenshots/`.

Gotchas:

- **Re-seeding wipes sessions** — sign in again after every seed run.
- Cover URLs in `books.cover_json` must be **absolute** (the books contract
  validates them as URLs); the seed builds them from `DEMO_WEB_ORIGIN`
  (default `http://localhost:5174`). If you screenshot on a different port,
  set `DEMO_WEB_ORIGIN` when seeding.
- Screens that call the live Amazon gateway fail on demo data: the **Max CPC
  tab**, apply/rollback, and "Sync now" all 500. Do not screenshot those
  states; leave tabs that need the gateway closed.
- Expanding a **draft** change set transitions it to `previewed` (real product
  behavior). Re-seed to reset before capturing Change center.
- Wait ~1.5–2s after navigation for charts (Recharts) to render before each
  capture.

## 4. Finish

- Verify each PNG visually (mock data only — no real titles, ASINs, or
  Amazon-hosted cover URLs).
- `pnpm build` in `website/` — VitePress fails on dead links.
- Stop the :3100 API and :5174 Vite server. The scratch DB can stay seeded for
  next time; drop it with
  `docker exec amazon-king-db psql -U postgres -c "DROP DATABASE amazon_king_demo"`
  if you want it gone.
