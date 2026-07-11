## 1. Baseline And Tests

- [x] 1.1 Record the duplicated detail labels and truncated desktop shortcut as baselines.
- [x] 1.2 Strictly validate this OpenSpec change.
- [x] 1.3 Add failing renderer tests for the detail question mark, hover/focus explanation, formula text, and removal of the internal label.
- [x] 1.4 Add failing launcher/packaging tests for `Codex Switcher.lnk`, exact old-shortcut cleanup, shorter NSIS shortcut name, and unchanged product/EXE identity.

## 2. Implementation

- [x] 2.1 Replace the duplicated detail score block with a single label/value row and interactive question-mark popover.
- [x] 2.2 Add bilingual formula, bottleneck, local-score, and accessibility text with responsive styling.
- [x] 2.3 Update the launcher to create `Codex Switcher.lnk`, remove only the retired exact shortcut, and refresh Explorer.
- [x] 2.4 Update NSIS shortcut naming, bilingual documentation, and version 2.5.4 while preserving formal identity and storage paths.

## 3. Verification And Delivery

- [x] 3.1 Run targeted tests, full tests, syntax checks, strict OpenSpec validation, and diff checks.
- [x] 3.2 Visually verify the detail question mark in Chinese/English and normal/narrow layouts.
- [x] 3.3 Rebuild unpacked and NSIS artifacts and verify shortcut target, name, icon, executable identity, and single-instance behavior.
- [x] 3.4 Run source, staged, asset, ASAR, and runtime privacy scans.
- [x] 3.5 Commit to Git, restart the packaged app, and verify one product main process with no development or remote-debugging instance.
