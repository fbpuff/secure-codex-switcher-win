# Change: Polish report alignment, account status, refresh, and branding

## Why

The usage panels still present independent date/value geometry, report quota evidence is hard to understand, model disclosure glyphs are optically off-center, the single availability number hides useful weekly capacity context, the internal brand still shows `CS`, and entering Reports waits for a fresh aggregation even when a recent result is available.

## What Changes

- Render both seven-day panels from one shared row geometry.
- Simplify account report quota-change evidence and explain its observational meaning.
- Replace text disclosure glyphs with centered CSS chevrons.
- Separate immediate account state, overall remaining quota, and expected recovery.
- Rank usable accounts by remaining quota and unavailable accounts by recovery time.
- Replace the internal `CS` mark with the switch-product icon treatment.
- Show cached report data immediately and refresh it incrementally in the background on the configured interval.
