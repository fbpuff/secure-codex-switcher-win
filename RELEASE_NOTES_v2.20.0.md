# Secure Codex Switcher v2.20.0

## 中文

- 删除维护者特定安装目录和数据目录的硬编码依赖。
- 普通安装继续使用 `%APPDATA%\secure-codex-switcher-win`。
- 使用旧自定义数据目录的用户应通过应用的 `--user-data-dir` 或启动脚本的 `-UserDataPath` 显式指定原目录。不自动迁移、合并或删除账号数据。
- 启动脚本支持 `-InstallRoot`；未指定时通过脚本目录、既有快捷方式、Windows 卸载注册信息和当前用户的 Programs 目录发现安装位置。多个候选无法唯一确定时要求显式指定。
- 匹配的既有快捷方式中显式配置的数据目录会保留，显式参数可覆盖；保留代理继承、快捷方式修复和应用启动方式。
- 内部正式安装验证要求显式路径参数，保留来源、哈希、快捷方式及进程身份检查；公开构建继续使用 `npm run package:public`。
- 路径清理不改变账号切换、认证、DPAPI、quota 或网络请求逻辑；本版另包含下述自动续接窗口修复。

### 自动续接窗口与任务恢复

- 在聚焦后、提交前和备用提交前，重新验证输入框、提交控件与当前前台根窗口的 UI Automation 祖先关系。只有控件、提示内容、进程、可用状态及稳定前台窗口均匹配时，才接受窗口句柄重新绑定；同进程或拥有者关系本身不足以允许提交。
- 焦点、提示内容或窗口归属无法确认时停止提交，保留现有 rollout 启动证据检查，避免将不确定的输入提交视为恢复成功。
- 增加有界的前台窗口和鼠标点击诊断，记录句柄、进程 ID、状态及尝试序号；不记录窗口标题、输入文本、鼠标坐标或进程路径。事件队列最多记录 64 条，观察线程最长运行 120 秒，并在结束时清理。
- PowerShell 续接脚本改用标准输入传递，避免诊断脚本增长触发 Windows 命令行长度限制。
- 这些变化改善自动续接的窗口识别和故障诊断；自动测试不等于所有真实账号切换后的任务均已成功恢复。

此版本不会修改旧 Release 或旧安装包。更新前请确认原数据目录，并保留相应启动参数，避免打开另一套空账号库。

## English

- Remove hardcoded dependencies on maintainer-specific installation and data directories.
- Ordinary installations continue to use `%APPDATA%\secure-codex-switcher-win`.
- Users of an existing custom data directory should explicitly select it with the application's `--user-data-dir` or the launcher's `-UserDataPath`. Account data is not automatically migrated, merged, or deleted.
- The launcher accepts `-InstallRoot`. Otherwise, it discovers installations through the script directory, existing shortcuts, Windows uninstall registration, and the per-user Programs directory. Ambiguous installations require an explicit path.
- Explicit data-directory arguments in matching existing shortcuts are preserved unless overridden. Proxy inheritance, shortcut repair, and the application launch mechanism are retained.
- Internal formal-install verification requires explicit path parameters while retaining provenance, hash, shortcut, and process identity checks. Public builds continue to use `npm run package:public`.
- Path cleanup does not change account switching, authentication, DPAPI, quota, or network request logic. This release also includes the automatic continuation fixes below.

### Continuation windows and task recovery

- Revalidate UI Automation ancestry between the composer, submit control, and live foreground root after focus, before submission, and before fallback submission. Rebinding requires matching controls, prompt, process, usability, and stable foreground evidence; process equality or ownership alone does not authorize submission.
- Stop submission when focus, prompt, or window ownership cannot be verified. Preserve existing rollout start-evidence checks rather than treating an uncertain submission as successful task recovery.
- Add bounded foreground and mouse-click diagnostics containing handles, process IDs, status, and attempt numbers, without window titles, input text, mouse coordinates, or process paths. The event queue records at most 64 entries; the observer runs for at most 120 seconds and is cleaned up on completion.
- Pass the PowerShell continuation script through standard input to avoid the Windows command-line length limit as diagnostic helpers grow.
- These changes improve continuation window identification and diagnostics. Automated tests do not establish successful recovery after every real account switch.

This version does not change older Releases or installers. Before updating, identify your existing data directory and retain its launch arguments to avoid opening a separate empty account store.
