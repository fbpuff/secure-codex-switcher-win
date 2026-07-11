## 1. Specification And Tests

- [x] 1.1 Add regression tests requiring a shared vector symbol in both help buttons.
- [x] 1.2 Add regression coverage that text question-mark glyphs are no longer used.
- [x] 1.3 Strictly validate the OpenSpec change.

## 2. Implementation

- [x] 2.1 Define one reusable CircleHelp SVG symbol.
- [x] 2.2 Replace summary and account-detail text glyphs with symbol references.
- [x] 2.3 Normalize both icon geometries without changing popover interaction.

## 3. Verification And Delivery

- [x] 3.1 Run focused/full tests, syntax checks, OpenSpec validation, and production audit.
- [x] 3.2 Package the next patch version and inspect both icons at the active Windows DPI.
- [x] 3.3 Run source, staged, and packaged privacy scans.
- [x] 3.4 Commit all changes, restart the packaged application, and verify one main window.
