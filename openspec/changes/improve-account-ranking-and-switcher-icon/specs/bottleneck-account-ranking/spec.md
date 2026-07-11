## ADDED Requirements

### Requirement: Bottleneck-aware availability score
The system SHALL calculate the displayed account score as 60% of the lower remaining quota, 20% of 5-hour remaining quota, and 20% of 7-day remaining quota.

#### Scenario: Both windows are full
- **WHEN** 5-hour and 7-day remaining quota are both 100%
- **THEN** the displayed availability score is 100 points

#### Scenario: One window is constrained
- **WHEN** one remaining quota is substantially lower than the other
- **THEN** the lower value dominates the score through the 60% bottleneck component

#### Scenario: One window is unavailable
- **WHEN** exactly one remaining quota value is known
- **THEN** the known remaining value is used as the availability score

### Requirement: Close-score reset ordering
The system SHALL use reset timing only when two availability scores differ by no more than 5 points.

#### Scenario: Scores are clearly different
- **WHEN** availability scores differ by more than 5 points
- **THEN** the account with the higher availability score ranks first regardless of reset timing

#### Scenario: Scores are close
- **WHEN** availability scores differ by no more than 5 points
- **THEN** the account whose limiting quota window resets sooner ranks first

### Requirement: Honest score presentation
The system SHALL label the calculated value as points rather than an official quota percentage and SHALL explain the bottleneck formula and close-score reset rule.

#### Scenario: User opens score help
- **WHEN** the user hovers, focuses, or pins the score help control
- **THEN** the UI shows the formula, the 5-point reset rule, both remaining values, and both reset times
