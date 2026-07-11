## 1. Specification And Tests

- [x] 1.1 Record current alignment, clipping, persistent-detail, and overflow problems.
- [x] 1.2 Strictly validate this OpenSpec change before implementation.
- [x] 1.3 Add UI contract tests for semantic alignment, compact bars, donut details, pin/dismiss behavior, model disclosures, and no permanent legends.
- [x] 1.4 Add interaction tests for one-open-at-a-time, Escape, outside click, keyboard activation, and viewport clamping.

## 2. Shared Token Composition Interaction

- [x] 2.1 Render compact non-overlapping composition buttons in account and model rows.
- [x] 2.2 Add dependency-free donut popovers with localized values, percentages, definitions, and local-only limitations.
- [x] 2.3 Implement hover/focus preview, click pinning, one-open-at-a-time, outside-click and Escape dismissal.
- [x] 2.4 Clamp popovers to normal and narrow viewports without changing table dimensions.

## 3. Report Layout

- [x] 3.1 Align label columns left and numeric columns right in both headers and body.
- [x] 3.2 Compact quota consumption and expected reset text into bounded two-line content.
- [x] 3.3 Convert model/reasoning rows into compact disclosures with capacity evidence shown only when expanded.
- [x] 3.4 Keep contextual help for account metrics, composition, model disclosures, capacity, resets, and unattributed usage.
- [x] 3.5 Remove persistent token legends and eliminate incoherent clipping or page-level horizontal overflow.

## 4. Verification And Delivery

- [x] 4.1 Run targeted and full tests, syntax checks, strict OpenSpec validation, dependency audit, and diff checks.
- [x] 4.2 Visually verify account/model interactions in daily/weekly, Chinese/English, light/dark, normal/narrow layouts.
- [x] 4.3 Update bilingual documentation, bump to 2.9.0, and rebuild unpacked and NSIS artifacts.
- [x] 4.4 Run source, staged, local-report schema, ASAR, asset, and runtime privacy scans.
- [x] 4.5 Commit to Git, restart the packaged app, and verify one product main process with no development or remote-debugging instance.
