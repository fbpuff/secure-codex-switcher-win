## ADDED Requirements

### Requirement: Primary account report contains only comparison metrics
The primary account report SHALL contain account, attributed tokens, token composition, usage overview, and attribution confidence, and SHALL NOT contain observed quota-change totals or reset counts.

#### Scenario: Account report renders
- **WHEN** local report accounts are available
- **THEN** each account renders as one centered five-group row without quota-change evidence

### Requirement: Reset history remains independent by quota window
The system SHALL record reset events independently for 5h and 7d windows and SHALL require confirmation for early unscheduled recovery.

#### Scenario: Only the 5h boundary passes
- **WHEN** 5h usage materially recovers at its boundary and the 7d boundary has not passed
- **THEN** one 5h scheduled reset is recorded and no 7d reset is invented
