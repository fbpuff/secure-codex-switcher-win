# Explain Report Metrics And Deduplicate Resets

## Why

The report currently exposes technical shorthand, raw capacity ranges, and reset events without account identity. Users cannot reliably interpret the values, cached input appears additive, and events from several accounts or repeated confirmations look like duplicate resets.

## What Changes

- Center report table headers and give every report section an accessible contextual explanation.
- Replace token-composition text with a segmented bar that separates non-cached input, cached input, output, and reasoning without double counting cached input.
- Reformat model and reasoning rows with readable labels and capacity evidence.
- Show per-account next expected 5h/7d reset times as estimates from the latest quota snapshot.
- Show account identity and timing meaning in reset history, and deduplicate repeated confirmations of the same account/window/reset cycle.
- Preserve distinct simultaneous resets from different accounts.

## Privacy

All calculations remain local. Specifications and Git history contain no account records, credentials, tokens, session content, snapshots, or generated reports.
