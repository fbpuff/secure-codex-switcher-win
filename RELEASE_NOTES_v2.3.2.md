# v2.3.2 Release Notes

## 中文

本版本是 v2.3 系列的稳定性修复版本，重点解决自动切换误判、后台网络断连提示、401 登录态说明和用量日期跨天不跟随的问题。

### 更新内容

- 自动切换从“检测到空闲就立即切换”调整为“检测到 Codex 活动后，需要连续空闲 90 秒才切换”，降低对话刚结束或日志仍写入时误切账号的风险。
- 后台代理或远端导致的 `SocketError`、`UND_ERR_SOCKET`、`ECONNRESET`、`ETIMEDOUT` 等可恢复网络错误会写入主进程日志并显示为界面状态，不再作为致命弹窗中断应用。
- 账号用量刷新遇到 401 时，会明确提示该账号需要刷新登录态，而不是只显示原始 IPC/fetch 报错。
- 用量页日期在未手动选择历史日期时会自动跟随今天；如果用户手动选择了历史日期，则保留该选择。
- 新增针对自动切换决策、主进程错误分类、用量刷新错误分类和用量日期逻辑的单元测试。

### 安装/更新

```powershell
git pull
cd secure-codex-switcher-win
npm install
npm test
npm start
```

如果使用桌面快捷方式安装：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-CodexSwitcher.ps1
```

### 安全说明

- 本版本不新增远程 UI、本地 HTTP 服务或插件系统。
- 账号 auth JSON 仍使用 Windows DPAPI `CurrentUser` 加密保存。
- README 已补充自动切换、401 登录态刷新、用量日期和相关实现路径。

## English

This is a v2.3 stability release focused on safer auto-switch timing, recoverable network-disconnect handling, clearer 401 login-refresh messaging, and usage-date behavior across day changes.

### Changes

- Auto-switch now requires 90 seconds of continuous quiet time after detected Codex activity before switching accounts, reducing the risk of switching immediately after a conversation finishes or while local activity files are still being updated.
- Recoverable proxy/remote disconnects such as `SocketError`, `UND_ERR_SOCKET`, `ECONNRESET`, and `ETIMEDOUT` are logged and surfaced as UI status instead of fatal main-process dialogs.
- 401 usage-refresh failures are classified as login-refresh-needed states instead of raw IPC/fetch errors.
- The usage dashboard follows today unless the user manually selected a historical date. Historical selections are preserved until the user selects today again.
- Added unit coverage for auto-switch decisions, main-process error classification, usage-refresh classification, and usage-date behavior.

### Install/Update

```powershell
git pull
cd secure-codex-switcher-win
npm install
npm test
npm start
```

If using the desktop shortcut installer:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-CodexSwitcher.ps1
```

### Security Notes

- This release does not add remote UI, a local HTTP server, or a plugin system.
- Imported auth JSON remains encrypted with Windows DPAPI `CurrentUser`.
- README files now document the auto-switch timing, 401 login-refresh behavior, usage-date behavior, and implementation paths.
