## 1. Specification And Tests

- [x] 1.1 Document the current raw capacity, model, token-composition, and reset-history problems.
- [x] 1.2 Strictly validate this OpenSpec change before implementation.
- [x] 1.3 Add core tests for reset-cycle deduplication, distinct-account preservation, historical report deduplication, and next expected reset times.
- [x] 1.4 Add UI tests for centered headers, segmented non-overlapping token composition, readable model/capacity evidence, account-labelled reset history, and contextual explanations.

## 2. Observation And Report Data

- [x] 2.1 Deduplicate reset detection by account, window, and prior reset cycle.
- [x] 2.2 Deduplicate legacy report projection without mutating private observation history.
- [x] 2.3 Add masked account identity and expected 5h/7d reset times to report data.
- [x] 2.4 Preserve reset-aware quota calculations and distinct events from different accounts.

## 3. Report Interface

- [x] 3.1 Center all report table headers while preserving readable body alignment.
- [x] 3.2 Replace token composition text with an accessible segmented bar using non-cached input, cached input, output, and reasoning.
- [x] 3.3 Reformat model/reasoning rows and capacity evidence with localized labels, compact numbers, ranges, sample counts, and confidence.
- [x] 3.4 Display expected reset times and account-labelled detected reset events with unambiguous timing labels.
- [x] 3.5 Add bilingual circular contextual help to account metrics, token composition, model/reasoning, capacity evidence, reset history, and unattributed usage.

## 4. Verification And Delivery

- [x] 4.1 Run targeted and full tests, syntax checks, strict OpenSpec validation, dependency audit, and diff checks.
- [x] 4.2 Visually verify daily/weekly, Chinese/English, light/dark, normal/narrow, bars, help popovers, and reset rows.
- [x] 4.3 Update bilingual documentation, bump to 2.8.0, and rebuild unpacked and NSIS artifacts.
- [x] 4.4 Run source, staged, local-report schema, ASAR, asset, and runtime privacy scans.
- [x] 4.5 Commit to Git, restart the packaged app, and verify one product main process with no development or remote-debugging instance.
