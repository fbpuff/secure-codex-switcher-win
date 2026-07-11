## 1. Baseline And Tests

- [x] 1.1 Reproduce direct timeout, proxied connectivity, process-tree hang, and desktop-shortcut startup behavior.
- [x] 1.2 Strictly validate this OpenSpec change before implementation.
- [x] 1.3 Add process tests for self-cycles, multi-node cycles, normal trees, current-tree exclusion, and the current code-mode host.
- [x] 1.4 Add proxy tests for environment precedence, Windows proxy fallback, disabled/malformed settings, and direct fallback.
- [x] 1.5 Add renderer tests for removal of the Electron IPC wrapper and actionable connectivity text.

## 2. Process Closure

- [x] 2.1 Add visited-PID guards to JavaScript and generated PowerShell process-tree walks.
- [x] 2.2 Include the official `codex-code-mode-host.exe` process family without matching unrelated executables.
- [x] 2.3 Preserve safe exclusion of the active invoking Codex tree.
- [x] 2.4 Verify count mode returns promptly against the real process table and closure failures remain fail-closed.

## 3. Proxy And Errors

- [x] 3.1 Resolve enabled Windows user proxy settings inside the packaged application.
- [x] 3.2 Preserve explicit environment-variable precedence and normalize protocol-specific proxy strings.
- [x] 3.3 Keep desktop shortcut startup independent of launcher-only environment injection.
- [x] 3.4 Present sanitized localized network causes without Electron IPC wrapper text.

## 4. Verification And Delivery

- [x] 4.1 Run targeted/full tests, syntax checks, strict OpenSpec validation, audit, and diff checks.
- [x] 4.2 Verify real direct/proxy connectivity, process count timing, and desktop-start behavior.
- [x] 4.3 Coordinate version 2.9.0 packaging with the interactive report change.
- [x] 4.4 Run source, staged, ASAR, runtime-data, and diagnostic privacy scans.
- [x] 4.5 Commit, restart the packaged app, refresh usage successfully, and verify one product main process without debug instances.
