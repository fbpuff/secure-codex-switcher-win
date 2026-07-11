# Compact Account Report

## ADDED Requirements

### Requirement: Normal-width fit

The account report SHALL present six semantic information groups without a horizontal scrollbar at the supported normal desktop width.

#### Scenario: Account report has multiple accounts

- **WHEN** the report renders at normal desktop width
- **THEN** account, attributed tokens, composition, usage overview, quota status, and confidence SHALL remain visible together
- **AND** the report table SHALL NOT require horizontal scrolling

### Requirement: Readable quota status

Quota status SHALL use localized terms instead of unexplained abbreviations.

#### Scenario: Quota consumption and resets exist

- **WHEN** a 5h or 7d window has consumed points and reset events
- **THEN** the row SHALL label consumed percentage points and reset count in readable language
- **AND** contextual help SHALL explain the difference between percentage points, percentages, detected resets, and expected reset time

### Requirement: Narrow account layout

The report SHALL use a coherent two-row account layout on narrow viewports.

#### Scenario: Viewport is narrow

- **WHEN** six groups cannot fit on one row
- **THEN** each account SHALL wrap into two stable rows
- **AND** values SHALL remain associated with their labels without overlap
