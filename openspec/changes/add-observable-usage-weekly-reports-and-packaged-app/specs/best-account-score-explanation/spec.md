## MODIFIED Requirements

### Requirement: Discoverable score explanation
The summary SHALL place a compact help button beside the best-score label, associate it with an explanatory popover, and position the popover within the visible viewport without resizing the summary metric.

#### Scenario: Pointer or keyboard user seeks an explanation
- **WHEN** the user hovers over or focuses the help control
- **THEN** the score explanation becomes visible without moving neighboring summary content or crossing the viewport boundary

#### Scenario: Window or pane is narrow
- **WHEN** available horizontal space is smaller than the preferred popover width
- **THEN** the popover clamps to the viewport gutter, adapts its width, and uses a single-column breakdown when necessary so the formula and all four values remain visible

#### Scenario: User pins or dismisses the explanation
- **WHEN** the user activates the button, activates it again, presses Escape, or activates outside the score-help region
- **THEN** the existing pinned and dismissal behavior remains accessible and the button reports the correct expanded state
