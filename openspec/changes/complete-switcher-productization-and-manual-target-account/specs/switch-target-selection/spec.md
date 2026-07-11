## ADDED Requirements

### Requirement: Auto-switch target mode
The system SHALL support an auto-switch target mode with two values: best-score mode and manual-target mode. Best-score mode SHALL remain the default for existing and new settings.

#### Scenario: Default mode uses best score
- **WHEN** settings do not contain an auto-switch target mode
- **THEN** the system treats the mode as best-score mode

#### Scenario: Manual mode stores selected target
- **WHEN** the user selects an imported account as the next auto-switch target
- **THEN** the system stores manual-target mode and the selected account id locally

### Requirement: Manual target selection behavior
When manual-target mode is active, the system SHALL attempt to use the selected account as the auto-switch target if that account exists, is not current, is ready, has fresh usable usage, and has remaining quota.

#### Scenario: Selected target is usable
- **WHEN** the current account is exhausted and the selected manual target is usable
- **THEN** the system queues or executes switching to the selected target

#### Scenario: Selected target is unavailable
- **WHEN** the current account is exhausted and the selected manual target is missing, current, stale, exhausted, or not ready
- **THEN** the system does not silently switch to a different account and reports why the selected target is unavailable

### Requirement: Best-score fallback behavior
When best-score mode is active or no manual target is selected, the system SHALL choose the highest-scored usable non-current account using the existing score formula.

#### Scenario: No manual target selected
- **WHEN** the current account is exhausted and no manual target is configured
- **THEN** the system chooses the highest-scored usable non-current account

#### Scenario: Manual mode is cleared
- **WHEN** the user clears manual-target mode
- **THEN** the system returns to best-score target selection

### Requirement: Account list ordering
The account list SHALL display the current account first, the configured manual target second when manual-target mode has a valid non-current target, and all remaining accounts ordered by score.

#### Scenario: Manual target is configured
- **WHEN** accounts are listed and a non-current manual target exists
- **THEN** the current account appears first and the manual target appears second

#### Scenario: Best-score mode is active
- **WHEN** accounts are listed in best-score mode
- **THEN** the current account appears first and the remaining accounts are ordered by score
