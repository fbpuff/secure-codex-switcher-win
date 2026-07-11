## ADDED Requirements

### Requirement: Dedicated weekly Reports view
The system SHALL provide a `Reports / 报告` navigation item between Usage and Settings and keep raw local usage separate from weekly analysis.

#### Scenario: User opens Reports
- **WHEN** the Reports navigation item is activated
- **THEN** the latest complete retained local week is shown with loading, empty, error, and privacy states as applicable

### Requirement: Weekly filtering and grouping
The weekly report SHALL support retained-week selection and filters for account, model, reasoning effort, and confidence.

#### Scenario: User filters a report
- **WHEN** one or more filters are selected
- **THEN** totals, rates, capacity observations, averages, medians, ranges, sample counts, and anomalies are recalculated from the matching local observations

### Requirement: Transparent weekly metrics
The weekly report SHALL show per-account and grouped local token composition, durations, token rate, quota rate, observed 5h/7d capacity, confidence, and unattributed usage.

#### Scenario: Multiple plans or incomplete samples exist
- **WHEN** observations differ by plan or confidence
- **THEN** the report keeps groups separate by default and does not hide unattributed or rejected samples inside a simple overall average

### Requirement: Local-only history and retention
The system SHALL store weekly observations and reports locally with bounded retention and deterministic regeneration.

#### Scenario: Retention limit is reached
- **WHEN** retained observation/report history exceeds the configured policy
- **THEN** the system prunes eligible old data without deleting encrypted accounts, Codex sessions, or current-week source observations
