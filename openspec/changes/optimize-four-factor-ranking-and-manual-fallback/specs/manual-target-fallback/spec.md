## ADDED Requirements

### Requirement: Safe manual-target fallback
The system SHALL use the configured manual target first when it is usable and locally readable, and SHALL fall back to the highest-ranked other usable account when the manual target fails preflight validation.

#### Scenario: Manual target usage is unavailable
- **WHEN** the manual target is missing, not ready, stale, exhausted, or reset-expired
- **THEN** the system selects the highest-ranked eligible fallback for the current switch event

#### Scenario: Manual target encrypted record is unreadable
- **WHEN** the manual target cannot be decrypted before switching starts
- **THEN** the system excludes it and selects the highest-ranked readable fallback

#### Scenario: No fallback is usable
- **WHEN** the manual target fails preflight and no other usable readable account exists
- **THEN** the system reports target unavailable and does not change the active auth file

### Requirement: Preserve manual preference and explain fallback
The system SHALL preserve the configured manual target after a per-event fallback and SHALL expose a redacted reason and chosen fallback in diagnostics and UI status.

#### Scenario: Fallback succeeds
- **WHEN** an auto-switch queues or switches to a fallback account
- **THEN** the manual target setting remains unchanged and the result identifies that fallback occurred without exposing auth data
