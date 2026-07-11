# Reset History Clarity

## ADDED Requirements

### Requirement: Reset-cycle identity

The system SHALL represent one reset confirmation per account, quota window, and prior reset cycle while preserving resets belonging to different accounts.

#### Scenario: Same reset cycle is confirmed twice

- **WHEN** two observations confirm recovery for the same account, quota window, and prior reset boundary
- **THEN** reset history SHALL contain one event

#### Scenario: Two accounts reset together

- **WHEN** two accounts recover in the same minute
- **THEN** reset history SHALL retain one labelled event for each account

### Requirement: Reset timing semantics

The report SHALL distinguish expected next reset time from local detection time.

#### Scenario: A current quota snapshot has a reset boundary

- **WHEN** the report is generated
- **THEN** the account SHALL expose that boundary as an expected reset time
- **AND** reset history SHALL label event time as the time the recovery was detected locally
