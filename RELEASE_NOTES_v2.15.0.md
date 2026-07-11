# Secure Codex Switcher v2.15.0

## English

This release replaces the previous public v2.3.2 baseline with the completed local Windows application.

### Highlights

- DPAPI-encrypted multi-account storage.
- Verified ChatGPT Codex process closure before authentication replacement.
- One-time manual next-account selection with scored fallback.
- 5-hour and 7-day quota-aware ranking and reset display.
- Active task protection based on process, rollout activity, and task lifecycle events.
- Daily and weekly local Token reports with account, model, and reasoning-effort dimensions.
- Independent reset detection and evidence-aware capacity estimates.
- Packaged Windows installer, tray behavior, unified product icons, and responsive UI.
- Reduced scroll jank and redundant background rendering.
- Complete matching English and Simplified Chinese documentation.

### Privacy

- No credentials, account stores, sessions, logs, reports, caches, backups, or local development history are included.
- Authentication records remain local and are encrypted with Windows DPAPI.
- Release assets were checked against the published SHA-256 values.

## 中文

本版本将公开仓库从旧的 v2.3.2 基线更新为已经完成的 Windows 本地应用。

### 主要更新

- 使用 DPAPI 加密保存多个账号。
- 替换认证前验证 ChatGPT Codex 已完全关闭，避免假切换。
- 支持一次性的指定下次账号，并在不可用时按评分回退。
- 综合 5 小时和 7 天额度进行排序并显示重置时间。
- 结合进程、rollout 活动和任务生命周期事件保护未完成任务。
- 提供按账号、模型和思考强度分类的每日及每周本地 Token 报告。
- 独立识别额度重置，并提供基于证据的容量估算。
- 提供正式 Windows 安装包、托盘行为、统一图标和响应式界面。
- 减少滚动卡顿和后台重复渲染。
- 提供内容对应的英文与简体中文文档。

### 隐私

- 不包含凭据、账号存储、会话、日志、报告、缓存、备份或本地开发历史。
- 认证记录只保存在本机，并使用 Windows DPAPI 加密。
- Release 资产可使用公开的 SHA-256 值进行校验。
