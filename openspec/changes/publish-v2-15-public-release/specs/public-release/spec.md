## ADDED Requirements

### Requirement: Public release is privacy-sanitized

The public source tree and release assets SHALL exclude machine-specific personal paths, credentials, account records, sessions, logs, reports, caches, backups, and local development-only history.

#### Scenario: Version 2.15.0 is published

- **WHEN** the source commit and release assets are uploaded to GitHub
- **THEN** automated and manual privacy checks report no private runtime files or personal identifiers

### Requirement: Public documentation is bilingual

The release SHALL provide English and Chinese README files with equivalent installation, safety, switching, reporting, privacy, and troubleshooting guidance.

#### Scenario: A user opens either README

- **WHEN** the English or Chinese documentation is viewed
- **THEN** it describes the same v2.15.0 behavior and links to the other language
