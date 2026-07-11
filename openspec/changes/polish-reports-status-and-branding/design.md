# Design

## Report refresh

Report aggregation and quota refresh remain different data operations, but they share the configured refresh cadence. Keep the latest daily and weekly report in renderer memory by mode and date. Entering Reports renders the cached result immediately; only stale or missing entries trigger a background request. Manual refresh and date changes always request fresh data. Show the last successful report refresh time and loading state without clearing existing rows.

## Account state

Immediate availability is a state, not a blended score. A known exhausted 5h or 7d window blocks immediate use. Overall remaining quota still combines both windows for comparison and remains visible. Usable accounts sort first by overall remaining quota; blocked accounts sort after them by the reset time of the exhausted window.

## Geometry

Both seven-day panels use identical date, bar, and value tracks and center every row on the same fixed baseline. Report account rows use compact content wrappers inside stable table cells. Disclosure icons are drawn with CSS borders in an exact square rather than relying on a font glyph.
