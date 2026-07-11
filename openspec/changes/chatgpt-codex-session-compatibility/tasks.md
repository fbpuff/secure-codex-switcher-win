## 1. Diagnosis And Scope

- [x] 1.1 Record the verified ChatGPT Codex process-name change and the two independent plugin startup failures from local logs.
- [x] 1.2 Confirm `sites-design-picker` is plugin-provided rather than a user-authored `config.toml` MCP entry.
- [x] 1.3 Confirm the project worktree is clean and existing Git exclusions cover local credentials, account stores, sessions, plugin caches, and logs.

## 2. ChatGPT Codex Session Lifecycle

- [x] 2.1 Add a failing test proving trusted `ChatGPT.exe` desktop processes are included with trusted internal `codex.exe` processes, while unrelated same-named processes remain excluded.
- [x] 2.2 Extend the shared process identity rule and PowerShell lifecycle script to manage the trusted ChatGPT Codex session.
- [x] 2.3 Update launch errors and user-facing lifecycle messages to distinguish ChatGPT Codex from `.codex` compatibility storage.
- [x] 2.4 Run the targeted process test and full test suite after the lifecycle change.

## 3. Plugin Startup Recovery

- [x] 3.1 Add a local, idempotent recovery script that backs up and repairs only the verified `ngs-analysis` manifest and bundled Sites MCP incompatibilities.
- [x] 3.2 Execute the recovery script and verify it neither reads nor writes account credentials, session data, account stores, or `config.toml` values.
- [x] 3.3 Verify the repaired Sites MCP server answers `resources/list` and the NGS default prompt satisfies the current length limit.

## 4. Documentation, Validation, And Delivery

- [x] 4.1 Update English and Chinese documentation with the ChatGPT Codex terminology boundary and plugin recovery procedure.
- [x] 4.2 Run JavaScript and PowerShell syntax checks, the full test suite, strict OpenSpec validation, and a project-wide sensitive-data scan.
- [x] 4.3 Verify both repaired plugin artifacts with a direct MCP handshake without terminating the active ChatGPT Codex task; the next normal application launch loads the repaired artifacts.
- [x] 4.4 Restart Secure Codex Switcher from the D drive launcher and verify the running process path.
- [x] 4.5 Inspect staged changes for sensitive data, commit only project files to local Git, and verify the final worktree state.
