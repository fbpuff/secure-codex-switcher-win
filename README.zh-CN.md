# Secure Codex Switcher for Windows

一个本地优先的 Windows 图形界面工具，用来管理多个官方 Codex / ChatGPT 登录态，查看用量，并在账号之间切换。账号数据使用 Windows DPAPI 加密保存。

[English README](./README.md)

这个项目适合已经使用官方 Codex 应用或 CLI 的用户。它不会提供或绕过 OpenAI 登录流程，登录仍然由官方 Codex 完成。

## 功能

- Windows GUI：导入、查看、刷新、切换和删除本地 Codex 账号。
- 使用 Windows DPAPI `CurrentUser` 加密保存导入的 auth JSON。
- 切换账号时原子写入 `%USERPROFILE%\.codex\auth.json`。
- 切换前会把旧 auth 文件做 DPAPI 加密备份，而不是明文备份。
- 切换或删除当前账号前会关闭官方 Codex 进程，避免旧登录态仍留在内存中。
- 切换后可以自动重新打开官方 Codex。
- 支持新版 Codex `tokens` 嵌套 auth 结构。
- GUI 打开时会定时刷新用量，并在接口允许时显示 5 小时 / 7 天窗口。
- 支持低余量提醒；自动切换只会在当前账号用尽时触发。
- GUI 支持中文和英文，选择会保存到本地设置。

## 安全模型

这个项目刻意压低攻击面：

- 没有本地 HTTP server。
- 没有插件系统。
- 没有远程 UI 内容。
- 没有内嵌 OAuth webview。
- 没有明文账号 store。
- 没有明文 auth 备份。
- Renderer 只能通过很小的 Electron IPC allowlist 调用主进程。
- 日志和界面不会打印原始 access token / refresh token。
- 运行态账号文件已经通过 `.gitignore` 排除。

相比一些简单账号切换器或早期方案，这个版本主要加强在：

- 明文 token 存储改为 DPAPI 加密。
- 明文备份改为 `.dpapi` 加密备份。
- 切换前关闭官方 Codex，避免旧登录态残留。
- 同时支持旧版顶层 token 和新版 `tokens` 嵌套结构。
- 用量刷新失败只作为状态显示，不会暴露 token。
- GUI renderer 不直接发起网络请求；用量请求在主进程中执行。

它仍然是一个会处理敏感 auth 材料的本地工具。不要上传你的 `%USERPROFILE%\.codex\auth.json`、应用数据目录、`.dpapi` 备份文件，或包含完整账号标识的截图。

## 安装要求

- Windows 10 或 Windows 11。
- Node.js 22.12 或更高版本，以及 npm。
- Git，或 GitHub Desktop，或能下载仓库 ZIP。
- 已安装官方 Codex 应用/CLI，并能生成 `%USERPROFILE%\.codex\auth.json`。

## 从 GitHub 安装

克隆仓库：

```powershell
git clone https://github.com/your-org-or-username/secure-codex-switcher-win.git
cd secure-codex-switcher-win
```

运行安装脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-CodexSwitcher.ps1
```

脚本会：

- 在 `secure-codex-switcher-win` 中安装 npm 依赖；
- 运行测试；
- 创建桌面快捷方式 `Codex Switcher`。

之后可以双击桌面图标启动，或运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Start-CodexSwitcher.ps1
```

## 手动运行

```powershell
cd .\secure-codex-switcher-win
npm install
npm test
npm start
```

## 导入第一个账号

GUI 会导入官方 Codex 的 auth 文件：

```text
%USERPROFILE%\.codex\auth.json
```

首次使用流程：

1. 打开官方 Codex，或在 PowerShell 里运行 `codex`。
2. 按官方流程完成 ChatGPT/Codex 登录。
3. 确认 `%USERPROFILE%\.codex\auth.json` 已存在。
4. 打开 Codex Switcher。
5. 点击 `导入/新增当前`。

如果官方 Codex 询问 auth method，选择 ChatGPT/Codex 登录，不要选择纯 API key 模式。

## 添加另一个账号

1. 在官方 Codex 里退出或切换到另一个 ChatGPT/Codex 账号。
2. 确认 `%USERPROFILE%\.codex\auth.json` 已变成新账号。
3. 回到 Codex Switcher。
4. 点击 `导入/新增当前`。

浏览器登录本身不够。这个工具只导入官方 Codex 生成的 auth 文件，不读取浏览器 cookie。

## 切换账号

切换时应用会：

1. 关闭官方 Codex 进程；
2. DPAPI 加密备份当前 auth 文件；
3. 把目标账号写入 `%USERPROFILE%\.codex\auth.json`；
4. 标记目标账号为当前账号；
5. 尝试重新打开官方 Codex。

删除非当前账号只会删除本地加密记录，不影响官方 Codex。

删除当前账号有两种选择：

- 切换到一个已经导入的账号；
- 清除当前 auth 并重新打开官方 Codex，让你登录新账号。

## 用量刷新

用量刷新依赖 ChatGPT/Codex 的用量接口。该接口不是稳定公开 API，所以即使账号切换可用，用量显示也可能失败。

刷新行为：

- `导入/新增当前` 会刷新刚导入的账号。
- `刷新全部` 会立即刷新所有账号。
- 单个账号的 `刷新` 只刷新该账号。
- GUI 打开时，每 5 分钟后台刷新一次。
- 低余量提醒默认在剩余 15% 或以下时显示。
- 自动切换只在当前账号用尽时触发。

常见失败：

- `401`：保存的登录态被用量接口拒绝。切换到该账号，重新打开官方 Codex，让它刷新 auth；仍失败时重新登录并导入。
- `403`：账号可能仍可切换，但非公开用量接口拒绝显示用量。
- 网络超时：先启动代理/VPN，再刷新。

启动脚本会读取 `HTTP_PROXY`、`HTTPS_PROXY` 和 Windows 当前用户代理设置。

## HTTP-only 模式

在 `设置 -> 网络连接 -> HTTP-only 模式` 中，可以让官方 Codex 使用 Responses HTTP/SSE 传输，并通过独立的自定义 provider 设置 `supports_websockets = false`，减少代理环境下 WebSocket 反复 reconnect 的情况。

修改此设置时，Switcher 会：

1. 完全关闭官方 Codex；
2. 迁移活动和归档 rollout 元数据中的 `model_provider`；
3. 更新 `state_*.sqlite` 中对应的 provider 字段；
4. 写入或移除 `%USERPROFILE%\.codex\config.toml` 中由 Switcher 管理的配置段；
5. 仅在修改前 Codex 正在运行时自动重新打开。

迁移历史标记是必要步骤，因为 Codex 会按 `model_provider` 过滤侧栏。只修改配置不会删除旧对话，但旧对话可能会像“消失”一样被隐藏。

安全措施：

- rollout 文件采用原子替换，只修改第一行会话元数据；
- SQLite 修改在事务中完成；
- SQLite 备份和可恢复迁移清单保存在 `%USERPROFILE%\.codex\secure-switcher-history-backups`；
- Switcher 管理的配置段可以撤销，并恢复原来的顶层 `model_provider`；
- 迁移清单不保存 auth token、API key 或对话正文。

## 设置与退出

从左侧栏打开 `设置 / Settings` 可以修改：

- 界面语言。
- 颜色主题：跟随系统、亮色、暗色。
- 用量自动刷新间隔。
- 低余量提醒。
- 当前账号用尽后的自动切换。
- 手动切换前确认。
- 适用于 WebSocket 代理不稳定环境的 HTTP-only 传输。
- 窗口关闭行为。
- 打开 `%USERPROFILE%\.codex` 文件夹。
- 彻底退出 Switcher 应用。

当前界面调整方向：

- 账号管理和设置页拆成独立视图，避免账号搜索框、账号列表遮挡设置内容。
- 左侧栏只保留账号和设置两个导航入口；`.codex` 文件夹入口移动到 `设置 -> 应用`。
- `低余量提醒` 和 `用尽后自动切换` 在账号页中改成上下排列的组合控件。
- 颜色主题改成三段按钮，不再使用下拉框。

关闭行为：

- 首次关闭窗口时，应用会询问最小化还是退出；如果勾选“以后均保持此操作”，选择会保存到本地 `settings.json`。
- 如果关闭行为设置为“最小化窗口”，点击窗口关闭按钮会最小化。
- 最小化后想彻底退出，可以进入 `设置 -> 应用 -> 退出应用`，也可以在任务栏右键窗口并选择 `关闭窗口`。
- `settings.json` 只保存行为配置，不保存账号 token 或 API key。

相关实现路径：

- 主进程关闭/退出逻辑：`secure-codex-switcher-win/src/main.js`。
- Renderer 退出 IPC allowlist：`secure-codex-switcher-win/src/preload.cjs`。
- 设置页结构和事件：`secure-codex-switcher-win/src/renderer/index.html`、`secure-codex-switcher-win/src/renderer/app.js`。
- 设置页布局和主题样式：`secure-codex-switcher-win/src/renderer/styles.css`。
- HTTP-only 配置管理：`secure-codex-switcher-win/src/core/codex-config.js`。
- 历史 provider 迁移：`secure-codex-switcher-win/src/core/codex-history.js`。

## 别人能否直接安装

可以，只要对方是 Windows 且安装了 Node.js 22.12 或更高版本及 npm。仓库里包含源码、启动脚本、安装脚本、测试和依赖锁文件。

目前它不是签名 `.exe` 安装包，而是源码安装。这样更透明：依赖来自 `package-lock.json`，用户可以先审查代码再运行。

## 关于整合成一个 EXE

打包成单个 Windows 安装包或 exe 并不天然更不安全。如果包里只包含应用代码和运行依赖，安全模型可以保持一致。

风险主要转移到分发和供应链：

- release artifact 必须从干净 checkout 构建；
- 不能把 `auth.json`、`accounts-store.json`、`.dpapi` 备份、`.env` 等运行态数据打进包；
- 构建应使用锁文件和可复现步骤；
- 用户应能确认 release 对应的源码 commit；
- 正式发布最好做代码签名；
- 如果以后加入自动更新，必须校验更新签名。

所以当前公开项目先保持源码安装，是更透明、更容易审计的方式。后续可以增加签名安装包，而不改变本地安全模型。

## 开发

```powershell
cd .\secure-codex-switcher-win
npm install
npm test
npm run audit:prod
npm start
```

## 仓库卫生

仓库已经忽略运行态和敏感文件：

- `node_modules/`
- `auth.json`
- `accounts-store.json`
- `settings.json`
- `*.dpapi`
- `.env`
- `secure-switcher-backups/`

发布前建议运行：

```powershell
git status --short
npm test
npm run audit:prod
```
