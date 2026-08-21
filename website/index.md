---
layout: home
title: Amazon King — Self-hosted Amazon Ads optimizer for KDP authors
titleTemplate: false
description: Open-source, self-hosted control room that analyzes your Amazon Sponsored Products ads against real KDP book economics and applies changes only after your explicit approval.

hero:
  name: Amazon King
  text: Amazon Ads optimization for KDP authors
  tagline: Self-hosted, open source, and deterministic. It reads your Sponsored Products data, scores it against your real book economics, and touches your account only when you approve a change.
  image:
    src: /logo.svg
    alt: Amazon King logo
  actions:
    - theme: brand
      text: Get started
      link: /guide/installation
    - theme: alt
      text: What is Amazon King?
      link: /guide/what-is-amazon-king
    - theme: alt
      text: View on GitHub
      link: https://github.com/simonScheff/amazon-king

features:
  - icon: 📈
    title: Recommendations with evidence
    details: Nine deterministic, versioned rules score your campaigns over 7/14/30/60-day windows. Every recommendation shows its exact inputs, confidence, and expiry — no black box, no LLM spending decisions.
    link: /reference/optimization-rules
    linkText: See the rules
  - icon: 🛡️
    title: Guarded writes, human approval
    details: Nothing is written to Amazon without an explicit apply. Every change set is re-read against live Amazon state, re-checked against guardrails, verified after writing, and fully auditable.
    link: /guide/applying-changes
    linkText: How applying works
  - icon: 💰
    title: Real KDP economics
    details: ACoS alone hides whether ads make you money. Enter your royalty per sale and target ACoS per book and market to get true profit estimates — suppressed, never guessed, when economics are missing.
    link: /guide/book-economics
    linkText: Set up book economics
  - icon: 🏠
    title: Self-hosted and private
    details: Runs on your own infrastructure with your own Amazon API credentials. Refresh tokens are envelope-encrypted, the browser never sees an Amazon token, and there is no third-party analytics.
    link: /guide/self-hosting
    linkText: Deploy it yourself
  - icon: 🔁
    title: Idempotent data pipeline
    details: Reporting v3 imports are fingerprint-deduplicated, reconciliation-checked, and upserted transactionally. Re-running a sync converges to the same state — never duplicates facts.
    link: /architecture/data-pipeline
    linkText: Pipeline architecture
  - icon: 🧯
    title: Safe by default
    details: A global kill switch and per-profile read-only defaults ship enabled. Rollback is a compensating API action, bid changes are clamped, and stale evidence blocks writes automatically.
    link: /architecture/security
    linkText: Security model
---

<div class="ak-section">

## Up and running in two commands

Requirements: Node.js 20+, pnpm 10, Docker, and GNU Make.

```sh
git clone https://github.com/simonScheff/amazon-king.git
cd amazon-king
make setup   # installs dependencies, creates .env
make run     # PostgreSQL + migrations + API + worker + dashboard
```

The dashboard starts on `http://localhost:5173` — in development, your sign-in
link is printed straight to the API log.

</div>

<div class="ak-section">

## A control room, not an autopilot

<div class="ak-screenshot">

![Amazon King overview dashboard in the All markets view — KPI cards converted to one display currency, a daily performance trend chart, profitability, and top recommendations](/screenshots/overview.png)

</div>

<p class="ak-muted">
Amazon King is an advisory system. It imports your campaigns, finds what is
wasting or earning money, and prepares exact changes — you approve each one.
Automation is deliberately a later phase, gated on weeks of observed results.
</p>

</div>

<div class="ak-section">

## How it works

```mermaid
flowchart LR
    A[Amazon Ads API] -->|OAuth, read-only by default| B(Gateway)
    B --> C[Worker: sync pipeline]
    C -->|reconciled daily facts| D[(PostgreSQL)]
    E[Your KDP book economics] --> D
    D --> F[Optimizer: 9 deterministic rules]
    F --> G[Dashboard: review recommendations]
    G -->|approve| H[Guarded change set]
    H -->|preview, guardrails, apply, verify| B
```

<p class="ak-muted">
Every write flows back through the same gateway after fresh state checks and
guardrail re-validation — and every step is recorded in the audit log.
</p>

[Explore the architecture →](/architecture/overview)

</div>

<div class="ak-section">

## Where to go next

- **New here?** Start with [What is Amazon King?](/guide/what-is-amazon-king) and the [quickstart](/guide/quickstart).
- **Running it locally?** Follow [installation](/guide/installation), then [connect your Amazon Ads account](/guide/connecting-amazon).
- **Deploying?** Read [self-hosting in production](/guide/self-hosting) and the [operations runbook](/guide/operations).
- **Integrating?** The [HTTP API reference](/reference/api) documents every endpoint, and [API workflows](/examples/api-workflows) shows copy-pasteable examples.

::: warning Alpha software
Amazon King is pre-1.0. Its write path has not completed end-to-end validation
against real Amazon credentials. Keep `KILL_SWITCH=true` and profiles read-only
until you have completed the live validation checklist.
:::

</div>
