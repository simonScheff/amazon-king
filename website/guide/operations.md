---
title: Operations Runbook
description: Backups, monitoring, incident response, and data-deletion duties for operating a self-hosted amazon-king instance.
---

# Operations Runbook

amazon-king stores application state in PostgreSQL and compressed Amazon
report artifacts in the `report-data` Docker volume. Both may contain
sensitive advertiser data, and both are the operator's responsibility.

## Backups

Create encrypted, off-host PostgreSQL backups on a schedule, and test
restoration into an isolated, disposable environment. A logical backup:

```sh
docker compose --env-file .env.production -f compose.production.yml \
  exec -T db pg_dump -U amazon_king -d amazon_king -Fc > amazon-king.dump
```

Protect the resulting file immediately — it contains application and
advertiser data.

Back up the `report-data` volume with a tool that preserves ownership and
encrypts data before it leaves the host.

::: danger
A database backup without the token encryption keys cannot recover Amazon
connections. Back the keys up **separately** in a secret manager — never
beside the database backups, or one theft defeats both layers.
:::

The repository does not yet automate point-in-time recovery or raw-report
retention. Configure these controls in your own infrastructure and document
your chosen retention periods before production use.

## Monitoring

At minimum, alert on:

- API or worker restarts
- Amazon connection refresh failures (`reconnect_required` transitions)
- dead queue jobs
- stale syncs (a profile whose last complete metrics sync is aging out)
- report reconciliation failures
- write verification failures
- PostgreSQL capacity
- filesystem capacity
- backup failures

Logs must remain access-controlled and must never contain OAuth credentials
or presigned report URLs — see [Log redaction](#log-redaction) below.

## Suspected credential or data exposure

If you suspect the LWA client secret, a token, the session secret, an
encryption key, or advertiser data has leaked:

1. Set `KILL_SWITCH=true` and restart the API and worker.
2. Revoke or rotate the affected LWA client credentials and the Amazon
   connection.
3. Rotate `SESSION_SECRET`; invalidate active rows in the `sessions` table.
4. Rotate the token encryption keys, retaining old versions until all stored
   ciphertext has been re-encrypted or the Amazon connections are revoked
   (see [key rotation](/guide/configuration#token-encryption-key)).
5. Restrict network access and preserve the relevant audit and
   infrastructure logs.
6. Determine which advertiser data was affected and follow applicable Amazon
   and legal notification requirements.
7. Patch and verify in an isolated environment before restoring access.

Report software vulnerabilities privately according to `SECURITY.md` in the
repository. Never include a live secret or advertiser dataset in the report.

## Data export and deletion

The alpha does not provide an in-product workspace export or a full deletion
workflow. Disconnecting Amazon revokes the application's access and destroys
the stored refresh token, but **imported metrics and audit records remain in
PostgreSQL**. Until a tested application workflow exists, fulfill deletion
requests at the infrastructure/database layer.

This limitation must be disclosed in your privacy notice if you operate the
instance for anyone's data but your own.

## Log redaction

Logs are structured and redacted by the platform, but the rule bears
repeating for anything you add yourself: never log

- authorization headers or Amazon access/refresh tokens,
- OAuth authorization codes or state values,
- client secrets or session secrets,
- presigned report download URLs.

Amazon auth errors are sanitized before logging; keep it that way in any
custom tooling, and scrub logs before attaching them to issues or reports.

## Updating cadence

Follow the update procedure in [Self-hosting](/guide/self-hosting#updating):
back up first, review release notes and migrations, `git pull --ff-only`,
`make prod-up`. Pin and review versioned releases once they are available
rather than tracking a moving branch on a production advertiser account.
