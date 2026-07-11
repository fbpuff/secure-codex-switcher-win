## ADDED Requirements

### Requirement: Daily and weekly report modes
The report view SHALL provide Daily and Weekly modes and SHALL default to Daily.

#### Scenario: Report view opens
- **WHEN** the user opens Reports
- **THEN** Daily mode is selected with the current local date

#### Scenario: User selects Weekly
- **WHEN** Weekly mode is selected
- **THEN** the existing week-start aggregation and labels are used

### Requirement: Local-day aggregation
Daily mode SHALL aggregate observations in the selected local calendar day using a start-inclusive, end-exclusive interval.

#### Scenario: Event occurs at local midnight boundary
- **WHEN** an event timestamp equals the selected day start
- **THEN** it is included, while an event at the next day start is excluded

### Requirement: Honest daily attribution and capacity
Daily mode SHALL retain ambiguous token events as unattributed and SHALL not estimate capacity without valid same-window evidence.

#### Scenario: Account interval is ambiguous
- **WHEN** a token event cannot be mapped to one account for the selected day
- **THEN** it contributes only to daily unattributed usage

#### Scenario: Daily capacity evidence is insufficient
- **WHEN** no valid quota-capacity sample exists inside the selected day
- **THEN** daily 5h/7d observed capacity is shown as unknown
