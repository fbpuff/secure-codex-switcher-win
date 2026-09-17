# Secure Codex Switcher for Windows

[中文说明](README.zh-CN.md)

Secure Codex Switcher is an independent, local-only Windows desktop application for managing multiple ChatGPT Codex sign-ins, monitoring quota snapshots, and switching accounts without storing credentials in plaintext.

> This project is not affiliated with, endorsed by, or maintained by OpenAI. ChatGPT, Codex, and OpenAI are trademarks of their respective owner.

## Release

- Ordinary Windows installations now use per-user AppData instead of requiring a writable D drive. Startup storage errors show a diagnostic message.
- Current version: **v2.20.0**, with a Windows x64 installer.
- Pending-switch status remains stable during quota refresh; long notices and diagnostics scroll within a fixed-height status region so the account list does not jump.
- New Switcher logs, displayed times and report/token calendar boundaries use Beijing time (UTC+08:00), independently of the host timezone. Historical logs and Codex-owned records are preserved.
- Platform: Windows x64
- Desktop runtime: Electron
- Credential protection: Windows DPAPI
- Upstream application name: **ChatGPT Codex**

Published installers, when available, are on [GitHub Releases](https://github.com/fbpuff/secure-codex-switcher-win/releases); verify them against `SHA256SUMS.txt`. Local installation and automated tests do not by themselves verify real account-switch continuation.

## Highlights

- Import and manage multiple ChatGPT Codex login states.
- Encrypt saved authentication records with Windows DPAPI.
- Show current 5-hour and 7-day quota snapshots and expected reset times.
- Provide a live left/right screen-edge quota window with animated liquid meters, a distinct below-10% warning, and an auto-retracting reveal handle.
- Show the current account remark, next switch target, active tasks, and recently completed tasks; rows with exact thread IDs open directly in Codex.
- Add a new account after preserving the current login with DPAPI, without first deleting or signing out the original saved account.
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

1. Download the Windows x64 installer from [v2.20.0](https://github.com/fbpuff/secure-codex-switcher-win/releases/tag/v2.20.0), or build this source version using the instructions below.
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
npm run package:public
```

Generated packages are written to `dist/` and are excluded from Git.

For this privacy-filtered public snapshot, use `npm run package:public` instead of `package:win` or `package:dir`. The latter are internal formal-delivery checks that require private development ancestry, which is intentionally not published. Public builds are community builds and do not carry the internal formal-install provenance claim. Do not disable these checks in an internal checkout.

Ordinary installations store data in `%APPDATA%\secure-codex-switcher-win`. An explicit absolute `--user-data-dir="<your local data directory>"` takes priority. Users of an older custom or internal data directory must explicitly select that existing directory; startup no longer infers it from a maintainer-specific installation location. No account data is automatically migrated. If startup fails, read the displayed error and, when available, `%TEMP%\secure-codex-switcher-win\startup.log`. Do not run as administrator merely to work around a data-directory error.

`Start-CodexSwitcher.ps1` accepts `-InstallRoot` and `-UserDataPath` (alias `-user-data-dir`). Without an install path, it checks for the executable beside the script, then existing shortcuts, Windows uninstall registration, and the per-user Programs directory. Ambiguous installations require an explicit path. Existing matching shortcuts retain their custom data directory unless overridden; otherwise the launcher uses AppData. It preserves Windows proxy inheritance and repairs shortcuts before launching. These source changes do not alter already published installers.

Internal formal-install verification requires explicit absolute `-InstallRoot` and `-UserDataPath` parameters; its provenance, hash, shortcut, and process checks remain in force.

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

Development uses Electron's per-user application data directory. Packaged builds default to the data path described above; an explicit `--user-data-dir` takes precedence.

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

This public source update preserves existing public history but does not import private development commits, local task records, agent configuration, delivery evidence, account data, or logs. See [PRIVACY.md](PRIVACY.md) before sharing diagnostics.

### 2.19.7 verification scope

The application regression suite passed 730 tests before publication. Isolated Electron checks verified matching left/right handle and client-reservation dimensions at 100%, 125%, 150%, and 200% scale. These checks do not establish physical drag smoothness or successful real account-switch continuation in every environment.

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

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
