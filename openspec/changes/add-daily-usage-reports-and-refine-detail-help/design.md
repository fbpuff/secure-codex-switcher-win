## Decisions

- Use a two-option segmented control: `Daily / Weekly`.
- Default to the current local day. Daily boundaries are local midnight to the next local midnight; weekly behavior remains unchanged.
- Generalize the existing observation report builder around an explicit `[start, end)` interval rather than duplicating aggregation logic.
- Preserve unattributed token events inside the selected interval. Never infer an account from proximity.
- Capacity remains unknown when the selected interval lacks valid same-account/same-window samples; daily mode does not relax evidence thresholds.
- Use a native date input in daily mode and the existing week-start date behavior in weekly mode.
- Set the detail help button to `16px × 16px`, `aspect-ratio: 1`, zero padding, a circular border, and an outline-only focus-visible state.
- Bump the packaged application to 2.6.0 because daily reporting adds a user-facing reporting mode.
