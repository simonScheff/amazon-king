# Security policy

amazon-king processes advertising data and encrypted OAuth credentials. Please
report suspected vulnerabilities privately and do not test against systems or
Amazon accounts you do not own.

## Reporting a vulnerability

Use GitHub's **Report a vulnerability** button on the repository Security page
to open a private security advisory. Include affected versions, reproduction
steps, impact, and a proposed mitigation when available.

Do not open a public issue containing credentials, tokens, presigned report
URLs, advertiser data, or exploit details. If private vulnerability reporting
is unavailable, open a public issue containing no sensitive detail and ask the
maintainers to establish a private channel.

Maintainers will acknowledge complete reports within seven days, provide a
status update within fourteen days, and coordinate disclosure after a fix is
available. These are response targets, not a commercial support guarantee.

## Supported versions

The project is pre-1.0 alpha software. Security fixes are made on the `main`
branch until versioned releases begin. No release is currently approved for
unattended Amazon Ads writes.

## If credentials may have leaked

Immediately enable `KILL_SWITCH`, revoke or rotate the affected Login with
Amazon credentials and refresh tokens, rotate `SESSION_SECRET` and token
encryption keys, invalidate active application sessions, and inspect audit and
access logs. Do not paste the leaked value into an issue.
