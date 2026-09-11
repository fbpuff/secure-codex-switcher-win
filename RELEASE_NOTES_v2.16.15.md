# Secure Codex Switcher v2.16.15

## Edge-window runtime correction

- Remove the stale renderer-side completed-task filter that referenced an undefined function.
- Keep completed-thread read state in the main process, isolated by the current account and persisted across edge-window reloads.
- Refresh the completed list only after Codex accepts the exact thread-open request.
- Preserve direct drag-to-left/right automatic docking as the sole side-selection flow.

## Verification boundary

- Source tests, full validation, formal NSIS installation, provenance checks, and real installed-window acceptance are required before release closure.
- Switcher installation and restart must preserve all Codex process identities and must not switch accounts.
