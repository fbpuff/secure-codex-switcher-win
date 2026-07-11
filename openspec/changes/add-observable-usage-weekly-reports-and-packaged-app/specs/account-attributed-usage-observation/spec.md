## ADDED Requirements

### Requirement: Privacy-preserving account attribution
The system SHALL associate local token deltas with a saved account only during an unambiguous locally observed active-account interval.

#### Scenario: Switcher confirms an account switch
- **WHEN** the active account changes through a completed Switcher flow
- **THEN** the system closes the prior interval and opens a new interval using a redacted internal account reference

#### Scenario: Account evidence is ambiguous
- **WHEN** startup state, external login, overlapping evidence, or a timeline gap prevents reliable attribution
- **THEN** token deltas remain unattributed and are not assigned to the most recently known account

### Requirement: Model and reasoning-effort dimensions
The system SHALL use only explicit non-content rollout metadata to classify model and reasoning effort.

#### Scenario: Metadata is present
- **WHEN** a token event has reliable model and reasoning-effort context
- **THEN** its delta contributes to the corresponding account/model/reasoning group

#### Scenario: Metadata is absent
- **WHEN** model or reasoning effort cannot be established from approved fields
- **THEN** the missing dimension is stored and displayed as unknown without reading conversation text or inferring from later settings

### Requirement: Idempotent token deltas
The system SHALL convert cumulative rollout usage into non-negative deltas and avoid double counting during rescans, appends, truncation, or restart.

#### Scenario: Existing rollout receives new events
- **WHEN** a previously scanned file is appended
- **THEN** only newly observed deltas are added to aggregates

#### Scenario: Counter resets or file changes
- **WHEN** a cumulative counter decreases or a file is truncated/replaced
- **THEN** the system starts a bounded new baseline and does not create a negative or duplicated delta

### Requirement: Explicit usage rates
The system SHALL calculate and label token rate separately from quota percentage-point rate.

#### Scenario: Report shows rates
- **WHEN** attributable duration and valid quota snapshots exist
- **THEN** the report identifies the denominator and unit for each rate and never presents them as the same measure
