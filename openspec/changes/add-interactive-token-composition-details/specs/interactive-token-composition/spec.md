# Interactive Token Composition

## ADDED Requirements

### Requirement: Compact composition control

Account and model rows SHALL show a compact segmented composition control without permanent verbose token labels.

#### Scenario: Report row is collapsed

- **WHEN** the report renders token composition
- **THEN** the row SHALL show a compact non-overlapping segmented bar
- **AND** exact values SHALL remain hidden until the user previews or opens the details

### Requirement: Accessible donut details

The composition control SHALL expose a donut visualization and equivalent text through hover, focus, and activation.

#### Scenario: User opens composition details

- **WHEN** the user hovers, focuses, clicks, or keyboard-activates the composition control
- **THEN** the detail SHALL show non-cached input, cached input, output, and reasoning values and percentages
- **AND** it SHALL explain cached-input overlap and local-only data

#### Scenario: User dismisses details

- **WHEN** the user presses Escape, clicks outside, or opens another composition control
- **THEN** the previous pinned detail SHALL close

### Requirement: Viewport-safe details

Composition details SHALL remain within the visible viewport and SHALL NOT resize the table row.

#### Scenario: Narrow viewport

- **WHEN** a composition detail opens near a viewport edge
- **THEN** its fixed position SHALL be clamped inside the viewport
