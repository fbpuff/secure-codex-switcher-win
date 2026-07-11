## ADDED Requirements

### Requirement: Interactive detail score explanation
The account detail SHALL display a question-mark control next to the availability label and SHALL expose the explanation on hover and keyboard focus.

#### Scenario: User inspects the score
- **WHEN** the user hovers or focuses the question-mark control
- **THEN** the UI shows the formula, explains that the lower quota dominates, and states that the value is a local selection score rather than official quota

### Requirement: Single clear score row
The detail SHALL present one account-availability label and one one-decimal value without the internal phrase `Bottleneck-aware score`.

#### Scenario: Low availability account
- **WHEN** an account scores 13.6
- **THEN** the detail displays `Account availability 13.6 points` with the adjacent explanation control
