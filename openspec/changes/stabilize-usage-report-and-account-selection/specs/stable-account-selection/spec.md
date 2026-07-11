## ADDED Requirements

### Requirement: Immediate account selection and recovery are distinct
The system SHALL exclude accounts with an exhausted known quota window from immediate selection and SHALL use the nearest future reset only when no immediately usable account exists.

#### Scenario: An immediately usable account exists
- **WHEN** at least one ready fresh account has both known windows remaining
- **THEN** the system selects among immediately usable accounts by remaining-quota availability

#### Scenario: Every candidate is exhausted
- **WHEN** every ready fresh candidate has an exhausted known window
- **THEN** the system selects the candidate with the nearest future reset as a recovery fallback

### Requirement: Refresh preserves reading context
The renderer SHALL preserve the selected account and account/detail scroll offsets when usage refresh rebuilds account content.

#### Scenario: Background refresh while reading an account
- **WHEN** usage refresh completes while the user is reading a selected account
- **THEN** the same account remains selected and the visible scroll position is restored
