# Secure Codex Switcher for Windows

[中文说明](README.zh-CN.md)

Secure Codex Switcher is an independent, local-only Windows desktop application for managing multiple ChatGPT Codex sign-ins, monitoring quota snapshots, and switching accounts without storing credentials in plaintext.

> This project is not affiliated with, endorsed by, or maintained by OpenAI. ChatGPT, Codex, and OpenAI are trademarks of their respective owner.

## Release

- Current release: **v2.15.0**
- Platform: Windows x64
- Desktop runtime: Electron
- Credential protection: Windows DPAPI
- Upstream application name: **ChatGPT Codex**

Download the installer from the [GitHub Releases](https://github.com/fbpuff/secure-codex-switcher-win/releases) page and verify it against `SHA256SUMS.txt`.

## Highlights

- Import and manage multiple ChatGPT Codex login states.
- Encrypt saved authentication records with Windows DPAPI.
- Show current 5-hour and 7-day quota snapshots and expected reset times.
- Rank usable accounts with a transparent availability formula.
- Choose a one-time next switch account or use automatic best-account selection.
- Fall back to the best usable account when the selected target is unavailable.
- Queue automatic switching while a Codex task is active.
- Detect `task_started` and `task_complete` lifecycle events before closing ChatGPT Codex.
- Preserve account-list selection and scroll position during refresh.
- Provide local daily and weekly Token reports with model and reasoning-effort dimensions.
- Support English and Simplified Chinese UI and documentation.
- Minimize to tray and use packaged product icons throughout the application.

## Installation

1. Download `Secure Codex Switcher-2.15.0-x64.exe` from the release page.
2. Compare its SHA-256 value with `SHA256SUMS.txt`.
3. Run the installer and choose an installation directory.
4. Start **Codex Switcher** from the desktop or Start menu.
5. Sign in to ChatGPT Codex normally before importing the current account.

The installer does not delete local application data during uninstall by default.

## Development

Requirements:

- Windows 10 or Windows 11
- Node.js 22.19 or later
- npm

```powershell
npm install
npm test
npm start
```

Build the Windows installer:

```powershell
npm run package:win
```

Generated packages are written to `dist/` and are excluded from Git.

## Account Import And Storage

The application reads the current ChatGPT Codex authentication file only when the user requests an import or when it needs to synchronize a saved current account. Imported authentication JSON is encrypted before it is written to the Switcher account store.

- Encryption uses Windows DPAPI under the current Windows user profile.
- Saved records are intended to be decryptable only by the same Windows user on the same Windows installation.
- Plaintext auth backups are migrated to DPAPI-protected files.
- Tokens, complete account identifiers, and auth JSON are never written to diagnostic logs.
- Runtime account data is not included in the source tree or release package.

This protects data at rest from casual file access. It does not protect against malware or another process already running with the same Windows user privileges.

## Switching Behavior

Manual switching:

1. The Switcher validates the target account and reads its encrypted auth record.
2. It closes official ChatGPT Codex processes.
3. It verifies that closure completed before replacing authentication.
4. It writes the selected auth state atomically.
5. It reopens ChatGPT Codex when appropriate.

If ChatGPT Codex cannot be closed completely, authentication replacement is cancelled to prevent a false or partial switch.

Automatic switching:

- Triggers when a known current-account quota window is exhausted.
- A manually selected next account is a **one-time preference**.
- The preference is consumed after the next automatic switch attempt.
- Missing, unreadable, stale, current, or quota-blocked targets fall back to a usable scored account.
- If no usable account exists, the Switcher waits instead of changing auth prematurely.

## Active Task Protection

Automatic switching must not interrupt unfinished Codex work. The Switcher combines three local signals:

1. Live official ChatGPT Codex process records.
2. Recent local rollout activity.
3. Rollout lifecycle events, where an unmatched `task_started` remains busy until `task_complete` appears.

An active or uncertain task keeps switching queued. File silence alone is not treated as proof that a task finished. User-confirmed manual switching remains available.

## Quota And Ranking

Quota percentages come from the ChatGPT/Codex usage endpoint available to the current login. They are snapshots, not locally counted Token totals.

Account availability is a local decision score:

```text
availability = minimum remaining quota * 60%
             + 5-hour remaining quota * 20%
             + 7-day remaining quota * 20%
```

Rules:

- Full known quotas score 100.
- If only one quota window is known, that remaining percentage is used directly.
- An exhausted known window makes the account unavailable for immediate automatic switching.
- Reset time is used only to order equal or blocked candidates; it does not inflate immediate availability.
- Login failures, unreadable records, and stale quota snapshots are excluded from automatic selection.

This score is not an official OpenAI metric.

## Token Usage And Reports

The usage dashboard reads local Codex rollout metadata and aggregates Token events without storing prompt or response content.

Available views include:

- Daily and seven-day Token totals.
- Input, cached input, output, and reasoning Token composition.
- Per-account attributed Token totals.
- Model and reasoning-effort breakdowns.
- Daily and weekly reports.
- Observed quota reset history.
- Capacity estimates derived from unambiguous observed quota changes.

Attribution is evidence-based. Periods that cannot be assigned to exactly one account remain **unattributed**. Capacity estimates are observations, not official plan limits.

Official quota percentages and local rollout Token totals use different data sources and should not be expected to match exactly.

## Refresh And Performance

- The refresh interval is configurable from 1 to 60 minutes.
- Manual refresh remains available at any time.
- Background refresh performs one renderer commit per cycle.
- Account refresh does not rebuild unrelated usage and report views.
- Non-urgent updates wait briefly while the account panes are actively scrolling.
- Selection and both pane scroll positions are preserved.

## Network And HTTP-Only Mode

The application uses the operating environment's normal proxy settings. HTTP-only mode can be configured globally or per account for ChatGPT Codex transport compatibility. Changing transport may close and reopen ChatGPT Codex because provider tags and local configuration must remain consistent.

No custom remote telemetry, analytics service, or shared OpenSpec store is enabled by this project.

## Local Files And Privacy

Runtime data is stored under Electron's per-user application data directory. Exact locations depend on Windows and installation context.

The repository excludes:

- Auth files and DPAPI blobs.
- Account stores and settings.
- Token caches and usage observations.
- Codex sessions and process-manager data.
- Logs, reports, backups, databases, archives, and temporary files.
- Installers and unpacked build output.

Before publishing changes, run:

```powershell
git status
git diff --cached
npm test
npm audit --omit=dev
```

Never commit runtime files copied from a real user profile.

## Troubleshooting

### The displayed quota differs from ChatGPT Codex

Refresh both applications. The Switcher displays the latest successful usage snapshot, while ChatGPT Codex may refresh at a different time.

### Automatic switching is waiting

An active or uncertain Codex task, a recent activity quiet period, or the absence of a usable target can keep switching queued. Finish the task or use a confirmed manual switch.

### The selected next account disappeared

The saved record may have been deleted, replaced, become current, or become unreadable. The one-time preference is cleared and selection returns to the best usable account.

### ChatGPT Codex did not restart

Check whether official Codex processes could be fully closed and whether the installed ChatGPT Codex application is discoverable. Authentication is not replaced when safe closure cannot be verified.

### Reports show unattributed usage

The local evidence did not identify exactly one active account for that interval. The application intentionally avoids guessing.

## Scope

This release targets one local Windows user and the installed ChatGPT Codex desktop application. It is not a cloud account manager, does not synchronize credentials between machines, and does not bypass OpenAI limits or authentication controls.

## License

No license file is currently included. Unless a license is added, copyright law reserves reuse and redistribution rights.
