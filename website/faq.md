---
title: Frequently asked questions
description: Answers to common questions about amazon-king — Amazon affiliation, credentials, safety, automation, data storage, and cost.
---

# Frequently asked questions

## Is amazon-king affiliated with Amazon?

No. amazon-king is an independent open-source project and is not affiliated
with, endorsed by, or sponsored by Amazon. Amazon, Kindle Direct Publishing,
KDP, and Sponsored Products are trademarks of Amazon.com, Inc. or its
affiliates. The software talks to your own Amazon Ads account through the
official Amazon Ads API, using your own credentials.

## Do I need my own Amazon API credentials?

Yes. You apply for Amazon Ads API access yourself and create your own Login
with Amazon (LWA) application, then configure `LWA_CLIENT_ID`,
`LWA_CLIENT_SECRET`, and `AMAZON_REDIRECT_URI` in your deployment. Credentials
are never distributed with or shared through the repository. See
[Connecting Amazon Ads](/guide/connecting-amazon).

## Does it change my ads automatically?

No. amazon-king is an advisory system: it produces deterministic, evidence-
backed recommendations, and every change requires your explicit approval —
draft, preview against a fresh read of Amazon, then apply. Automation is a
later phase of the roadmap, gated on weeks of observed live results, and no
automation is enabled today.

## Is it safe to use today?

The project is alpha software, designed to fail safe:

- Writes are off by default — `KILL_SWITCH=true` ships enabled and every
  profile starts read-only.
- Reads and recommendations work fully in that state.

Keep the kill switch on until you have completed the live-validation steps in
the [operations runbook](/guide/operations), and never test writes against
important campaigns first — use a dedicated low-risk campaign.

## Which ad products are supported?

Sponsored Products only. Sponsored Brands, Sponsored Display, and the DSP are
out of scope.

## Can multiple users or a team share one deployment?

No. A deployment is single-owner: one workspace, one sign-in (optionally
locked to `OWNER_EMAIL`). There is no multi-tenancy, team roles, or billing —
and none is planned for the core product.

## What does self-hosting require?

A Docker host with HTTPS, a PostgreSQL database (the provided Compose files
include one), and an SMTP provider for sign-in emails. Full details,
including the production Compose file and reverse-proxy setup, are in
[Self-hosting in production](/guide/self-hosting).

## Where are my Amazon tokens stored?

In your own PostgreSQL database, envelope-encrypted with AES-256-GCM under
your `TOKEN_ENCRYPTION_KEY` (versioned, so keys can be rotated). Tokens are
decrypted only inside the backend/worker immediately before a refresh, which
is serialized per connection. The browser never receives the access token,
refresh token, or LWA client secret — all Amazon traffic goes through the
backend gateway. See the [security model](/architecture/security).

## What data leaves my server?

Only two kinds of outbound calls: requests to the Amazon Ads API (OAuth,
report downloads, approved writes) and sign-in emails through your SMTP
provider. There is no telemetry, analytics, or third-party data sharing.

## Can I export or delete my data?

There is no in-product export or deletion workflow in the alpha. Because
everything lives in your own PostgreSQL and report-storage volume, you export
or delete data at the infrastructure level (for example with `pg_dump` or by
removing rows/volumes). The [operations runbook](/guide/operations) covers
backup and data handling.

## Why do I see no profit numbers?

Profit recommendations and royalty estimates require your real KDP economics
(royalty per sale, target ACoS, optional bid/budget ceilings). Until you enter
them, profit fields are `null` and profit-based rules are suppressed — the
system never guesses your margins. Enter them under
[book economics](/guide/book-economics).

## What happens if Amazon is down or rejects items during apply?

Failures are handled per item: a batch success never implies item success.
Each action records its own result and error message, and the change set ends
as `failed` or `partially_applied`. Retrying a failed set is idempotent —
already-applied actions are not re-sent — and goes through the same guarded
path (fresh re-read of Amazon, before-state comparison, guardrails).

## How are bid changes bounded?

Three layers: each recommendation's proposed bid is clamped to ±15% per
cooldown period; guardrails re-check every action at apply time (clamp,
cooldowns, evidence staleness); and an optional per-campaign Max CPC ceiling
blocks any bid above it. Details are in
[optimization rules](/reference/optimization-rules).

## Does it cost anything?

The software is free and open source under the Apache License 2.0. You pay
only for your own infrastructure (a small VPS and database are enough) and
your usual Amazon ad spend.

## How do I report a security issue?

Privately, via the **Report a vulnerability** button on the repository's
Security tab (GitHub private security advisory) — never as a public issue
containing credentials, tokens, report URLs, or exploit details. The full
policy and response targets are in `SECURITY.md` at the repository root.
