# Design

## Account report

Use six groups: account, attributed tokens, compact composition, usage overview, quota status, and attribution confidence. Usage overview combines share, session count, and average tokens/session. Quota status uses two bounded rows, one each for 5h and 7d, with localized consumed percentage points, reset count, and compact expected time.

At normal desktop width, the table must fit without horizontal scrolling. All six group headers and values use consistent centered alignment. At narrow width, each account becomes a stable two-row grid while preserving header meaning and keyboard access, without a horizontal scrollbar. Full timestamps and the distinction between percentage points and percentages remain in contextual help.

## Seven-day charts

Both panels consume the same seven-row CSS grid with a stable row height. Date labels, bars, and values use matching tracks. Highest/lowest badges are positioned within the value cell without contributing to row height. Move the date picker to a shared toolbar above both charts so neither panel needs a private footer or placeholder.
