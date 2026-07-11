## ADDED Requirements

### Requirement: Intuitive primary metrics
The account table SHALL show attributed tokens, token composition, report share, unique sessions, average tokens per session, reset-aware 5h/7d quota change, and attribution confidence.

#### Scenario: Account has attributed token events
- **WHEN** an account has one or more attributed sessions
- **THEN** every primary metric is calculated without using idle wall-clock hours

### Requirement: Reset-aware quota change
Quota change SHALL sum only positive consumption deltas inside unchanged reset windows and SHALL report reset counts separately.

#### Scenario: Quota resets during the report
- **WHEN** snapshots span a reset event
- **THEN** pre-reset and post-reset positive consumption are summed separately and reset recovery is not counted as negative use

### Requirement: Secondary capacity evidence
Capacity SHALL appear outside the primary account table and SHALL include sample count, range, representative value, and confidence.

#### Scenario: Capacity samples exist
- **WHEN** valid same-window samples are available
- **THEN** the evidence section shows representative value, range, count, and confidence

### Requirement: Metric explanation
The account section SHALL provide an interactive explanation of every displayed metric and SHALL state that local attribution is not cross-device official billing.

#### Scenario: User opens metric help
- **WHEN** the explanation control is hovered or focused
- **THEN** definitions and the local-only limitation are visible
