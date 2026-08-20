---
title: Connecting Amazon Ads
description: How to get Amazon Ads API access, create a Login with Amazon app, and connect it to your self-hosted amazon-king instance.
---

# Connecting Amazon Ads

amazon-king never ships with Amazon credentials. Every self-hoster connects
their own Amazon Ads account through their own Login with Amazon (LWA)
application. This page walks through the whole path: API access, the LWA app,
the connect flow, and what happens to your tokens afterwards.

## Getting Amazon Ads API access

You must apply for Amazon Ads API access for your own advertiser account;
approval is per developer and cannot be shared through this repository or
between unrelated self-hosters.

Amazon distinguishes two kinds of API consumers:

- **Direct advertisers** use the API for their own advertising account. This
  is the category a self-hosted single-owner amazon-king deployment falls
  into.
- **Partners** operate software on behalf of other advertisers. Running a
  centrally hosted service for other users requires the appropriate Amazon
  Partner registration and is outside what amazon-king provides.

Apply at [Amazon Ads API access](https://advertising.amazon.com/about-api) and
review the
[Amazon Ads Partner Network policies](https://advertising.amazon.com/resources/ad-policy/partner-network-policies)
if you are unsure which category you are in.

## Creating the Login with Amazon app

Once your API access is approved, create a Login with Amazon application in
the Amazon developer console and note its client ID and client secret. Three
things must line up exactly:

- **Authorization endpoint.** amazon-king sends the browser to
  `https://www.amazon.com/ap/oa` to start consent. You do not configure this;
  it is built into the OAuth client.
- **Scope.** The consent request asks for
  `advertising::campaign_management` — the scope that covers Sponsored
  Products structure, reporting, and campaign management.
- **Redirect URI.** Register exactly the value of your `AMAZON_REDIRECT_URI`
  environment variable in the LWA app's allowed return URLs. It must end in
  `/api/integrations/amazon/callback`, for example
  `https://ads.example.com/api/integrations/amazon/callback` in production or
  `http://localhost:3000/api/integrations/amazon/callback` in development. A
  mismatch — even a trailing slash or a different host — makes Amazon reject
  the callback.

Put the client ID and secret in `LWA_CLIENT_ID` and `LWA_CLIENT_SECRET` (see
[Configuration](/guide/configuration) and the
[environment variable reference](/reference/environment-variables)).

## The connect flow

With credentials configured, connecting is a UI flow:

1. Sign in to the dashboard and open `/connect`.
2. Click **Connect Amazon Ads**. The API creates a one-time OAuth state and
   returns the Amazon consent URL; the browser navigates to Amazon.
3. Approve the consent screen on Amazon.
4. Amazon redirects back to
   `AMAZON_REDIRECT_URI` with a code. The API validates the state, exchanges
   the code server-side, encrypts and stores the refresh token, and runs an
   initial profile discovery.
5. The browser lands on `/connect?connected=1` on success, or
   `/connect?error=<code>` on failure.

The browser only ever sees the consent URL and these redirects. The
authorization code, access token, refresh token, and LWA client secret stay
server-side; the app session never contains an Amazon token.

### Callback error codes

| Code | Meaning |
| --- | --- |
| `invalid_callback` | The callback arrived without a `state` or `code` parameter. |
| `invalid_state` | The state is unknown, expired (10-minute TTL), or already used. Retry the connect flow. |
| `session_required` | The state was valid but you were not signed in. Sign in and start again. |
| `foreign_state` | The state was issued to a different signed-in user. Refused. |
| `exchange_failed` | Amazon rejected the code exchange (bad client credentials, redirect mismatch, expired code). Check `LWA_CLIENT_ID`, `LWA_CLIENT_SECRET`, and `AMAZON_REDIRECT_URI`. |
| `profile_discovery_failed` | The token was stored but listing profiles failed. Check the API logs, then disconnect and reconnect. |

## Profiles and discovery

One Amazon account can contain many **profiles** (roughly one per marketplace
or account type). Profiles are mirrored into the database twice:

- once inline during the OAuth callback, so `/connect` shows them
  immediately, and
- daily by the worker's `profile_discovery` job, which picks up profiles
  added to your Amazon account later.

**New profiles start disabled.** Nothing syncs until you opt in per profile.

## Enabling a profile: sync vs. write access

Open **Settings → Profiles & sync**. Each discovered profile has
two independent toggles:

- **Read (sync)** — the `enabled` flag. When on, the worker syncs structure
  and metrics for this profile on schedule (and on demand via **Sync now**).
- **Writes** — the `writeEnabled` flag. When on, approved change sets for
  this profile may be applied to Amazon. Profiles are read-only by default,
  and writes additionally require the global `KILL_SWITCH=false`; see
  [Applying & rolling back changes](/guide/applying-changes).

Keep profiles read-only until you have completed the
[read-only validation checklist](/guide/self-hosting#validate-read-only-operation).

## Disconnecting

**Disconnect** on `/connect` (behind a confirmation dialog):

- destroys the stored refresh-token ciphertext, so the app can no longer call
  Amazon for this account,
- invalidates any cached access token, and
- dead-letters pending queue jobs for the connection's profiles.

Disconnecting is idempotent and you can reconnect at any time — reconnecting
runs the same OAuth flow and stores a fresh grant. Imported metrics and audit
records are kept; see [Operations](/guide/operations#data-export-and-deletion)
for what that means for data deletion. To also revoke the grant on Amazon's
side, remove the application in your Amazon account's app permissions.

## The `reconnect_required` state

Token refresh is serialized per connection through a circuit breaker. If
Amazon answers a refresh with `invalid_grant` — the grant was revoked,
expired, or superseded — the token manager stops retrying, marks the
connection `reconnect_required`, and dead-letters its pending sync jobs.
`/connect` shows the status and the last error code.

Recovery is a normal reconnect: click **Connect Amazon Ads** again and approve
the consent screen. The new grant replaces the dead one and scheduled syncs
resume on the next tick.

## Security properties

- **OAuth state** is a 256-bit random token. Only its SHA-256 hash is stored,
  tied to the signed-in user, with a 10-minute TTL. The state is marked used
  *before* the code exchange, so a replayed callback can never exchange twice.
- **Refresh tokens** are stored only envelope-encrypted (AES-256-GCM) in the
  `amazon_connections` table, with the key version embedded in the ciphertext
  so keys can be rotated. They are decrypted in the backend/worker only,
  immediately before a refresh.
- Codes, tokens, and the client secret are never logged; Amazon auth errors
  are sanitized before they reach the log.

For the full model see [Security](/architecture/security).
