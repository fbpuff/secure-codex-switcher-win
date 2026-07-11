## Why

The tray initially loads the project PNG but then replaces it with `app.getFileIcon(process.execPath)`. Windows can return a stale cached executable icon for the unchanged EXE path, so minimizing to tray still shows a retired or unrelated-looking symbol.

## What Changes

- Remove executable-icon synchronization from the tray path.
- Package and load a versioned standalone tray PNG directly from `process.resourcesPath`.
- Retain an explicit development fallback and verify hide-to-tray taskbar behavior.
- Rebuild version 2.5.3, validate privacy, commit, and restart.

## Capabilities

### New Capabilities

- `versioned-tray-icon`: Defines deterministic cache-independent tray icon loading and fallback behavior.
