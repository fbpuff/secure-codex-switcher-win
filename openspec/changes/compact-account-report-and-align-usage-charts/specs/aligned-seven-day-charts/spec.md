# Aligned Seven-Day Charts

## ADDED Requirements

### Requirement: Shared row geometry

The daily-token and cache-hit panels SHALL use the same seven-row geometry.

#### Scenario: Matching dates render in both panels

- **WHEN** both seven-day charts contain the same date sequence
- **THEN** corresponding date labels, bars, and values SHALL share the same vertical position
- **AND** extrema badges SHALL NOT change row height

### Requirement: Shared date control

The two seven-day charts SHALL use one common statistics-date control.

#### Scenario: User changes statistics date

- **WHEN** the common date control changes
- **THEN** both charts SHALL update to the same seven-day period
- **AND** neither panel SHALL require a private footer or spacer for alignment
