## ADDED Requirements

### Requirement: Four-factor composite score
The system SHALL calculate account rank from 5-hour remaining quota, 7-day remaining quota, 5-hour reset proximity, and 7-day reset proximity with weights 30%, 35%, 15%, and 20% respectively.

#### Scenario: All four components are available
- **WHEN** both usage windows contain remaining quota and future reset timestamps
- **THEN** the system returns the weighted sum of all four normalized components

#### Scenario: A component is unavailable
- **WHEN** one or more score components cannot be calculated
- **THEN** the system renormalizes the available component weights instead of treating missing data as zero

### Requirement: Ranking eligibility and stability
The system SHALL exclude accounts that are not ready, have stale usage, have an exhausted window, or have a known reset timestamp that has passed without refresh.

#### Scenario: Reset boundary has passed
- **WHEN** a usage window reset timestamp is at or before ranking time
- **THEN** the account is not selected until usage is refreshed

#### Scenario: Composite scores are equal
- **WHEN** two eligible accounts have the same composite score
- **THEN** the system prefers greater 7-day remaining quota, then greater 5-hour remaining quota, then nearer reset time, then stable creation order

### Requirement: Consistent account ordering
The account list SHALL keep the current account first, keep the configured non-current manual target second, and sort all remaining accounts using the shared composite comparator.

#### Scenario: Manual target is configured
- **WHEN** the account list is rendered
- **THEN** current and manual target placement remains fixed and every later account follows four-factor ranking order
