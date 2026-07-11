# Explainable Usage Reports

## ADDED Requirements

### Requirement: Non-overlapping token composition

The report SHALL render token composition as a segmented bar whose categories do not double count cached input.

#### Scenario: Cached input is part of input

- **WHEN** input is 100, cached input is 60, output is 20, and reasoning is 10
- **THEN** the segments SHALL represent 40 non-cached input, 60 cached input, 20 output, and 10 reasoning
- **AND** the accessible explanation SHALL state that cached input is included in input

### Requirement: Contextual explanations

Each major report block SHALL provide an accessible bilingual explanation of definition, calculation, interpretation, and local-observation limitation.

#### Scenario: User opens contextual help

- **WHEN** the user hovers, focuses, or activates a report help control
- **THEN** an explanation SHALL be available without changing the surrounding layout
- **AND** the control SHALL remain a true circle in normal and narrow layouts

### Requirement: Readable evidence

Capacity and model evidence SHALL use localized labels and compact values instead of raw ranges and unexplained abbreviations.

#### Scenario: Capacity samples exist

- **WHEN** a capacity estimate has samples
- **THEN** the report SHALL show representative value, observed range, sample count, and confidence
- **AND** it SHALL label the estimate as local and non-official
