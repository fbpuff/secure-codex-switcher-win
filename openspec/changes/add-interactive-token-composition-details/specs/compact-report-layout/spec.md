# Compact Report Layout

## ADDED Requirements

### Requirement: Semantic column alignment

Report headers and body cells SHALL use matching alignment based on data type.

#### Scenario: Account table renders

- **WHEN** label and numeric columns are visible
- **THEN** identity and explanatory columns SHALL align left
- **AND** numeric headers and values SHALL align right

### Requirement: Expandable model evidence

Model/reasoning rows SHALL keep capacity evidence collapsed until requested.

#### Scenario: User expands a model row

- **WHEN** the user activates a model disclosure
- **THEN** exact token composition and 5h/7d capacity evidence SHALL appear below that row
- **AND** expanding another model row SHALL collapse the previous row

### Requirement: Compact quota presentation

Quota consumption and expected reset information SHALL fit a bounded two-line presentation without forcing page-level overflow.

#### Scenario: Both quota windows have data

- **WHEN** 5h and 7d values and expected reset times are present
- **THEN** each window SHALL occupy one readable line
