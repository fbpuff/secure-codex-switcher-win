# Change: Stabilize usage, report, refresh, and account selection UI

## Why

The fixed-row usage charts overlap extrema labels, the compact account report breaks row geometry, model rows lose context at narrow widths, refresh replaces the list without restoring the reading position, and one score is being asked to represent both immediate usability and future recovery.

## What Changes

- Give chart extrema labels a non-overlapping fixed slot and align both seven-day panels.
- Replace the fragile report table behavior with a stable centered six-group layout.
- Keep model labels, composition bars, and disclosure controls aligned and readable.
- Preserve selected account, expanded detail state, and scroll position across refreshes.
- Separate immediate availability from recovery, and use earliest recovery only when no account is immediately usable.
