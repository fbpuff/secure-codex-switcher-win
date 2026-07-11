## 1. Baseline And Tests

- [x] 1.1 Record the stale tray icon and identify executable icon synchronization as the overriding path.
- [x] 1.2 Strictly validate this OpenSpec change.
- [x] 1.3 Add failing tests requiring a versioned tray PNG, `process.resourcesPath` loading, no `app.getFileIcon`, and retained hide-to-tray behavior.

## 2. Implementation

- [x] 2.1 Generate a transparent 32-pixel `tray-icon-2.5.3.png` from the approved switching icon.
- [x] 2.2 Package the versioned PNG as an extra resource and load it directly in packaged mode with a development fallback.
- [x] 2.3 Remove executable-icon synchronization and bump the application to 2.5.3.
- [x] 2.4 Update bilingual documentation for deterministic tray icon handling.

## 3. Verification And Delivery

- [x] 3.1 Run targeted tests, the full suite, syntax checks, strict OpenSpec validation, and diff checks.
- [x] 3.2 Inspect the 16/24/32-pixel tray asset and verify real packaged minimize-to-tray behavior.
- [x] 3.3 Rebuild unpacked and NSIS artifacts and verify the versioned tray resource is packaged.
- [x] 3.4 Run source, staged, asset-metadata, ASAR, and runtime privacy scans.
- [x] 3.5 Commit to Git, restart the packaged app, and verify one product main process with no development or remote-debugging instance.
