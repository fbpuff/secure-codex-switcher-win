## ADDED Requirements

### Requirement: Discoverable score explanation
The summary SHALL place a compact help button beside the best-score label and associate it with an explanatory popover without resizing the summary metric.

#### Scenario: Pointer user seeks an explanation
- **WHEN** the user hovers over the help control
- **THEN** the score explanation becomes visible without moving neighboring summary content

#### Scenario: Keyboard user seeks an explanation
- **WHEN** the help control receives keyboard focus
- **THEN** the same explanation becomes visible and the button exposes its popover relationship to assistive technology

### Requirement: Persistent and dismissible interaction
The score explanation SHALL support click or touch pinning and predictable dismissal.

#### Scenario: User pins the explanation
- **WHEN** the user activates the help button
- **THEN** the popover remains visible after hover or focus leaves and the button reports its expanded state

#### Scenario: User dismisses the explanation
- **WHEN** the user activates the button again, presses Escape, or activates outside the score-help region
- **THEN** the pinned state closes and focus behavior remains usable

### Requirement: Exact bilingual calculation content
The popover SHALL present localized fixed formula text and explain reset proximity, missing-component weight redistribution, and automatic-target ineligibility.

#### Scenario: Interface language changes
- **WHEN** the user switches between Chinese and English
- **THEN** the help button label, formula, explanatory rules, and dynamic field labels use the selected language

### Requirement: Dynamic winning-account breakdown
The popover SHALL use the shared ranking breakdown to display the current winning account, rounded total score, and all four score components.

#### Scenario: Best account has complete usage data
- **WHEN** the summary renders an eligible best account with all four components
- **THEN** the popover shows its masked identity, total score, 5-hour remaining, 7-day remaining, 5-hour reset score, and 7-day reset score

#### Scenario: No winning account or component is available
- **WHEN** no account or one score component is unavailable
- **THEN** the corresponding localized value is shown as unknown without fabricating a zero
