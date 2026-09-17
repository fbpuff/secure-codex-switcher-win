# Security Policy

## Supported versions

Security maintenance focuses on the latest published release. Older versions
are not guaranteed to receive security fixes.

## Reporting a vulnerability

Please report suspected security issues, especially those involving:

- Authentication data handling.
- DPAPI-protected credentials.
- Local account storage.
- Token or authentication information exposure.
- Unsafe account switching behavior.
- Unintended logging of sensitive information.

If GitHub Private Vulnerability Reporting is enabled for this repository, use
**Security > Advisories > Report a vulnerability** to submit a private report:
[Security Advisories](https://github.com/fbpuff/secure-codex-switcher-win/security/advisories).
This reporting option may not be available. If it is unavailable, open only a
minimal, non-sensitive issue asking for a private reporting channel, and wait
for one before sharing vulnerability details or exploit instructions.

Never post access tokens, `auth.json`, cookies, complete account identifiers,
or personal logs containing credentials in a public issue, pull request, or
comment. Do not upload real account stores or DPAPI blobs, even in a private
report. Read [PRIVACY.md](PRIVACY.md) before sharing diagnostics.

A report should include the affected application version, Windows version,
expected and observed behavior, and minimal reproduction steps using synthetic
data. Remove credentials and personal information from all examples. If a
credential has already been exposed, revoke or rotate it promptly; deleting a
post or file alone does not undo the exposure.
