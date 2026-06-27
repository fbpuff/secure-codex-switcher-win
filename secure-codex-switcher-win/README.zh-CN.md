# Windows 版 Secure Codex Switcher

一个本地优先的 Windows Codex / ChatGPT 登录态切换工具。

English documentation: [README.md](README.md).

## 版本

- `v1.1`：账号列表和详情面板可调宽度，优化响应式账号卡片，补充 HTTP-only 模式文档，并改进自动切换延迟策略。
- `v2.1`：排队式自动切换。Codex 正在运行时不再只做一次延迟判断，而是排队目标账号，每 15 秒检查一次，等 Codex 退出后完成切换。
- `v2.2`：基于对话活动的自动切换。只有检测到 Codex 对话或任务仍活跃时才等待；如果 Codex 打开但空闲，排队切换可以继续完成。
- `v2.3.0`：新增独立本地 token 用量页面，支持选择统计日期、7 天每日用量横条图、7 天每日缓存命中率横条图、与账号余量一致的刷新节奏，以及中英文文档。
- `v2.3.1`：修复用量页面日期选择器。统计日期现在只通过日历图标选择，并且每次打开日历前都会刷新最大可选日期。
- `v2.3.2`：稳定性修复。自动切换在检测到对话活动后会等待 90 秒连续空闲再切换；后台网络断连会记录日志并在界面提示，不再弹出主进程错误；401 用量刷新失败会明确提示需要刷新登录态；用量日期在未手动选择历史日期时会自动跟随今天。

## 安全模型

- 不启动本地 HTTP 服务。
- 没有插件系统。
- 不加载远程 UI 内容。
- Renderer 只通过有限 IPC 白名单与主进程通信。
- 账号 auth JSON 使用 Windows DPAPI `CurrentUser` 加密保存。
- 切换账号前会用 DPAPI 加密备份 `%USERPROFILE%\.codex\auth.json`，写入时使用原子写入。
- 日志和界面摘要不会显示原始 token。

## 安装和运行

要求：

- Windows 10 或 Windows 11。
- Node.js 22.12 或更新版本。
- npm。
- 已安装官方 Codex，并且能生成 `%USERPROFILE%\.codex\auth.json`。

从 GitHub 安装：

```powershell
git clone https://github.com/<your-org-or-username>/secure-codex-switcher-win.git
cd secure-codex-switcher-win
npm install
npm test
npm start
```

更新已有目录：

```powershell
cd secure-codex-switcher-win
git pull
npm install
npm test
npm start
```

开发检查：

```powershell
npm audit --omit=dev
npm test
node --check src\main.js
node --check src\preload.cjs
node --check src\renderer\app.js
node --check src\services\account-service.js
```

## 登录和导入账号

本应用导入官方 Codex 的 auth 文件：

```text
%USERPROFILE%\.codex\auth.json
```

首次使用：

1. 打开 PowerShell。
2. 运行 `codex`。
3. 按官方 Codex 登录流程操作，选择 ChatGPT/Codex 登录，不要只使用 API key 模式。
4. 确认 `%USERPROFILE%\.codex\auth.json` 存在，并包含 `tokens` 字段。
5. 打开本 GUI，点击 `导入/新增当前`。

添加另一个账号：

1. 在官方 Codex 应用或 CLI 中登录或切换到另一个 ChatGPT/Codex 账号，让 `%USERPROFILE%\.codex\auth.json` 发生变化。
2. 回到本 GUI。
3. 点击 `导入/新增当前`。
4. 应用会将其作为一个本地加密账号加入；如果已经导入过，则更新现有记录。

浏览器里单独登录 ChatGPT 不会更新 `%USERPROFILE%\.codex\auth.json`。本应用不内嵌 OpenAI OAuth WebView，只导入官方 Codex 生成的 auth 文件。

`最佳账号分数` 不是 OpenAI 的独立配额，而是本应用用于选择切换目标的评分：

```text
7 天剩余 * 0.7 + 5 小时剩余 * 0.3
```

支持的 auth 结构：

- 旧格式顶层 token：`access_token`、`refresh_token`、`account_id`。
- 新格式嵌套 token：`tokens.access_token`、`tokens.refresh_token`、`tokens.account_id`。

## 余量刷新、自动切换和代理

账号余量刷新会访问 ChatGPT/Codex usage 接口。如果当前网络不能直接访问 `chatgpt.com`，请先启动代理或 VPN。

刷新行为：

- 点击 `导入/新增当前` 会刷新刚导入的账号。
- 点击 `刷新全部` 会立即刷新所有账号。
- 点击单个账号的 `刷新` 会刷新该账号。
- GUI 打开期间会后台刷新所有账号，默认间隔 5 分钟，可在 `设置 / Settings` 中修改。
- 开启 `低余量提醒` 后，当前账号剩余低于 15% 时会在账号页显示红色内联提醒。
- 开启 `用尽后自动切换` 后，只有当前账号耗尽时才会自动切换到最佳可用账号。15% 阈值只是提醒，不会触发切换。
- 自动切换是活动感知的：如果 Codex 对话或任务仍活跃，Switcher 会排队目标账号，显示红色内联提示，每 15 秒检查一次，等 Codex 连续空闲 90 秒后完成切换，降低对话刚结束就误切的风险。
- 切换时会写入 `%USERPROFILE%\.codex\auth.json`，关闭官方 Codex 进程，然后重新启动官方 Codex，使新账号生效。
- 官方 Codex 刷新当前账号 auth 文件时，Switcher 会自动同步更新匹配的本地加密账号记录。
- 如果某个保存账号的用量接口返回 401，界面会标记该账号需要刷新登录态。通常需要先切换到该账号，重新打开官方 Codex，让官方 Codex 刷新 auth 后再回到 Switcher 刷新或重新导入。
- 删除非当前账号只删除 Switcher 本地加密记录，不关闭官方 Codex。
- 删除当前账号时有两个选择：
  - 选择一个已有账号，Switcher 会写入该账号、关闭官方 Codex 并重新启动；
  - 选择登录新账号，Switcher 会关闭官方 Codex，备份并删除 `%USERPROFILE%\.codex\auth.json`，启动官方 Codex 等待登录。登录完成后回到 GUI 点击 `导入/新增当前`。

启动脚本会读取 `HTTP_PROXY` / `HTTPS_PROXY`。如果未设置，也会读取当前 Windows 用户代理：

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings
```

例如 `127.0.0.1:7897` 会被规范化为 `http://127.0.0.1:7897`。

## 本地 token 用量

左侧导航栏中有独立的 `用量 / Usage` 页面，位置在 `设置 / Settings` 上方。

用量页面包括：

- `选中日`、`近 7 天`、`本月` token 总量。
- `平均缓存命中率`，口径为选中 7 天窗口内 `cached_input_tokens / input_tokens`。
- 通过日历图标打开统计日期选择器。选择某一天后，会显示该日和前 6 个自然日，共 7 天。
- 每次打开日期选择器前都会刷新最大可选日期，即使应用跨天未重启，也能选择当天。
- 如果用户没有手动选择历史日期，用量页会在刷新或重新进入页面时自动切换到今天；手动选择历史日期后会保留该日期，直到再次选择今天。
- 左侧横条图显示选中 7 天窗口内每天的 token 总量，并标记最高和最低非零日期。
- 右侧横条图显示同一个 7 天窗口内每天的缓存命中率。
- 横条宽度按比例显示：最高日为 100%，其他日期按 `当天 token / 最高日 token` 缩放；命中率按 0-100% 缩放。

数据来源：

- `%USERPROFILE%\.codex\sessions\**\rollout-*.jsonl`
- `%USERPROFILE%\.codex\archived_sessions\**\rollout-*.jsonl`

解析器只读取：

- `timestamp`
- `payload.info.last_token_usage`

不会显示对话正文。

准确性边界：

- 对本机 rollout 日志中存在 `last_token_usage` 的记录，统计是真实汇总，不是估算。
- 这不是 OpenAI 官方账单，不包含其他设备使用量。
- 如果 Codex 日志被删除、移动到其他位置，或由未写入 `last_token_usage` 的旧版本生成，对应 token 无法统计。
- 当前不能稳定按账号拆分，因为 Codex rollout usage 事件没有稳定账号 ID。
- token 用量统计和账号余量刷新使用同一个后台刷新间隔；如果账号余量联网刷新失败，本地 token 统计仍会尝试刷新。

## HTTP-only 模式

当代理环境导致 WebSocket 反复 reconnect 时，可以开启：

```text
设置 / Settings -> 网络连接 / Network -> HTTP-only mode
```

开启后，Switcher 会完全关闭官方 Codex，选择一个 `supports_websockets = false` 的自定义 provider，并迁移 rollout 和 SQLite 历史会话 provider 标记，使已有线程继续可见。如果修改前 Codex 正在运行，完成后会重新打开。

该配置可逆。SQLite 安全备份和 provider 迁移 manifest 位于：

```text
%USERPROFILE%\.codex\secure-switcher-history-backups
```

manifest 只包含 provider 元数据，不包含 auth token、API key 或对话正文。

## 设置

从左侧导航打开 `设置 / Settings` 可以修改：

- 界面语言。
- 颜色主题：跟随系统、亮色、暗色。
- 余量自动刷新间隔，范围 1-60 分钟。
- 低余量提醒。
- 当前账号耗尽后自动切换。
- 手动切换确认。
- HTTP-only 网络传输。
- 关闭窗口行为：每次询问、最小化到任务栏、最小化到托盘、退出应用。
- 打开 `%USERPROFILE%\.codex` 文件夹。
- 完全退出 Switcher。

关闭行为：

- 第一次点击窗口关闭按钮时，应用会询问最小化或退出。如果勾选 `以后均保持此操作`，选择会保存在 `settings.json`。
- `最小化窗口`：点击关闭按钮后最小化到任务栏。
- `最小化到托盘`：点击关闭按钮后从任务栏隐藏并保留托盘图标。点击或双击托盘图标可恢复窗口。
- 最小化后如需彻底退出，可在设置页点击 `退出应用`，或通过托盘菜单点击 `退出应用`。
- 设置文件不会保存账号 token 或 API key。

## 实现路径

- 主进程关闭、托盘和 IPC：`src/main.js`
- Renderer IPC 白名单：`src/preload.cjs`
- 自动切换空闲等待决策：`src/core/activity-switching.js`
- 主进程网络错误分类：`src/core/main-errors.js`
- 用量刷新错误分类：`src/core/refresh-status.js`
- 用量日期跟随今天逻辑：`src/core/usage-date.js`
- 设置、用量页面和事件处理：`src/renderer/index.html`、`src/renderer/app.js`
- 主题、设置和用量图表样式：`src/renderer/styles.css`
- 账号切换、自动切换活动检测、本地 token 聚合、DPAPI 存储和设置规范化：`src/services/account-service.js`

## 当前范围

当前版本支持导入官方 Codex auth 文件、刷新账号余量、手动切换、按剩余额度选择最佳账号、活动感知自动切换、HTTP-only 代理环境修复，以及本机 token 用量统计。账号余量接口基于 ChatGPT/Codex 私有 usage 响应，上游结构变化时会失败关闭而不是误报。
