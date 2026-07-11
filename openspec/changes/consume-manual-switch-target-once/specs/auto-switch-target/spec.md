## ADDED Requirements

### Requirement: Manual target is one-shot

The system SHALL use a manually selected target only for the next automatic switch attempt and SHALL return future target selection to best-score mode after that attempt is resolved.

#### Scenario: Manual target switches successfully

- **WHEN** an exhausted current account triggers an automatic switch to an available manual target
- **THEN** the system switches to that target and clears the manual target preference

#### Scenario: Manual target is queued

- **WHEN** activity protection queues the resolved manual target
- **THEN** the queued target remains fixed and the manual preference is cleared for future switches

#### Scenario: Manual target falls back

- **WHEN** the manual target is unavailable or unreadable and a scored fallback exists
- **THEN** the system uses the fallback for this attempt and clears the manual preference

#### Scenario: No usable target exists

- **WHEN** the manual target cannot be used and no fallback exists
- **THEN** the system reports no target and clears the manual preference

#### Scenario: Current account remains usable

- **WHEN** no automatic switch attempt is required
- **THEN** the system preserves the manual target for the next attempt

### Requirement: Compact help control

The account availability help control SHALL render as a small circle with its question mark centered on both axes.

#### Scenario: Help control is displayed

- **WHEN** the account availability row is rendered
- **THEN** its help control has equal width and height and centers the question mark
