## ADDED Requirements

### Requirement: Usage and report geometry remains aligned
The renderer SHALL prevent chart labels from overlapping values and SHALL keep account and model report content centered and semantically aligned without horizontal scrolling in the supported report viewport.

#### Scenario: Extrema labels are shown
- **WHEN** the seven-day chart marks the highest and lowest days
- **THEN** labels occupy a dedicated slot and do not overlap token totals or percentages

#### Scenario: Account and model reports render
- **WHEN** report rows contain localized long values
- **THEN** each value remains in its semantic group and disclosure glyphs remain geometrically centered
