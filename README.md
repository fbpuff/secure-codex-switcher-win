# Secure Codex Switcher for Windows

A local-only Windows GUI for managing multiple official Codex / ChatGPT auth files, checking usage, and switching accounts with encrypted storage.

[中文说明](./README.zh-CN.md)

This project is designed for users who already use the official Codex app or CLI and want a safer local account switcher. It does not provide or bypass OpenAI login. Login still happens through official Codex.

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
- Node.js LTS with npm.
- Git, or GitHub Desktop, or the ability to download this repository as a ZIP.
- Official Codex app/CLI installed and able to create `%USERPROFILE%\.codex\auth.json`.

## Install From GitHub

Clone the repository:

```powershell
git clone https://github.com/fbpuff/secure-codex-switcher-win.git
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

Common failures:

- `401`: the saved login state was rejected. Switch to that account, reopen official Codex, let it refresh auth, then try again. If it still fails, log in again and re-import.
- `403`: account switching may still work, but the non-public usage endpoint refused usage display.
- Network timeout: start your proxy/VPN, then refresh again.

The launcher reads `HTTP_PROXY`, `HTTPS_PROXY`, and Windows user proxy settings.

## Settings and Window Exit

Open `设置 / Settings` from the left rail to change:

- UI language.
- Color theme: follow system, light, or dark.
- Usage auto-refresh interval.
- Low-quota warning.
- Auto-switch when the current account is exhausted.
- Manual switch confirmation.
- Window close behavior.
- Open the `%USERPROFILE%\.codex` folder.
- Fully quit the Switcher app.

Current UI direction:

- Account management and settings are separate views, so the account search/list UI does not overlap the settings page.
- The left rail only keeps account navigation and settings navigation. The `.codex` folder opener lives inside `设置 / Settings -> 应用 / App`.
- Low-quota warning and auto-switch controls are grouped vertically in one compact account-page control.
- Color theme uses a three-option segmented control instead of a dropdown.

Close behavior:

- On first close, the app asks whether to minimize or quit. If you choose `Always use this action`, the choice is saved locally in `settings.json`.
- If close behavior is set to `Minimize window`, clicking the window close button minimizes the app.
- To fully quit after minimizing, either use `设置 / Settings -> 应用 / App -> 退出应用 / Quit App`, or right-click the minimized taskbar window and choose `关闭窗口 / Close window`.
- No account tokens or API keys are stored in settings.

Relevant implementation paths:

- Main close/quit behavior: `secure-codex-switcher-win/src/main.js`.
- Renderer IPC allowlist for quit: `secure-codex-switcher-win/src/preload.cjs`.
- Settings UI and event handling: `secure-codex-switcher-win/src/renderer/index.html` and `secure-codex-switcher-win/src/renderer/app.js`.
- Settings layout and theme styles: `secure-codex-switcher-win/src/renderer/styles.css`.

## Can Others Install Directly From This Repository?

Yes, if they are on Windows and have Node.js/npm installed. The repository contains the source code, launcher, installer script, tests, and dependency lockfile.

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
