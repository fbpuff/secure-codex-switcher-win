# Add Interactive Token Composition Details

## Why

The account table mixes centered headers with left-aligned data, keeps verbose token labels visible in every row, and forces horizontal scrolling. The model/reasoning section places all token and capacity evidence in a narrow final column, causing clipping and weak information hierarchy.

## What Changes

- Align each header with its data type: labels left, numeric values right.
- Keep a compact segmented token bar in account and model rows.
- Show a donut chart, exact values, percentages, definitions, and local-data limits on hover, focus, or activation.
- Allow click-to-pin, outside-click and Escape dismissal, with one open detail at a time.
- Convert model/reasoning rows into compact expandable disclosures; capacity evidence is hidden until expanded.
- Compact quota consumption into two readable lines and reduce horizontal pressure.
- Preserve non-overlapping cached-input calculation and keyboard accessibility.

## Privacy

The interaction consumes only already-rendered local aggregate values. No account records, credentials, session content, snapshots, or report files enter Git or application assets.
