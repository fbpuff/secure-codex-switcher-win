# Change: Reduce scroll jank during refresh

## Why

The configured one-minute background refresh currently commits two complete renderer rebuilds. Each rebuild replaces account and detail DOM, also rerenders unrelated usage and report views, then restores scroll position on the next frame. If this overlaps scrolling, the user sees a hitch or small position correction.

## What Changes

- Commit one account refresh after the complete background refresh cycle.
- Render only account-facing surfaces when account data changes.
- Delay non-urgent background DOM commits until active scrolling settles.
- Preserve selection and both pane scroll positions.
- Reduce expensive account-card shadows during scrolling.

