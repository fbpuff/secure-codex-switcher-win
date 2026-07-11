## Context

Secure Codex Switcher is a local Electron account switcher. Its existing process rule accepts only `Codex.exe` paths under the OpenAI package, then writes the selected local auth cache and launches the application through its Start-menu identity. The current Microsoft Store package runs the visible desktop application as `ChatGPT.exe` and uses `codex.exe` as an internal app-server.

The observed startup log also proves two independent local plugin defects: `ngs-analysis` has a default prompt longer than the current 128-character limit, and the bundled Sites MCP server returns method-not-found for `resources/list`. Neither condition involves account credentials.

## Goals / Non-Goals

**Goals:**

- Close every trusted ChatGPT Codex desktop process before replacing the active local auth cache, then relaunch the current Start-menu application identity.
- Keep process matching strict to known official OpenAI package paths so unrelated ChatGPT/Codex-named processes are never targeted.
- Use ChatGPT Codex in user-facing lifecycle text. Keep `.codex`, `auth.json`, and internal compatibility identifiers unchanged where they name an existing storage contract.
- Provide a repeatable local repair for the two verified plugin defects, with timestamped backups and no credential access.

**Non-Goals:**

- Changing account encryption, account selection, usage scoring, or the `.codex` storage layout.
- Disabling arbitrary plugins, deleting plugin directories, or changing OpenAI application binaries.
- Automatically patching plugins during every account switch.
- Adding telemetry, dependencies, or remote services.

## Decisions

### Decision 1: Treat the Store package as one ChatGPT Codex session

The existing trusted package-path checks remain the boundary. Within those paths, both `ChatGPT.exe` and `codex.exe` are session processes. The close operation targets only that trusted set, so the visible desktop process cannot retain stale authentication while its internal app-server is restarted.

Alternative considered: close only `ChatGPT.exe`. Rejected because independently running or child app-server processes can remain and preserve stale state.

### Decision 2: Preserve technical compatibility names while correcting product wording

Internal filenames and data keys retain `codex` because the official local cache remains `.codex`. User-visible messages and documentation use `ChatGPT Codex` for the current desktop product and describe `Codex.exe` only as its internal app-server or a legacy executable name.

Alternative considered: rename every internal identifier. Rejected because it adds migration risk without changing behavior.

### Decision 3: Make plugin repair explicit and narrowly scoped

A repository script locates only the observed `ngs-analysis` manifest and the bundled Sites MCP server. It creates timestamped backups before shortening the invalid prompt and adding an empty `resources/list` response. It does not inspect, copy, or write `auth.json`, account stores, sessions, tokens, or config values.

Alternative considered: delete or globally disable plugins. Rejected because it loses unrelated functionality and has no verified per-plugin configuration contract in the current Store build.

## Risks / Trade-offs

- [Risk] A future application update can replace plugin cache files. -> Mitigation: the repair is idempotent and can be rerun; documentation states this explicitly.
- [Risk] Matching a generic executable name could close unrelated software. -> Mitigation: retain the existing OpenAI Store/runtime path allowlist and test both accepted and rejected cases.
- [Risk] Plugin repair modifies local cache files outside Git. -> Mitigation: create timestamped local backups, limit edits to known patterns, and keep all such files ignored.

## Migration Plan

1. Add tests for current ChatGPT Codex process identity and observe their expected failure.
2. Update the shared process classifier and lifecycle wording, then run the targeted and full test suites.
3. Add and execute the local recovery script once, retaining local backups outside Git.
4. Verify the repaired plugin artifacts through a direct MCP handshake without terminating an active ChatGPT Codex task, then restart Secure Codex Switcher. The next normal ChatGPT Codex launch loads the repaired local artifacts.
5. Run OpenSpec validation and a scoped privacy scan before staging only project files.
