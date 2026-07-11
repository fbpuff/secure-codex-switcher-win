## ADDED Requirements

### Requirement: Availability score is the strict primary key
The system SHALL always rank a higher unrounded availability score before a lower score.

#### Scenario: 99.2 points versus 95.4 points
- **WHEN** two eligible accounts score 99.2 and 95.4
- **THEN** the 99.2-point account ranks first regardless of reset timing

#### Scenario: Scores are exactly equal
- **WHEN** two eligible accounts have exactly equal raw scores
- **THEN** the limiting-window reset time is used as the first tie-breaker

### Requirement: Honest score precision
The UI SHALL display availability with one decimal place and SHALL not normalize a 99% upstream quota value to 100%.

#### Scenario: Quotas are 99% and 100%
- **WHEN** an account has 99% 5-hour remaining and 100% 7-day remaining
- **THEN** the score is displayed as 99.2 points rather than 100 points
