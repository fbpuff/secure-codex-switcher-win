## ADDED Requirements

### Requirement: Quota snapshot provenance and freshness
The system SHALL identify 5-hour and 7-day values as server quota snapshots and display their last successful fetch time, age, reset time, and refresh state.

#### Scenario: Snapshot is current
- **WHEN** a quota refresh succeeds for an account
- **THEN** the account detail shows the new values and successful fetch time without claiming continuous real-time synchronization

#### Scenario: Snapshot is stale or refresh failed
- **WHEN** the freshness threshold is exceeded or the latest refresh fails
- **THEN** the UI marks the snapshot stale or failed and retains the last successful timestamp separately from the failed attempt

### Requirement: Quota mismatch diagnostics
The system SHALL explain known reasons Switcher values can differ from ChatGPT Codex without exposing credentials or raw upstream responses.

#### Scenario: User inspects a difference
- **WHEN** the visible snapshot may be affected by age, account mismatch, refresh failure, reset boundary, rounding, or missing fields
- **THEN** the UI presents the applicable redacted diagnostic and a refresh action where safe

### Requirement: Observed capacity is not an official limit
The system SHALL label every 5-hour or 7-day token-capacity result as a local observed estimate with sample count, range, and confidence.

#### Scenario: Valid observations exist
- **WHEN** valid same-account and same-window quota/token samples are available
- **THEN** the system shows an observed range and aggregate statistics rather than an official-looking fixed token limit

#### Scenario: Evidence is insufficient
- **WHEN** samples cross resets, have rounding-only deltas, contain attribution gaps, or indicate external use
- **THEN** the system rejects or lowers confidence for those samples and explains why

### Requirement: Reset detection preserves evidence boundaries
The system SHALL detect scheduled and observed-unscheduled quota recoveries, close the prior observation window, and prevent reset-spanning capacity calculations.

#### Scenario: Scheduled reset occurs
- **WHEN** used percentage decreases at or after the prior reset boundary for the same account
- **THEN** the system records a scheduled reset and starts a new observation window

#### Scenario: Quota recovers before the scheduled boundary
- **WHEN** consecutive same-account snapshots confirm a significant used-percentage decrease before the prior reset time
- **THEN** the system records an observed unscheduled reset with unknown cause and starts a new observation window

#### Scenario: Upstream explicitly identifies a reset card
- **WHEN** an approved upstream field explicitly identifies a reset-card event
- **THEN** the reset event may use the reset-card cause while retaining the original evidence field class

#### Scenario: Reset cause is not explicit
- **WHEN** quota recovery could result from a reset card, official adjustment, account mismatch, or corrected response
- **THEN** the system does not claim a reset-card cause and rejects ambiguous cross-boundary capacity samples
