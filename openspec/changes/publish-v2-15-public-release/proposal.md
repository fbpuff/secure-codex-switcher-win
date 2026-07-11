# Change: Publish v2.15.0 public release

## Why

The public repository is still on v2.3.2 and does not include the completed account switching, lifecycle protection, reporting, packaging, branding, and renderer performance work. The local development history also contains machine-specific path examples that must not be published.

## What Changes

- Update English and Chinese README files as matching public documentation.
- Replace machine-specific path examples with neutral placeholders or environment variables.
- Bump the product to v2.15.0 and produce release artifacts plus SHA-256 checksums.
- Build one sanitized public commit on top of the existing remote main branch instead of publishing private local development history.
- Publish source, tag, installer, blockmap, checksums, and bilingual release notes.

## Privacy Boundary

Credentials, account data, tokens, sessions, logs, observations, reports, caches, backups, local archives, generated unpacked applications, and local development history SHALL NOT be uploaded.

