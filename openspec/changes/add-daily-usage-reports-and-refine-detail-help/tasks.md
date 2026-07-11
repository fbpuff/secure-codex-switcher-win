## 1. Baseline And Tests

- [x] 1.1 Record the weekly-only report flow, observation aggregation boundaries, and current detail-help dimensions.
- [x] 1.2 Strictly validate this OpenSpec change before implementation.
- [x] 1.3 Add failing core tests for local-day boundaries, daily account/model/reasoning totals, daily unattributed usage, reset events, and insufficient capacity evidence.
- [x] 1.4 Add failing service/IPC tests for daily report requests without changing weekly behavior.
- [x] 1.5 Add failing renderer tests for the Daily/Weekly segmented control, default daily mode, mode-aware title/date/refresh states, shared filters, and 16-pixel circular help styling.

## 2. Daily Observation And Service Layer

- [x] 2.1 Generalize report aggregation to an explicit interval while retaining the weekly API.
- [x] 2.2 Add local-day boundary calculation and daily report generation with deterministic start-inclusive/end-exclusive behavior.
- [x] 2.3 Preserve daily unattributed events, reset history, grouping, rates, and capacity evidence rules.
- [x] 2.4 Expose daily reports through AccountService, IPC, and preload without adding remote storage or new sensitive fields.

## 3. Reports UI And Help Control

- [x] 3.1 Add a Daily/Weekly segmented control and default the report view to Daily.
- [x] 3.2 Make the date input, title, refresh, loading, empty, and error states mode-aware while reusing all existing filters.
- [x] 3.3 Render daily summaries through the existing report tables and clearly preserve unknown capacity and unattributed usage.
- [x] 3.4 Add complete Chinese and English text for daily/weekly modes and data-boundary explanations.
- [x] 3.5 Refine the account-detail question mark to a fixed 16-pixel circle with stable hover/focus-visible behavior.

## 4. Verification And Delivery

- [x] 4.1 Run targeted tests, the full suite, JavaScript syntax checks, strict OpenSpec validation, and diff checks.
- [x] 4.2 Visually verify Daily/Weekly reports and the detail help control in Chinese/English, light/dark, and normal/narrow layouts.
- [x] 4.3 Update bilingual documentation, bump to 2.6.0, rebuild unpacked and NSIS artifacts, and verify product identity and shortcut behavior.
- [x] 4.4 Run source, staged, generated-report, ASAR, asset, and runtime privacy scans.
- [x] 4.5 Commit to Git, restart the packaged app, and verify one product main process with no development or remote-debugging instance.
