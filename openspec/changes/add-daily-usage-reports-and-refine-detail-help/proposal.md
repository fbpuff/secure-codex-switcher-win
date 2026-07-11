## Why

Weekly reports are useful summaries but do not show what happened on a specific local day. The report view needs a daily mode that preserves attribution and evidence boundaries. The account-detail question mark also appears oversized and non-circular under focus styling.

## What Changes

- Add daily and weekly report modes, defaulting to daily.
- Aggregate retained observations by selected local calendar day while preserving unattributed usage and capacity-confidence rules.
- Reuse account, model, reasoning-effort, and confidence filters in both modes.
- Make report titles, date controls, refresh state, empty state, and bilingual text mode-aware.
- Refine the detail question-mark button to a stable 16-pixel circle with a separate focus ring.

## Capabilities

### New Capabilities

- `daily-usage-report`: Defines local-day aggregation and the daily/weekly report-mode contract.
- `compact-detail-help-control`: Defines the stable circular help control.
