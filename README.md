# Secure Codex Switcher for Windows

A local-only Windows GUI for managing multiple official Codex / ChatGPT auth files, checking usage, and switching accounts with encrypted storage.

[中文说明](./README.zh-CN.md)

This project is designed for users who already use the official Codex app or CLI and want a safer local account switcher. It does not provide or bypass OpenAI login. Login still happens through official Codex.

## Versions

- `v1.1`: resizable account/detail panes, polished responsive account cards, HTTP-only mode documentation, and safer auto-switch deferral.
- `v2.1`: queued auto-switch. When Codex is running, the Switcher queues the target account, checks every 15 seconds, and completes the switch after Codex exits.
- `v2.2`: activity-aware auto-switch. The Switcher waits only when a Codex conversation or task appears active; if Codex is open but idle, the queued switch can complete.
- `v2.3.0`: dedicated local token-usage dashboard with selected-date 7-day charts, daily cache-hit bars, synchronized refresh cadence, and bilingual documentation.

## Features

- Windows GUI for importing, viewing, refreshing, switching, and deleting local Codex accounts.
- Stores imported auth JSON with Windows DPAPI `CurrentUser` encryption.
- Writes `%USERPROFILE%\.codex\auth.json` atomically when switching.
- Backs up the previous auth file with DPAPI encryption, not plaintext.
- Closes official Codex processes before switching or deleting the current account.
- Can automatically reopen official Codex after a switch.
- Supports current nested Codex auth format under `tokens`.
- Refreshes usage while the GUI is open and shows 5-hour / 7-day quota windows when the upstream endpoint allows it.
- Shows low-quota warnings and can switch automatically only when the current account is exhausted.
- Uses activity-aware queued auto-switching so active Codex conversations are not interrupted by automatic account changes.
- Provides a dedicated `Usage / 用量` dashboard for local token totals and cache-hit trends from Codex rollout logs.
- Supports minimize-to-tray and configurable close behavior.

## Security Model

The project intentionally keeps the attack surface small:

- No local HTTP server.
- No plugin system.
- No remote UI content.
- No embedded OAuth webview.
- No plaintext account store.
- No plaintext auth backups.
- Renderer access is limited to a small Electron IPC allowlist.
- Logs and UI text do not print raw access tokens or refresh tokens.
- Runtime account data is ignored by Git with `.gitignore`.

Compared with simpler or earlier account-switcher approaches, this version avoids several common weaknesses:

- Plaintext token storage is replaced with Windows DPAPI encryption.
- Plaintext backup files are replaced with encrypted `.dpapi` backups.
- Switching is guarded by process shutdown so official Codex does not keep using a stale in-memory auth state.
- The app supports both legacy top-level token auth and newer nested `tokens` auth.
- Usage refresh failures are treated as status information, not as a reason to expose token data.
- The GUI has no network-capable renderer; usage requests happen from the main process.

This is still a local tool that handles sensitive auth material. Do not upload your `%USERPROFILE%\.codex\auth.json`, app data folder, `.dpapi` backup files, or screenshots showing full account identifiers.

## Requirements

- Windows 10 or Windows 11.
- Node.js 22.12 or newer with npm.
- Git, or GitHub Desktop, or the ability to download this repository as a ZIP.
- Official Codex app/CLI installed and able to create `%USERPROFILE%\.codex\auth.json`.

## Install From GitHub

Clone the repository:

```powershell
git clone https://github.com/your-org-or-username/secure-codex-switcher-win.git
cd secure-codex-switcher-win
```

Run the installer script:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-CodexSwitcher.ps1
```

The script will:

- install npm dependencies in `secure-codex-switcher-win`;
- run the test suite;
- create a desktop shortcut named `Codex Switcher`.

After that, launch it from the desktop shortcut or run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Start-CodexSwitcher.ps1
```

## Manual Run

```powershell
cd .\secure-codex-switcher-win
npm install
npm test
npm start
```

## First Account

The GUI imports the official Codex auth file at:

```text
%USERPROFILE%\.codex\auth.json
```

First-time flow:

1. Open official Codex or run `codex` in PowerShell.
2. Complete the official ChatGPT/Codex login flow.
3. Confirm `%USERPROFILE%\.codex\auth.json` exists.
4. Open Codex Switcher.
5. Click `导入/新增当前`.

If official Codex asks for an auth method, choose the ChatGPT/Codex login flow rather than API-key-only mode.

## Add Another Account

1. Use official Codex to log out or switch to another ChatGPT/Codex account.
2. Confirm `%USERPROFILE%\.codex\auth.json` now belongs to that account.
3. Return to Codex Switcher.
4. Click `导入/新增当前`.

The account will be added as a separate encrypted local record, or updated if it was already imported.

Browser login alone is not enough. The Switcher imports the auth file created by official Codex; it does not read browser cookies.

## Switching Accounts

When you switch accounts, the app:

1. closes official Codex processes;
2. creates an encrypted backup of the current auth file;
3. writes the selected account to `%USERPROFILE%\.codex\auth.json`;
4. marks the selected account as current;
5. attempts to reopen official Codex.

Deleting a non-current account only removes the local encrypted Switcher record.

Deleting the current account offers two paths:

- switch to an existing imported account;
- clear the current auth and reopen official Codex so you can log in to a new account.

## Usage Refresh

Usage refresh calls ChatGPT/Codex usage endpoints. These endpoints are not a stable public API, so usage display can fail even when account switching still works.

Refresh behavior:

- `导入/新增当前` refreshes the imported account once.
- `刷新全部` refreshes all accounts immediately.
- Per-account `刷新` refreshes one account.
- While the GUI is open, all accounts refresh every 5 minutes.
- Low-quota warning appears at 15% remaining or below.
- Auto-switch only triggers when the current account is exhausted.
- Local token usage stats refresh on the same interval as account usage refresh while the GUI is open.

Common failures:

- `401`: the saved login state was rejected. Switch to that account, reopen official Codex, let it refresh auth, then try again. If it still fails, log in again and re-import.
- `403`: account switching may still work, but the non-public usage endpoint refused usage display.
- Network timeout: start your proxy/VPN, then refresh again.

The launcher reads `HTTP_PROXY`, `HTTPS_PROXY`, and Windows user proxy settings.

## Local Token Usage Dashboard

The left rail includes a dedicated `Usage / 用量` page above `Settings / 设置`.

The dashboard shows:

- `Selected Day`, `Last 7 Days`, and `This Month` local token totals.
- Average cache-hit rate for the selected 7-day window, calculated as `cached_input_tokens / input_tokens`.
- A stats date picker. Selecting a date shows that day plus the previous 6 calendar days.
- Daily token usage bars for the selected 7-day window. The highest day is 100%, and other days scale proportionally.
- Daily cache-hit-rate bars for the same selected 7-day window.

Data source:

- `%USERPROFILE%\.codex\sessions\**\rollout-*.jsonl`
- `%USERPROFILE%\.codex\archived_sessions\**\rollout-*.jsonl`

The parser reads only:

- `timestamp`
- `payload.info.last_token_usage`

It does not display conversation text.

Accuracy boundary:

- These stats are real summaries of local Codex rollout records that contain `last_token_usage`.
- They are not OpenAI billing data.
- They do not include usage from other devices or deleted logs.
- They are not split by account because current Codex rollout usage events do not expose a stable account ID.

## HTTP-only Mode

`Settings -> Network -> HTTP-only mode` switches official Codex from WebSocket transport to the Responses HTTP/SSE transport by selecting a dedicated custom provider with `supports_websockets = false`.

Changing this setting:

1. fully closes official Codex;
2. migrates the `model_provider` tag in active and archived rollout metadata;
3. updates the matching provider column in `state_*.sqlite`;
4. writes or removes the Switcher-managed block in `%USERPROFILE%\.codex\config.toml`;
5. reopens Codex only if it was running before the change.

History migration is necessary because Codex filters its sidebar by `model_provider`. Without migration, old threads are not deleted, but they can appear missing after selecting a custom provider.

Safety measures:

- rollout files are replaced atomically and only their first metadata line is changed;
- SQLite updates use a transaction;
- SQLite backups and a reversible provider manifest are stored under `%USERPROFILE%\.codex\secure-switcher-history-backups`;
- the managed config block is reversible and restores the previous top-level `model_provider`;
- no auth token, API key, or conversation body is written to the migration manifest.

## Settings and Window Exit

Open `设置 / Settings` from the left rail to change:

- UI language.
- Color theme: follow system, light, or dark.
- Usage auto-refresh interval.
- Low-quota warning.
- Auto-switch when the current account is exhausted.
- Manual switch confirmation.
- HTTP-only transport for unstable WebSocket proxy environments.
- Window close behavior: ask every time, minimize to taskbar, minimize to tray, or quit.
- Open the `%USERPROFILE%\.codex` folder.
- Fully quit the Switcher app.

Current UI direction:

- Account management and settings are separate views, so the account search/list UI does not overlap the settings page.
- The left rail only keeps account navigation and settings navigation. The `.codex` folder opener lives inside `设置 / Settings -> 应用 / App`.
- The left rail includes a separate `Usage / 用量` page for token charts, placed above settings.
- Low-quota warning and auto-switch controls are grouped vertically in one compact account-page control.
- Color theme uses a three-option segmented control instead of a dropdown.
- Selecting an account now updates only the selected row state and the detail panel, so the left account list keeps its scroll position instead of jumping back to the top.

Close behavior:

- On first close, the app asks whether to minimize or quit. If you choose `Always use this action`, the choice is saved locally in `settings.json`.
- If close behavior is set to `Minimize window`, clicking the window close button minimizes the app.
- If close behavior is set to `Minimize to tray`, clicking the window close button hides the app from the taskbar and keeps a tray icon. Click or double-click the tray icon to restore the window.
- To fully quit after minimizing, either use `设置 / Settings -> 应用 / App -> 退出应用 / Quit App`, or right-click the minimized taskbar window and choose `关闭窗口 / Close window`.
- To fully quit after minimizing to tray, use the tray menu `退出应用 / Quit App` or the Settings page quit button.
- No account tokens or API keys are stored in settings.

Relevant implementation paths:

- Main close/quit behavior: `secure-codex-switcher-win/src/main.js`.
- Renderer IPC allowlist for quit: `secure-codex-switcher-win/src/preload.cjs`.
- Settings UI and event handling: `secure-codex-switcher-win/src/renderer/index.html` and `secure-codex-switcher-win/src/renderer/app.js`.
- Settings, usage charts, and theme styles: `secure-codex-switcher-win/src/renderer/styles.css`.
- HTTP-only config management: `secure-codex-switcher-win/src/core/codex-config.js`.
- History provider migration: `secure-codex-switcher-win/src/core/codex-history.js`.

## Can Others Install Directly From This Repository?

Yes, if they are on Windows and have Node.js 22.12 or newer with npm installed. The repository contains the source code, launcher, installer script, tests, and dependency lockfile.

It is not currently a signed `.exe` installer. Users install it from source with the PowerShell script above. This keeps the distribution transparent: dependencies are installed from `package-lock.json`, and the app can be inspected before running.

## About a Single EXE Build

Bundling this project into a single Windows installer or executable is not automatically less secure. The security model can remain the same if the package contains only the app code and runtime dependencies.

The risks move to distribution and supply chain:

- the release artifact should be built from a clean checkout;
- runtime data such as `auth.json`, `accounts-store.json`, `.dpapi` backups, and `.env` files must never be bundled;
- the build should use a lockfile and reproducible steps;
- users should be able to verify the source commit used for a release;
- production releases should ideally be code-signed;
- auto-update, if added later, needs signature verification.

For now, source installation is the safer transparent default for a public project. A signed installer can be added later without changing the local security model.

## Development

```powershell
cd .\secure-codex-switcher-win
npm install
npm test
npm run audit:prod
npm start
```

## Repository Hygiene

The repository is configured to ignore runtime and secret-bearing files:

- `node_modules/`
- `auth.json`
- `accounts-store.json`
- `settings.json`
- `*.dpapi`
- `.env`
- `secure-switcher-backups/`

Before publishing changes, run:

```powershell
git status --short
npm test
npm run audit:prod
```
