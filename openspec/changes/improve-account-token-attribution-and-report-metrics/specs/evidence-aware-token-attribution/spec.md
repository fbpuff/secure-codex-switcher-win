## ADDED Requirements

### Requirement: Evidence-aware account attribution
The report SHALL classify directly timed account events as high confidence and SHALL use session continuity only when one session has exactly one directly evidenced account.

#### Scenario: Unambiguous session gap
- **WHEN** a token event lacks an active-account interval but its session has direct events for exactly one account
- **THEN** the event is attributed to that account with medium confidence

#### Scenario: Session crosses accounts
- **WHEN** a session has direct events for multiple accounts
- **THEN** events without direct interval evidence remain unattributed

### Requirement: Attribution coverage
The report SHALL expose attributed tokens, unattributed tokens, total local tokens, and coverage percentage for the selected period.

#### Scenario: Report contains attributed and unattributed events
- **WHEN** both evidence classes occur in the selected interval
- **THEN** coverage equals attributed tokens divided by all local tokens
