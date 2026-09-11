# Publication privacy / 公开发布隐私说明

## 中文

本仓库发布应用源码、合成测试数据、公开说明、构建脚本和产品图标，不发布真实用户的运行数据。

- 不提交认证文件、账号存储、设置、会话、续接票据、内部任务记录、数据库、截图、日志、报告、备份或安装产物。
- DPAPI 密文同样属于私人数据；加密不构成上传理由。
- 此次源码更新基于既有公开历史创建快照，不导入私人开发历史或个人 Git 邮箱。公开提交使用 GitHub noreply 身份。
- 既有公开历史保留。`.gitignore` 只能帮助避免新增误提交，不能删除旧提交中的内容。推送前仍须检查实际暂存内容、提交身份与将要发布的历史。
- 提交 issue 或诊断日志前，请移除账号标识、邮箱、个人路径、会话标识、提示词、回复正文及凭据；仅提供复现所需的最少信息。
- 若凭据已泄漏，应立即撤销或轮换，并处理仓库历史；仅删除当前文件不足以撤销泄漏。

这些措施降低意外泄漏风险，不构成绝对隐私保证。程序使用 Windows DPAPI 保护本地保存的认证信息，但不能防御已取得相同 Windows 用户权限的恶意程序。

## English

This repository publishes application source, synthetic test fixtures, public documentation, build scripts, and product icons, not real user runtime data.

- Do not commit authentication files, account stores, settings, sessions, resume tickets, internal task records, databases, screenshots, logs, reports, backups, or build artifacts.
- DPAPI ciphertext is still private data. Encryption is not a reason to upload it.
- This source update is a snapshot on the existing public history. It does not import private development history or personal Git email addresses. Public commits use a GitHub noreply identity.
- Existing public history is preserved. `.gitignore` helps prevent new accidental additions; it does not erase earlier commits. Review the actual staged contents, commit identities, and outgoing history before pushing.
- Before sharing issues or diagnostics, remove account identifiers, email addresses, personal paths, session identifiers, prompts, responses, and credentials. Share only the minimum evidence needed to reproduce the issue.
- Revoke or rotate any exposed credentials immediately and address repository history. Deleting the current file alone does not undo exposure.

These precautions reduce accidental disclosure; they are not an absolute privacy guarantee. Windows DPAPI protects saved local authentication data at rest, but not against malicious processes running with the same Windows user privileges.
