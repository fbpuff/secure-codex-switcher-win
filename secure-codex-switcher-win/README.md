# Secure Codex Switcher for Windows

Local-only Windows account switcher for Codex / ChatGPT auth files.

中文说明见 [README.zh-CN.md](README.zh-CN.md).

## Versions

- `v1.1`: resizable account/detail panes, polished responsive account cards, HTTP-only mode documentation, and safer auto-switch deferral.
- `v2.1`: queued auto-switch. When Codex is running, the Switcher no longer stops at a one-time deferral; it queues the target account, checks every 15 seconds, and completes the switch after Codex exits.
- `v2.2`: activity-aware auto-switch. The Switcher waits only when a Codex conversation or task appears active; if Codex is open but idle, the queued switch can complete.
- `v2.3.0`: dedicated local token-usage dashboard with selected-date 7-day charts, daily cache-hit bars, synchronized refresh cadence, and bilingual documentation.
- `v2.3.1`: date picker fix for the usage dashboard. Stats date selection now uses only the calendar icon and refreshes the maximum selectable date whenever the picker opens.
- `v2.3.2`: stability fixes. Auto-switch waits for 90 seconds of continuous quiet time after detected activity; transient main-process network disconnects are logged and shown as UI status instead of fatal dialogs; 401 usage-refresh failures are reported as login-refresh-needed states; usage dates follow today unless the user manually selected a historical date.

## Security model

- No local HTTP server.
- No plugin system.
- No remote UI content.
- Renderer talks to the main process through a small IPC allowlist.
- Account auth JSON is encrypted with Windows DPAPI `CurrentUser`.
- `%USERPROFILE%\.codex\auth.json` is written atomically and backed up with Windows DPAPI encryption before switching.
- Logs and UI summaries never display raw tokens.

## Install and run

Requirements:

- Windows 10 or Windows 11.
- Node.js 22.12 or newer.
- npm.
- Official Codex installed and able to create `%USERPROFILE%\.codex\auth.json`.

Install from GitHub:

```powershell
git clone https://github.com/your-org-or-username/secure-codex-switcher-win.git
cd secure-codex-switcher-win
npm install
npm test
npm start
```

Update an existing checkout:

```powershell
cd secure-codex-switcher-win
git pull
npm install
npm test
npm start
```

Developer checks:

```powershell
npm audit --omit=dev
npm test
node --check src\main.js
node --check src\preload.cjs
node --check src\renderer\app.js
node --check src\services\account-service.js
```

## Login and import

The app imports the Codex auth file at `%USERPROFILE%\.codex\auth.json`.

First-time flow:

1. Open PowerShell.
2. Run `codex`.
3. Follow the official Codex login flow and choose ChatGPT/Codex login, not API key-only mode.
4. Confirm `%USERPROFILE%\.codex\auth.json` exists and contains a `tokens` object.
5. Open this GUI and click `导入当前`.

To add another account:

1. Use the official Codex app/CLI to log in or switch to the other ChatGPT/Codex account so `%USERPROFILE%\.codex\auth.json` changes.
2. Return to this GUI.
3. Click `导入/新增当前`.
4. The app will add it as a separate encrypted local account or update the existing record if it is already imported.

Browser login alone does not update `%USERPROFILE%\.codex\auth.json`. This app does not embed OpenAI OAuth in its own webview; it only imports auth files created by official Codex.

The `最佳账号分数` metric is not a separate quota from OpenAI. It is the app's switching score:

```text
7-day remaining * 0.7 + 5-hour remaining * 0.3
```

Alternative manual flow:

1. In Codex, log out or switch to the other ChatGPT/Codex account so `%USERPROFILE%\.codex\auth.json` changes.
2. Return to this GUI.
3. Click `导入/新增当前`.
4. The app will add it as a separate encrypted local account or update the existing record if it is already imported.

Supported auth shapes:

- Legacy top-level tokens: `access_token`, `refresh_token`, `account_id`.
- Current nested tokens: `tokens.access_token`, `tokens.refresh_token`, `tokens.account_id`.

## Usage refresh and proxy

Usage refresh calls ChatGPT/Codex usage endpoints. If your network cannot directly reach `chatgpt.com`, start your proxy/VPN first.

Refresh behavior:

- Clicking `导入/新增当前` refreshes that imported account once.
- Clicking `刷新全部` refreshes all accounts immediately.
- Clicking an account's `刷新` button refreshes that account immediately.
- While the GUI is open, it refreshes all accounts in the background. The interval defaults to 5 minutes and can be changed in `设置 / Settings`.
- If `低余量提醒` is enabled, the app shows a red inline warning when the current account drops to 15% remaining or below.
- If `用尽后自动切换` is enabled, the app switches directly to the best fresh non-current account only when the current account is exhausted. The 15% threshold is just a warning.
- Automatic switching is activity-aware: if a Codex conversation/task is active, the Switcher queues the account change, shows a red inline warning, checks every 15 seconds, and completes the switch after Codex stays quiet for 90 continuous seconds.
- Switching writes `%USERPROFILE%\.codex\auth.json`, closes official Codex processes, and then starts official Codex again so the new account is loaded.
- When official Codex refreshes the current account's auth file, the Switcher automatically updates the matching encrypted account record.
- If a saved account's usage refresh returns 401, the UI marks that account as needing a login refresh. Usually you need to switch to that account, reopen official Codex so it refreshes auth, then refresh or re-import in the Switcher.
- Deleting a non-current account only removes the local encrypted Switcher record.
- Deleting the current account offers two paths:
  - choose an existing saved account, then the Switcher writes that account, closes official Codex, and starts official Codex again;
  - choose new login, then the Switcher closes official Codex, backs up and removes `%USERPROFILE%\.codex\auth.json`, starts official Codex, and waits for you to log in there. After login, return to the GUI and click `导入/新增当前`.

Local token usage:

- The left rail includes a dedicated `Usage / 用量` page above `Settings / 设置`.
- The usage page shows local token usage for `Selected Day`, `Last 7 Days`, and `This Month`.
- The page includes a calendar-icon stats date picker. Selecting a date shows that day plus the previous 6 calendar days.
- The picker refreshes its maximum selectable date each time it opens, so the current day remains selectable even if the app stays open across midnight.
- If the user has not manually selected a historical date, the usage page follows today whenever it refreshes or is reopened. After a historical date is selected, that date is kept until the user selects today again.
- The page uses a left-side bar chart for daily totals across the selected 7-day window and marks the highest and lowest non-zero days.
- The right-side chart shows daily cache hit rate across the same selected 7-day window, calculated as `cached_input_tokens / input_tokens`.
- The top summary includes average cache hit rate for the selected 7-day window, calculated from total cached input tokens divided by total input tokens in that window.
- Token usage stats refresh on the same schedule as account usage refresh. The configured `Usage auto-refresh interval` drives both account quota refresh and local token-stat refresh while the GUI is open.
- This is calculated from `%USERPROFILE%\.codex\sessions\**\rollout-*.jsonl` and `%USERPROFILE%\.codex\archived_sessions\**\rollout-*.jsonl`.
- The parser only reads `timestamp` and `payload.info.last_token_usage`; it does not display conversation text.
- The statistic is accurate for local rollout records that contain `last_token_usage`, but it is not OpenAI billing data, not cross-device usage, and not currently split by account because Codex rollout usage events do not provide a stable account ID.
- If Codex logs are deleted, archived elsewhere, or created by a Codex version that did not write `last_token_usage`, those tokens cannot be counted.

The launcher reads `HTTP_PROXY` / `HTTPS_PROXY`. If those are missing, it also reads the current Windows user proxy setting from:

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings
```

For example, a local proxy such as `127.0.0.1:7897` will be normalized to `http://127.0.0.1:7897`.

## HTTP-only mode

Enable `设置 / Settings -> 网络连接 / Network -> HTTP-only mode` when a proxy makes WebSocket connections repeatedly reconnect. The Switcher fully closes official Codex, selects a custom provider with `supports_websockets = false`, migrates rollout and SQLite history provider tags so existing threads remain visible, and reopens Codex if it was running.

The config change is reversible. SQLite safety backups and the provider migration manifest stay under `%USERPROFILE%\.codex\secure-switcher-history-backups`. The manifest contains provider metadata only, not auth tokens, API keys, or conversation bodies.

## Settings

Open `设置 / Settings` from the left rail to change:

- UI language.
- Color theme: follow system, light, or dark.
- Usage auto-refresh interval, from 1 to 60 minutes.
- Low-quota warning.
- Auto-switch when the current account is exhausted.
- Manual switch confirmation.
- HTTP-only transport for unstable WebSocket proxy environments.
- Window close behavior: ask every time, minimize to the taskbar, minimize to the system tray, or quit the app.
- Open the `%USERPROFILE%\.codex` folder.
- Fully quit the Switcher app.

Current UI direction:

- Account management and settings are separate views, so the account search/list UI does not overlap the settings page.
- The left rail only keeps account navigation and settings navigation. The `.codex` folder opener lives inside `设置 / Settings -> 应用 / App`.
- Low-quota warning and auto-switch controls are grouped vertically in one compact account-page control.
- Color theme uses a three-option segmented control instead of a dropdown.
- The account list and account detail panes can be resized with the center splitter. The ratio is saved locally as `accountListPanePercent` in `settings.json`, and double-clicking the splitter restores the default width.
- Account cards and detail usage cards adapt to narrow pane widths. The usage rings keep a stable visual size, long account text is clipped or wrapped where appropriate, and the left rail keeps a dark hover/active state for readability.
- Selecting an account updates only the row selection state and the detail panel, preserving the account list scroll position.

Close behavior:

- On the first window close, the app asks whether to minimize or quit. If you choose `Always use this action`, the choice is saved locally in `settings.json`.
- If close behavior is set to `Minimize window`, clicking the window close button minimizes the app.
- If close behavior is set to `Minimize to tray`, clicking the window close button hides the app from the taskbar and keeps a tray icon. Use the tray menu or double-click/click the tray icon to show the window again.
- To fully quit after minimizing, either use `设置 / Settings -> 应用 / App -> 退出应用 / Quit App`, or right-click the minimized taskbar window and choose `关闭窗口 / Close window`.
- To fully quit after minimizing to tray, use the tray menu `退出应用 / Quit App` or the Settings page quit button.
- No account tokens or API keys are stored in settings.

Relevant implementation paths:

- Main close/quit behavior: `src/main.js`.
- Renderer IPC allowlist for quit: `src/preload.cjs`.
- Auto-switch quiet-period decision: `src/core/activity-switching.js`.
- Main-process network error classification: `src/core/main-errors.js`.
- Usage-refresh error classification: `src/core/refresh-status.js`.
- Usage-date follow-today logic: `src/core/usage-date.js`.
- Settings UI and event handling: `src/renderer/index.html` and `src/renderer/app.js`.
- Settings, usage charts, and theme styles: `src/renderer/styles.css`.
- Account switching, queued auto-switch activity checks, local token usage aggregation, DPAPI auth storage, and settings normalization: `src/services/account-service.js`.

## Current scope

This MVP supports importing the current Codex auth file, refreshing usage, manual switching, and choosing a best account by remaining quota. The usage endpoint is based on ChatGPT/Codex private usage responses, so it is designed to fail closed when the upstream shape changes.
