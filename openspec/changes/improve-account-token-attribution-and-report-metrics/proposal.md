## Why

Wall-clock `Tokens/hour` is distorted by idle gaps, and quota percentage-points per hour is noisy and difficult to interpret. Reports should answer how many local tokens each account actually used, how those tokens are composed, how much quota changed, and how reliable the account attribution is.

## What Changes

- Replace hourly-rate columns with attributed tokens, token composition, share, session count, average tokens per session, reset-aware quota change, and attribution confidence.
- Add high-confidence direct timeline attribution and medium-confidence conflict-free session continuity attribution.
- Keep ambiguous or cross-account sessions unattributed and expose overall attribution coverage.
- Move capacity estimates to a secondary evidence section with sample count, range, and confidence.
- Add an interactive metric explanation and fix the availability question mark to a guaranteed 16-pixel circle.

## Capabilities

### New Capabilities

- `evidence-aware-token-attribution`: Defines direct, session-continuity, conflicting, and unattributed evidence.
- `intuitive-account-report-metrics`: Defines account report columns, quota changes, coverage, and capacity evidence presentation.
