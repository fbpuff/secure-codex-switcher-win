## ADDED Requirements

### Requirement: Reports render cached content before background refresh
The renderer SHALL retain successful reports by mode and selected date and SHALL display a matching cached report immediately when the Reports view opens.

#### Scenario: Cached report is still fresh
- **WHEN** the user enters Reports within the configured refresh interval
- **THEN** the cached report is displayed without starting a blocking refresh

#### Scenario: Cached report is stale
- **WHEN** the user enters Reports after the configured refresh interval
- **THEN** the cached report remains visible while a background refresh updates it

### Requirement: Report refresh state is visible
The renderer SHALL show the last successful report refresh time and SHALL distinguish background loading from an empty report.

#### Scenario: Background refresh is running
- **WHEN** a cached report is being refreshed
- **THEN** existing report rows remain visible and the report timestamp indicates updating
