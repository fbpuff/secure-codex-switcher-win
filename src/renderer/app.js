import { autoSwitchQuietSecondsRemaining } from "../core/activity-switching.js";
import { formatBeijingTime, beijingDayStart, previousBeijingWeekStart } from "../core/beijing-time.js";
import { buildReportPresentation, orderReportAccounts } from "../core/report-presentation.js";
import { classifyRefreshResults, isUsageAuthExpiredError } from "../core/refresh-status.js";
import { compareAccountsByScore, exhaustedResetAt, quotaBalanceScore, remainingScore, scoreBreakdown } from "../core/ranking.js";
import { localDateInputValue, nextUsageDateState, usageDateFollowsToday } from "../core/usage-date.js";
import { formatQuotaPercent, quotaDisplayState } from "./quota-display.js";

import { createProgressEtaEstimator } from "../core/progress-eta.js";

const api = window.codexSwitcher;
const RECOVERY_INVENTORY_CACHE_KEY = "codex-recovery-inventory-v1";
const RECOVERY_INVENTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const THREAD_PINNED_OPEN_KEY = "threads-pinned-open-v1";
const THREAD_ORDINARY_OPEN_KEY = "threads-ordinary-open-v1";

const accountsEl = document.querySelector("#accounts");
const appVersionEl = document.querySelector("#app-version");
const detailEl = document.querySelector("#detail");
const statusLine = document.querySelector("#status-line");
const refreshAllButton = document.querySelector("#refresh-all");
const activityDiagnostics = document.querySelector("#activity-diagnostics");
const activityDiagnosticIds = document.querySelector("#activity-diagnostic-ids");
const quotaWarningLine = document.querySelector("#quota-warning-line");
const quotaWarningText = document.querySelector("#quota-warning-text");
const quotaAutoSwitchAction = document.querySelector("#quota-auto-switch-action");
const template = document.querySelector("#account-template");
const autoSwitchInput = document.querySelector("#auto-switch");
const lowQuotaWarningInput = document.querySelector("#low-quota-warning");
const searchInput = document.querySelector("#account-search");
const resultCount = document.querySelector("#result-count");
const metricTotal = document.querySelector("#metric-total");
const metricCurrent = document.querySelector("#metric-current");
const metricBest = document.querySelector("#metric-best");
const scoreHelp = document.querySelector("#score-help");
const scoreHelpButton = document.querySelector("#score-help-button");
const scoreHelpTitle = document.querySelector("#score-help-title");
const scoreHelpFormula = document.querySelector("#score-help-formula");
const scoreHelpResetRule = document.querySelector("#score-help-reset-rule");
const scoreHelpMissingRule = document.querySelector("#score-help-missing-rule");
const scoreHelpEligibilityRule = document.querySelector("#score-help-eligibility-rule");
const scoreHelpAccount = document.querySelector("#score-help-account");
const scoreHelpFiveRemainingLabel = document.querySelector("#score-help-five-remaining-label");
const scoreHelpWeekRemainingLabel = document.querySelector("#score-help-week-remaining-label");
const scoreHelpFiveResetLabel = document.querySelector("#score-help-five-reset-label");
const scoreHelpWeekResetLabel = document.querySelector("#score-help-week-reset-label");
const scoreHelpFiveRemaining = document.querySelector("#score-help-five-remaining");
const scoreHelpWeekRemaining = document.querySelector("#score-help-week-remaining");
const scoreHelpFiveReset = document.querySelector("#score-help-five-reset");
const scoreHelpWeekReset = document.querySelector("#score-help-week-reset");
const replacementDialog = document.querySelector("#replacement-dialog");
const replacementSelect = document.querySelector("#replacement-select");
const replacementField = document.querySelector("#replacement-field");
const replacementConfirm = document.querySelector("#replacement-confirm");
const manualSwitchDialog = document.querySelector("#manual-switch-dialog");
const manualSwitchDialogIntro = document.querySelector("#manual-switch-dialog-intro");
const manualSwitchResume = document.querySelector("#manual-switch-resume");
const manualSwitchForce = document.querySelector("#manual-switch-force");
const remarkDialog = document.querySelector("#remark-dialog");
const remarkInput = document.querySelector("#remark-input");
const remarkCancel = document.querySelector("#remark-cancel");
const languageSelect = document.querySelector("#language-select");
const accountsNav = document.querySelector("#accounts-nav");
const threadsNav = document.querySelector("#threads-nav");
const usageNav = document.querySelector("#usage-nav");
const reportsNav = document.querySelector("#reports-nav");
const settingsNav = document.querySelector("#settings-nav");
const accountsView = document.querySelector("#accounts-view");
const accountsTopbar = document.querySelector("#accounts-topbar");
const metricsStrip = document.querySelector("#metrics-strip");
const accountsWorkspace = document.querySelector("#accounts-workspace");
const listPanel = document.querySelector(".list-panel");
const accountsSplitter = document.querySelector("#accounts-splitter");
const threadsView = document.querySelector("#threads-view");
const threadsActiveList = document.querySelector("#threads-active-list");
const threadsActiveCount = document.querySelector("#threads-active-count");
const threadsSearch = document.querySelector("#threads-search");
const threadsShowArchived = document.querySelector("#threads-show-archived");
const threadsShowInternal = document.querySelector("#threads-show-internal");
const threadsShowUnregistered = document.querySelector("#threads-show-unregistered");
const threadsSearchStatus = document.querySelector("#threads-search-status");
const threadsSearchResults = document.querySelector("#threads-search-results");
const usageView = document.querySelector("#usage-view");
const refreshTokenUsageButton = document.querySelector("#refresh-token-usage");
const usageTotalToday = document.querySelector("#usage-total-today");
const usageTotalSevenDays = document.querySelector("#usage-total-seven-days");
const usageTotalMonth = document.querySelector("#usage-total-month");
const usageAverageCache = document.querySelector("#usage-average-cache");
const usageBarChart = document.querySelector("#usage-bar-chart");
const usagePieChart = document.querySelector("#usage-pie-chart");
const usageDateInput = document.querySelector("#usage-date");
const usageDateButton = document.querySelector("#usage-date-button");
const reportsView = document.querySelector("#reports-view");
const reportsTitle = document.querySelector("#reports-title");
const reportsRefreshState = document.querySelector("#reports-refresh-state");
const reportsDateLabel = document.querySelector("#reports-date-label");
const reportsModeDaily = document.querySelector("#reports-mode-daily");
const reportsModeWeekly = document.querySelector("#reports-mode-weekly");
const refreshWeeklyReportButton = document.querySelector("#refresh-weekly-report");
const reportsWeekInput = document.querySelector("#reports-week");
const reportsTodayButton = document.querySelector("#reports-today");
const reportsAccountFilter = document.querySelector("#reports-account-filter");
const reportsModelFilter = document.querySelector("#reports-model-filter");
const reportsEffortFilter = document.querySelector("#reports-effort-filter");
const reportsConfidenceFilter = document.querySelector("#reports-confidence-filter");
const reportsSourceNote = document.querySelector(".reports-source-note");
const reportsTotalTokens = document.querySelector("#reports-total-tokens");
const reportsAttributedTokens = document.querySelector("#reports-attributed-tokens");
const reportsUnattributedSummary = document.querySelector("#reports-unattributed-summary");
const reportsAttributionCoverage = document.querySelector("#reports-attribution-coverage");
const reportsFiveCapacity = document.querySelector("#reports-five-capacity");
const reportsWeekCapacity = document.querySelector("#reports-week-capacity");
const reportsCapacityAccounts = document.querySelector("#reports-capacity-accounts");
const reportsAccountTable = document.querySelector("#reports-account-table tbody");
const reportsModelGroups = document.querySelector("#reports-model-groups");
const reportsResetHistory = document.querySelector("#reports-reset-history");
const reportsUnattributed = document.querySelector("#reports-unattributed");
const tokenCompositionPopover = document.querySelector("#token-composition-popover");
const tokenCompositionPopoverBody = tokenCompositionPopover.querySelector(".token-composition-popover-body");
const settingsView = document.querySelector("#settings-view");
const settingsLanguage = document.querySelector("#settings-language");
const settingsAutoSwitch = document.querySelector("#settings-auto-switch");
const settingsAutoResumeAfterQuota = document.querySelector("#settings-auto-resume-after-quota");
const settingsAutoTargetSummary = document.querySelector("#settings-auto-target-summary");
const settingsAutoExclusions = document.querySelector("#settings-auto-exclusions");
const settingsClearAutoExclusions = document.querySelector("#settings-clear-auto-exclusions");
const settingsLowQuotaWarning = document.querySelector("#settings-low-quota-warning");
const settingsRequireSwitchConfirmation = document.querySelector("#settings-require-switch-confirmation");
const settingsEdgeWindow = document.querySelector("#settings-edge-window");
const settingsRefreshInterval = document.querySelector("#settings-refresh-interval");
const settingsHttpOnly = document.querySelector("#settings-http-only");
const settingsDisableGpu = document.querySelector("#settings-disable-gpu");
let transportDiagnosticsSection;
let transportDiagnosticValueElements;
let latestTransportDiagnostics;
let transportDiagnosticsUnavailable = true;
let transportDiagnosticStatus;
const settingsThemeInputs = document.querySelectorAll('input[name="settings-theme"]');
const settingsOpenFolder = document.querySelector("#settings-open-folder");
const settingsQuitApp = document.querySelector("#settings-quit-app");
const settingsClearObservations = document.querySelector("#settings-clear-observations");
const settingsRunConversationBackup = document.querySelector("#settings-run-conversation-backup");
const settingsBackupStatus = document.querySelector("#settings-backup-status");
const settingsBackupPolicy = document.querySelector("#settings-backup-policy");
const settingsBackupProgress = document.querySelector("#settings-backup-progress");
const settingsBackupProgressStage = document.querySelector("#settings-backup-progress-stage");
const settingsBackupProgressBar = document.querySelector("#settings-backup-progress-bar");
const settingsBackupProgressDetail = document.querySelector("#settings-backup-progress-detail");
const settingsCompleteRecoveryPoint = document.querySelector("#settings-complete-recovery-point");
const settingsShowEarlierBackups = document.querySelector("#settings-show-earlier-backups");
const settingsRecoveryProgress = document.querySelector("#settings-recovery-progress");
const settingsRecoveryProgressStage = document.querySelector("#settings-recovery-progress-stage");
const settingsRecoveryProgressBar = document.querySelector("#settings-recovery-progress-bar");
const settingsRecoveryProgressDetail = document.querySelector("#settings-recovery-progress-detail");
const settingsCriticalBackup = document.querySelector("#settings-critical-backup");
const settingsConversationBackup = document.querySelector("#settings-conversation-backup");
const settingsQuarantinedConversationBackupRow = document.querySelector("#settings-quarantined-conversation-backup-row");
const settingsQuarantinedConversationBackup = document.querySelector("#settings-quarantined-conversation-backup");
const settingsQuarantinedConversationStatus = document.querySelector("#settings-quarantined-conversation-status");
const settingsRevalidateQuarantinedConversation = document.querySelector("#settings-revalidate-quarantined-conversation");
const settingsRefreshRecoveryBackups = document.querySelector("#settings-refresh-recovery-backups");
const settingsPreviewRecovery = document.querySelector("#settings-preview-recovery");
const settingsRecoveryPreview = document.querySelector("#settings-recovery-preview");
const settingsReplaceRecovery = document.querySelector("#settings-replace-recovery");
const settingsReplacementStatus = document.querySelector("#settings-replacement-status");
const closeDialog = document.querySelector("#close-dialog");
const closeRemember = document.querySelector("#close-remember");

const messages = {
  "zh-CN": {
    "brand.subtitle": "Windows Local",
    "brand.versionUnknown": "版本未知",
    "nav.accounts": "账号",
    "nav.usage": "用量",
    "nav.reports": "报告",
    "nav.settings": "设置",
    "rail.dpapi": "DPAPI protected",
    "nav.threads": "线程",
    "threads.eyebrow": "本机线程索引",
    "threads.title": "任务活动与线程检索",
    "threads.subtitle": "活动列表只使用本机 Codex 生命周期与登记证据；检索只读取标题、ID、项目路径和时间，不读取对话正文。",
    "threads.active": "正在执行的任务",
    "threads.activeHelp": "打开本页时每两秒刷新；这里只统计正在执行的任务，不包含闲置或等待输入的线程。",
    "threads.activeCount": "执行中 {count}",
    "threads.noActive": "目前没有正在执行的任务。闲置或等待输入的线程不计入这里。",
    "threads.activityUnavailable": "暂时无法读取本机线程活动：{error}",
    "threads.activityIndexing": "正在建立完整本机活动索引；为避免漏掉旧任务，目前按保守方式保持为忙。",
    "threads.unidentifiedActivity": "存在未关联到线程 ID 的本机活动",
    "threads.unidentifiedActivityHelp": "保留为活动证据，不会猜测 PID 或线程身份。",
    "threads.evidence": "活动证据",
    "threads.evidence.lifecycle": "本机任务生命周期",
    "threads.evidence.processRegistry": "本机进程登记",
    "threads.evidence.mixed": "本机生命周期与进程登记",
    "threads.evidence.recent": "本机最近会话活动",
    "threads.evidence.unknown": "本机活动证据",
    "threads.activityLevel": "任务层级",
    "threads.activityLevel.top_level": "顶层任务",
    "threads.activityLevel.subagent": "子代理任务",
    "threads.activityLevel.unknown": "任务层级未知",
    "threads.searchTitle": "检索本机线程",
    "threads.searchHelp": "按标题、线程 ID、所属项目或任务目录查找。不会读取消息、预览或提示词。",
    "threads.searchPlaceholder": "搜索标题、线程 ID、所属项目或任务目录",
    "threads.searchPrompt": "显示最近更新的本机线程。",
    "threads.searching": "正在检索本机线程…",
    "threads.searchResultCount": "找到 {count} 条线程记录。",
    "threads.searchResultCountWithHidden": "显示 {count} 条未归档线程，已隐藏 {hidden} 条归档线程。",
    "threads.searchFailed": "本机线程检索失败：{error}",
    "threads.noSearchResults": "没有匹配的本机线程记录。",
    "threads.archivedSearchOnly": "匹配结果仅存在于已归档线程；启用“显示已归档”即可查看。",
    "threads.unregisteredSearchOnly": "匹配结果仅存在于未登记目录；启用“显示未登记目录”即可查看。",
    "threads.showArchived": "显示已归档",
    "threads.showInternal": "显示内部任务",
    "threads.showUnregistered": "显示未登记目录",
    "threads.groupSummary": "{count} 条线程 · 最近更新 {updated}",
    "threads.ordinary": "任务",
    "threads.ordinarySummary": "{groups} 个分组 · {count} 条任务",
    "threads.unreadCompleted": "新完成 {count}",
    "threads.unreadInterrupted": "新中断 {count}",
    "threads.unregisteredDirectoryDetail": "未登记目录 · {path}",
    "threads.temporaryGroup": "临时执行器与自动化任务",
    "threads.temporaryExecutorTitle": "AgentBridge 临时执行器任务",
    "threads.pinned": "置顶",
    "threads.pinnedProject": "项目/任务文件夹",
    "threads.childTasks": "内部子任务 {count}",
    "threads.orphanedChild": "父任务当前不可见",
    "threads.state.running": "执行中",
    "threads.state.completed": "本轮已完成",
    "threads.state.newlyCompleted": "新完成",
    "threads.state.interrupted": "已中断",
    "threads.state.usageLimited": "额度受限",
    "threads.state.failed": "执行失败",
    "threads.state.unknown": "状态未知",
    "threads.showMore": "继续显示 10 条",
    "threads.id": "线程 ID",
    "threads.project": "所属项目",
    "threads.workspace": "任务目录",
    "threads.unregisteredProject": "未登记项目",
    "threads.created": "创建时间",
    "threads.updated": "更新时间",
    "threads.archived": "已归档",
    "threads.source": "元数据来源",
    "threads.sourceDatabase": "本机线程数据库",
    "threads.sourceSessionIndex": "本机会话索引",
    "threads.copyId": "复制 ID",
    "threads.copied": "线程 ID 已复制。",
    "threads.copyFailed": "无法复制线程 ID。",
    "top.eyebrow": "本机账号保险箱",
    "top.title": "账号余量与切换",
    "top.statusRegion": "账号状态",
    "top.language": "语言",
    "actions.importCurrent": "导入/新增当前",
    "actions.addAccount": "添加新账号",
    "actions.refreshAll": "刷新全部",
    "actions.bestAccount": "最佳账号",
    "actions.switch": "切换",
    "actions.refresh": "刷新",
    "actions.delete": "删除",
    "actions.cancel": "取消",
    "actions.save": "保存",
    "actions.editRemark": "编辑备注",
    "actions.setAutoSwitchTarget": "设为下次自动切换",
    "actions.clearAutoSwitchTarget": "恢复最高评分",
    "actions.holdCurrentAccount": "保持当前账号，不自动切换",
    "actions.resumeAutoSwitch": "恢复自动切换",
    "metrics.total": "账号数",
    "metrics.current": "当前账号",
    "metrics.best": "最佳账号可用度",
    "metrics.scoreHelpLabel": "说明最佳账号评分计算方法",
    "metrics.scoreHelpTitle": "可用度评分方法",
    "metrics.scoreFormula": "可用度 = 最低余量 × 60% + 5h 余量 × 20% + 7d 余量 × 20%",
    "metrics.scoreResetRule": "只有可用度分数完全相同时，才优先选择受限额度更早重置的账号。重置时间不会反转更高分账号。",
    "metrics.scoreMissingRule": "只有一个额度可用时，直接使用该额度余量作为评分。",
    "metrics.scoreEligibilityRule": "额度耗尽、数据过期、登录异常或已越过重置时间的账号不会被选为自动切换目标。",
    "metrics.scoreCurrentAccount": "当前最佳：{account} · {score} 分",
    "metrics.scoreFiveRemaining": "5h 余量",
    "metrics.scoreWeekRemaining": "7d 余量",
    "metrics.scoreFiveReset": "5h 重置时间",
    "metrics.scoreWeekReset": "7d 重置时间",
    "toggles.autoSwitch": "用尽后自动切换",
    "toggles.lowWarning": "低余量提醒",
    "search.placeholder": "搜索账号、计划、状态",
    "splitter.resize": "调整账号列表和详情面板宽度",
    "splitter.resizeTitle": "拖动调整左右宽度，双击恢复默认",
    "modal.deleteCurrentTitle": "删除当前账号",
    "modal.manualSwitchTitle": "手动切换账号",
    "modal.manualSwitchIntro": "切换到 {email}？切换时会关闭正在运行的 ChatGPT Codex，并尝试自动重新打开。",
    "modal.manualSwitchResume": "切换后继续未完成的任务",
    "modal.manualSwitchResumeHelp": "默认启用；Switcher 会识别并分别继续当前账号周期内所有可确认的未完成任务。",
    "modal.manualSwitchForce": "强制切换",
    "modal.manualSwitchForceHelp": "仅在普通切换被续接任务阻止时使用；可取消的续接会停止，其他安全校验不会绕过。",
    "modal.deleteCurrentIntro": "删除当前账号前，先选择接下来要让 ChatGPT Codex 使用哪个登录态。",
    "modal.switchExisting": "切换已有账号",
    "modal.switchExistingHelp": "关闭 ChatGPT Codex，写入已保存账号，然后自动重新打开。",
    "modal.loginNew": "登录新账号",
    "modal.loginNewHelp": "关闭 ChatGPT Codex，移除当前 auth.json，然后打开 ChatGPT Codex 登录。",
    "modal.replacement": "替代账号",
    "modal.remarkTitle": "编辑账号备注",
    "modal.remarkIntro": "备注仅保存在本机，留空后保存即可清除。",
    "modal.remarkLabel": "备注（最多 80 个字符）",
    "modal.remarkInvalid": "备注含有无法识别的字符，请删除该字符后重新输入。",
    "settings.eyebrow": "基础行为",
    "settings.title": "设置",
    "settings.subtitle": "调整语言、余量刷新、切换确认和关闭窗口行为。",
    "settings.accountManagement": "账号管理",
    "settings.autoSwitch": "用尽后自动切换",
    "settings.autoSwitchHelp": "当前账号任一额度耗尽时自动选择可用账号。",
    "settings.autoResumeAfterQuotaSwitch": "额度切换后自动继续任务",
    "settings.autoResumeAfterQuotaSwitchHelp": "额度触发自动切换后，逐个继续当前账号周期内所有已明确识别的未完成任务；无法确认身份的任务不会猜测。",
    "settings.autoSwitchTargetBest": "下次目标：默认选择最高评分账号。",
    "settings.autoSwitchTargetManual": "下次目标：{email}。",
    "settings.autoSwitchExcluded": "下次自动切换排除",
    "settings.autoSwitchExcludedHelp": "下一次自动切换时跳过选中的账号；成功切换后自动清除。",
    "settings.autoSwitchExcludedNone": "下次自动切换不排除账号。",
    "settings.autoSwitchExcludedSummary": "下次跳过 {count} 个账号：{accounts}",
    "settings.autoSwitchExcludedUnknown": "{count} 个已移除账号",
    "settings.clearAutoSwitchExclusions": "清除全部排除",
    "settings.confirmSwitch": "切换确认",
    "settings.confirmSwitchHelp": "手动切换账号前先确认。",
    "settings.lowWarning": "低余量提醒",
    "settings.lowWarningHelp": "低于阈值时在账号页显示红色提醒。",
    "settings.refreshTitle": "余量刷新",
    "settings.refreshInterval": "自动刷新间隔",
    "settings.minutes": "分钟",
    "settings.refreshHelp": "修改后立即生效，手动刷新不受影响。",
    "settings.networkTitle": "网络连接",
    "settings.httpOnly": "默认 HTTP-only 模式",
    "settings.httpOnlyHelp": "作为未单独设置账号的默认网络模式。需要按账号区分时，在账号详情里设置。",
    "settings.disableGpu": "默认禁用 GPU 启动 Codex",
    "settings.disableGpuHelp": "用于规避内置浏览器 GPU 崩溃；未单独设置的账号继承此选项。",
    "settings.transportDiagnosticsTitle": "传输诊断",
    "settings.transportDiagnosticsHelp": "只显示本机配置与有限状态枚举；不会显示代理地址、凭据或原始错误。",
    "settings.transportWireMode": "实际传输模式",
    "settings.transportWebsockets": "WebSocket 支持",
    "settings.transportRetryLimit": "SSE 重试上限",
    "settings.transportIdleTimeout": "SSE 空闲超时",
    "settings.transportProxySource": "代理来源",
    "settings.transportErrorCategory": "已观测错误类别",
    "settings.transportRetryOrdinal": "重试序号",
    "settings.transportUnavailable": "暂时无法读取传输诊断。",
    "settings.transportResponsesSse": "Responses / SSE",
    "settings.transportWebsocketCapable": "Responses / WebSocket 可用",
    "settings.transportWebsocketYes": "支持",
    "settings.transportWebsocketNo": "不支持",
    "settings.transportProxyNone": "未发现代理",
    "settings.transportProxyEnvironment": "环境变量",
    "settings.transportProxyWindows": "Windows 系统代理",
    "settings.transportProxyBoth": "环境变量与 Windows 系统代理",
    "settings.transportProxyMismatch": "环境变量与 Windows 系统代理不一致",
    "settings.transportErrorUnknown": "未知（暂无观测）",
    "settings.transportErrorResponseDecode": "响应解码",
    "settings.transportErrorTls": "TLS",
    "settings.transportErrorConnectionRefused": "连接被拒绝",
    "settings.transportErrorTimeout": "超时",
    "settings.transportErrorStreamReset": "流重置",
    "settings.transportUnknown": "未知",
    "settings.transportMilliseconds": "{value} 毫秒",
    "settings.transportAttempt": "第 {value} 次",
    "detail.network": "网络模式",
    "detail.accountHttpOnly": "此账号使用 HTTP-only",
    "detail.accountHttpOnlyHelp": "适合需要 HTTPS/SSE 才能读取上下文的账号；遇到 lite 模型不支持错误的账号应关闭。",
    "detail.accountDisableGpu": "此账号禁用 GPU 启动 Codex",
    "detail.accountDisableGpuHelp": "开启后，Switcher 会用 --disable-gpu 启动此账号的 Codex。",
    "settings.interfaceTitle": "界面",
    "settings.language": "语言",
    "settings.theme": "颜色主题",
    "settings.themeSystem": "跟随系统设置",
    "settings.themeLight": "亮色",
    "settings.themeDark": "暗色",
    "settings.edgeWindow": "屏幕边缘额度窗",
    "settings.edgeWindowHelp": "在屏幕左右边缘显示实时额度、账号和最近任务；移出后自动收边。",
    "settings.closeBehavior": "关闭窗口行为",
    "settings.closeAsk": "每次询问",
    "settings.closeMinimize": "最小化窗口",
    "settings.closeTray": "最小化到托盘",
    "settings.closeQuit": "关闭应用",
    "settings.appTitle": "应用",
    "settings.appHelp": "管理本地文件入口和应用退出。",
    "settings.quitApp": "退出应用",
    "settings.codexTitle": ".codex 文件夹",
    "settings.codexHelp": "打开 ChatGPT Codex 兼容 auth.json 所在目录。",
    "settings.openCodexFolder": "打开 .codex",
    "settings.clearObservations": "清除本地观测与报告",
    "settings.codexBackupTitle": "Codex 备份与恢复",
    "settings.codexBackupHelp": "备份仅保存在本机 D 盘；恢复预览只显示数量，不显示对话正文。",
    "settings.runConversationBackup": "立即备份对话",
    "settings.backupPolicy": "自动备份每 24 小时在 Codex 完全关闭后执行快速增量检查；每 7 天或手动备份时执行完整校验。",
    "settings.backupPolicyStatus": "自动增量：每 24 小时且 Codex 完全关闭 · 最近检查 {incremental}；完整校验：每 7 天或手动执行 · 最近校验 {full}",
    "settings.backupNever": "尚未完成",
    "settings.completeRecoveryPoint": "完整恢复点",
    "settings.noCompleteRecoveryPoint": "没有可用的完整恢复点",
    "settings.completeRecoveryPointOption": "{time} · 完整 · 项目 {projects} · 线程 {threads} · 对话 {conversations}",
    "settings.completeRecoveryPointCaptures": "关键状态 {criticalTime} · 加密对话 {conversationTime}",
    "settings.independentBackups": "更早的独立备份",
    "settings.showEarlierBackups": "显示更早备份",
    "settings.showRecentBackups": "仅显示最近备份",
    "settings.criticalBackup": "关键状态备份",
    "settings.conversationBackup": "加密对话备份",
    "settings.previewRecovery": "预览恢复",
    "settings.backupLoading": "正在读取本机备份...",
    "settings.backupRunning": "正在创建加密对话备份...",
    "settings.backupSucceeded": "加密对话备份已完成：活跃 {active}，归档 {archived}，用时 {seconds} 秒。",
    "settings.backupFailed": "备份失败：{error}",
    "settings.backupStageDiscovering": "正在扫描本机对话",
    "settings.backupStageProcessing": "正在加密并校验对话",
    "settings.backupStageValidating": "正在验证备份清单",
    "settings.backupStagePruning": "正在清理过期备份",
    "settings.backupStageCompleted": "对话备份已完成",
    "settings.backupProgressDetail": "{processedFiles}/{totalFiles} 个文件 · {processedBytes}/{totalBytes} · 已用时 {seconds} 秒",
    "settings.backupElapsed": "已用时 {seconds} 秒",
    "settings.backupEta": "预计剩余约 {minutes} 分钟",
    "settings.backupEstimating": "正在估算剩余时间",
    "settings.recoveryStageDiscovering": "正在查找本机恢复点",
    "settings.recoveryStageValidating": "正在校验加密备份",
    "settings.recoveryStageComparing": "正在与当前对话比较",
    "settings.recoveryStageCompleted": "恢复列表已刷新",
    "settings.backupListFailed": "无法读取备份：{error}",
    "settings.noCriticalBackup": "没有可用的关键状态备份",
    "settings.noConversationBackup": "没有可用的对话备份",
    "settings.quarantinedConversationBackup": "隔离的对话备份",
    "settings.noQuarantinedConversationBackup": "没有需要重新校验的隔离备份",
    "settings.quarantinedConversationBackupOption": "{time} · 活跃 {active} · 已归档 {archived}",
    "settings.quarantinedConversationBackupUnknown": "隔离备份（需要重新校验）",
    "settings.unavailableConversationBackups": "{count} 个对话备份暂时不可用，已保留且不会删除。",
    "settings.revalidateQuarantinedConversation": "重新校验并恢复到可用列表",
    "settings.revalidatingQuarantinedConversation": "正在重新校验隔离备份...",
    "settings.revalidateQuarantinedConversationSucceeded": "隔离备份已重新校验，现已回到可用列表。",
    "settings.revalidateQuarantinedConversationFailed": "隔离备份暂时不能恢复，原始数据已保留。",
    "settings.refreshRecoveryBackups": "刷新备份列表",
    "settings.criticalBackupOption": "{time} · 项目 {projects} · 归属 {assignments} · 线程 {threads}",
    "settings.conversationBackupOption": "{time} · 活跃 {active} · 已归档 {archived}",
    "settings.previewLoading": "正在验证备份并生成恢复预览...",
    "settings.previewFailed": "预览失败：{error}",
    "settings.recoveryPreviewPrivacy": "仅显示本机聚合数量，不显示对话正文。",
    "settings.previewBackupTime": "备份时间",
    "settings.previewProjects": "项目",
    "settings.previewAssignments": "线程归属",
    "settings.previewThreads": "线程",
    "settings.previewActive": "活跃会话",
    "settings.previewArchived": "已归档会话",
    "settings.previewMissing": "可补回项目",
    "settings.previewConflicts": "冲突项目",
    "settings.replaceRecoveryTitle": "危险操作：精确替换",
    "settings.replaceRecoveryHelp": "仅在核对预览后使用。选定备份之外的会话将被删除。",
    "settings.replaceRecovery": "精确替换为选定备份",
    "settings.replacePreparing": "正在关闭 Codex 并创建恢复前安全快照...",
    "settings.replaceCancelled": "已取消精确替换；没有执行恢复。",
    "settings.replaceSelectionChanged": "备份选择已变化，请重新预览后再操作。",
    "settings.replaceRunning": "正在执行精确替换...",
    "settings.replaceSucceeded": "精确替换已完成，备份列表已刷新。",
    "settings.replaceFailed": "精确替换未完成；未显示任何恢复内容。备份列表已刷新。",
    "confirm.replaceCodexRecovery": "这是独立的最终确认。继续将用选定备份精确替换 Codex 状态，并删除该备份中不存在的会话。是否继续？",
    "usage.eyebrow": "本地统计",
    "usage.title": "Token 用量",
    "usage.subtitle": "基于本机 .codex 会话日志统计，不读取或显示对话正文。",
    "usage.refresh": "刷新统计",
    "usage.averageCache": "平均缓存命中率",
    "usage.selectedDay": "选中日",
    "usage.datePicker": "统计日期",
    "usage.barTitle": "近 7 天每日用量",
    "usage.barUnit": "total tokens",
    "usage.pieTitle": "近 7 天缓存命中率",
    "usage.pieUnit": "cached input / input",
    "usage.noData": "暂无 token 记录",
    "usage.loading": "正在统计本地 token 用量...",
    "usage.maxDay": "最高",
    "usage.minDay": "最低",
    "usage.cacheToday": "今日命中",
    "usage.cacheSevenDays": "近 7 天命中",
    "usage.cacheMonth": "本月命中",
    "usage.cachedInput": "缓存输入",
    "usage.totalInput": "总输入",
    "reports.eyebrow": "本机观测",
    "reports.title": "用量报告",
    "reports.dailyTitle": "每日用量报告",
    "reports.weeklyTitle": "每周用量报告",
    "reports.daily": "日报",
    "reports.weekly": "周报",
    "reports.date": "日期",
    "reports.backToToday": "今天",
    "reports.subtitle": "按账号、模型和思考强度汇总本机 Token 与额度快照。",
    "reports.refresh": "刷新报告",
    "reports.week": "周起始日",
    "reports.account": "账号",
    "reports.model": "模型",
    "reports.effort": "思考强度",
    "reports.confidence": "可信度",
    "reports.all": "全部",
    "reports.localOnly": "本报告由本机 rollout Token 事件和 Switcher 额度快照生成，不是 OpenAI 官方账单或固定限额。",
    "reports.localTokens": "本机 Token",
    "reports.accountCount": "观测账号",
    "reports.fiveCapacity": "5h 观测容量",
    "reports.weekCapacity": "7d 观测容量",
    "reports.byAccount": "按账号",
    "reports.observedEstimate": "容量是本机观测估算",
    "reports.attributedTokens": "已归属 Token",
    "reports.composition": "Token 构成",
    "reports.share": "归属占比",
    "reports.sessions": "会话数",
    "reports.averageSession": "会话均值",
    "reports.usageOverview": "使用概览",
    "reports.consumedPoints": "消耗百分点",
    "reports.resetCount": "重置次数",
    "reports.quotaChange": "额度消耗",
    "reports.quotaObservedChange": "额度变化记录",
    "reports.quotaObservedHelp": "这是本机在多次额度快照中观察到的累计下降，不是 Token 数。数值跨重置周期累计，因此可能超过 100；重置次数表示本机检测到额度恢复的次数。",
    "reports.lastUpdated": "报告更新于 {time}",
    "reports.updatingCached": "正在后台更新 · 上次 {time}",
    "reports.notUpdated": "报告尚未生成",
    "reports.attributionConfidence": "归属可信度",
    "reports.coverage": "归属覆盖率",
    "reports.metricHelp": "只统计本机 rollout 事件。会话数按会话去重；会话均值是已归属 Token 除以会话数；额度消耗只累计同一重置周期内的正向变化；直接时间线归属为高可信，唯一账号会话补全为中可信，冲突数据保持未归属。",
    "reports.accountHelp": "已归属 Token 是能可靠匹配账号的本机用量；占比以全部已归属 Token 为分母；会话数按 rollout 去重；会话均值为已归属 Token ÷ 会话数；额度消耗只累计同一重置周期内的正向百分点变化。",
    "reports.compositionHelp": "输入包含缓存输入，因此横条将输入拆为非缓存输入与缓存输入，再与输出和推理组成互不重叠的比例。数据来自本机 rollout，不是官方账单。",
    "reports.modelHelp": "每行表示账号、模型和思考强度的组合。本机 Token 按非缓存输入、缓存输入、输出和推理展示；容量参考仍是本机观测估算。",
    "reports.capacityHelp": "容量估算 = 同一账号和重置周期内已归属 Token ÷ 额度消耗百分点 × 100。代表值取中位数，范围是样本最小至最大值；样本越多、波动越小越可信。它不是官方固定限额。",
    "reports.resetHelp": "预计重置来自最新服务端快照，可能在刷新后变化；历史时间是本机检测到额度恢复的时间。相同账号、窗口和上一周期只显示一次，不同账号分别保留。",
    "reports.capacityEvidence": "容量估算证据",
    "reports.confidenceHigh": "高（时间线直接匹配）",
    "reports.confidenceMedium": "中（含会话连续性补全）",
    "reports.tokenRate": "Token/小时",
    "reports.quotaRate": "额度%/小时",
    "reports.byModel": "模型与思考强度",
    "reports.rateHelp": "Token 速率与额度百分点速率分开计算",
    "reports.resetHistory": "额度重置记录",
    "reports.unattributed": "未归属用量",
    "reports.unattributedHelp": "账号时间线不明确或同一会话出现账号冲突的 Token 会保留在这里，不会强行归给最近账号；它仍计入本机 Token 总量。",
    "reports.expectedReset": "预计重置",
    "reports.detectedAt": "本机检测",
    "reports.representative": "代表值",
    "reports.range": "范围",
    "reports.sampleCount": "样本",
    "reports.nonCachedInput": "非缓存输入",
    "reports.cachedInput": "缓存输入",
    "reports.output": "输出",
    "reports.reasoning": "推理",
    "reports.compositionAria": "查看 Token 构成详情",
    "reports.compositionTitle": "Token 构成",
    "reports.localAggregate": "本图仅使用本机 rollout 聚合数据，不是 OpenAI 官方账单。缓存输入包含在原始输入中，图中已从输入扣除以避免重复。",
    "reports.expandEvidence": "展开容量证据",
    "reports.collapseEvidence": "收起容量证据",
    "reports.noData": "当前期间还没有可用的本机观测。",
    "reports.dailyNoData": "这一天还没有可用的本机观测。",
    "reports.weeklyNoData": "这一周还没有可用的本机观测。",
    "reports.noUsageInRange": "本时段暂无记录",
    "reports.loading": "正在生成本机报告...",
    "reports.dailyBoundary": "日报按本地时间 00:00 至次日 00:00 汇总；未归属 Token 不会强行分配给账号。",
    "reports.weeklyBoundary": "周报汇总连续 7 天本机观测；未归属 Token 不会强行分配给账号。",
    "reports.observedUnscheduled": "检测到非计划重置（原因未知）",
    "reports.scheduledReset": "计划重置",
    "reports.resetCard": "重置卡",
    "reports.samples": "{count} 个有效样本",
    "reports.sourceLocal": "本机观测",
    "reports.cleared": "本地观测与报告历史已清除。",
    "close.title": "关闭 Codex Switcher？",
    "close.intro": "选择最小化到任务栏、最小化到托盘，或直接关闭应用。",
    "close.remember": "以后均保持此操作",
    "close.minimize": "最小化窗口",
    "close.tray": "最小化到托盘",
    "close.quit": "关闭应用",
    "status.ready": "准备就绪",
    "status.processing": "处理中...",
    "status.importedRefreshed": "已导入当前账号，并刷新了余量",
    "status.importedRefreshFailed": "已导入当前账号；余量刷新失败：{error}",
    "status.usageRefreshDone": "余量刷新完成",
    "status.usageRefreshProgress": "正在刷新余量：{completed}/{total}",
    "status.usageRefreshPersisting": "正在保存 {total} 个账号的余量记录…",
    "status.noCandidate": "没有可用的候选账号",
    "status.recoveryCandidate": "当前没有可立即切换的账号；{email} 最早预计于 {time} 恢复。",
    "status.bestAccount": "最佳账号：{email}，分数 {score}",
    "status.autoSwitchOn": "已开启自动切换",
    "status.autoSwitchOff": "已关闭自动切换",
    "status.autoResumeOn": "已开启额度切换后自动继续",
    "status.autoResumeOff": "已关闭额度切换后自动继续",
    "status.lowWarningOn": "已开启低余量提醒",
    "status.lowWarningOff": "已关闭低余量提醒",
    "status.switchConfirmOn": "已开启切换确认",
    "status.switchConfirmOff": "已关闭切换确认",
    "status.edgeWindowOn": "已启用屏幕边缘额度窗",
    "status.edgeWindowOff": "已关闭屏幕边缘额度窗",
    "status.refreshIntervalSaved": "余量自动刷新间隔已更新",
    "status.httpOnlyOn": "已启用 HTTP-only，并迁移 {rollouts} 个会话、{threads} 条索引。{launch}",
    "status.httpOnlyOff": "已恢复默认网络传输，并还原 {rollouts} 个会话、{threads} 条索引。{launch}",
    "status.accountHttpOnlyOn": "已为 {email} 启用 HTTP-only。{launch}",
    "status.accountHttpOnlyOff": "已为 {email} 关闭 HTTP-only。{launch}",
    "status.disableGpuOn": "已启用默认禁用 GPU 启动。{launch}",
    "status.disableGpuOff": "已关闭默认禁用 GPU 启动。{launch}",
    "status.accountDisableGpuOn": "已为 {email} 启用禁用 GPU 启动。{launch}",
    "status.accountDisableGpuOff": "已为 {email} 关闭禁用 GPU 启动。{launch}",
    "status.accountRemarkSaved": "已保存 {email} 的备注。",
    "status.closeBehaviorSaved": "关闭窗口行为已保存",
    "status.themeSaved": "颜色主题已保存",
    "status.settingsSaved": "设置已保存",
    "status.languageSaved": "语言已切换为中文",
    "status.backgroundUpdated": "后台余量已更新",
    "status.backgroundFailed": "后台余量刷新失败：{error}",
    "status.exhaustedNoTarget": "当前账号已达到自动切换条件，但没有可用的目标账号",
    "status.autoSwitched": "当前账号已达到自动切换条件，已切换到 {email}，并关闭 {count} 个 ChatGPT Codex 进程。{launch}",
    "status.autoResumeStarted": "已在 Codex 原任务中自动发送续接请求。",
    "status.autoResumeFailed": "但自动继续原未完成任务失败，请手动检查。",
    "status.autoResumeUncertain": "但自动继续原未完成任务结果不确定，请手动检查；不会自动重试。",
    "status.autoResumeCandidatePendingVerification": "检测到未完成任务，但续接状态仍在核验；不会重复发送请求。",
    "status.autoResumeNeedsAttention": "检测到未完成任务，但续接需要人工核对；不会自动重试。",
    "status.autoResumeSkippedNoCandidate": "未自动继续任务（没有可用的近期未完成任务）。",
    "status.autoResumeSkippedMultipleCandidates": "未自动继续任务（检测到多个未完成任务，无法安全自动选择）。",
    "status.autoResumeSkipped": "未自动继续任务（当前账号周期内没有可安全继续的未完成任务）。",
    "status.autoResumeMultiPending": "已将 {total} 个明确识别的任务加入后台续接队列，Switcher 可以继续操作。",
    "status.autoResumeMultiComplete": "任务续接完成：共 {total} 个，成功 {started} 个，失败 {failed} 个，结果不确定 {uncertain} 个，跳过 {skipped} 个。",
    "status.autoResumeProgressPosition": "续接 {currentIndex}/{total}",
    "status.autoResumeProgressRemaining": "本阶段最多还剩 {seconds} 秒",
    "status.autoResumeProgressElapsed": "本阶段已用 {seconds} 秒",
    "status.autoResumeProgressQueue": "整队列最多约 {seconds} 秒",
    "status.autoResumeProgressCounts": "成功 {started} / 失败 {failed} / 不确定 {uncertain}",
    "status.autoResumePhasePrepared": "等待开始续接",
    "status.autoResumePhaseLaunchVerified": "正在连接 Codex Desktop",
    "status.autoResumePhaseWaitingDesktop": "等待 Codex Desktop 可用",
    "status.autoResumePhaseDeepLink": "正在查找任务输入框和发送按钮",
    "status.autoResumePhaseWindowRestored": "已恢复目标任务窗口",
    "status.autoResumePhaseComposerFound": "已找到任务输入框",
    "status.autoResumePhaseSubmitFound": "已找到发送按钮",
    "status.autoResumePhaseFocusVerified": "正在核验目标任务焦点",
    "status.autoResumePhaseInvokeStarted": "已调用发送，正在核验结果",
    "status.autoResumePhaseInvokeNoEffect": "首次发送未生效，正在安全重试",
    "status.autoResumePhaseFallbackInvokeStarted": "已执行备用发送，正在核验结果",
    "status.autoResumePhasePromptConsumed": "消息已离开输入框，正在核验任务记录",
    "status.manualResumeStarted": "已按本次选择在 Codex 原任务中发送续接请求。",
    "status.manualResumePending": "账号切换已完成，任务续接正在后台确认；Switcher 可以继续操作。",
    "status.continuationInProgress": "Switcher 正在后台续接未完成任务。为避免账号认证变化或两个 Codex 同时占用该任务，本次切换未执行；请等待续接完成。",
    "status.switchInProgress": "账号切换正在执行，请稍候，不要重复点击。",
    "status.manualResumeFailed": "账号已切换，但继续原未完成任务失败，请手动检查。",
    "status.manualResumeUncertain": "账号已切换，但继续任务的结果不确定，请手动检查；不会自动重试。",
    "status.manualResumeCandidatePendingVerification": "账号已切换，但检测到未完成任务仍在核验续接状态；不会重复发送请求。",
    "status.manualResumeNeedsAttention": "账号已切换，但检测到未完成任务需要人工核对；不会自动重试。",
    "status.manualResumeSkippedNoCandidate": "账号已切换，但没有可用的近期未完成任务，因此未继续。",
    "status.manualResumeSkippedMultipleCandidates": "账号已切换，但多个未完成任务未能安全组成续接队列，因此未继续。",
    "status.manualResumeSkippedSourceNotExhausted": "账号已切换；未找到可安全继续的未完成任务。",
    "status.manualResumeSkippedTargetUnavailable": "账号已切换；目标账号不适合继续任务，因此未继续。",
    "status.manualResumeSkipped": "账号已切换，但当前账号周期内没有可安全继续的未完成任务。",
    "status.autoSwitchQueued": "当前账号已达到自动切换条件，已排队切换到 {email}。检测到正在运行或刚结束的 ChatGPT Codex 对话/任务，短暂等待后将自动切换并重新打开。",
    "status.autoSwitchWaitingTasks": "已排队切换到 {email}。正在等待任务“{tasks}”结束。",
    "status.autoSwitchWaitingRegistryTasks": "已排队切换到 {email}。Codex 实时登记显示任务“{tasks}”仍有逻辑活动；正在等待结束。PID 仅作进程诊断，不作为线程身份。",
    "status.autoSwitchWaitingRegistryAndInferredTasks": "已排队切换到 {email}。Codex 实时登记显示当前逻辑活动，其他任务来自生命周期记录；正在等待任务“{tasks}”结束。PID 仅作进程诊断，不作为线程身份。",
    "status.autoSwitchWaitingInferredTasks": "已排队切换到 {email}。本机生命周期记录显示任务“{tasks}”仍活跃，正在保守等待结束。",
    "status.autoSwitchConfirmingInferredTasks": "已排队切换到 {email}。本机生命周期记录中任务“{tasks}”没有新的活动，正在确认结束。",
    "status.autoSwitchWaitingMixedTasks": "已排队切换到 {email}。一部分任务来自 Codex 实时登记，其他来自生命周期记录；正在等待任务“{tasks}”结束。PID 仅作进程诊断，不作为线程身份。",
    "status.autoSwitchConfirmingMixedTasks": "已排队切换到 {email}。一部分任务来自 Codex 实时登记，其他来自生命周期记录；任务“{tasks}”正在确认结束。PID 仅作进程诊断，不作为线程身份。",
    "status.autoSwitchWaitingUnassociatedProcess": "已排队切换到 {email}。检测到 Codex 主机及辅助进程，但没有可关联的活动任务。",
    "status.autoSwitchQuietCountdownUnassociatedProcess": "已排队切换到 {email}。未检测到继续中的任务；Codex 主机及辅助进程仅作诊断。切换倒计时 {seconds} 秒。",
    "status.autoSwitchReadyUnassociatedProcess": "已排队切换到 {email}。未检测到继续中的任务；Codex 主机及辅助进程不会阻止切换，正在准备切换。",
    "status.autoSwitchConfirmingTasks": "已排队切换到 {email}。任务“{tasks}”的进程已停止，正在确认任务记录已结束。",
    "status.autoSwitchConfirmingRecentActivity": "已排队切换到 {email}。最近的 Codex 任务刚结束，正在确认活动已完全停止。",
    "status.autoSwitchWaitingUnknownThreads": "已排队切换到 {email}。仍有未识别名称的任务在运行。",
    "status.autoSwitchQuietCountdown": "已排队切换到 {email}。任务已结束，切换倒计时 {seconds} 秒。",
    "status.manualSwitchInspectionCountdown": "已手动切换到当前账号以查看信息。将在至少保留 {seconds} 秒后自动切换到 {email}。",
    "status.activityDiagnostics": "诊断详情（任务/会话 ID）",
    "status.processRegistryCorrupt": "进程登记状态：{state}。本机生命周期活动仍会单独显示；不会把 PID 当作线程身份。",
    "status.processRegistryStateMissing": "缺失",
    "status.processRegistryStateCorrupt": "损坏",
    "status.processRegistryReasonAllZero": "原因：文件内容全为零。",
    "status.processRegistryReasonMalformedJson": "原因：文件不是有效 JSON。",
    "status.processRegistryReasonNotFound": "原因：文件不存在。",
    "status.processRegistryReasonUnreadable": "原因：文件无法读取。",
    "status.processRegistryReasonUnstable": "原因：文件在读取期间发生变化。",
    "status.processRegistryLastWrite": "最后写入：{time}",
    "status.processRegistryPredatesCodexStart": "进程登记早于当前 Codex app-server 启动（{time}），不能代表当前进程归属。",
    "status.processRegistryIgnoredStale": "已忽略 {count} 条历史工具任务登记；最早证据：{time}",
    "labels.unnamedTask": "未命名任务",
    "status.autoSwitchFallbackContext": "原指定账号不可用（{reason}），因此改用综合评分最高的可用账号。",
    "status.autoSwitchFallbackSwitched": "指定账号不可用（{reason}），本次已按综合评分切换到 {email}，并关闭 {count} 个 ChatGPT Codex 进程。{launch}",
    "status.autoSwitchQueueCleared": "当前账号余量已恢复，已取消排队切换。",
    "status.autoSwitchProjectionBlocked": "本地 Codex 对话投影状态不一致，已阻止账号切换且不会自动重试；检测到 {count} 项偏移不匹配。当前认证、配置和 Codex 进程均未更改。",
    "status.autoSwitchProjectionMetadataBlocked": "本地 Codex 对话投影元数据不完整或不可读，已阻止账号切换且不会自动重试。当前认证、配置和 Codex 进程均未更改。",
    "status.autoSwitchProjectionUnavailable": "本地 Codex 对话投影状态无法安全校验，已阻止账号切换且不会自动重试。当前认证、配置和 Codex 进程均未更改。",
    "status.autoSwitchHeld": "已保持当前账号；额度恢复或 Switcher 重启后也不会自动切换。",
    "status.autoSwitchResumed": "已恢复自动切换。",
    "status.manualTargetSet": "已将 {email} 设为下一个自动切换账号。",
    "status.manualTargetCleared": "已恢复为自动选择最高评分账号。",
    "status.manualTargetUnavailable": "指定的下一个切换账号不可用，且没有其他可用账号。",
    "status.autoSwitchExcluded": "已将 {email} 加入下次自动切换排除列表。",
    "status.autoSwitchIncluded": "已将 {email} 从下次自动切换排除列表移除。",
    "status.autoSwitchExclusionsCleared": "下次自动切换排除列表已清空。",
    "status.accountUsageRefreshed": "账号余量已刷新",
    "status.switched": "账号已切换到 {email}",
    "status.currentDeletedSwitched": "当前账号已删除，并切换到 {email}",
    "status.deletedUnaffected": "账号已删除。ChatGPT Codex 未受影响。",
    "status.currentAlready": "{prefix}。该账号已经是当前账号，未重启 ChatGPT Codex。",
    "status.switchResult": "{prefix}，并关闭 {count} 个 ChatGPT Codex 进程。{launch}",
    "status.dshAuthSyncFailed": "DSH Codex 认证同步失败；请等待 DSH 子代理结束后再次选择当前账号重试。",
    "status.dshAuthSyncPendingBusy": "DSH Codex 子代理正在运行；认证未被覆盖，空闲后将自动重试。",
    "status.dshAuthSyncPendingRetry": "DSH Codex 认证存在漂移；Switcher 将自动重试同步。",
    "status.dshAuthSyncSkipped": "未执行 DSH Codex 认证同步（未配置或未启用）。",
    "status.launchOk": "已验证关闭旧进程并重新打开 ChatGPT Codex。",
    "status.launchFresh": "ChatGPT Codex 原先未运行，现已启动。",
    "status.launchRecovered": "等待 Windows 完成 Codex 升级或注册后，已验证自动打开。",
    "status.launchFailed": "未能自动打开 ChatGPT Codex，请手动打开。",
    "status.transportWarning": "HTTP-only 配置校验失败：{error}",
    "status.loginNew": "当前账号已删除，并关闭 {count} 个 ChatGPT Codex 进程。{launch}请在 ChatGPT Codex 完成新账号登录，然后回到这里点击“导入/新增当前”。",
    "status.addAccount": "当前账号登录态已加密保留，并关闭 {count} 个 ChatGPT Codex 进程。{launch}请在 ChatGPT Codex 登录新账号；登录完成后将自动导入，无需再次点击。",
    "status.addAccountImported": "新账号已自动导入并刷新额度。",
    "status.refreshFailures": "{message}，{count} 个账号刷新失败",
    "status.refreshAuthExpired": "{message}；{count} 个账号的用量认证已过期，但仍可手动切换。",
    "status.refreshMixedFailures": "{message}；{count} 个账号需要处理，其中 {authExpiredCount} 个用量认证已过期。",
    "status.refreshSkipped": "{message}；{count} 个认证过期账号未尝试刷新，当前余量显示为未知。",
    "status.refreshCached": "{message}；{count} 个账号使用一分钟内的当前快照，未重复请求。",
    "status.accountUsageAuthExpired": "{email} 的用量认证已过期，但账号仍可切换。切换并打开 ChatGPT Codex 后，认证会自动刷新。",
    "status.accountRefreshFailed": "{email} 余量刷新失败：{error}",
    "quota.empty": "当前账号余量已用尽，建议切换账号；如果已开启自动切换，应用会选择可用账号。",
    "quota.pendingSwitch": "当前账号已达到自动切换条件，已排队切换到 {email}。检测到正在运行或刚结束的 Codex 对话/任务，短暂等待后将自动切换并重新打开。",
    "quota.executionLimited": "Codex 已返回额度限制；官方快照仍显示剩余 {remaining}，当前周期按执行受限处理。",
    "quota.pendingSwitchLimited": "Codex 已返回额度限制；官方快照仍显示剩余 {remaining}，已排队切换到 {email}。",
    "quota.autoSwitchHeld": "已保持当前账号，不会自动切换；额度恢复和 Switcher 重启不会解除。",
    "quota.autoSwitchAvailable": "当前账号自动切换控制",
    "quota.low": "当前账号余量只剩 {remaining}，建议切换账号。",
    "quota.stale": "额度快照已过期或刷新失败，请刷新后再查看当前余量。",
    "quota.remainingLabel": "{label} 剩余 {remaining}",
    "quota.staleLabel": "{label} 当前余量未知",
    "empty.noAccounts": "还没有账号",
    "empty.noMatches": "没有匹配账号",
    "empty.noAccountsHelp": "先导入当前 Codex auth.json。",
    "empty.noMatchesHelp": "换一个关键词再试。",
    "detail.selectAccount": "选择一个账号",
    "detail.selectHelp": "账号详情、余量窗口和切换操作会显示在这里。",
    "detail.fingerprint": "账号指纹 {id}",
    "detail.remark": "备注",
    "detail.remarkEmpty": "未设置",
    "detail.usage": "余量",
    "detail.tokenUsage": "本地 token 用量",
    "detail.tokenUsageHelp": "基于本机 .codex 会话日志统计，不读取或显示对话正文。",
    "detail.localTokenBoundary": "本机 rollout 真实统计，不是跨设备账单或官方额度。",
    "detail.quotaSource": "额度来源：{source}",
    "detail.quotaLastRefresh": "最后成功刷新：{time}",
    "detail.quotaSnapshotAge": "快照年龄：{age}",
    "detail.quotaFresh": "当前快照在自动切换有效期内",
    "detail.quotaStale": "当前快照已过期，请刷新后再比较官方显示",
    "detail.tokenToday": "今日",
    "detail.tokenSevenDays": "近 7 天",
    "detail.tokenMonth": "本月",
    "detail.tokenInput": "输入",
    "detail.tokenOutput": "输出",
    "detail.tokenReasoning": "推理",
    "detail.tokenEvents": "{count} 次记录",
    "detail.tokenLatest": "最近记录：{value}",
    "detail.fiveHour": "5 小时窗口",
    "detail.oneWeek": "7 天窗口",
    "detail.used": "已用 {used}",
    "detail.resetTime": "重置时间",
    "detail.compositeScore": "账号可用度",
    "detail.scoreHelpLabel": "说明账号可用度评分方法",
    "detail.scoreHelpTitle": "账号可用度",
    "detail.scoreHelpFormula": "可用度 = 最低余量 × 60% + 5h 余量 × 20% + 7d 余量 × 20%",
    "detail.scoreHelpMeaning": "任一已知额度耗尽时即时可用度为 0，并且不会被自动切换选中；只有全部账号都不可用时，才单独按预计恢复时间提示候选。这不是 OpenAI 官方评分。",
    "detail.expectedRecovery": "预计恢复",
    "detail.availableNow": "当前可立即使用",
    "detail.executionLimited": "Codex 执行受限（官方余量 {remaining}）",
    "detail.noExpectedRecovery": "暂无可靠恢复时间",
    "detail.immediateState": "当前状态",
    "detail.overallQuota": "综合余量",
    "detail.waitFiveHour": "等待 5h 额度重置",
    "detail.waitOneWeek": "等待 7d 额度重置",
    "detail.waitBoth": "等待 5h 与 7d 额度重置",
    "detail.localStatus": "本地状态",
    "detail.status": "状态：{value}",
    "detail.created": "添加：{value}",
    "detail.updated": "更新：{value}",
    "detail.autoSwitchPolicy": "自动切换",
    "detail.autoSwitchTargetHelp": "当前账号耗尽时优先使用此账号；如果它不可用，本次自动回退到综合评分最高的可用账号。",
    "detail.autoSwitchTargetCurrentHelp": "当前账号不能设为自己的下一个自动切换目标。",
    "detail.autoSwitchExcluded": "下次自动切换时跳过此账号",
    "detail.autoSwitchExcludedHelp": "仅影响自动切换；手动点击切换仍可使用。成功自动切换后此设置会自动清除。",
    "detail.autoSwitchExcludedCurrentHelp": "可以提前排除当前账号；下次自动切换时不会选择它。",
    "detail.controls": "账号控制",
    "detail.actions": "操作",
    "detail.switchTo": "切换到此账号",
    "detail.autoSwitchTarget": "下次自动切换目标",
    "labels.none": "无",
    "labels.unknown": "未知",
    "labels.scoreUnit": "分",
    "labels.planUnknown": "计划未知",
    "labels.current": "当前",
    "labels.switchable": "可切换",
    "labels.candidate": "候选",
    "labels.autoTarget": "下次切换",
    "labels.autoExcluded": "下次跳过",
    "labels.bestScoreMode": "默认最高评分",
    "fallback.manual_target_missing": "账号不存在",
    "fallback.manual_target_current": "账号已成为当前账号",
    "fallback.manual_target_excluded": "账号已被设置为下次跳过",
    "fallback.manual_target_unavailable": "账号当前不可用",
    "fallback.manual_target_unreadable": "本地账号记录不可读取",
    "labels.localRecord": "本机记录 {id}",
    "statusLabel.ready": "可用",
    "statusLabel.usage_failed": "余量刷新失败",
    "statusLabel.usage_auth_expired": "用量认证待刷新",
    "confirm.switch": "切换到 {email}？\n\n切换时会自动关闭正在运行的 ChatGPT Codex，并尝试自动重新打开。",
    "confirm.forceProjectionSwitch": "{detail}\n\n仍要手动切换到 {email}？Switcher 不会修复或改写对话数据，其他进程、备份、回滚和对话状态校验仍会执行。",
    "confirm.delete": "删除 {email} 的本地加密记录？\n\n该账号不是当前账号，不会关闭 ChatGPT Codex。",
    "confirm.httpOnly": "修改网络传输模式会完全关闭 ChatGPT Codex，并迁移历史会话标记。完成后会按原状态重新打开。\n\n继续吗？",
    "confirm.disableGpu": "如果此设置影响当前账号，Switcher 会完全关闭 ChatGPT Codex，并按新的 GPU 设置重新打开。\n\n继续吗？",
    "confirm.clearUsageObservations": "清除本机额度快照、账号观测时间线和周报历史？此操作不会删除加密账号或 ChatGPT Codex 会话。",
    "modal.deleteSwitch": "删除并切换",
    "modal.deleteLogin": "删除并登录新账号",
    "modal.continue": "继续"
  },
  en: {
    "brand.subtitle": "Windows Local",
    "brand.versionUnknown": "Version unknown",
    "nav.accounts": "Accounts",
    "nav.usage": "Usage",
    "nav.reports": "Reports",
    "nav.settings": "Settings",
    "rail.dpapi": "DPAPI protected",
    "nav.threads": "Threads",
    "threads.eyebrow": "Local thread index",
    "threads.title": "Task activity and thread search",
    "threads.subtitle": "The activity list uses only local Codex lifecycle and registry evidence. Search reads titles, IDs, workspace paths, and timestamps, never conversation bodies.",
    "threads.active": "Executing tasks",
    "threads.activeHelp": "Refreshes every two seconds while this view is open. Idle threads and threads waiting for input are not counted here.",
    "threads.activeCount": "{count} executing",
    "threads.noActive": "No task is currently executing. Idle threads and threads waiting for input are not counted here.",
    "threads.activityUnavailable": "Local thread activity is temporarily unavailable: {error}",
    "threads.activityIndexing": "Building the complete local activity index. It remains conservatively busy so an older task is not missed.",
    "threads.unidentifiedActivity": "Local activity is not associated with a thread ID",
    "threads.unidentifiedActivityHelp": "It remains activity evidence; no PID or thread identity is guessed.",
    "threads.evidence": "Activity evidence",
    "threads.evidence.lifecycle": "Local task lifecycle",
    "threads.evidence.processRegistry": "Local process registry",
    "threads.evidence.mixed": "Local lifecycle and process registry",
    "threads.evidence.recent": "Recent local session activity",
    "threads.evidence.unknown": "Local activity evidence",
    "threads.activityLevel": "Task level",
    "threads.activityLevel.top_level": "Top-level task",
    "threads.activityLevel.subagent": "Subagent task",
    "threads.activityLevel.unknown": "Task level unknown",
    "threads.searchTitle": "Search local threads",
    "threads.searchHelp": "Search by title, thread ID, project, or task directory. Messages, previews, and prompts are never read.",
    "threads.searchPlaceholder": "Search title, thread ID, project, or task directory",
    "threads.searchPrompt": "Showing the most recently updated local threads.",
    "threads.searching": "Searching local threads…",
    "threads.searchResultCount": "Found {count} thread record(s).",
    "threads.searchResultCountWithHidden": "Showing {count} current thread(s); {hidden} archived thread(s) hidden.",
    "threads.searchFailed": "Local thread search failed: {error}",
    "threads.noSearchResults": "No local thread records match.",
    "threads.archivedSearchOnly": "Matching records are archived; enable “Show archived” to view them.",
    "threads.unregisteredSearchOnly": "Matching records are in unregistered directories; enable “Show unregistered directories” to view them.",
    "threads.showArchived": "Show archived",
    "threads.showInternal": "Show internal tasks",
    "threads.showUnregistered": "Show unregistered directories",
    "threads.groupSummary": "{count} thread(s) · latest {updated}",
    "threads.ordinary": "Tasks",
    "threads.ordinarySummary": "{groups} group(s) · {count} task(s)",
    "threads.unreadCompleted": "{count} newly completed",
    "threads.unreadInterrupted": "{count} newly interrupted",
    "threads.unregisteredDirectoryDetail": "Unregistered directory · {path}",
    "threads.temporaryGroup": "Temporary executors and automation",
    "threads.temporaryExecutorTitle": "AgentBridge temporary executor task",
    "threads.pinned": "Pinned",
    "threads.pinnedProject": "Project/task folder",
    "threads.childTasks": "{count} internal child task(s)",
    "threads.orphanedChild": "Parent task is not currently visible",
    "threads.state.running": "Running",
    "threads.state.completed": "Turn completed",
    "threads.state.newlyCompleted": "Newly completed",
    "threads.state.interrupted": "Interrupted",
    "threads.state.usageLimited": "Usage limited",
    "threads.state.failed": "Failed",
    "threads.state.unknown": "Status unknown",
    "threads.showMore": "Show 10 more",
    "threads.id": "Thread ID",
    "threads.project": "Project",
    "threads.workspace": "Task directory",
    "threads.unregisteredProject": "Unregistered project",
    "threads.created": "Created",
    "threads.updated": "Updated",
    "threads.archived": "Archived",
    "threads.source": "Metadata source",
    "threads.sourceDatabase": "Local thread database",
    "threads.sourceSessionIndex": "Local session index",
    "threads.copyId": "Copy ID",
    "threads.copied": "Thread ID copied.",
    "threads.copyFailed": "Unable to copy thread ID.",
    "top.eyebrow": "Local account vault",
    "top.title": "Usage & Switching",
    "top.statusRegion": "Account status",
    "top.language": "Language",
    "actions.importCurrent": "Import/Add Current",
    "actions.addAccount": "Add New Account",
    "actions.refreshAll": "Refresh All",
    "actions.bestAccount": "Best Account",
    "actions.switch": "Switch",
    "actions.refresh": "Refresh",
    "actions.delete": "Delete",
    "actions.cancel": "Cancel",
    "actions.save": "Save",
    "actions.editRemark": "Edit remark",
    "actions.setAutoSwitchTarget": "Use as next auto-switch",
    "actions.clearAutoSwitchTarget": "Use best score",
    "actions.holdCurrentAccount": "Keep current account; do not auto-switch",
    "actions.resumeAutoSwitch": "Resume auto-switch",
    "metrics.total": "Accounts",
    "metrics.current": "Current",
    "metrics.best": "Best Availability",
    "metrics.scoreHelpLabel": "Explain the best-account score",
    "metrics.scoreHelpTitle": "Availability score calculation",
    "metrics.scoreFormula": "Availability = lowest remaining × 60% + 5h remaining × 20% + 7d remaining × 20%",
    "metrics.scoreResetRule": "Only exactly equal availability scores use the limiting quota reset time. Reset timing never reverses a higher score.",
    "metrics.scoreMissingRule": "When only one quota is available, its remaining value is the score.",
    "metrics.scoreEligibilityRule": "Exhausted, stale, login-failed, or reset-expired accounts are not automatic-switch targets.",
    "metrics.scoreCurrentAccount": "Current best: {account} · {score}",
    "metrics.scoreFiveRemaining": "5h remaining",
    "metrics.scoreWeekRemaining": "7d remaining",
    "metrics.scoreFiveReset": "5h reset time",
    "metrics.scoreWeekReset": "7d reset time",
    "toggles.autoSwitch": "Auto-switch on empty",
    "toggles.lowWarning": "Low-quota warning",
    "search.placeholder": "Search account, plan, status",
    "splitter.resize": "Resize account list and detail panels",
    "splitter.resizeTitle": "Drag to resize panels; double-click to reset",
    "modal.deleteCurrentTitle": "Delete Current",
    "modal.manualSwitchTitle": "Switch account",
    "modal.manualSwitchIntro": "Switch to {email}? Switching closes running ChatGPT Codex processes and attempts to reopen the app.",
    "modal.manualSwitchResume": "Continue unfinished tasks after switching",
    "modal.manualSwitchResumeHelp": "On by default; Switcher continues every verified unfinished task from the current account cycle.",
    "modal.manualSwitchForce": "Force switch",
    "modal.manualSwitchForceHelp": "Use only when continuation blocks a normal switch; cancellable continuation stops while all other safeguards remain.",
    "modal.deleteCurrentIntro": "Choose which login state ChatGPT Codex should use next.",
    "modal.switchExisting": "Switch to saved account",
    "modal.switchExistingHelp": "Close ChatGPT Codex, write a saved account, then reopen it.",
    "modal.loginNew": "Log in to new account",
    "modal.loginNewHelp": "Close ChatGPT Codex, remove auth.json, then open ChatGPT Codex for login.",
    "modal.replacement": "Replacement account",
    "modal.remarkTitle": "Edit Account Remark",
    "modal.remarkIntro": "Remarks stay on this device. Save an empty value to clear it.",
    "modal.remarkLabel": "Remark (80 characters maximum)",
    "modal.remarkInvalid": "The remark contains an unrecognized character. Remove it and enter the text again.",
    "settings.eyebrow": "Basic behavior",
    "settings.title": "Settings",
    "settings.subtitle": "Adjust language, usage refresh, switch confirmation, and window close behavior.",
    "settings.accountManagement": "Account Management",
    "settings.autoSwitch": "Auto-switch on empty",
    "settings.autoSwitchHelp": "Choose an available account when any current-account quota is exhausted.",
    "settings.autoResumeAfterQuotaSwitch": "Automatically continue after a quota switch",
    "settings.autoResumeAfterQuotaSwitchHelp": "After a quota-triggered automatic switch, continue every positively identified unfinished task from the current account cycle. Unidentified tasks are never guessed.",
    "settings.autoSwitchTargetBest": "Next target: best-score account.",
    "settings.autoSwitchTargetManual": "Next target: {email}.",
    "settings.autoSwitchExcluded": "Exclude from next auto-switch",
    "settings.autoSwitchExcludedHelp": "Skip selected accounts on the next automatic switch; clears after a successful switch.",
    "settings.autoSwitchExcludedNone": "No account is excluded from the next automatic switch.",
    "settings.autoSwitchExcludedSummary": "Skipping {count} account(s) next: {accounts}",
    "settings.autoSwitchExcludedUnknown": "{count} removed account(s)",
    "settings.clearAutoSwitchExclusions": "Clear all exclusions",
    "settings.confirmSwitch": "Switch confirmation",
    "settings.confirmSwitchHelp": "Confirm before manually switching accounts.",
    "settings.lowWarning": "Low-quota warning",
    "settings.lowWarningHelp": "Show a red warning on the account page below the threshold.",
    "settings.refreshTitle": "Usage Refresh",
    "settings.refreshInterval": "Auto-refresh interval",
    "settings.minutes": "minutes",
    "settings.refreshHelp": "Changes apply immediately. Manual refresh is unaffected.",
    "settings.networkTitle": "Network",
    "settings.httpOnly": "Default HTTP-only mode",
    "settings.httpOnlyHelp": "Default network mode for accounts without their own setting. Use account details when accounts need different modes.",
    "settings.disableGpu": "Disable GPU for Codex by default",
    "settings.disableGpuHelp": "Work around embedded-browser GPU crashes. Accounts without their own setting inherit this option.",
    "settings.transportDiagnosticsTitle": "Transport diagnostics",
    "settings.transportDiagnosticsHelp": "Only bounded local configuration and state categories are shown; proxy URLs, credentials, and raw errors are never displayed.",
    "settings.transportWireMode": "Effective transport",
    "settings.transportWebsockets": "WebSocket support",
    "settings.transportRetryLimit": "SSE retry limit",
    "settings.transportIdleTimeout": "SSE idle timeout",
    "settings.transportProxySource": "Proxy source",
    "settings.transportErrorCategory": "Observed error category",
    "settings.transportRetryOrdinal": "Retry ordinal",
    "settings.transportUnavailable": "Transport diagnostics are temporarily unavailable.",
    "settings.transportResponsesSse": "Responses / SSE",
    "settings.transportWebsocketCapable": "Responses / WebSocket capable",
    "settings.transportWebsocketYes": "Supported",
    "settings.transportWebsocketNo": "Not supported",
    "settings.transportProxyNone": "No proxy detected",
    "settings.transportProxyEnvironment": "Environment variables",
    "settings.transportProxyWindows": "Windows system proxy",
    "settings.transportProxyBoth": "Environment variables and Windows system proxy",
    "settings.transportProxyMismatch": "Environment and Windows proxy mismatch",
    "settings.transportErrorUnknown": "Unknown (not observed)",
    "settings.transportErrorResponseDecode": "Response decoding",
    "settings.transportErrorTls": "TLS",
    "settings.transportErrorConnectionRefused": "Connection refused",
    "settings.transportErrorTimeout": "Timeout",
    "settings.transportErrorStreamReset": "Stream reset",
    "settings.transportUnknown": "Unknown",
    "settings.transportMilliseconds": "{value} ms",
    "settings.transportAttempt": "Attempt {value}",
    "detail.network": "Network Mode",
    "detail.accountHttpOnly": "Use HTTP-only for this account",
    "detail.accountHttpOnlyHelp": "Use this for accounts that need HTTPS/SSE to read context; keep it off for accounts that hit the lite model unsupported error.",
    "detail.accountDisableGpu": "Disable GPU when launching this account",
    "detail.accountDisableGpuHelp": "When enabled, Switcher launches this account's Codex with --disable-gpu.",
    "settings.interfaceTitle": "Interface",
    "settings.language": "Language",
    "settings.theme": "Color theme",
    "settings.themeSystem": "Follow system",
    "settings.themeLight": "Light",
    "settings.themeDark": "Dark",
    "settings.edgeWindow": "Screen-edge quota window",
    "settings.edgeWindowHelp": "Shows live quotas, accounts, and recent tasks at either screen edge, then retracts automatically.",
    "settings.closeBehavior": "Window close behavior",
    "settings.closeAsk": "Ask every time",
    "settings.closeMinimize": "Minimize window",
    "settings.closeTray": "Minimize to tray",
    "settings.closeQuit": "Quit app",
    "settings.appTitle": "App",
    "settings.appHelp": "Manage local file access and app exit.",
    "settings.quitApp": "Quit App",
    "settings.codexTitle": ".codex Folder",
    "settings.codexHelp": "Open the compatibility auth.json folder used by ChatGPT Codex.",
    "settings.openCodexFolder": "Open .codex",
    "settings.clearObservations": "Clear local observations & reports",
    "settings.codexBackupTitle": "Codex Backup & Recovery",
    "settings.codexBackupHelp": "Backups stay on the local D drive. Recovery previews show counts only, never conversation text.",
    "settings.runConversationBackup": "Back Up Conversations Now",
    "settings.backupPolicy": "Automatic backup runs a fast incremental check every 24 hours after Codex is fully closed; full verification runs every 7 days or on manual backup.",
    "settings.backupPolicyStatus": "Automatic incremental: every 24 hours with Codex fully closed · last check {incremental}; full verification: every 7 days or manually · last verification {full}",
    "settings.backupNever": "not completed yet",
    "settings.completeRecoveryPoint": "Complete recovery point",
    "settings.noCompleteRecoveryPoint": "No complete recovery point is available",
    "settings.completeRecoveryPointOption": "{time} · Complete · {projects} projects · {threads} threads · {conversations} conversations",
    "settings.completeRecoveryPointCaptures": "Critical state {criticalTime} · Encrypted conversations {conversationTime}",
    "settings.independentBackups": "Earlier independent backups",
    "settings.showEarlierBackups": "Show earlier backups",
    "settings.showRecentBackups": "Show recent backups only",
    "settings.criticalBackup": "Critical-state backup",
    "settings.conversationBackup": "Encrypted conversation backup",
    "settings.previewRecovery": "Preview Recovery",
    "settings.backupLoading": "Loading local backups...",
    "settings.backupRunning": "Creating encrypted conversation backup...",
    "settings.backupSucceeded": "Encrypted conversation backup completed: {active} active, {archived} archived, {seconds}s.",
    "settings.backupFailed": "Backup failed: {error}",
    "settings.backupStageDiscovering": "Scanning local conversations",
    "settings.backupStageProcessing": "Encrypting and verifying conversations",
    "settings.backupStageValidating": "Validating backup manifest",
    "settings.backupStagePruning": "Cleaning up expired backups",
    "settings.backupStageCompleted": "Conversation backup completed",
    "settings.backupProgressDetail": "{processedFiles}/{totalFiles} files · {processedBytes}/{totalBytes} · {seconds}s elapsed",
    "settings.backupElapsed": "{seconds}s elapsed",
    "settings.backupEta": "About {minutes} min remaining",
    "settings.backupEstimating": "Estimating remaining time",
    "settings.recoveryStageDiscovering": "Finding local recovery points",
    "settings.recoveryStageValidating": "Validating encrypted backup",
    "settings.recoveryStageComparing": "Comparing with current conversations",
    "settings.recoveryStageCompleted": "Recovery list refreshed",
    "settings.backupListFailed": "Could not load backups: {error}",
    "settings.noCriticalBackup": "No critical-state backup is available",
    "settings.noConversationBackup": "No conversation backup is available",
    "settings.quarantinedConversationBackup": "Quarantined conversation backup",
    "settings.noQuarantinedConversationBackup": "No quarantined backup needs revalidation",
    "settings.quarantinedConversationBackupOption": "{time} · {active} active · {archived} archived",
    "settings.quarantinedConversationBackupUnknown": "Quarantined backup (needs revalidation)",
    "settings.unavailableConversationBackups": "{count} conversation backup(s) are temporarily unavailable and have been retained.",
    "settings.revalidateQuarantinedConversation": "Revalidate and return to available backups",
    "settings.revalidatingQuarantinedConversation": "Revalidating quarantined backup...",
    "settings.revalidateQuarantinedConversationSucceeded": "The quarantined backup was revalidated and is available again.",
    "settings.revalidateQuarantinedConversationFailed": "The quarantined backup could not be restored yet; its original data was retained.",
    "settings.refreshRecoveryBackups": "Refresh backup list",
    "settings.criticalBackupOption": "{time} · {projects} projects · {assignments} assignments · {threads} threads",
    "settings.conversationBackupOption": "{time} · {active} active · {archived} archived",
    "settings.previewLoading": "Validating backups and preparing the recovery preview...",
    "settings.previewFailed": "Preview failed: {error}",
    "settings.recoveryPreviewPrivacy": "Local aggregate counts only. Conversation text is never displayed.",
    "settings.previewBackupTime": "Backup time",
    "settings.previewProjects": "Projects",
    "settings.previewAssignments": "Thread assignments",
    "settings.previewThreads": "Threads",
    "settings.previewActive": "Active sessions",
    "settings.previewArchived": "Archived sessions",
    "settings.previewMissing": "Missing items",
    "settings.previewConflicts": "Conflicts",
    "settings.replaceRecoveryTitle": "Danger zone: exact replacement",
    "settings.replaceRecoveryHelp": "Use only after reviewing the preview. Sessions outside the selected backup will be deleted.",
    "settings.replaceRecovery": "Replace Exactly with Selected Backup",
    "settings.replacePreparing": "Closing Codex and creating a pre-restore safety snapshot...",
    "settings.replaceCancelled": "Exact replacement cancelled. No restore was performed.",
    "settings.replaceSelectionChanged": "The backup selection changed. Preview it again before continuing.",
    "settings.replaceRunning": "Performing exact replacement...",
    "settings.replaceSucceeded": "Exact replacement completed. The backup list was refreshed.",
    "settings.replaceFailed": "Exact replacement did not complete. No recovery content is shown. The backup list was refreshed.",
    "confirm.replaceCodexRecovery": "This is a separate final confirmation. Continuing will exactly replace Codex state with the selected backup and delete sessions absent from that backup. Continue?",
    "usage.eyebrow": "Local stats",
    "usage.title": "Token Usage",
    "usage.subtitle": "Calculated from local .codex session logs. Conversation text is not read or displayed.",
    "usage.refresh": "Refresh Stats",
    "usage.averageCache": "Average Cache Hit",
    "usage.selectedDay": "Selected Day",
    "usage.datePicker": "Stats Date",
    "usage.barTitle": "Daily Usage, Last 7 Days",
    "usage.barUnit": "total tokens",
    "usage.pieTitle": "Daily Cache Hit Rate, Last 7 Days",
    "usage.pieUnit": "cached input / input",
    "usage.noData": "No token records yet",
    "usage.loading": "Calculating local token usage...",
    "usage.maxDay": "High",
    "usage.minDay": "Low",
    "usage.cacheToday": "Today hit",
    "usage.cacheSevenDays": "7-day hit",
    "usage.cacheMonth": "Month hit",
    "usage.cachedInput": "Cached input",
    "usage.totalInput": "Total input",
    "reports.eyebrow": "Local observation",
    "reports.title": "Usage Reports",
    "reports.dailyTitle": "Daily Usage Report",
    "reports.weeklyTitle": "Weekly Usage Report",
    "reports.daily": "Daily",
    "reports.weekly": "Weekly",
    "reports.date": "Date",
    "reports.backToToday": "Today",
    "reports.subtitle": "Summarize local tokens and quota snapshots by account, model, and reasoning effort.",
    "reports.refresh": "Refresh report",
    "reports.week": "Week start",
    "reports.account": "Account",
    "reports.model": "Model",
    "reports.effort": "Reasoning effort",
    "reports.confidence": "Confidence",
    "reports.all": "All",
    "reports.localOnly": "This report is generated from local rollout token events and Switcher quota snapshots. It is not OpenAI billing or a fixed official limit.",
    "reports.localTokens": "Local tokens",
    "reports.accountCount": "Observed accounts",
    "reports.fiveCapacity": "Observed 5h capacity",
    "reports.weekCapacity": "Observed 7d capacity",
    "reports.byAccount": "By account",
    "reports.observedEstimate": "Capacity is a local observed estimate",
    "reports.attributedTokens": "Attributed tokens",
    "reports.composition": "Token composition",
    "reports.share": "Attributed share",
    "reports.sessions": "Sessions",
    "reports.averageSession": "Average/session",
    "reports.usageOverview": "Usage overview",
    "reports.consumedPoints": "points consumed",
    "reports.resetCount": "resets",
    "reports.quotaChange": "Quota consumed",
    "reports.quotaObservedChange": "Observed quota changes",
    "reports.quotaObservedHelp": "This is cumulative quota decline observed across local snapshots, not tokens. It can exceed 100 across reset cycles; reset count is how often local observation detected recovery.",
    "reports.lastUpdated": "Report updated {time}",
    "reports.updatingCached": "Updating in background · last {time}",
    "reports.notUpdated": "Report has not been generated",
    "reports.attributionConfidence": "Attribution confidence",
    "reports.coverage": "Attribution coverage",
    "reports.metricHelp": "Only local rollout events are counted. Sessions are deduplicated; average/session divides attributed tokens by sessions; quota consumed only adds positive changes within one reset cycle; direct timeline matches are high confidence, conflict-free session continuity is medium confidence, and conflicts remain unattributed.",
    "reports.accountHelp": "Attributed tokens are local usage reliably matched to an account. Share uses all attributed tokens as its denominator. Sessions are deduplicated by rollout, average/session divides attributed tokens by sessions, and quota consumed only adds positive percentage-point changes within one reset cycle.",
    "reports.compositionHelp": "Input includes cached input, so the bar splits input into non-cached and cached input, then adds output and reasoning as non-overlapping segments. This is local rollout data, not official billing.",
    "reports.modelHelp": "Each row is one account, model, and reasoning-effort combination. Local tokens are split into non-cached input, cached input, output, and reasoning; capacity remains a local observed estimate.",
    "reports.capacityHelp": "Capacity estimate = attributed tokens within one account/reset cycle ÷ quota percentage points consumed × 100. The representative is the median and the range is sample minimum to maximum. It is not an official fixed limit.",
    "reports.resetHelp": "Expected resets come from the latest server snapshot and may change after refresh. History times show when recovery was detected locally. The same account, window, and prior cycle appears once; different accounts remain separate.",
    "reports.capacityEvidence": "Capacity estimate evidence",
    "reports.confidenceHigh": "High (direct timeline match)",
    "reports.confidenceMedium": "Medium (includes session continuity)",
    "reports.tokenRate": "Tokens/hour",
    "reports.quotaRate": "Quota %/hour",
    "reports.byModel": "Models & reasoning effort",
    "reports.rateHelp": "Token rate and quota percentage-point rate are calculated separately",
    "reports.resetHistory": "Quota reset history",
    "reports.unattributed": "Unattributed usage",
    "reports.unattributedHelp": "Tokens with an ambiguous account timeline or conflicting account evidence remain here instead of being forced onto the last account. They still count toward total local tokens.",
    "reports.expectedReset": "Expected reset",
    "reports.detectedAt": "Detected locally",
    "reports.representative": "Representative",
    "reports.range": "Range",
    "reports.sampleCount": "Samples",
    "reports.nonCachedInput": "Non-cached input",
    "reports.cachedInput": "Cached input",
    "reports.output": "Output",
    "reports.reasoning": "Reasoning",
    "reports.compositionAria": "View token composition details",
    "reports.compositionTitle": "Token composition",
    "reports.localAggregate": "This chart uses local rollout aggregates, not OpenAI billing. Cached input is included in raw input and is subtracted here to avoid double counting.",
    "reports.expandEvidence": "Expand capacity evidence",
    "reports.collapseEvidence": "Collapse capacity evidence",
    "reports.noData": "No usable local observations exist for this period.",
    "reports.dailyNoData": "No usable local observations exist for this day.",
    "reports.weeklyNoData": "No usable local observations exist for this week.",
    "reports.noUsageInRange": "No records in this range",
    "reports.loading": "Generating local report...",
    "reports.dailyBoundary": "Daily reports use local 00:00 to the next local 00:00; unattributed tokens are never forced onto an account.",
    "reports.weeklyBoundary": "Weekly reports summarize seven local days; unattributed tokens are never forced onto an account.",
    "reports.observedUnscheduled": "Observed unscheduled reset (cause unknown)",
    "reports.scheduledReset": "Scheduled reset",
    "reports.resetCard": "Reset card",
    "reports.samples": "{count} valid samples",
    "reports.sourceLocal": "Local observation",
    "reports.cleared": "Local observation and report history cleared.",
    "close.title": "Close Codex Switcher?",
    "close.intro": "Choose whether to minimize to the taskbar, minimize to the tray, or quit the app.",
    "close.remember": "Always use this action",
    "close.minimize": "Minimize Window",
    "close.tray": "Minimize to Tray",
    "close.quit": "Quit App",
    "status.ready": "Ready",
    "status.processing": "Working...",
    "status.importedRefreshed": "Imported the current account and refreshed usage",
    "status.importedRefreshFailed": "Imported the current account; usage refresh failed: {error}",
    "status.usageRefreshDone": "Usage refresh completed",
    "status.usageRefreshProgress": "Refreshing usage: {completed}/{total}",
    "status.usageRefreshPersisting": "Saving usage records for {total} account(s)…",
    "status.noCandidate": "No usable candidate account",
    "status.recoveryCandidate": "No account is immediately usable; {email} is expected to recover first at {time}.",
    "status.bestAccount": "Best account: {email}, score {score}",
    "status.autoSwitchOn": "Auto-switch enabled",
    "status.autoSwitchOff": "Auto-switch disabled",
    "status.autoResumeOn": "Automatic continuation after quota switches enabled",
    "status.autoResumeOff": "Automatic continuation after quota switches disabled",
    "status.lowWarningOn": "Low-quota warning enabled",
    "status.lowWarningOff": "Low-quota warning disabled",
    "status.switchConfirmOn": "Switch confirmation enabled",
    "status.switchConfirmOff": "Switch confirmation disabled",
    "status.edgeWindowOn": "Screen-edge quota window enabled",
    "status.edgeWindowOff": "Screen-edge quota window disabled",
    "status.refreshIntervalSaved": "Usage auto-refresh interval updated",
    "status.httpOnlyOn": "HTTP-only enabled; migrated {rollouts} sessions and {threads} index rows. {launch}",
    "status.httpOnlyOff": "Default transport restored; reverted {rollouts} sessions and {threads} index rows. {launch}",
    "status.accountHttpOnlyOn": "HTTP-only enabled for {email}. {launch}",
    "status.accountHttpOnlyOff": "HTTP-only disabled for {email}. {launch}",
    "status.disableGpuOn": "Default disable-GPU launch enabled. {launch}",
    "status.disableGpuOff": "Default disable-GPU launch disabled. {launch}",
    "status.accountDisableGpuOn": "Disable-GPU launch enabled for {email}. {launch}",
    "status.accountDisableGpuOff": "Disable-GPU launch disabled for {email}. {launch}",
    "status.accountRemarkSaved": "Saved the remark for {email}.",
    "status.closeBehaviorSaved": "Window close behavior saved",
    "status.themeSaved": "Color theme saved",
    "status.settingsSaved": "Settings saved",
    "status.languageSaved": "Language switched to English",
    "status.backgroundUpdated": "Background usage updated",
    "status.backgroundFailed": "Background usage refresh failed: {error}",
    "status.exhaustedNoTarget": "Current account reached an auto-switch condition, but no usable target is available.",
    "status.autoSwitched": "Current account reached an auto-switch condition; switched to {email} and closed {count} ChatGPT Codex processes. {launch}",
    "status.autoResumeStarted": "A continuation request was submitted in the original Codex task.",
    "status.autoResumeFailed": "The account switch succeeded, but automatic continuation failed; inspect the task manually.",
    "status.autoResumeUncertain": "The account switch succeeded, but automatic continuation is uncertain; inspect the task manually. No retry will be attempted.",
    "status.autoResumeCandidatePendingVerification": "A unfinished task was found, but its continuation is still being verified. No duplicate request will be sent.",
    "status.autoResumeNeedsAttention": "A unfinished task was found, but its continuation needs manual review. No automatic retry will be attempted.",
    "status.autoResumeSkippedNoCandidate": "No task was continued automatically because no recent unfinished task was available.",
    "status.autoResumeSkippedMultipleCandidates": "No task was continued automatically because multiple unfinished tasks prevented a safe automatic choice.",
    "status.autoResumeSkipped": "No task was continued automatically because there was no single safe unfinished candidate.",
    "status.autoResumeMultiPending": "Queued {total} positively identified task(s) for background continuation. Switcher remains usable.",
    "status.autoResumeMultiComplete": "Task continuation finished: {total} total, {started} started, {failed} failed, {uncertain} uncertain, {skipped} skipped.",
    "status.autoResumeProgressPosition": "Continuation {currentIndex}/{total}",
    "status.autoResumeProgressRemaining": "up to {seconds}s left in this phase",
    "status.autoResumeProgressElapsed": "{seconds}s elapsed in this phase",
    "status.autoResumeProgressQueue": "up to about {seconds}s for the queue",
    "status.autoResumeProgressCounts": "{started} started / {failed} failed / {uncertain} uncertain",
    "status.autoResumePhasePrepared": "waiting to continue",
    "status.autoResumePhaseLaunchVerified": "connecting to Codex Desktop",
    "status.autoResumePhaseWaitingDesktop": "waiting for Codex Desktop",
    "status.autoResumePhaseDeepLink": "finding the task composer and submit control",
    "status.autoResumePhaseWindowRestored": "target task window restored",
    "status.autoResumePhaseComposerFound": "task composer found",
    "status.autoResumePhaseSubmitFound": "submit control found",
    "status.autoResumePhaseFocusVerified": "verifying target task focus",
    "status.autoResumePhaseInvokeStarted": "submit invoked; verifying the result",
    "status.autoResumePhaseInvokeNoEffect": "the first submit had no effect; retrying safely",
    "status.autoResumePhaseFallbackInvokeStarted": "fallback submit invoked; verifying the result",
    "status.autoResumePhasePromptConsumed": "message left the composer; verifying task history",
    "status.manualResumeStarted": "A continuation request was submitted in the original Codex task.",
    "status.manualResumePending": "The account switch completed and task continuation is being verified in the background. Switcher remains usable.",
    "status.continuationInProgress": "Switcher is continuing an unfinished task in the background. This switch was not started to avoid changing authentication or opening the same task in two Codex owners; wait for continuation to finish.",
    "status.switchInProgress": "An account switch is already running. Wait before trying again.",
    "status.manualResumeFailed": "The account switched, but the requested task continuation failed; inspect the task manually.",
    "status.manualResumeUncertain": "The account switched, but the requested continuation is uncertain; inspect the task manually. No retry will be attempted.",
    "status.manualResumeCandidatePendingVerification": "The account switched, but an unfinished task was found and its continuation is still being verified. No duplicate request will be sent.",
    "status.manualResumeNeedsAttention": "The account switched, but an unfinished task needs manual review. No automatic retry will be attempted.",
    "status.manualResumeSkippedNoCandidate": "The account switched, but no recent unfinished task was available to continue.",
    "status.manualResumeSkippedMultipleCandidates": "The account switched, but the unfinished tasks could not be prepared as a safe continuation queue.",
    "status.manualResumeSkippedSourceNotExhausted": "The account switched, but no unfinished task could be identified safely.",
    "status.manualResumeSkippedTargetUnavailable": "The account switched, but the target account was not suitable for continuation.",
    "status.manualResumeSkipped": "The account switched, but no unfinished task from the current account cycle was safe to continue.",
    "status.autoSwitchQueued": "Current account reached an auto-switch condition; queued switch to {email}. A ChatGPT Codex conversation/task is running or just finished. The switcher will switch after a short wait, then reopen ChatGPT Codex.",
    "status.autoSwitchWaitingTasks": "Queued switch to {email}. Waiting for task(s) “{tasks}” to finish.",
    "status.autoSwitchWaitingRegistryTasks": "Queued switch to {email}. The live Codex registry shows task(s) “{tasks}” as logically active; waiting for completion. PID is diagnostic only and is not a thread identity.",
    "status.autoSwitchWaitingRegistryAndInferredTasks": "Queued switch to {email}. The live Codex registry shows current logical activity while other tasks come from lifecycle records; waiting for task(s) “{tasks}” to finish. PID is diagnostic only and is not a thread identity.",
    "status.autoSwitchWaitingInferredTasks": "Queued switch to {email}. Local lifecycle records show task(s) “{tasks}” as active, so switching remains conservatively paused until they end.",
    "status.autoSwitchConfirmingInferredTasks": "Queued switch to {email}. Local lifecycle records for task(s) “{tasks}” have stopped changing and are being confirmed ended.",
    "status.autoSwitchWaitingMixedTasks": "Queued switch to {email}. Some tasks come from the live Codex registry while others come from lifecycle records. Waiting for task(s) “{tasks}” to finish. PID is diagnostic only and is not a thread identity.",
    "status.autoSwitchConfirmingMixedTasks": "Queued switch to {email}. Some tasks come from the live Codex registry while others come from lifecycle records. Task(s) “{tasks}” are being confirmed ended. PID is diagnostic only and is not a thread identity.",
    "status.autoSwitchWaitingUnassociatedProcess": "Queued switch to {email}. A Codex host and helper processes are present, but no active task is associated with them.",
    "status.autoSwitchQuietCountdownUnassociatedProcess": "Queued switch to {email}. No continuing task was detected; Codex host/helper processes are diagnostic only. Switch countdown: {seconds}s.",
    "status.autoSwitchReadyUnassociatedProcess": "Queued switch to {email}. No continuing task was detected; Codex host/helper processes will not block switching. Preparing to switch.",
    "status.autoSwitchConfirmingTasks": "Queued switch to {email}. The process for task(s) “{tasks}” stopped; confirming the task records are finished.",
    "status.autoSwitchConfirmingRecentActivity": "Queued switch to {email}. Recent Codex work just ended; confirming all activity has settled.",
    "status.autoSwitchWaitingUnknownThreads": "Queued switch to {email}. A task with no readable name is still active.",
    "status.autoSwitchQuietCountdown": "Queued switch to {email}. Tasks finished; switch countdown: {seconds}s.",
    "status.manualSwitchInspectionCountdown": "The current account was selected manually for inspection. It will remain selected for at least {seconds}s before switching automatically to {email}.",
    "status.activityDiagnostics": "Diagnostic details (task/session IDs)",
    "status.processRegistryCorrupt": "Process registry state: {state}. Local lifecycle activity remains visible separately; a PID is not used as a thread identity.",
    "status.processRegistryStateMissing": "missing",
    "status.processRegistryStateCorrupt": "corrupt",
    "status.processRegistryReasonAllZero": "Reason: the file contains only zero bytes.",
    "status.processRegistryReasonMalformedJson": "Reason: the file is not valid JSON.",
    "status.processRegistryReasonNotFound": "Reason: the file does not exist.",
    "status.processRegistryReasonUnreadable": "Reason: the file cannot be read.",
    "status.processRegistryReasonUnstable": "Reason: the file changed while it was being read.",
    "status.processRegistryLastWrite": "Last write: {time}",
    "status.processRegistryPredatesCodexStart": "The process registry predates the current Codex app-server start ({time}) and cannot represent current process ownership.",
    "status.processRegistryIgnoredStale": "Ignored {count} historical tool-task registration(s); oldest evidence: {time}",
    "labels.unnamedTask": "Unnamed task",
    "status.autoSwitchFallbackContext": "The originally selected target is unavailable ({reason}), so the highest composite-score usable account is being used.",
    "status.autoSwitchFallbackSwitched": "The selected target is unavailable ({reason}); switched to highest composite-score account {email} and closed {count} ChatGPT Codex processes. {launch}",
    "status.autoSwitchQueueCleared": "Current account usage recovered; queued switch was cancelled.",
    "status.autoSwitchProjectionBlocked": "Local Codex thread projection is inconsistent, so account switching was blocked and will not retry automatically. Found {count} mismatched offset(s). Authentication, configuration, and Codex processes were unchanged.",
    "status.autoSwitchProjectionMetadataBlocked": "Local Codex thread projection metadata is incomplete or unreadable, so account switching was blocked and will not retry automatically. Authentication, configuration, and Codex processes were unchanged.",
    "status.autoSwitchProjectionUnavailable": "Local Codex thread projection could not be checked safely, so account switching was blocked and will not retry automatically. Authentication, configuration, and Codex processes were unchanged.",
    "status.autoSwitchHeld": "The current account is held; quota recovery or a Switcher restart will not auto-switch it.",
    "status.autoSwitchResumed": "Auto-switch resumed.",
    "status.manualTargetSet": "{email} is now the next auto-switch target.",
    "status.manualTargetCleared": "Auto-switch target restored to best-score selection.",
    "status.manualTargetUnavailable": "The selected next switch account is unavailable and no other usable account exists.",
    "status.autoSwitchExcluded": "{email} will be skipped on the next automatic switch.",
    "status.autoSwitchIncluded": "{email} is no longer excluded from the next automatic switch.",
    "status.autoSwitchExclusionsCleared": "The next automatic-switch exclusion list is clear.",
    "status.accountUsageRefreshed": "Account usage refreshed",
    "status.switched": "Switched to {email}",
    "status.currentDeletedSwitched": "Current account deleted and switched to {email}",
    "status.deletedUnaffected": "Account deleted. ChatGPT Codex was not affected.",
    "status.currentAlready": "{prefix}. This account is already current; ChatGPT Codex was not restarted.",
    "status.switchResult": "{prefix}, and closed {count} ChatGPT Codex processes. {launch}",
    "status.dshAuthSyncFailed": "DSH Codex authentication sync failed; wait for DSH subagents to finish, then select the current account again to retry.",
    "status.dshAuthSyncPendingBusy": "A DSH Codex subagent is running; authentication was not overwritten and will retry automatically when idle.",
    "status.dshAuthSyncPendingRetry": "DSH Codex authentication has drifted; Switcher will retry synchronization automatically.",
    "status.dshAuthSyncSkipped": "DSH Codex authentication sync was not run (not configured or not enabled).",
    "status.launchOk": "The old ChatGPT Codex process was verified closed and the app was reopened.",
    "status.launchFresh": "ChatGPT Codex was not running and has now been launched.",
    "status.launchRecovered": "Codex was verified open after Windows finished updating or registering it.",
    "status.launchFailed": "Could not reopen ChatGPT Codex; please open it manually.",
    "status.transportWarning": "HTTP-only configuration check failed: {error}",
    "status.loginNew": "Current account deleted and {count} ChatGPT Codex processes were closed. {launch}Finish login in ChatGPT Codex, then return here and click Import/Add Current.",
    "status.addAccount": "The current login was encrypted and preserved, and {count} ChatGPT Codex processes were closed. {launch}Log in to the new account; it will be imported automatically.",
    "status.addAccountImported": "The new account was imported automatically and its usage was refreshed.",
    "status.refreshFailures": "{message}, {count} accounts failed",
    "status.refreshAuthExpired": "{message}; usage authentication expired for {count} accounts, but they remain manually switchable.",
    "status.refreshMixedFailures": "{message}; {count} accounts need attention, including {authExpiredCount} expired usage authentications.",
    "status.refreshSkipped": "{message}; {count} authentication-expired accounts were not attempted and their current balance is shown as unknown.",
    "status.refreshCached": "{message}; {count} accounts reused a current snapshot from the last minute without another request.",
    "status.accountUsageAuthExpired": "Usage authentication expired for {email}, but the account remains switchable. Switch to it and open ChatGPT Codex to refresh authentication.",
    "status.accountRefreshFailed": "{email} usage refresh failed: {error}",
    "quota.empty": "The current account is exhausted. Switch accounts; if auto-switch is enabled, the app will choose a usable account.",
    "quota.pendingSwitch": "Current account reached an auto-switch condition; queued switch to {email}. A Codex conversation/task is running or just finished. The switcher will switch after a short wait, then reopen Codex.",
    "quota.executionLimited": "Codex returned a usage limit; the official snapshot still shows {remaining} remaining, so this account cycle is treated as execution-limited.",
    "quota.pendingSwitchLimited": "Codex returned a usage limit; the official snapshot still shows {remaining} remaining, and a switch to {email} is queued.",
    "quota.autoSwitchHeld": "The current account is held and will not auto-switch. Quota recovery and Switcher restarts do not clear this choice.",
    "quota.autoSwitchAvailable": "Current account auto-switch control",
    "quota.low": "Current account has only {remaining} remaining. Consider switching.",
    "quota.stale": "The quota snapshot is stale or failed. Refresh before reading the current balance.",
    "quota.remainingLabel": "{label} {remaining} remaining",
    "quota.staleLabel": "{label} current balance unknown",
    "empty.noAccounts": "No accounts yet",
    "empty.noMatches": "No matching accounts",
    "empty.noAccountsHelp": "Import the current Codex auth.json first.",
    "empty.noMatchesHelp": "Try another keyword.",
    "detail.selectAccount": "Select an account",
    "detail.selectHelp": "Account details, usage windows, and switch actions appear here.",
    "detail.fingerprint": "Account fingerprint {id}",
    "detail.remark": "Remark",
    "detail.remarkEmpty": "Not set",
    "detail.usage": "Usage",
    "detail.tokenUsage": "Local Token Usage",
    "detail.tokenUsageHelp": "Calculated from local .codex session logs. Conversation text is not read or displayed.",
    "detail.localTokenBoundary": "Real local rollout totals, not cross-device billing or official quota.",
    "detail.quotaSource": "Quota source: {source}",
    "detail.quotaLastRefresh": "Last successful refresh: {time}",
    "detail.quotaSnapshotAge": "Snapshot age: {age}",
    "detail.quotaFresh": "Snapshot is within the auto-switch freshness window",
    "detail.quotaStale": "Snapshot is stale; refresh before comparing it with the official display",
    "detail.tokenToday": "Today",
    "detail.tokenSevenDays": "Last 7 Days",
    "detail.tokenMonth": "This Month",
    "detail.tokenInput": "Input",
    "detail.tokenOutput": "Output",
    "detail.tokenReasoning": "Reasoning",
    "detail.tokenEvents": "{count} records",
    "detail.tokenLatest": "Latest record: {value}",
    "detail.fiveHour": "5-hour window",
    "detail.oneWeek": "7-day window",
    "detail.used": "Used {used}",
    "detail.resetTime": "Reset time",
    "detail.compositeScore": "Account availability",
    "detail.scoreHelpLabel": "Explain the account availability score",
    "detail.scoreHelpTitle": "Account availability",
    "detail.scoreHelpFormula": "Availability = lowest remaining × 60% + 5h remaining × 20% + 7d remaining × 20%",
    "detail.scoreHelpMeaning": "Immediate availability is 0 when either known quota is exhausted, so it cannot be auto-selected. Only when all accounts are unavailable is expected recovery shown separately. This is not an official OpenAI score.",
    "detail.expectedRecovery": "Expected recovery",
    "detail.availableNow": "Immediately usable",
    "detail.executionLimited": "Codex execution limited (official remaining {remaining})",
    "detail.noExpectedRecovery": "No reliable recovery time",
    "detail.immediateState": "Current state",
    "detail.overallQuota": "Overall remaining quota",
    "detail.waitFiveHour": "Waiting for 5h quota reset",
    "detail.waitOneWeek": "Waiting for 7d quota reset",
    "detail.waitBoth": "Waiting for 5h and 7d quota resets",
    "detail.localStatus": "Local status",
    "detail.status": "Status: {value}",
    "detail.created": "Added: {value}",
    "detail.updated": "Updated: {value}",
    "detail.autoSwitchPolicy": "Auto-switch",
    "detail.autoSwitchTargetHelp": "Use this account first when the current account is exhausted. If unavailable, fall back to the highest composite-score usable account for that switch.",
    "detail.autoSwitchTargetCurrentHelp": "The current account cannot be its own next auto-switch target.",
    "detail.autoSwitchExcluded": "Skip this account on the next automatic switch",
    "detail.autoSwitchExcludedHelp": "Only automatic switching is affected; the explicit switch button remains available. Clears after a successful automatic switch.",
    "detail.autoSwitchExcludedCurrentHelp": "You can exclude the current account in advance so the next automatic switch will not select it.",
    "detail.controls": "Account controls",
    "detail.actions": "Actions",
    "detail.switchTo": "Switch to this account",
    "detail.autoSwitchTarget": "Next auto-switch target",
    "labels.none": "None",
    "labels.unknown": "Unknown",
    "labels.scoreUnit": "points",
    "labels.planUnknown": "Plan unknown",
    "labels.current": "Current",
    "labels.switchable": "Switchable",
    "labels.candidate": "Candidate",
    "labels.autoTarget": "Next switch",
    "labels.autoExcluded": "Next skip",
    "labels.bestScoreMode": "Best-score default",
    "fallback.manual_target_missing": "account no longer exists",
    "fallback.manual_target_current": "account is now current",
    "fallback.manual_target_excluded": "account is excluded from the next automatic switch",
    "fallback.manual_target_unavailable": "account is currently unavailable",
    "fallback.manual_target_unreadable": "local account record cannot be read",
    "labels.localRecord": "Local record {id}",
    "statusLabel.ready": "Ready",
    "statusLabel.usage_failed": "Usage refresh failed",
    "statusLabel.usage_auth_expired": "Usage authentication needs refresh",
    "confirm.switch": "Switch to {email}?\n\nSwitching will close ChatGPT Codex and try to reopen it.",
    "confirm.forceProjectionSwitch": "{detail}\n\nStill switch manually to {email}? Switcher will not repair or rewrite conversation data; process, backup, rollback, and thread-state safeguards remain active.",
    "confirm.delete": "Delete the local encrypted record for {email}?\n\nThis account is not current, so ChatGPT Codex will not be closed.",
    "confirm.httpOnly": "Changing the transport fully closes ChatGPT Codex and migrates history provider tags. It reopens afterward if it was running.\n\nContinue?",
    "confirm.disableGpu": "If this changes the current account's effective setting, Switcher fully closes ChatGPT Codex and reopens it with the new GPU preference.\n\nContinue?",
    "confirm.clearUsageObservations": "Clear local quota snapshots, account observation timeline, and weekly report history? Encrypted accounts and ChatGPT Codex sessions are not deleted.",
    "modal.deleteSwitch": "Delete and Switch",
    "modal.deleteLogin": "Delete and Log In",
    "modal.continue": "Continue"
  }
};

let accounts = [];
let selectedAccountId;
let tokenUsageStats;
let tokenUsageLoading = false;
let tokenUsageRequestId = 0;
let weeklyReport;
let weeklyReportLoading = false;
let weeklyReportUpdatedAt;
const reportCache = new Map();
const reportRequests = new Map();
let reportDataRevision = 0;
let compositionPinnedTrigger;
let compositionPreviewTrigger;
let expandedModelDisclosure;
let weeklyReportRequestId = 0;
let reportMode = "daily";
const reportDates = { daily: "", weekly: "" };
let settings = {
  autoSwitchEnabled: false,
  autoResumeAfterQuotaSwitch: false,
  requireSwitchConfirmation: true,
  lowQuotaWarningEnabled: true,
  lowQuotaThresholdPercent: 15,
  uiLanguage: "zh-CN",
  closeBehavior: "ask",
  themeMode: "system",
  edgeWindowEnabled: false,
  httpOnlyModeEnabled: false,
  disableGpuModeEnabled: false,
  accountListPanePercent: 46,
  usageRefreshIntervalMinutes: 5,
  autoSwitchStayAccountId: undefined,
  autoSwitchExcludedAccountIds: []
};
let autoSwitchInProgress = false;
let backgroundRefreshTimer;
let backgroundRefreshInProgress = false;
let currentQuotaSyncTimer;
let currentQuotaSyncInProgress = false;
let pendingAutoSwitch;
let pendingAutoSwitchTimer;
let pendingAutoSwitchDisplayTimer;
let pendingAutoSwitchCheckInProgress = false;
let manualResumeWatchGeneration = 0;
let autoResumeQueueWatchGeneration = 0;
let manualSwitchInProgress = false;
let threadActivityStatus;
let threadActivityTimer;
let threadActivityRequestId = 0;
let threadActivityRefreshInFlight = false;
let previousActiveThreadIds;
let previousThreadSidebarStateRevision;
let threadSidebarRevisionTimer;
let threadSidebarRevisionRequestId = 0;
let threadSidebarRevisionRefreshInFlight = false;
let threadSearchTimer;
let threadSearchRequestId = 0;
let threadSearchInFlight = false;
let queuedThreadSearch;
let threadSearchResults = [];
let threadSearchMessage = { key: "threads.searchPrompt" };
const threadGroupVisibleCounts = new Map();
let pinnedSectionOpen = localStorage.getItem(THREAD_PINNED_OPEN_KEY) !== "false";
let ordinarySectionOpen = localStorage.getItem(THREAD_ORDINARY_OPEN_KEY) !== "false";
let currentView = "accounts";
let accountSurfacesDirty = false;
const cachedRecoveryInventory = readRecoveryInventoryCache();
let recoveryBackups = cachedRecoveryInventory.inventory;
let recoveryBackupsListedAt = cachedRecoveryInventory.listedAt;
let recoveryBackupsFullValidatedAt = cachedRecoveryInventory.fullValidatedAt;
let latestRecoveryPreview;
let latestRecoverySelection;
let conversationBackupProgress;
let conversationBackupStartedAt;
let conversationBackupElapsedTimer;
let conversationBackupRunning = false;
const conversationBackupEta = createProgressEtaEstimator();
const recoveryEta = createProgressEtaEstimator();
let recoveryProgress;
let recoveryStartedAt;
let recoveryElapsedTimer;
let recoveryPreviewGeneration = 0;
let activeRecoveryGeneration;
let recoveryBackupsExpanded = false;
let usageDateTracksToday = true;
const pendingAutoSwitchIntervalMs = 15_000;
const threadActivityIntervalMs = 2_000;
const threadSidebarRevisionIntervalMs = 5_000;
const threadGroupPageSize = 10;
const accountScrollIdleMs = 140;
let accountScrollActiveUntil = 0;
let accountLoadRequestId = 0;

document.querySelector("#import-current").addEventListener("click", runAction(async () => {
  const account = await api.importCurrentAuth();
  selectedAccountId = account.id;
  try {
    await api.refreshUsage(account.id, true);
    await loadAccounts(t("status.importedRefreshed"), { deferWhileScrolling: true });
  } catch (error) {
    await loadAccounts(t("status.importedRefreshFailed", { error: errorMessage(error) }), { deferWhileScrolling: true });
  }
}));

document.querySelector("#add-account").addEventListener("click", runAction(async () => {
  const result = await api.beginAddAccount();
  selectedAccountId = result.preservedAccount.id;
  await loadAccounts(addAccountMessage(result));
  watchForAddedAccount(result.preservedAccount.id);
}));

let addAccountPollTimer;
let addAccountPollBusy = false;

function watchForAddedAccount(preservedAccountId) {
  clearInterval(addAccountPollTimer);
  addAccountPollTimer = setInterval(async () => {
    if (addAccountPollBusy) return;
    addAccountPollBusy = true;
    try {
      const result = await api.completeAddAccount(preservedAccountId);
      if (result?.status !== "imported") return;
      clearInterval(addAccountPollTimer);
      addAccountPollTimer = undefined;
      selectedAccountId = result.account.id;
      try {
        await api.refreshUsage(result.account.id, true);
      } catch {}
      await loadAccounts(t("status.addAccountImported"), { deferWhileScrolling: true });
    } catch (error) {
      clearInterval(addAccountPollTimer);
      addAccountPollTimer = undefined;
      setStatus(errorMessage(error));
    } finally {
      addAccountPollBusy = false;
    }
  }, 1_500);
}

refreshAllButton.addEventListener("click", runRefreshAction(async () => {
  const results = await api.refreshAllUsage();
  markReportDataChanged(results);
  await loadAccounts(refreshSummary(results, t("status.usageRefreshDone")), { deferWhileScrolling: true });
}));

document.querySelector("#pick-best").addEventListener("click", runAction(async () => {
  const result = await api.pickBestAccount();
  if (!result.account) {
    if (result.recovery) {
      selectedAccountId = result.recovery.id;
      render();
      setStatus(t("status.recoveryCandidate", { email: result.recovery.emailMasked, time: formatTime(exhaustedResetAt(result.recovery)) }));
      return;
    }
    setStatus(t("status.noCandidate"));
    return;
  }
  selectedAccountId = result.account.id;
  render();
  setStatus(t("status.bestAccount", { email: result.account.emailMasked, score: formatScore(result.score) }));
}));

settingsOpenFolder.addEventListener("click", runAction(async () => {
  await api.openCodexFolder();
}));

settingsQuitApp.addEventListener("click", runAction(async () => {
  await api.quitApp();
}));

settingsClearObservations.addEventListener("click", runAction(async () => {
  if (!confirm(t("confirm.clearUsageObservations"))) return;
  await api.clearUsageObservations();
  reportCache.clear();
  weeklyReport = undefined;
  weeklyReportUpdatedAt = undefined;
  setStatus(t("reports.cleared"));
}));

accountsNav.addEventListener("click", () => showView("accounts"));
threadsNav.addEventListener("click", () => showView("threads"));
usageNav.addEventListener("click", () => {
  syncUsageDateWithToday();
  showView("usage");
  void refreshTokenUsageView();
});
reportsNav.addEventListener("click", () => {
  showView("reports");
  hydrateReportCache();
  void refreshWeeklyReport({ background: true });
});
settingsNav.addEventListener("click", () => {
  showView("settings");
  void loadCodexRecoveryBackups();
  void refreshTransportDiagnostics();
});

threadsSearch.addEventListener("input", queueThreadSearch);
threadsShowArchived.addEventListener("change", () => {
  threadGroupVisibleCounts.clear();
  renderThreadSearchResults(threadSearchResults);
  setThreadSearchResultMessage();
});
threadsShowInternal.addEventListener("change", () => {
  threadGroupVisibleCounts.clear();
  renderThreadSearchResults(threadSearchResults);
  setThreadSearchResultMessage();
});
threadsShowUnregistered.addEventListener("change", () => {
  threadGroupVisibleCounts.clear();
  renderThreadSearchResults(threadSearchResults);
  setThreadSearchResultMessage();
});

document.addEventListener("mouseover", (event) => {
  const trigger = event.target.closest?.(".token-composition-trigger");
  if (trigger && !compositionPinnedTrigger) showTokenCompositionPopover(trigger);
});

document.addEventListener("mouseout", (event) => {
  const trigger = event.target.closest?.(".token-composition-trigger");
  if (trigger && !compositionPinnedTrigger && !trigger.contains(event.relatedTarget) && !tokenCompositionPopover.contains(event.relatedTarget)) hideTokenCompositionPopover();
});

document.addEventListener("focusin", (event) => {
  const trigger = event.target.closest?.(".token-composition-trigger");
  if (trigger && !compositionPinnedTrigger) showTokenCompositionPopover(trigger);
});

document.addEventListener("focusout", () => {
  setTimeout(() => {
    if (!compositionPinnedTrigger && !document.activeElement?.closest?.(".token-composition-trigger") && !tokenCompositionPopover.contains(document.activeElement)) hideTokenCompositionPopover();
  }, 0);
});

tokenCompositionPopover.addEventListener("mouseleave", () => {
  if (!compositionPinnedTrigger) hideTokenCompositionPopover();
});

document.addEventListener("click", (event) => {
  const trigger = event.target.closest?.(".token-composition-trigger");
  if (trigger) {
    event.stopPropagation();
    if (compositionPinnedTrigger === trigger) hideTokenCompositionPopover(true);
    else {
      hideTokenCompositionPopover(true);
      showTokenCompositionPopover(trigger, true);
    }
    return;
  }
  if (!tokenCompositionPopover.contains(event.target)) hideTokenCompositionPopover(true);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideTokenCompositionPopover(true);
});

reportsModelGroups.addEventListener("click", (event) => {
  const button = event.target.closest?.(".model-disclosure-button");
  if (!button) return;
  const panel = document.getElementById(button.getAttribute("aria-controls"));
  const opening = button.getAttribute("aria-expanded") !== "true";
  if (expandedModelDisclosure && expandedModelDisclosure !== button) {
    expandedModelDisclosure.setAttribute("aria-expanded", "false");
    document.getElementById(expandedModelDisclosure.getAttribute("aria-controls"))?.setAttribute("hidden", "");
  }
  button.setAttribute("aria-expanded", String(opening));
  button.title = t(opening ? "reports.collapseEvidence" : "reports.expandEvidence");
  panel.hidden = !opening;
  expandedModelDisclosure = opening ? button : undefined;
});

window.addEventListener("resize", () => {
  const trigger = compositionPinnedTrigger ?? compositionPreviewTrigger;
  if (trigger && !tokenCompositionPopover.hidden) positionTokenCompositionPopover(trigger);
});

refreshTokenUsageButton.addEventListener("click", runAction(async () => {
  syncUsageDateWithToday();
  await refreshTokenUsageView();
  setStatus(t("usage.refresh"));
}));

usageDateInput.addEventListener("change", runAction(async () => {
  clampUsageDateToToday();
  usageDateTracksToday = usageDateFollowsToday(usageDateInput.value, localDateInputValue(new Date()));
  await refreshTokenUsageView();
}));

usageDateButton.addEventListener("click", () => {
  syncUsageDateWithToday();
  if (typeof usageDateInput.showPicker === "function") {
    usageDateInput.showPicker();
    return;
  }
  usageDateInput.click();
});

refreshWeeklyReportButton.addEventListener("click", runAction(() => refreshWeeklyReport({ force: true })));
reportsWeekInput.addEventListener("change", runAction(() => refreshWeeklyReport({ force: true })));
reportsModeDaily.addEventListener("click", () => setReportMode("daily"));
reportsModeWeekly.addEventListener("click", () => setReportMode("weekly"));
reportsTodayButton.addEventListener("click", runAction(() => {
  reportsWeekInput.value = currentReportMaximum("daily");
  return refreshWeeklyReport({ force: true });
}));
for (const filter of [reportsAccountFilter, reportsModelFilter, reportsEffortFilter, reportsConfidenceFilter]) {
  filter.addEventListener("change", renderReportsView);
}

accountsSplitter.addEventListener("pointerdown", startPaneResize);
accountsSplitter.addEventListener("dblclick", runAction(async () => {
  settings = await api.updateSettings({ accountListPanePercent: 46 });
  syncSettingsControls();
}));

autoSwitchInput.addEventListener("change", runAction(async () => {
  settings = await api.updateSettings({ autoSwitchEnabled: autoSwitchInput.checked });
  syncSettingsControls();
  setStatus(t(autoSwitchInput.checked ? "status.autoSwitchOn" : "status.autoSwitchOff"));
  await evaluateQuotaActions("settings");
}));

lowQuotaWarningInput.addEventListener("change", runAction(async () => {
  settings = await api.updateSettings({ lowQuotaWarningEnabled: lowQuotaWarningInput.checked });
  syncSettingsControls();
  setStatus(t(lowQuotaWarningInput.checked ? "status.lowWarningOn" : "status.lowWarningOff"));
}));

quotaAutoSwitchAction.addEventListener("click", runAction(toggleCurrentAccountAutoSwitchHold));

languageSelect.addEventListener("change", runAction(async () => {
  await saveLanguage(languageSelect.value);
}));

searchInput.addEventListener("input", () => render());

scoreHelpButton.addEventListener("click", () => {
  if (scoreHelp.classList.contains("is-pinned")) {
    dismissScoreHelp(true);
    return;
  }
  positionScoreHelp();
  scoreHelp.classList.remove("is-dismissed");
  scoreHelp.classList.add("is-pinned");
  scoreHelpButton.setAttribute("aria-expanded", "true");
});

scoreHelp.addEventListener("pointerenter", () => {
  positionScoreHelp();
  scoreHelp.classList.remove("is-dismissed");
});
scoreHelp.addEventListener("focusin", positionScoreHelp);
scoreHelp.addEventListener("focusout", () => {
  setTimeout(() => {
    if (!scoreHelp.contains(document.activeElement) && !scoreHelp.matches(":hover")) {
      scoreHelp.classList.remove("is-dismissed");
    }
  });
});

document.addEventListener("pointerdown", (event) => {
  if (!scoreHelp.contains(event.target)) {
    dismissScoreHelp(false);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    dismissScoreHelp(true);
  }
});
window.addEventListener("resize", () => {
  if (scoreHelp.classList.contains("is-pinned")) positionScoreHelp();
});

settingsAutoSwitch.addEventListener("change", runAction(async () => {
  settings = await api.updateSettings({ autoSwitchEnabled: settingsAutoSwitch.checked });
  syncSettingsControls();
  setStatus(t(settingsAutoSwitch.checked ? "status.autoSwitchOn" : "status.autoSwitchOff"));
  await evaluateQuotaActions("settings");
}));

settingsAutoResumeAfterQuota.addEventListener("change", runAction(async () => {
  settings = await api.updateSettings({ autoResumeAfterQuotaSwitch: settingsAutoResumeAfterQuota.checked });
  syncSettingsControls();
  setStatus(t(settingsAutoResumeAfterQuota.checked ? "status.autoResumeOn" : "status.autoResumeOff"));
}));

settingsLowQuotaWarning.addEventListener("change", runAction(async () => {
  settings = await api.updateSettings({ lowQuotaWarningEnabled: settingsLowQuotaWarning.checked });
  syncSettingsControls();
  setStatus(t(settingsLowQuotaWarning.checked ? "status.lowWarningOn" : "status.lowWarningOff"));
}));

settingsRequireSwitchConfirmation.addEventListener("change", runAction(async () => {
  settings = await api.updateSettings({ requireSwitchConfirmation: settingsRequireSwitchConfirmation.checked });
  syncSettingsControls();
  setStatus(t(settingsRequireSwitchConfirmation.checked ? "status.switchConfirmOn" : "status.switchConfirmOff"));
}));

settingsRefreshInterval.addEventListener("change", runAction(async () => {
  settings = await api.updateSettings({ usageRefreshIntervalMinutes: Number(settingsRefreshInterval.value) });
  syncSettingsControls();
  startBackgroundRefreshTimer();
  setStatus(t("status.refreshIntervalSaved"));
}));

settingsClearAutoExclusions.addEventListener("click", runAction(async () => {
  if (!settings.autoSwitchExcludedAccountIds?.length) return;
  settings = await api.clearAutoSwitchExclusions();
  syncSettingsControls();
  await loadAccounts(t("status.autoSwitchExclusionsCleared"), { reason: "exclusions-cleared" });
}));

settingsRunConversationBackup.addEventListener("click", runAction(runExplicitConversationBackup));
settingsPreviewRecovery.addEventListener("click", runAction(previewSelectedRecovery));
settingsReplaceRecovery.addEventListener("click", runAction(replaceSelectedRecovery));
settingsRevalidateQuarantinedConversation.addEventListener("click", runAction(revalidateSelectedQuarantinedConversation));
settingsRefreshRecoveryBackups.addEventListener("click", runAction(() => loadCodexRecoveryBackups({ force: true, full: true })));
settingsQuarantinedConversationBackup.addEventListener("change", () => {
  settingsRevalidateQuarantinedConversation.disabled = !settingsQuarantinedConversationBackup.value;
});
settingsShowEarlierBackups.addEventListener("click", () => {
  recoveryBackupsExpanded = !recoveryBackupsExpanded;
  renderRecoveryBackupOptions();
});
for (const select of [settingsCompleteRecoveryPoint, settingsCriticalBackup, settingsConversationBackup]) {
  select.addEventListener("change", () => {
    if (select === settingsCompleteRecoveryPoint && select.value) {
      settingsCriticalBackup.value = "";
      settingsConversationBackup.value = "";
    } else if (select !== settingsCompleteRecoveryPoint && select.value) {
      settingsCompleteRecoveryPoint.value = "";
    }
    invalidateRecoveryPreview();
    settingsPreviewRecovery.disabled = !hasRecoverySelection();
  });
}

settingsHttpOnly.addEventListener("change", runAction(async () => {
  const requested = settingsHttpOnly.checked;
  const currentAccount = accounts.find((account) => account.isCurrent);
  if (!currentAccount?.httpOnlyModeOverride && !confirm(t("confirm.httpOnly"))) {
    settingsHttpOnly.checked = !requested;
    return;
  }
  try {
    const result = await api.setHttpOnlyMode(requested);
    settings = result.settings;
    syncSettingsControls();
    const launch = result.closedCodexProcesses > 0
      ? (result.launchedCodex ? t("status.launchOk") : t("status.launchFailed"))
      : "";
    setStatus(t(requested ? "status.httpOnlyOn" : "status.httpOnlyOff", {
      rollouts: result.migration?.changedRollouts ?? 0,
      threads: result.migration?.changedThreads ?? 0,
      launch
    }));
    await refreshTransportDiagnostics();
  } catch (error) {
    settings = await api.readSettings();
    syncSettingsControls();
    throw error;
  }
}));

settingsEdgeWindow.addEventListener("change", runAction(async () => {
  settings = await api.updateSettings({ edgeWindowEnabled: settingsEdgeWindow.checked });
  syncSettingsControls();
  setStatus(t(settingsEdgeWindow.checked ? "status.edgeWindowOn" : "status.edgeWindowOff"));
}));

settingsDisableGpu.addEventListener("change", runAction(async () => {
  const requested = settingsDisableGpu.checked;
  if (!confirm(t("confirm.disableGpu"))) {
    settingsDisableGpu.checked = !requested;
    return;
  }
  try {
    const result = await api.setDisableGpuMode(requested);
    settings = result.settings;
    syncSettingsControls();
    const launch = result.closedCodexProcesses > 0
      ? (result.launchedCodex ? t("status.launchOk") : t("status.launchFailed"))
      : "";
    setStatus(t(requested ? "status.disableGpuOn" : "status.disableGpuOff", { launch }));
  } catch (error) {
    settings = await api.readSettings();
    syncSettingsControls();
    throw error;
  }
}));

settingsLanguage.addEventListener("change", runAction(async () => {
  await saveLanguage(settingsLanguage.value);
}));

for (const input of settingsThemeInputs) {
  input.addEventListener("change", runAction(async () => {
    settings = await api.updateSettings({ themeMode: input.value });
    syncSettingsControls();
    applyTheme();
    setStatus(t("status.themeSaved"));
  }));
}

for (const input of document.querySelectorAll('input[name="settings-close-behavior"]')) {
  input.addEventListener("change", runAction(async () => {
    settings = await api.updateSettings({ closeBehavior: input.value });
    syncSettingsControls();
    setStatus(t("status.closeBehaviorSaved"));
  }));
}

closeDialog.addEventListener("close", async () => {
  const action = closeDialog.returnValue;
  if (action !== "minimize" && action !== "tray" && action !== "quit") {
    return;
  }
  try {
    const result = await api.applyCloseDecision({ action, remember: closeRemember.checked });
    if (result.remembered) {
      settings = await api.readSettings();
      syncSettingsControls();
    }
  } catch (error) {
    setStatus(errorMessage(error));
  } finally {
    closeDialog.returnValue = "";
  }
});

remarkCancel.addEventListener("click", () => remarkDialog.close("cancel"));

remarkInput.addEventListener("input", () => remarkInput.setCustomValidity(""));

remarkDialog.addEventListener("submit", (event) => {
  if (!remarkInput.value.includes("\uFFFD")) return;
  event.preventDefault();
  remarkInput.setCustomValidity(t("modal.remarkInvalid"));
  remarkInput.reportValidity();
});

api.onCloseDecisionRequested(() => {
  if (closeDialog.open) {
    return;
  }
  closeDialog.returnValue = "";
  closeRemember.checked = false;
  closeDialog.showModal();
});

api.onMainProcessWarning((payload) => {
  setStatus(payload?.message || t("status.backgroundFailed", { error: t("labels.unknown") }));
});

api.onUsageRefreshProgress?.(({ operationId, progress }) => {
  if (!Number.isSafeInteger(operationId) || !progress || typeof progress !== "object") return;
  if (pendingAutoSwitch) return;
  if (progress.stage === "persisting") {
    setStatus(t("status.usageRefreshPersisting", { total: progress.total }));
  } else if (progress.stage === "refreshing") {
    setStatus(t("status.usageRefreshProgress", {
      completed: progress.completed,
      total: progress.total
    }));
  }
});

initialize();

async function initialize() {
  await loadSettings();
  initializeUsageDate();
  initializeReportsWeek();
  ensureTransportDiagnosticsSection();
  applyTheme();
  applyTranslations();
  await loadAppVersion();
  showView(currentView);
  await loadAccounts(t("status.ready"));
  const dshAuthSyncState = await api.getDshAuthSyncState?.();
  if (dshAuthSyncState?.status === "pending_busy") setStatus(t("status.dshAuthSyncPendingBusy"));
  else if (dshAuthSyncState?.status === "pending_retry") setStatus(t("status.dshAuthSyncPendingRetry"));
  else if (dshAuthSyncState?.status === "failed" && dshAuthSyncState?.unresolvedDrift) setStatus(t("status.dshAuthSyncFailed"));
  initializePaneObservers();
  initializeAccountScrollTracking();
  updatePaneDensity();
  void refreshAllUsageInBackground();
  startCurrentQuotaSyncTimer();
}

function initializeUsageDate() {
  usageDateTracksToday = true;
  syncUsageDateWithToday();
}

function initializeReportsWeek() {
  const today = new Date(beijingDayStart());
  const date = new Date(previousBeijingWeekStart());
  reportDates.daily = localDateInputValue(today);
  reportDates.weekly = localDateInputValue(date);
  reportsWeekInput.value = reportDates.daily;
  reportsWeekInput.max = currentReportMaximum(reportMode);
  populateReportFilter(reportsAccountFilter, [], t("reports.all"));
  populateReportFilter(reportsModelFilter, [], t("reports.all"));
  populateReportFilter(reportsEffortFilter, [], t("reports.all"));
  populateReportFilter(reportsConfidenceFilter, ["high", "medium", "low", "insufficient"], t("reports.all"));
}

async function loadSettings() {
  settings = await api.readSettings();
  syncSettingsControls();
}

function ensureTransportDiagnosticsSection() {
  if (transportDiagnosticsSection) return transportDiagnosticsSection;
  const grid = settingsView?.querySelector(".settings-grid");
  if (!grid) return undefined;

  const section = document.createElement("section");
  section.id = "settings-transport-diagnostics";
  section.className = "settings-section";

  const heading = document.createElement("h3");
  heading.dataset.i18n = "settings.transportDiagnosticsTitle";
  section.append(heading);

  const help = document.createElement("p");
  help.dataset.i18n = "settings.transportDiagnosticsHelp";
  section.append(help);

  const status = document.createElement("p");
  status.className = "settings-note";
  status.setAttribute("aria-live", "polite");
  section.append(status);

  const rows = [
    ["settings.transportWireMode", "wire-mode"],
    ["settings.transportWebsockets", "websockets"],
    ["settings.transportRetryLimit", "retry-limit"],
    ["settings.transportIdleTimeout", "idle-timeout"],
    ["settings.transportProxySource", "proxy-source"],
    ["settings.transportErrorCategory", "error-category"],
    ["settings.transportRetryOrdinal", "retry-ordinal"]
  ];
  const list = document.createElement("dl");
  const values = {};
  for (const [labelKey, id] of rows) {
    const row = document.createElement("div");
    const label = document.createElement("dt");
    label.dataset.i18n = labelKey;
    const value = document.createElement("dd");
    value.id = `settings-transport-${id}`;
    row.append(label, value);
    list.append(row);
    values[id] = value;
  }
  section.append(list);
  grid.append(section);
  transportDiagnosticsSection = section;
  transportDiagnosticValueElements = values;
  transportDiagnosticStatus = status;
  renderTransportDiagnostics(latestTransportDiagnostics);
  return section;
}

async function refreshTransportDiagnostics() {
  ensureTransportDiagnosticsSection();
  try {
    if (typeof api.getTransportDiagnostics !== "function") throw new Error("transport diagnostics unavailable");
    const result = await api.getTransportDiagnostics();
    latestTransportDiagnostics = result && typeof result === "object" && !Array.isArray(result) ? result : undefined;
    transportDiagnosticsUnavailable = !latestTransportDiagnostics;
  } catch {
    latestTransportDiagnostics = undefined;
    transportDiagnosticsUnavailable = true;
  }
  renderTransportDiagnostics(latestTransportDiagnostics);
}

function renderTransportDiagnostics(diagnostics) {
  ensureTransportDiagnosticsSection();
  if (!transportDiagnosticValueElements) return;
  const value = diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics) ? diagnostics : {};
  transportDiagnosticValueElements["wire-mode"].textContent = transportWireModeLabel(value.wireMode);
  transportDiagnosticValueElements.websockets.textContent = transportWebsocketLabel(value.supportsWebsockets);
  transportDiagnosticValueElements["retry-limit"].textContent = transportIntegerLabel(value.streamMaxRetries);
  transportDiagnosticValueElements["idle-timeout"].textContent = transportMillisecondsLabel(value.streamIdleTimeoutMs);
  transportDiagnosticValueElements["proxy-source"].textContent = transportProxyLabel(value.proxySource);
  transportDiagnosticValueElements["error-category"].textContent = transportErrorLabel(value.errorCategory);
  transportDiagnosticValueElements["retry-ordinal"].textContent = transportRetryOrdinalLabel(value.retryOrdinal);
  if (transportDiagnosticStatus) {
    transportDiagnosticStatus.textContent = transportDiagnosticsUnavailable ? t("settings.transportUnavailable") : "";
  }
  translateTree(transportDiagnosticsSection);
}

function transportWireModeLabel(value) {
  if (value === "responses_sse") return t("settings.transportResponsesSse");
  if (value === "websocket_capable") return t("settings.transportWebsocketCapable");
  return t("settings.transportUnknown");
}

function transportWebsocketLabel(value) {
  if (value === true) return t("settings.transportWebsocketYes");
  if (value === false) return t("settings.transportWebsocketNo");
  return t("settings.transportUnknown");
}

function transportIntegerLabel(value) {
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : t("settings.transportUnknown");
}

function transportMillisecondsLabel(value) {
  return Number.isSafeInteger(value) && value >= 0
    ? t("settings.transportMilliseconds", { value })
    : t("settings.transportUnknown");
}

function transportProxyLabel(value) {
  const keys = {
    none: "settings.transportProxyNone",
    env: "settings.transportProxyEnvironment",
    windows: "settings.transportProxyWindows",
    both: "settings.transportProxyBoth",
    mismatch: "settings.transportProxyMismatch"
  };
  return t(keys[value] ?? "settings.transportUnknown");
}

function transportErrorLabel(value) {
  const keys = {
    unknown: "settings.transportErrorUnknown",
    response_decode: "settings.transportErrorResponseDecode",
    tls_failure: "settings.transportErrorTls",
    connection_refused: "settings.transportErrorConnectionRefused",
    timeout: "settings.transportErrorTimeout",
    stream_reset: "settings.transportErrorStreamReset"
  };
  return t(keys[value] ?? "settings.transportErrorUnknown");
}

function transportRetryOrdinalLabel(value) {
  return Number.isSafeInteger(value) && value >= 0
    ? t("settings.transportAttempt", { value })
    : t("settings.transportUnknown");
}

async function runExplicitConversationBackup() {
  settingsRunConversationBackup.disabled = true;
  settingsRunConversationBackup.setAttribute("aria-busy", "true");
  conversationBackupRunning = true;
  conversationBackupStartedAt = Date.now();
  conversationBackupEta.reset();
  conversationBackupProgress = { stage: "discovering" };
  renderConversationBackupProgress();
  clearInterval(conversationBackupElapsedTimer);
  conversationBackupElapsedTimer = setInterval(renderConversationBackupProgress, 1_000);
  settingsBackupStatus.textContent = t("settings.backupRunning");
  try {
    const result = await api.runConversationBackup();
    await loadSettings();
    await loadCodexRecoveryBackups({ force: true, full: false });
    conversationBackupProgress = { ...conversationBackupProgress, stage: "completed" };
    renderConversationBackupProgress();
    settingsBackupStatus.textContent = t("settings.backupSucceeded", {
      active: result?.counts?.active ?? 0,
      archived: result?.counts?.archived ?? 0,
      seconds: backupElapsedSeconds()
    });
  } catch (error) {
    settingsBackupStatus.textContent = t("settings.backupFailed", { error: errorMessage(error) });
  } finally {
    conversationBackupRunning = false;
    clearInterval(conversationBackupElapsedTimer);
    conversationBackupElapsedTimer = undefined;
    renderConversationBackupProgress();
    settingsRunConversationBackup.disabled = false;
    settingsRunConversationBackup.removeAttribute("aria-busy");
  }
}

api.onConversationBackupProgress((progress) => {
  if (!conversationBackupRunning) return;
  if (progress?.stage === "completed") return;
  conversationBackupProgress = progress;
  renderConversationBackupProgress();
});

function renderConversationBackupProgress() {
  if (!conversationBackupProgress || !conversationBackupStartedAt) {
    settingsBackupProgress.hidden = true;
    return;
  }
  const progress = conversationBackupProgress;
  const stageKey = {
    discovering: "settings.backupStageDiscovering",
    processing: "settings.backupStageProcessing",
    validating: "settings.backupStageValidating",
    pruning: "settings.backupStagePruning",
    completed: "settings.backupStageCompleted"
  }[progress.stage] ?? "settings.backupStageDiscovering";
  settingsBackupProgress.hidden = false;
  settingsBackupProgressStage.textContent = t(stageKey);
  if (["processing", "validating"].includes(progress.stage) && progress.totalBytes > 0) {
    settingsBackupProgressBar.value = Math.min(100, (progress.processedBytes / progress.totalBytes) * 100);
  } else if (progress.stage === "completed") {
    settingsBackupProgressBar.value = 100;
  } else {
    settingsBackupProgressBar.removeAttribute("value");
  }
  const detail = Number.isSafeInteger(progress.totalFiles)
    ? t("settings.backupProgressDetail", {
        processedFiles: progress.processedFiles,
        totalFiles: progress.totalFiles,
        processedBytes: formatBackupBytes(progress.processedBytes),
        totalBytes: formatBackupBytes(progress.totalBytes),
        seconds: backupElapsedSeconds()
      })
    : t("settings.backupElapsed", { seconds: backupElapsedSeconds() });
  if (!["processing", "validating"].includes(progress.stage)) {
    settingsBackupProgressDetail.textContent = detail;
  } else {
    const estimate = estimatedRemaining(progress, conversationBackupStartedAt, conversationBackupEta);
    settingsBackupProgressDetail.textContent = `${detail} · ${estimate === undefined
      ? t("settings.backupEstimating")
      : t("settings.backupEta", { minutes: estimate })}`;
  }
}

function estimatedRemaining(progress, startedAt, estimator) {
  return estimator.update(progress, Date.now(), startedAt);
}

function backupElapsedSeconds() {
  return conversationBackupStartedAt ? Math.max(0, Math.floor((Date.now() - conversationBackupStartedAt) / 1_000)) : 0;
}

function formatBackupBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1_024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  const exponent = Math.min(units.length, Math.floor(Math.log(bytes) / Math.log(1_024)));
  return `${new Intl.NumberFormat(currentLanguage(), { maximumFractionDigits: 1 }).format(bytes / (1_024 ** exponent))} ${units[exponent - 1]}`;
}

async function loadCodexRecoveryBackups({ force = false, full: requestedFull } = {}) {
  if (recoveryBackups) renderRecoveryBackupOptions();
  if (recoveryBackups && !force) await loadSettings();
  const now = Date.now();
  const latestConversationBackupAt = Math.max(
    Number(settings.lastConversationIncrementalSucceededAtMs) || 0,
    Number(settings.lastConversationFullVerificationSucceededAtMs) || 0
  );
  recoveryBackupsFullValidatedAt = Math.max(
    Number(recoveryBackupsFullValidatedAt) || 0,
    Number(settings.lastConversationFullVerificationSucceededAtMs) || 0
  );
  if (
    recoveryBackups &&
    !force &&
    recoveryBackupsListedAt <= now &&
    recoveryBackupsListedAt >= latestConversationBackupAt &&
    now - recoveryBackupsListedAt < RECOVERY_INVENTORY_MAX_AGE_MS &&
    recoveryBackupsFullValidatedAt <= now &&
    now - recoveryBackupsFullValidatedAt < RECOVERY_INVENTORY_MAX_AGE_MS
  ) return;
  const full = requestedFull === true || !recoveryBackups ||
    !Number.isFinite(recoveryBackupsFullValidatedAt) ||
    now - recoveryBackupsFullValidatedAt >= RECOVERY_INVENTORY_MAX_AGE_MS;
  invalidateRecoveryPreview();
  const generation = recoveryPreviewGeneration;
  activeRecoveryGeneration = generation;
  settingsPreviewRecovery.disabled = true;
  settingsBackupStatus.textContent = t("settings.backupLoading");
  recoveryStartedAt = Date.now();
  recoveryEta.reset();
  recoveryProgress = { stage: "discovering" };
  renderRecoveryProgress();
  clearInterval(recoveryElapsedTimer);
  recoveryElapsedTimer = setInterval(() => {
    if (activeRecoveryGeneration === generation) renderRecoveryProgress();
  }, 1_000);
  try {
    const loadedRecoveryBackups = await api.listCodexRecoveryBackups({ full });
    if (generation !== recoveryPreviewGeneration) return;
    const completedAt = Date.now();
    recoveryBackups = loadedRecoveryBackups;
    recoveryBackupsListedAt = completedAt;
    if (full) recoveryBackupsFullValidatedAt = completedAt;
    persistRecoveryInventoryCache(recoveryBackups, recoveryBackupsListedAt, recoveryBackupsFullValidatedAt);
    renderRecoveryBackupOptions();
    settingsBackupStatus.textContent = "";
  } catch (error) {
    if (generation !== recoveryPreviewGeneration) return;
    if (!recoveryBackups) renderRecoveryBackupOptions();
    settingsBackupStatus.textContent = t("settings.backupListFailed", { error: errorMessage(error) });
  } finally {
    if (activeRecoveryGeneration === generation) {
      clearInterval(recoveryElapsedTimer);
      recoveryElapsedTimer = undefined;
      activeRecoveryGeneration = undefined;
    }
  }
}

api.onRecoveryProgress((progress) => {
  if (activeRecoveryGeneration === undefined) return;
  recoveryProgress = progress;
  renderRecoveryProgress();
});

function renderRecoveryProgress() {
  if (!recoveryProgress) {
    settingsRecoveryProgress.hidden = true;
    return;
  }
  const stageKey = {
    discovering: "settings.recoveryStageDiscovering",
    validating: "settings.recoveryStageValidating",
    validating_backup: "settings.recoveryStageValidating",
    comparing_live: "settings.recoveryStageComparing",
    completed: "settings.recoveryStageCompleted"
  }[recoveryProgress.stage] ?? "settings.recoveryStageDiscovering";
  settingsRecoveryProgress.hidden = false;
  settingsRecoveryProgressStage.textContent = t(stageKey);
  if (recoveryProgress.totalBytes > 0) {
    settingsRecoveryProgressBar.value = Math.min(100, (recoveryProgress.processedBytes / recoveryProgress.totalBytes) * 100);
  } else if (recoveryProgress.stage === "completed") {
    settingsRecoveryProgressBar.value = 100;
  } else {
    settingsRecoveryProgressBar.removeAttribute("value");
  }
  const seconds = Math.max(0, Math.floor((Date.now() - recoveryStartedAt) / 1_000));
  if (Number.isSafeInteger(recoveryProgress.totalFiles)) {
    const detail = t("settings.backupProgressDetail", {
      processedFiles: recoveryProgress.processedFiles,
      totalFiles: recoveryProgress.totalFiles,
      processedBytes: formatBackupBytes(recoveryProgress.processedBytes),
      totalBytes: formatBackupBytes(recoveryProgress.totalBytes),
      seconds
    });
    if (recoveryProgress.stage === "completed") {
      settingsRecoveryProgressDetail.textContent = detail;
    } else {
      const estimate = estimatedRemaining(recoveryProgress, recoveryStartedAt, recoveryEta);
      settingsRecoveryProgressDetail.textContent = `${detail} · ${estimate === undefined
        ? t("settings.backupEstimating")
        : t("settings.backupEta", { minutes: estimate })}`;
    }
  } else {
    settingsRecoveryProgressDetail.textContent = t("settings.backupElapsed", { seconds });
  }
}

function renderRecoveryBackupOptions() {
  populateCompleteRecoveryPointSelect(recoveryBackups?.completeRecoveryPoints);
  const criticalGenerations = [...(recoveryBackups?.criticalGenerations ?? [])].toReversed();
  const selectedCritical = criticalGenerations.find((item) => item.generationId === settingsCriticalBackup.value);
  const visibleCriticalGenerations = recoveryBackupsExpanded
    ? criticalGenerations
    : [...criticalGenerations.slice(0, 5), ...(selectedCritical && !criticalGenerations.slice(0, 5).includes(selectedCritical) ? [selectedCritical] : [])];
  populateRecoveryBackupSelect(settingsCriticalBackup, visibleCriticalGenerations, "critical");
  populateRecoveryBackupSelect(settingsConversationBackup, recoveryBackups?.conversationGenerations, "conversation");
  populateQuarantinedConversationBackupSelect(recoveryBackups?.quarantinedConversationGenerations);
  const unavailable = Number(recoveryBackups?.unavailableConversationBackups) || 0;
  settingsQuarantinedConversationStatus.textContent = unavailable > 0
    ? t("settings.unavailableConversationBackups", { count: unavailable })
    : "";
  settingsShowEarlierBackups.hidden = criticalGenerations.length <= 5;
  settingsShowEarlierBackups.textContent = t(recoveryBackupsExpanded ? "settings.showRecentBackups" : "settings.showEarlierBackups");
  settingsPreviewRecovery.disabled = !hasRecoverySelection();
  updateReplacementAvailability();
}

function populateCompleteRecoveryPointSelect(points = []) {
  const selected = settingsCompleteRecoveryPoint.value;
  settingsCompleteRecoveryPoint.replaceChildren();
  if (points.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = t("settings.noCompleteRecoveryPoint");
    settingsCompleteRecoveryPoint.append(option);
    return;
  }
  for (const point of points) {
    const option = document.createElement("option");
    option.value = point.recoveryPointId;
    option.textContent = t("settings.completeRecoveryPointOption", {
      time: formatBeijingTime(point.checkpointTime),
      projects: point.counts.projects,
      threads: point.counts.threads,
      conversations: point.counts.active + point.counts.archived
    });
    option.label = `${option.textContent} · ${t("settings.completeRecoveryPointCaptures", {
      criticalTime: formatBeijingTime(point.criticalCapturedAt),
      conversationTime: formatBeijingTime(point.conversationCapturedAt)
    })}`;
    settingsCompleteRecoveryPoint.append(option);
  }
  if ([...settingsCompleteRecoveryPoint.options].some((option) => option.value === selected)) settingsCompleteRecoveryPoint.value = selected;
}

function populateRecoveryBackupSelect(select, generations = [], kind) {
  const selected = select.value;
  select.replaceChildren();
  if (generations.length === 0) {
    const option = document.createElement("option");
    option.textContent = t(kind === "critical" ? "settings.noCriticalBackup" : "settings.noConversationBackup");
    option.value = "";
    select.append(option);
    return;
  }
  for (const generation of generations) {
    const option = document.createElement("option");
    option.value = generation.generationId;
    option.textContent = backupOptionLabel(generation, kind);
    select.append(option);
  }
  if ([...select.options].some((option) => option.value === selected)) select.value = selected;
}

function readRecoveryInventoryCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(RECOVERY_INVENTORY_CACHE_KEY));
    const inventory = cached?.inventory;
    const listedAt = cached?.listedAt ?? cached?.validatedAt;
    const fullValidatedAt = cached?.fullValidatedAt ?? cached?.validatedAt;
    if (
      !Number.isFinite(listedAt) ||
      !Number.isFinite(fullValidatedAt) ||
      !inventory ||
      !Array.isArray(inventory.completeRecoveryPoints) ||
      !Array.isArray(inventory.criticalGenerations) ||
      !Array.isArray(inventory.conversationGenerations) ||
      !Array.isArray(inventory.quarantinedConversationGenerations) ||
      !Number.isFinite(inventory.unavailableConversationBackups)
    ) return {};
    return { inventory, listedAt, fullValidatedAt };
  } catch {
    return {};
  }
}

function persistRecoveryInventoryCache(inventory, listedAt, fullValidatedAt) {
  try {
    localStorage.setItem(RECOVERY_INVENTORY_CACHE_KEY, JSON.stringify({ inventory, listedAt, fullValidatedAt }));
  } catch {}
}

function populateQuarantinedConversationBackupSelect(generations = []) {
  const selected = settingsQuarantinedConversationBackup.value;
  settingsQuarantinedConversationBackup.replaceChildren();
  if (generations.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = t("settings.noQuarantinedConversationBackup");
    settingsQuarantinedConversationBackup.append(option);
  } else {
    for (const generation of generations) {
      const option = document.createElement("option");
      option.value = generation.generationId;
      option.textContent = generation.backupTime && generation.counts
        ? t("settings.quarantinedConversationBackupOption", {
            time: formatBeijingTime(generation.backupTime),
            ...generation.counts
          })
        : t("settings.quarantinedConversationBackupUnknown");
      settingsQuarantinedConversationBackup.append(option);
    }
  }
  if ([...settingsQuarantinedConversationBackup.options].some((option) => option.value === selected)) {
    settingsQuarantinedConversationBackup.value = selected;
  }
  settingsQuarantinedConversationBackupRow.hidden = generations.length === 0;
  settingsRevalidateQuarantinedConversation.disabled = !settingsQuarantinedConversationBackup.value;
}

function backupOptionLabel(generation, kind) {
  const time = formatBeijingTime(generation.backupTime);
  return kind === "critical"
    ? t("settings.criticalBackupOption", { time, ...generation.counts })
    : t("settings.conversationBackupOption", { time, ...generation.counts });
}

async function revalidateSelectedQuarantinedConversation() {
  const conversationId = settingsQuarantinedConversationBackup.value;
  if (!conversationId) return;
  invalidateRecoveryPreview();
  const generation = recoveryPreviewGeneration;
  activeRecoveryGeneration = generation;
  settingsRevalidateQuarantinedConversation.disabled = true;
  settingsRevalidateQuarantinedConversation.setAttribute("aria-busy", "true");
  settingsQuarantinedConversationStatus.textContent = t("settings.revalidatingQuarantinedConversation");
  recoveryStartedAt = Date.now();
  recoveryEta.reset();
  recoveryProgress = { stage: "discovering" };
  renderRecoveryProgress();
  recoveryElapsedTimer = setInterval(() => {
    if (activeRecoveryGeneration === generation) renderRecoveryProgress();
  }, 1_000);
  try {
    await api.revalidateQuarantinedConversation(conversationId);
    await loadCodexRecoveryBackups({ force: true, full: false });
    settingsQuarantinedConversationStatus.textContent = t("settings.revalidateQuarantinedConversationSucceeded");
  } catch {
    settingsQuarantinedConversationStatus.textContent = t("settings.revalidateQuarantinedConversationFailed");
  } finally {
    if (activeRecoveryGeneration === generation) {
      clearInterval(recoveryElapsedTimer);
      recoveryElapsedTimer = undefined;
      activeRecoveryGeneration = undefined;
    }
    settingsRevalidateQuarantinedConversation.removeAttribute("aria-busy");
    settingsRevalidateQuarantinedConversation.disabled = !settingsQuarantinedConversationBackup.value;
  }
}

async function previewSelectedRecovery() {
  const selection = selectedRecoverySelection();
  invalidateRecoveryPreview();
  const generation = recoveryPreviewGeneration;
  activeRecoveryGeneration = generation;
  settingsPreviewRecovery.disabled = true;
  settingsPreviewRecovery.setAttribute("aria-busy", "true");
  settingsRecoveryPreview.textContent = t("settings.previewLoading");
  recoveryStartedAt = Date.now();
  recoveryEta.reset();
  recoveryProgress = { stage: "discovering" };
  renderRecoveryProgress();
  clearInterval(recoveryElapsedTimer);
  recoveryElapsedTimer = setInterval(() => {
    if (activeRecoveryGeneration === generation) renderRecoveryProgress();
  }, 1_000);
  try {
    const preview = await api.previewCodexRecovery(selection);
    if (generation !== recoveryPreviewGeneration) return;
    latestRecoveryPreview = preview;
    latestRecoverySelection = selection;
    renderRecoveryPreview(latestRecoveryPreview);
  } catch (error) {
    if (generation !== recoveryPreviewGeneration) return;
    latestRecoveryPreview = undefined;
    settingsRecoveryPreview.textContent = t("settings.previewFailed", { error: errorMessage(error) });
  } finally {
    if (activeRecoveryGeneration === generation) {
      clearInterval(recoveryElapsedTimer);
      recoveryElapsedTimer = undefined;
      activeRecoveryGeneration = undefined;
    }
    settingsPreviewRecovery.disabled = !hasRecoverySelection();
    settingsPreviewRecovery.removeAttribute("aria-busy");
    updateReplacementAvailability();
  }
}

function selectedRecoverySelection() {
  if (settingsCompleteRecoveryPoint.value) return { recoveryPointId: settingsCompleteRecoveryPoint.value };
  return { criticalId: settingsCriticalBackup.value, conversationId: settingsConversationBackup.value };
}

function hasRecoverySelection() {
  return Boolean(settingsCompleteRecoveryPoint.value || (settingsCriticalBackup.value && settingsConversationBackup.value));
}

function recoverySelectionMatches(selection) {
  return Boolean(
    latestRecoveryPreview &&
    latestRecoverySelection &&
    JSON.stringify(selection) === JSON.stringify(latestRecoverySelection)
  );
}

function invalidateRecoveryPreview() {
  recoveryPreviewGeneration += 1;
  activeRecoveryGeneration = undefined;
  clearInterval(recoveryElapsedTimer);
  recoveryElapsedTimer = undefined;
  recoveryProgress = undefined;
  latestRecoveryPreview = undefined;
  latestRecoverySelection = undefined;
  settingsRecoveryPreview.textContent = "";
  settingsReplacementStatus.textContent = "";
  updateReplacementAvailability();
}

function updateReplacementAvailability() {
  settingsReplaceRecovery.disabled = !recoverySelectionMatches(selectedRecoverySelection());
}

async function replaceSelectedRecovery() {
  const selection = selectedRecoverySelection();
  if (!recoverySelectionMatches(selection)) return;
    settingsReplaceRecovery.disabled = true;
    settingsReplaceRecovery.setAttribute("aria-busy", "true");
    settingsCompleteRecoveryPoint.disabled = true;
    settingsCriticalBackup.disabled = true;
  settingsConversationBackup.disabled = true;
  settingsReplacementStatus.textContent = t("settings.replacePreparing");
  try {
    const prepared = await api.prepareCodexReplacement(selection);
    if (!recoverySelectionMatches(selection)) {
      settingsReplacementStatus.textContent = t("settings.replaceSelectionChanged");
      return;
    }
    if (!confirm(t("confirm.replaceCodexRecovery"))) {
      settingsReplacementStatus.textContent = t("settings.replaceCancelled");
      return;
    }
    settingsReplacementStatus.textContent = t("settings.replaceRunning");
    await api.confirmCodexReplacement({ ...selection, confirmationToken: prepared.confirmationToken });
    await loadCodexRecoveryBackups();
    settingsReplacementStatus.textContent = t("settings.replaceSucceeded");
  } catch {
    await loadCodexRecoveryBackups();
    settingsReplacementStatus.textContent = t("settings.replaceFailed");
  } finally {
    settingsCriticalBackup.disabled = false;
    settingsConversationBackup.disabled = false;
    settingsCompleteRecoveryPoint.disabled = false;
    settingsReplaceRecovery.removeAttribute("aria-busy");
    updateReplacementAvailability();
  }
}

function renderRecoveryPreview(preview) {
  const rows = [
    ["settings.previewBackupTime", formatBeijingTime(preview.backupTime)],
    ["settings.previewProjects", preview.counts.projects],
    ["settings.previewAssignments", preview.counts.assignments],
    ["settings.previewThreads", preview.counts.threads],
    ["settings.previewActive", preview.counts.active],
    ["settings.previewArchived", preview.counts.archived],
    ["settings.previewMissing", preview.effects.missing],
    ["settings.previewConflicts", preview.effects.conflicts]
  ];
  settingsRecoveryPreview.innerHTML = `<p>${escapeHtml(t("settings.recoveryPreviewPrivacy"))}</p><dl>${rows.map(([key, value]) => `<div><dt>${escapeHtml(t(key))}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>`;
}

function syncSettingsControls() {
  autoSwitchInput.checked = Boolean(settings.autoSwitchEnabled);
  lowQuotaWarningInput.checked = Boolean(settings.lowQuotaWarningEnabled);
  languageSelect.value = settings.uiLanguage === "en" ? "en" : "zh-CN";
  settingsAutoSwitch.checked = Boolean(settings.autoSwitchEnabled);
  settingsAutoResumeAfterQuota.checked = Boolean(settings.autoResumeAfterQuotaSwitch);
  settingsAutoTargetSummary.textContent = autoSwitchTargetSummary();
  settingsBackupPolicy.textContent = t("settings.backupPolicyStatus", {
    incremental: formatBackupSuccessTime(settings.lastConversationIncrementalSucceededAtMs),
    full: formatBackupSuccessTime(settings.lastConversationFullVerificationSucceededAtMs)
  });
  settingsAutoExclusions.textContent = autoSwitchExclusionsSummary();
  settingsClearAutoExclusions.disabled = !settings.autoSwitchExcludedAccountIds?.length;
  settingsLowQuotaWarning.checked = Boolean(settings.lowQuotaWarningEnabled);
  settingsRequireSwitchConfirmation.checked = settings.requireSwitchConfirmation !== false;
  settingsEdgeWindow.checked = Boolean(settings.edgeWindowEnabled);
  settingsHttpOnly.checked = Boolean(settings.httpOnlyModeEnabled);
  settingsDisableGpu.checked = Boolean(settings.disableGpuModeEnabled);
  settingsLanguage.value = settings.uiLanguage === "en" ? "en" : "zh-CN";
  applyAccountPaneWidth(settings.accountListPanePercent);
  for (const input of settingsThemeInputs) {
    input.checked = input.value === normalizeThemeMode(settings.themeMode);
  }
  settingsRefreshInterval.value = String(clampRefreshInterval(settings.usageRefreshIntervalMinutes));
  const closeBehavior =
    settings.closeBehavior === "minimize" || settings.closeBehavior === "tray" || settings.closeBehavior === "quit"
      ? settings.closeBehavior
      : "ask";
  const closeInput = document.querySelector(`input[name="settings-close-behavior"][value="${closeBehavior}"]`);
  if (closeInput) {
    closeInput.checked = true;
  }
}

function formatBackupSuccessTime(value) {
  return Number.isFinite(Number(value)) ? formatBeijingTime(Number(value)) : t("settings.backupNever");
}

function autoSwitchTargetSummary() {
  if (settings.autoSwitchTargetMode !== "manual" || !settings.manualAutoSwitchTargetAccountId) {
    return t("settings.autoSwitchTargetBest");
  }
  const target = accounts.find((account) => account.id === settings.manualAutoSwitchTargetAccountId);
  return t("settings.autoSwitchTargetManual", {
    email: target?.emailMasked ?? shortId(settings.manualAutoSwitchTargetAccountId)
  });
}

function autoSwitchExclusionsSummary() {
  const ids = Array.isArray(settings.autoSwitchExcludedAccountIds) ? settings.autoSwitchExcludedAccountIds : [];
  if (ids.length === 0) return t("settings.autoSwitchExcludedNone");
  const known = ids
    .map((id) => accounts.find((account) => account.id === id)?.emailMasked)
    .filter(Boolean);
  const unknownCount = ids.length - known.length;
  if (unknownCount > 0) {
    known.push(t("settings.autoSwitchExcludedUnknown", { count: unknownCount }));
  }
  return t("settings.autoSwitchExcludedSummary", {
    count: ids.length,
    accounts: known.join(currentLanguage() === "en" ? ", " : "、")
  });
}

async function saveLanguage(uiLanguage) {
  settings = await api.updateSettings({ uiLanguage });
  syncSettingsControls();
  applyTranslations();
  await loadAppVersion();
  render();
  setStatus(t("status.languageSaved"));
}

async function loadAppVersion() {
  try {
    const version = await api.getAppVersion();
    appVersionEl.textContent = typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
      ? `v${version}`
      : t("brand.versionUnknown");
  } catch {
    appVersionEl.textContent = t("brand.versionUnknown");
  }
}

function renderDirtyAccountSurfaces() {
  if (currentView !== "accounts" || !accountSurfacesDirty) return;
  const readingContext = captureAccountReadingContext();
  renderAccountSurfaces();
  accountSurfacesDirty = false;
  restoreAccountReadingContext(readingContext);
}

function showView(view) {
  const nextView = view === "settings" || view === "threads" || view === "usage" || view === "reports" ? view : "accounts";
  if (currentView === "threads" && nextView !== "threads") {
    stopThreadSidebarRevisionRefresh();
    stopThreadsActivityRefresh();
  }
  currentView = nextView;
  const showingAccounts = currentView === "accounts";
  const showingThreads = currentView === "threads";
  const showingUsage = currentView === "usage";
  const showingReports = currentView === "reports";
  const showingSettings = currentView === "settings";
  accountsView.hidden = !showingAccounts;
  accountsTopbar.hidden = !showingAccounts;
  metricsStrip.hidden = !showingAccounts;
  accountsWorkspace.hidden = !showingAccounts;
  threadsView.hidden = !showingThreads;
  usageView.hidden = !showingUsage;
  reportsView.hidden = !showingReports;
  settingsView.hidden = !showingSettings;
  accountsView.style.display = showingAccounts ? "" : "none";
  accountsTopbar.style.display = showingAccounts ? "" : "none";
  metricsStrip.style.display = showingAccounts ? "" : "none";
  accountsWorkspace.style.display = showingAccounts ? "" : "none";
  threadsView.style.display = showingThreads ? "" : "none";
  usageView.style.display = showingUsage ? "" : "none";
  reportsView.style.display = showingReports ? "" : "none";
  settingsView.style.display = showingSettings ? "" : "none";
  document.body.classList.toggle("view-settings", showingSettings);
  document.body.classList.toggle("view-threads", showingThreads);
  document.body.classList.toggle("view-usage", showingUsage);
  document.body.classList.toggle("view-reports", showingReports);
  document.body.classList.toggle("view-accounts", showingAccounts);
  accountsNav.classList.toggle("active", showingAccounts);
  threadsNav.classList.toggle("active", showingThreads);
  usageNav.classList.toggle("active", showingUsage);
  reportsNav.classList.toggle("active", showingReports);
  settingsNav.classList.toggle("active", showingSettings);
  if (showingAccounts) renderDirtyAccountSurfaces();
  if (showingSettings) {
    settingsView.scrollTop = 0;
  }
  if (showingThreads) {
    threadsView.scrollTop = 0;
    renderThreadsView();
    startThreadSidebarRevisionRefresh();
    startThreadsActivityRefresh();
    queueThreadSearch();
  }
  if (showingUsage) {
    usageView.scrollTop = 0;
  }
  if (showingReports) {
    reportsView.scrollTop = 0;
  }
}

function applyTheme() {
  document.documentElement.dataset.theme = normalizeThemeMode(settings.themeMode);
}

function normalizeThemeMode(value) {
  return value === "light" || value === "dark" ? value : "system";
}

function applyAccountPaneWidth(value) {
  accountsWorkspace.style.setProperty("--account-list-pane", `${clampAccountPanePercent(value)}%`);
  requestAnimationFrame(updatePaneDensity);
}

function clampAccountPanePercent(value) {
  const percent = Number(value);
  return Number.isFinite(percent) ? Math.round(Math.max(28, Math.min(68, percent))) : 46;
}

function panePercentFromPointer(clientX) {
  const rect = accountsWorkspace.getBoundingClientRect();
  const splitterWidth = accountsSplitter.getBoundingClientRect().width || 12;
  const minimumListWidth = 320;
  const minimumDetailWidth = 360;
  const available = Math.max(1, rect.width - splitterWidth);
  const rawListWidth = clientX - rect.left - splitterWidth / 2;
  const listWidth = Math.max(minimumListWidth, Math.min(available - minimumDetailWidth, rawListWidth));
  return clampAccountPanePercent((listWidth / available) * 100);
}

function startPaneResize(event) {
  if (event.button !== 0 || window.matchMedia("(max-width: 980px)").matches) {
    return;
  }

  event.preventDefault();
  accountsSplitter.setPointerCapture(event.pointerId);
  document.body.classList.add("resizing-panes");
  let nextPercent = clampAccountPanePercent(settings.accountListPanePercent);

  const onPointerMove = (moveEvent) => {
    nextPercent = panePercentFromPointer(moveEvent.clientX);
    applyAccountPaneWidth(nextPercent);
  };

  const onPointerUp = async () => {
    accountsSplitter.removeEventListener("pointermove", onPointerMove);
    accountsSplitter.removeEventListener("pointerup", onPointerUp);
    accountsSplitter.removeEventListener("pointercancel", onPointerUp);
    document.body.classList.remove("resizing-panes");
    try {
      settings = await api.updateSettings({ accountListPanePercent: nextPercent });
      syncSettingsControls();
    } catch (error) {
      setStatus(errorMessage(error));
    }
  };

  accountsSplitter.addEventListener("pointermove", onPointerMove);
  accountsSplitter.addEventListener("pointerup", onPointerUp);
  accountsSplitter.addEventListener("pointercancel", onPointerUp);
}

function initializePaneObservers() {
  if (!("ResizeObserver" in window)) {
    window.addEventListener("resize", updatePaneDensity);
    return;
  }
  const observer = new ResizeObserver(updatePaneDensity);
  observer.observe(listPanel);
  observer.observe(detailEl);
}

function updatePaneDensity() {
  const listWidth = listPanel.getBoundingClientRect().width;
  const detailWidth = detailEl.getBoundingClientRect().width;
  listPanel.classList.toggle("compact", listWidth < 430);
  detailEl.classList.toggle("compact", detailWidth < 540);
  detailEl.classList.toggle("narrow", detailWidth < 420);
}

function startBackgroundRefreshTimer() {
  if (backgroundRefreshTimer) {
    clearTimeout(backgroundRefreshTimer);
  }
  backgroundRefreshTimer = setTimeout(
    refreshAllUsageInBackground,
    clampRefreshInterval(settings.usageRefreshIntervalMinutes) * 60 * 1000
  );
}

async function refreshAllUsageInBackground() {
  if (manualSwitchInProgress) {
    startBackgroundRefreshTimer();
    return;
  }
  if (backgroundRefreshInProgress) {
    return;
  }
  backgroundRefreshInProgress = true;
  try {
    const currentAccount = (await api.listAccounts()).find((account) => account.isCurrent);
    if (currentAccount) {
      let priorityError;
      try {
        await api.refreshUsage(currentAccount.id, true);
      } catch (error) {
        priorityError = error;
      }
      if (manualSwitchInProgress) return;
      await loadAccounts(
        priorityError ? t("status.backgroundFailed", { error: errorMessage(priorityError) }) : t("status.backgroundUpdated"),
        { reason: "background-priority" }
      );
    }
    if (manualSwitchInProgress) return;
    const results = await api.refreshAllUsage();
    if (manualSwitchInProgress) return;
    markReportDataChanged(results);
    await loadAccounts(refreshSummary(results, t("status.backgroundUpdated")), {
      reason: "background",
      deferWhileScrolling: true
    });
    if (currentView === "reports" && reportRangeIncludesToday()) void refreshWeeklyReport({ background: true });
  } catch (error) {
    setStatus(t("status.backgroundFailed", { error: errorMessage(error) }));
  } finally {
    backgroundRefreshInProgress = false;
    startBackgroundRefreshTimer();
  }
}

function startCurrentQuotaSyncTimer() {
  clearInterval(currentQuotaSyncTimer);
  currentQuotaSyncTimer = setInterval(syncCurrentQuotaDisplay, 2_000);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void syncCurrentQuotaDisplay();
});

function currentQuotaSignature(list) {
  const current = list.find((account) => account.isCurrent);
  return JSON.stringify({
    id: current?.id,
    usage: current?.usage,
    usageError: current?.usageError
  });
}

async function syncCurrentQuotaDisplay() {
  if (currentQuotaSyncInProgress || manualSwitchInProgress || document.hidden) return;
  currentQuotaSyncInProgress = true;
  const loadRevision = accountLoadRequestId;
  try {
    const nextAccounts = await api.listAccounts();
    if (loadRevision !== accountLoadRequestId
      || currentQuotaSignature(nextAccounts) === currentQuotaSignature(accounts)) return;
    const readingContext = currentView === "accounts" ? captureAccountReadingContext() : undefined;
    accounts = nextAccounts;
    if (!selectedAccountId || !accounts.some((account) => account.id === selectedAccountId)) {
      selectedAccountId = accounts.find((account) => account.isCurrent)?.id ?? accounts[0]?.id;
    }
    accountSurfacesDirty = true;
    if (currentView === "accounts") {
      renderAccountSurfaces();
      accountSurfacesDirty = false;
      restoreAccountReadingContext(readingContext);
    }
    await evaluateQuotaActions("quota-sync", loadRevision);
  } catch {
  } finally {
    currentQuotaSyncInProgress = false;
  }
}
function clampRefreshInterval(value) {
  const minutes = Number(value);
  return Number.isFinite(minutes) ? Math.round(Math.max(1, Math.min(60, minutes))) : 5;
}

async function loadAccounts(message, options = {}) {
  const requestId = ++accountLoadRequestId;
  const nextAccounts = await api.listAccounts();
  if (requestId !== accountLoadRequestId) return;
  if (options.deferWhileScrolling) {
    await waitForAccountScrollIdle();
    if (requestId !== accountLoadRequestId) return;
  }
  const nextPendingAutoSwitch = (await api.getAutoSwitchState()).pending;
  if (requestId !== accountLoadRequestId) return;
  const readingContext = currentView === "accounts" ? captureAccountReadingContext() : undefined;
  accounts = nextAccounts;
  pendingAutoSwitch = nextPendingAutoSwitch;
  if (pendingAutoSwitch) {
    startPendingAutoSwitchTimer();
  } else {
    stopPendingAutoSwitchTimer();
  }
  if (!selectedAccountId || !accounts.some((account) => account.id === selectedAccountId)) {
    selectedAccountId = accounts.find((account) => account.isCurrent)?.id ?? accounts[0]?.id;
  }
  syncSettingsControls();
  accountSurfacesDirty = true;
  if (currentView === "accounts") {
    renderAccountSurfaces();
    accountSurfacesDirty = false;
    restoreAccountReadingContext(readingContext);
  }
  if (pendingAutoSwitch) {
    renderPendingAutoSwitchStatus();
  } else {
    setStatus(message);
  }
  await evaluateQuotaActions(options.reason ?? "load", requestId);
}

function initializeAccountScrollTracking() {
  listPanel.addEventListener("scroll", markAccountScrollActive, { passive: true });
  detailEl.addEventListener("scroll", markAccountScrollActive, { passive: true });
}

function markAccountScrollActive() {
  accountScrollActiveUntil = performance.now() + accountScrollIdleMs;
}

async function waitForAccountScrollIdle() {
  let remaining = accountScrollActiveUntil - performance.now();
  while (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
    remaining = accountScrollActiveUntil - performance.now();
  }
}

function captureAccountReadingContext() {
  return {
    selectedAccountId,
    listScrollTop: listPanel.scrollTop,
    detailScrollTop: detailEl.scrollTop
  };
}

function restoreAccountReadingContext(context) {
  if (!context) return;
  requestAnimationFrame(() => {
    if (context.selectedAccountId === selectedAccountId) {
      listPanel.scrollTop = context.listScrollTop;
      detailEl.scrollTop = context.detailScrollTop;
    }
  });
}

async function refreshTokenUsageView() {
  const requestId = ++tokenUsageRequestId;
  tokenUsageLoading = true;
  renderUsageView();
  setStatus(t("usage.loading"));
  try {
    syncUsageDateWithToday();
    const nextStats = await api.getTokenUsageStats({ asOfDate: selectedUsageDate() });
    if (requestId === tokenUsageRequestId) {
      tokenUsageStats = nextStats;
    }
  } catch (error) {
    if (requestId === tokenUsageRequestId) {
      tokenUsageStats = undefined;
      setStatus(errorMessage(error));
    }
  } finally {
    if (requestId === tokenUsageRequestId) {
      tokenUsageLoading = false;
      renderUsageView();
    }
  }
}

function selectedUsageDate() {
  return usageDateInput.value || localDateInputValue(new Date());
}

function refreshUsageDateBounds() {
  const today = localDateInputValue(new Date());
  usageDateInput.min = "2024-01-01";
  usageDateInput.max = today;
  if (!usageDateInput.value) {
    usageDateInput.value = today;
  }
}

function syncUsageDateWithToday() {
  const today = localDateInputValue(new Date());
  usageDateInput.min = "2024-01-01";
  usageDateInput.max = today;
  const next = nextUsageDateState({
    value: usageDateInput.value,
    today,
    followsToday: usageDateTracksToday
  });
  usageDateInput.value = next.value;
  usageDateTracksToday = next.followsToday;
}

function clampUsageDateToToday() {
  refreshUsageDateBounds();
  if (usageDateInput.value > usageDateInput.max) {
    usageDateInput.value = usageDateInput.max;
  }
}

function render() {
  if (currentView === "accounts") {
    renderAccountSurfaces();
    accountSurfacesDirty = false;
  } else {
    accountSurfacesDirty = true;
  }
  if (currentView === "threads") renderThreadsView();
  if (currentView === "usage") renderUsageView();
  if (currentView === "reports") renderReportsView();
}

function renderThreadsView() {
  renderThreadsActivity();
  renderThreadSearchResults(threadSearchResults);
  renderThreadSearchStatus();
}

function startThreadSidebarRevisionRefresh() {
  if (currentView !== "threads" || threadSidebarRevisionTimer) return;
  void refreshThreadSidebarRevision();
  threadSidebarRevisionTimer = setInterval(refreshThreadSidebarRevision, threadSidebarRevisionIntervalMs);
}

function stopThreadSidebarRevisionRefresh() {
  threadSidebarRevisionRequestId += 1;
  previousThreadSidebarStateRevision = undefined;
  if (!threadSidebarRevisionTimer) return;
  clearInterval(threadSidebarRevisionTimer);
  threadSidebarRevisionTimer = undefined;
}

async function refreshThreadSidebarRevision() {
  if (currentView !== "threads" || threadSidebarRevisionRefreshInFlight) return;
  threadSidebarRevisionRefreshInFlight = true;
  const requestId = ++threadSidebarRevisionRequestId;
  try {
    const nextThreadSidebarStateRevision = await api.getCodexThreadSidebarStateRevision();
    if (currentView !== "threads" || requestId !== threadSidebarRevisionRequestId) return;
    if (nextThreadSidebarStateRevision) {
      if (previousThreadSidebarStateRevision
        && previousThreadSidebarStateRevision !== nextThreadSidebarStateRevision) {
        queueThreadSearch();
      }
      previousThreadSidebarStateRevision = nextThreadSidebarStateRevision;
    }
  } catch {} finally {
    threadSidebarRevisionRefreshInFlight = false;
  }
}

function startThreadsActivityRefresh() {
  if (currentView !== "threads" || threadActivityTimer) return;
  void refreshThreadsActivity();
  threadActivityTimer = setInterval(refreshThreadsActivity, threadActivityIntervalMs);
}

function stopThreadsActivityRefresh() {
  threadActivityRequestId += 1;
  previousActiveThreadIds = undefined;
  if (!threadActivityTimer) return;
  clearInterval(threadActivityTimer);
  threadActivityTimer = undefined;
}

async function refreshThreadsActivity() {
  if (currentView !== "threads" || threadActivityRefreshInFlight) return;
  threadActivityRefreshInFlight = true;
  const requestId = ++threadActivityRequestId;
  try {
    const status = await api.getCodexActivityStatus();
    if (currentView !== "threads" || requestId !== threadActivityRequestId) return;
    threadActivityStatus = status && typeof status === "object" ? status : {};
    const nextActiveThreadIds = new Set(
      (Array.isArray(threadActivityStatus.activeTasks) ? threadActivityStatus.activeTasks : [])
        .map((task) => typeof task?.id === "string" ? task.id : "")
        .filter(Boolean)
    );
    if ((!previousActiveThreadIds && nextActiveThreadIds.size > 0)
      || (previousActiveThreadIds
        && (previousActiveThreadIds.size !== nextActiveThreadIds.size
          || [...previousActiveThreadIds].some((id) => !nextActiveThreadIds.has(id))))) {
      queueThreadSearch();
    }
    previousActiveThreadIds = nextActiveThreadIds;
  } catch (error) {
    if (currentView !== "threads" || requestId !== threadActivityRequestId) return;
    threadActivityStatus = { error: errorMessage(error) };
  } finally {
    threadActivityRefreshInFlight = false;
  }
  renderThreadsActivity();
}

function renderThreadsActivity() {
  const activeTasks = Array.isArray(threadActivityStatus?.activeTasks) ? threadActivityStatus.activeTasks : [];
  const rows = [];
  threadsActiveCount.textContent = t("threads.activeCount", { count: activeTasks.length });
  if (threadActivityStatus?.error) {
    rows.push(createThreadEmptyState(t("threads.activityUnavailable", { error: threadActivityStatus.error })));
  } else {
    if (threadActivityStatus?.activityIndexing) {
      rows.push(createThreadRow({
        title: t("threads.activityIndexing"),
        tone: "notice"
      }));
    }
    activeTasks.forEach((task) => {
      rows.push(createThreadRow({
        title: typeof task?.displayName === "string" && task.displayName ? task.displayName : t("labels.unnamedTask"),
        id: typeof task?.id === "string" ? task.id : "",
        details: [
          { label: t("threads.activityLevel"), value: threadActivityLevelLabel(task) },
          { label: t("threads.evidence"), value: threadActivityEvidenceLabel(threadActivityStatus) }
        ]
      }));
    });
    if (threadActivityStatus?.isBusy && !threadActivityStatus?.activityIndexing && (threadActivityStatus.threadIdUnavailable || activeTasks.length === 0)) {
      rows.push(createThreadRow({
        title: t("threads.unidentifiedActivity"),
        details: [{ value: t("threads.unidentifiedActivityHelp") }],
        tone: "notice"
      }));
    }
    if (!rows.length) rows.push(createThreadEmptyState(t("threads.noActive")));
  }
  threadsActiveList.replaceChildren(...rows);
}

function renderThreadSearchResults(results) {
  const allThreads = Array.isArray(results) ? results : [];
  const archivedThreads = allThreads.filter((thread) => thread?.archived);
  const currentThreads = threadsShowArchived.checked
    ? allThreads
    : allThreads.filter((thread) => !thread?.archived || Number.isFinite(thread?.pinnedIndex));
  const currentIds = new Set(currentThreads.map((thread) => thread?.id));
  const threads = threadsShowInternal.checked
    ? currentThreads
    : currentThreads.filter((thread) => thread?.category !== "temporary_executor"
      && !(thread?.threadSource === "subagent"
        && (!thread?.parentThreadId || !currentIds.has(thread.parentThreadId))));
  const hierarchy = buildThreadHierarchy(threads);
  const ordinaryThreads = threadsShowUnregistered.checked
    ? hierarchy.ordinary
    : hierarchy.ordinary.filter((thread) => thread?.projectName || thread?.category === "temporary_executor");
  const hiddenUnregistered = hierarchy.ordinary.length - ordinaryThreads.length;
  const rows = [];
  if (hierarchy.pinned.length) {
    const pinned = document.createElement("details");
    pinned.className = "thread-pinned-section";
    pinned.open = pinnedSectionOpen;
    pinned.addEventListener("toggle", () => {
      pinnedSectionOpen = pinned.open;
      localStorage.setItem(THREAD_PINNED_OPEN_KEY, String(pinnedSectionOpen));
    });
    const heading = document.createElement("summary");
    heading.className = "thread-pinned-summary";
    const label = document.createElement("strong");
    label.textContent = t("threads.pinned");
    const pinnedUnreadStates = hierarchy.pinnedUnreadStates;
    heading.append(label);
    appendUnreadTerminalSummary(heading, pinnedUnreadStates);
    const body = document.createElement("div");
    body.className = "thread-pinned-body";
    body.replaceChildren(...hierarchy.pinned.map(createThreadSearchRow));
    pinned.append(heading, body);
    rows.push(pinned);
  }
  const ordinaryGroups = groupThreadSearchResults(ordinaryThreads);
  if (ordinaryGroups.length) {
    const ordinary = document.createElement("details");
    ordinary.className = "thread-ordinary-section";
    ordinary.open = Boolean(threadsSearch.value.trim()) || ordinarySectionOpen;
    ordinary.addEventListener("toggle", () => {
      ordinarySectionOpen = ordinary.open;
      localStorage.setItem(THREAD_ORDINARY_OPEN_KEY, String(ordinarySectionOpen));
    });
    const heading = document.createElement("summary");
    heading.className = "thread-ordinary-summary";
    const label = document.createElement("strong");
    label.textContent = t("threads.ordinary");
    const metadata = document.createElement("span");
    metadata.textContent = t("threads.ordinarySummary", {
      groups: ordinaryGroups.length,
      count: ordinaryThreads.length
    });
    const ordinaryUnreadStates = ordinaryGroups.reduce((counts, group) => {
      counts.completed += group.unreadCompletedCount;
      counts.interrupted += group.unreadInterruptedCount;
      return counts;
    }, { completed: 0, interrupted: 0 });
    heading.append(label, metadata);
    appendUnreadTerminalSummary(metadata, ordinaryUnreadStates, { sibling: true });
    const body = document.createElement("div");
    body.className = "thread-ordinary-body";
    body.replaceChildren(...ordinaryGroups.map(createThreadGroup));
    ordinary.append(heading, body);
    rows.push(ordinary);
  }
  if (!rows.length && threadsSearch.value.trim()) {
    rows.push(createThreadEmptyState(t(
      archivedThreads.length && !threadsShowArchived.checked
        ? "threads.archivedSearchOnly"
        : (hiddenUnregistered && !threadsShowUnregistered.checked
            ? "threads.unregisteredSearchOnly"
            : "threads.noSearchResults")
    )));
  }
  threadsSearchResults.replaceChildren(...rows);
}

function buildThreadHierarchy(threads) {
  const byId = new Map(threads.map((thread) => [thread?.id, thread]));
  const children = new Map();
  const roots = [];
  const parentChainIsAcyclic = (thread) => {
    const visited = new Set([thread?.id]);
    let parentId = thread?.parentThreadId;
    while (parentId && byId.has(parentId)) {
      if (visited.has(parentId)) return false;
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentThreadId;
    }
    return true;
  };
  threads.forEach((thread) => {
    if (thread?.parentThreadId && byId.has(thread.parentThreadId) && parentChainIsAcyclic(thread)) {
      const siblings = children.get(thread.parentThreadId) ?? [];
      siblings.push(thread);
      children.set(thread.parentThreadId, siblings);
    } else {
      roots.push(thread?.parentThreadId ? { ...thread, orphanedChild: true } : thread);
    }
  });
  const attachChildren = (thread) => ({
    ...thread,
    children: (children.get(thread.id) ?? []).map(attachChildren)
  });
  const projectThreads = new Map();
  threads.forEach((thread) => {
    if (thread?.entityType === "project" || !thread?.projectId) return;
    const members = projectThreads.get(thread.projectId) ?? [];
    members.push(thread);
    projectThreads.set(thread.projectId, members);
  });
  const primary = roots.map(attachChildren).map((thread) => {
    if (thread?.entityType !== "project") return thread;
    return (projectThreads.get(thread.projectId) ?? []).reduce((project, member) => {
      const counts = countUnreadTerminalStates(member);
      project.unreadCompletedCount += counts.completed;
      project.unreadInterruptedCount += counts.interrupted;
      return project;
    }, { ...thread, unreadCompletedCount: 0, unreadInterruptedCount: 0 });
  });
  const pinned = primary.filter((thread) => Number.isFinite(thread?.pinnedIndex))
    .sort((left, right) => left.pinnedIndex - right.pinnedIndex);
  const pinnedUnreadIds = new Set(pinned.flatMap((thread) => thread?.entityType === "project"
    ? (projectThreads.get(thread.projectId) ?? []).map((member) => member.id)
    : [thread.id]));
  const pinnedUnreadStates = [...pinnedUnreadIds].reduce((counts, id) => {
    const threadCounts = countUnreadTerminalStates(byId.get(id));
    counts.completed += threadCounts.completed;
    counts.interrupted += threadCounts.interrupted;
    return counts;
  }, { completed: 0, interrupted: 0 });
  return {
    pinned,
    pinnedUnreadStates,
    ordinary: primary.filter((thread) => !Number.isFinite(thread?.pinnedIndex))
  };
}

function groupThreadSearchResults(threads) {
  const groups = new Map();
  threads.forEach((thread) => {
    const identity = threadGroupIdentity(thread);
    let group = groups.get(identity.key);
    if (!group) {
      group = {
        ...identity,
        threads: [],
        unreadCompletedCount: 0,
        unreadInterruptedCount: 0,
        latestUpdatedAtMs: Number.isFinite(thread?.updatedAtMs) ? thread.updatedAtMs : 0
      };
      groups.set(identity.key, group);
    }
    group.threads.push(thread);
    const unreadStates = countUnreadTerminalStates(thread);
    group.unreadCompletedCount += unreadStates.completed;
    group.unreadInterruptedCount += unreadStates.interrupted;
  });
  return [...groups.values()]
    .sort((left, right) => right.latestUpdatedAtMs - left.latestUpdatedAtMs || left.label.localeCompare(right.label));
}

function threadGroupIdentity(thread) {
  if (thread?.category === "temporary_executor") {
    return { key: "temporary_executor", label: t("threads.temporaryGroup") };
  }
  if (thread?.projectName) {
    return { key: `project:${thread.projectName}`, label: thread.projectName };
  }
  if (thread?.workspacePath) {
    return {
      key: `workspace:${thread.workspacePath}`,
      label: workspaceDirectoryName(thread.workspacePath),
      subtitle: t("threads.unregisteredDirectoryDetail", { path: thread.workspacePath })
    };
  }
  return { key: "unregistered", label: t("threads.unregisteredProject") };
}

function workspaceDirectoryName(workspacePath) {
  return workspacePath.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || workspacePath;
}

function createThreadGroup(group) {
  const groupElement = document.createElement("details");
  groupElement.className = "thread-group";
  groupElement.open = Boolean(threadsSearch.value.trim());
  const summary = document.createElement("summary");
  summary.className = "thread-group-summary";
  const name = document.createElement("strong");
  name.textContent = group.label;
  const headingText = document.createElement("div");
  headingText.className = "thread-group-heading";
  headingText.append(name);
  if (group.subtitle) {
    const subtitle = document.createElement("small");
    subtitle.className = "thread-group-subtitle";
    subtitle.textContent = group.subtitle;
    headingText.append(subtitle);
  }
  const metadata = document.createElement("span");
  metadata.textContent = t("threads.groupSummary", {
    count: group.threads.length,
    updated: formatThreadTimestamp(group.latestUpdatedAtMs)
  });
  summary.append(headingText, metadata);
  appendUnreadTerminalSummary(metadata, group, { sibling: true });
  const body = document.createElement("div");
  body.className = "thread-group-body";
  renderThreadGroupBody(body, group);
  groupElement.append(summary, body);
  return groupElement;
}

function renderThreadGroupBody(body, group) {
  const visibleCount = Math.min(
    threadGroupVisibleCounts.get(group.key) ?? threadGroupPageSize,
    group.threads.length
  );
  const rows = group.threads.slice(0, visibleCount).map(createThreadSearchRow);
  if (visibleCount < group.threads.length) {
    const showMore = document.createElement("button");
    showMore.type = "button";
    showMore.className = "thread-group-more";
    showMore.textContent = t("threads.showMore");
    showMore.addEventListener("click", () => {
      threadGroupVisibleCounts.set(group.key, visibleCount + threadGroupPageSize);
      renderThreadGroupBody(body, group);
    });
    rows.push(showMore);
  }
  body.replaceChildren(...rows);
}

function createThreadSearchRow(thread) {
  const isProject = thread?.entityType === "project";
  const details = isProject
    ? [
        { value: t("threads.pinnedProject") },
        ...(Array.isArray(thread?.rootPaths) ? thread.rootPaths : []).map((value) => ({ label: t("threads.workspace"), value }))
      ]
    : [
        { label: t("threads.workspace"), value: thread?.workspacePath },
        { label: t("threads.updated"), value: formatThreadTimestamp(thread?.updatedAtMs) },
        { label: t("threads.created"), value: formatThreadTimestamp(thread?.createdAtMs) },
        { label: t("threads.source"), value: threadMetadataSourceLabel(thread?.source) }
      ];
  if (thread?.archived) details.push({ value: t("threads.archived") });
  if (thread?.orphanedChild) details.push({ value: t("threads.orphanedChild") });
  const sidebarUnread = threadIsCodexSidebarUnread(thread);
  const row = createThreadRow({
    title: isProject
      ? (thread?.projectName || t("threads.pinnedProject"))
      : thread?.category === "temporary_executor"
        ? t("threads.temporaryExecutorTitle")
        : (typeof thread?.title === "string" && thread.title ? thread.title : t("labels.unnamedTask")),
    id: !isProject && typeof thread?.id === "string" ? thread.id : "",
    details,
    state: threadTurnStateLabel(thread?.turnState, sidebarUnread),
    unread: sidebarUnread && thread?.turnState === "completed",
    unreadSummary: isProject ? thread : undefined
  });
  if (thread?.children?.length) row.append(createThreadChildren(thread.children));
  return row;
}

function createThreadChildren(children) {
  const childElement = document.createElement("details");
  childElement.className = "thread-children";
  childElement.open = false;
  const summary = document.createElement("summary");
  summary.textContent = t("threads.childTasks", { count: children.length });
  const body = document.createElement("div");
  body.className = "thread-children-body";
  body.replaceChildren(...children.map(createThreadSearchRow));
  childElement.append(summary, body);
  return childElement;
}

function queueThreadSearch() {
  const query = threadsSearch.value.trim();
  clearTimeout(threadSearchTimer);
  const requestId = ++threadSearchRequestId;
  setThreadSearchMessage("threads.searching");
  threadSearchTimer = setTimeout(() => {
    threadSearchTimer = undefined;
    if (threadSearchInFlight) {
      queuedThreadSearch = { query, requestId };
      return;
    }
    void searchLocalThreads(query, requestId);
  }, 180);
}

async function searchLocalThreads(query, requestId) {
  threadSearchInFlight = true;
  try {
    const results = await api.searchLocalCodexThreads(query);
    if (requestId !== threadSearchRequestId) return;
    threadSearchResults = Array.isArray(results) ? results : [];
    threadGroupVisibleCounts.clear();
    renderThreadSearchResults(threadSearchResults);
    setThreadSearchResultMessage();
  } catch (error) {
    if (requestId !== threadSearchRequestId) return;
    threadSearchResults = [];
    renderThreadSearchResults(threadSearchResults);
    setThreadSearchMessage("threads.searchFailed", { error: errorMessage(error) });
  } finally {
    threadSearchInFlight = false;
    if (queuedThreadSearch) {
      const nextSearch = queuedThreadSearch;
      queuedThreadSearch = undefined;
      void searchLocalThreads(nextSearch.query, nextSearch.requestId);
    }
  }
}

function setThreadSearchResultMessage() {
  const hidden = threadsShowArchived.checked
    ? 0
    : threadSearchResults.filter((thread) => thread?.archived && !Number.isFinite(thread?.pinnedIndex)).length;
  setThreadSearchMessage(
    hidden ? "threads.searchResultCountWithHidden" : "threads.searchResultCount",
    { count: threadSearchResults.length - hidden, hidden }
  );
}

function setThreadSearchMessage(key, values = {}) {
  threadSearchMessage = { key, values };
  renderThreadSearchStatus();
}

function renderThreadSearchStatus() {
  threadsSearchStatus.textContent = t(threadSearchMessage.key, threadSearchMessage.values);
}

function createThreadEmptyState(message) {
  const empty = document.createElement("p");
  empty.className = "threads-empty";
  empty.textContent = message;
  return empty;
}

function createThreadRow({ title, id = "", details = [], tone = "", state, unread = false, unreadSummary }) {
  const row = document.createElement("article");
  row.className = `thread-row${tone ? ` thread-row-${tone}` : ""}${unread ? " is-unread" : ""}`;
  const heading = document.createElement("div");
  heading.className = "thread-row-heading";
  const name = document.createElement("strong");
  name.textContent = title;
  heading.append(name);
  if (state) {
    const badge = document.createElement("span");
    badge.className = `thread-state is-${state.key.replaceAll("_", "-")}`;
    badge.textContent = state.label;
    heading.append(badge);
  }
  if (unreadSummary) appendUnreadTerminalSummary(heading, unreadSummary);
  if (id) {
    const identity = document.createElement("code");
    identity.className = "thread-id";
    identity.textContent = id;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "thread-copy-button";
    copy.textContent = t("threads.copyId");
    copy.addEventListener("click", () => void copyThreadId(id));
    heading.append(identity, copy);
  }
  row.append(heading);
  const metadata = document.createElement("div");
  metadata.className = "thread-metadata";
  details.forEach(({ label, value }) => {
    if (value === undefined || value === null || value === "") return;
    const item = document.createElement("span");
    item.textContent = label ? `${label}: ${value}` : String(value);
    metadata.append(item);
  });
  if (metadata.childElementCount) row.append(metadata);
  return row;
}

function threadTurnStateLabel(state, unread = false) {
  if (state === "completed" && unread) {
    return { key: "newly_completed", label: t("threads.state.newlyCompleted") };
  }
  if (["interrupted", "usage_limited"].includes(state) && unread) {
    return {
      key: "newly_interrupted",
      label: t(state === "usage_limited" ? "threads.state.usageLimited" : "threads.state.interrupted")
    };
  }
  const keys = {
    running: "threads.state.running",
    completed: "threads.state.completed",
    interrupted: "threads.state.interrupted",
    usage_limited: "threads.state.usageLimited",
    failed: "threads.state.failed",
    unknown: "threads.state.unknown"
  };
  const key = Object.hasOwn(keys, state) ? state : "unknown";
  return { key, label: t(keys[key]) };
}

function threadIsCodexSidebarUnread(thread) {
  return Boolean(thread?.unread
    && thread?.threadSource !== "subagent"
    && !thread?.parentThreadId
    && thread?.category !== "temporary_executor");
}

function countUnreadTerminalStates(thread) {
  const unread = threadIsCodexSidebarUnread(thread);
  return {
    completed: unread && thread?.turnState === "completed" ? 1 : 0,
    interrupted: unread && ["interrupted", "usage_limited"].includes(thread?.turnState) ? 1 : 0
  };
}

function appendUnreadTerminalSummary(target, counts, { sibling = false } = {}) {
  const values = {
    completed: counts?.completed ?? counts?.unreadCompletedCount ?? 0,
    interrupted: counts?.interrupted ?? counts?.unreadInterruptedCount ?? 0
  };
  const summaries = [];
  for (const state of ["completed", "interrupted"]) {
    if (!values[state]) continue;
    const summary = document.createElement("span");
    summary.className = `thread-unread-summary is-${state}`;
    summary.textContent = t(
      state === "completed" ? "threads.unreadCompleted" : "threads.unreadInterrupted",
      { count: values[state] }
    );
    summaries.push(summary);
  }
  if (sibling) target.after(...summaries);
  else target.append(...summaries);
}

function threadActivityEvidenceLabel(status) {
  if (status?.taskEvidenceSource === "lifecycle") return t("threads.evidence.lifecycle");
  if (status?.taskEvidenceSource === "process_registry") return t("threads.evidence.processRegistry");
  if (status?.taskEvidenceSource === "mixed") return t("threads.evidence.mixed");
  if (status?.taskEvidenceSource === "recent_rollout") return t("threads.evidence.recent");
  return t("threads.evidence.unknown");
}

function threadActivityLevelLabel(task) {
  const level = task?.activityLevel;
  if (level === "top_level") return t("threads.activityLevel.top_level");
  if (level === "subagent") return t("threads.activityLevel.subagent");
  return t("threads.activityLevel.unknown");
}

function threadMetadataSourceLabel(source) {
  return source === "state_database" ? t("threads.sourceDatabase") : t("threads.sourceSessionIndex");
}

function formatThreadTimestamp(value) {
  return Number.isFinite(value) ? formatBeijingTime(value) : "";
}

async function copyThreadId(id) {
  if (!id) return;
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(id);
      copied = true;
    }
  } catch {
    copied = false;
  }
  if (!copied) {
    const input = document.createElement("textarea");
    input.value = id;
    input.setAttribute("aria-hidden", "true");
    document.body.append(input);
    input.select();
    copied = document.execCommand?.("copy") === true;
    input.remove();
  }
  setThreadSearchMessage(copied ? "threads.copied" : "threads.copyFailed");
}

function renderAccountSurfaces() {
  renderMetrics();
  renderQuotaWarning();
  renderAccounts();
  renderDetail();
}

function renderMetrics() {
  const current = accounts.find((account) => account.isCurrent);
  const best = accounts
    .filter(hasCompleteCurrentQuota)
    .sort((left, right) => compareAccountsByScore(left, right))[0];
  metricTotal.textContent = String(accounts.length);
  metricCurrent.textContent = current?.emailMasked ?? t("labels.none");
  metricBest.textContent = best?.usage ? `${formatScore(remainingScore(best))} ${t("labels.scoreUnit")}` : t("labels.unknown");
  renderScoreHelp(best);
}

function renderScoreHelp(best) {
  const breakdown = best ? scoreBreakdown(best) : undefined;
  scoreHelpTitle.textContent = t("metrics.scoreHelpTitle");
  scoreHelpFormula.textContent = t("metrics.scoreFormula");
  scoreHelpResetRule.textContent = t("metrics.scoreResetRule");
  scoreHelpMissingRule.textContent = t("metrics.scoreMissingRule");
  scoreHelpEligibilityRule.textContent = t("metrics.scoreEligibilityRule");
  scoreHelpAccount.textContent = t("metrics.scoreCurrentAccount", {
    account: best?.emailMasked ?? t("labels.unknown"),
    score: breakdown ? formatScore(breakdown.total) : t("labels.unknown")
  });
  scoreHelpFiveRemainingLabel.textContent = t("metrics.scoreFiveRemaining");
  scoreHelpWeekRemainingLabel.textContent = t("metrics.scoreWeekRemaining");
  scoreHelpFiveResetLabel.textContent = t("metrics.scoreFiveReset");
  scoreHelpWeekResetLabel.textContent = t("metrics.scoreWeekReset");
  scoreHelpFiveRemaining.textContent = formatScoreComponent(breakdown?.fiveHourRemaining);
  scoreHelpWeekRemaining.textContent = formatScoreComponent(breakdown?.oneWeekRemaining);
  scoreHelpFiveReset.textContent = formatTime(breakdown?.fiveHourResetAt);
  scoreHelpWeekReset.textContent = formatTime(breakdown?.oneWeekResetAt);
}

function formatScoreComponent(value) {
  return Number.isFinite(value) ? formatQuotaPercent(value).replace(/%$/, "") : t("labels.unknown");
}

function formatScore(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(1) : t("labels.unknown");
}

function dismissScoreHelp(suppressDiscovery) {
  scoreHelp.classList.remove("is-pinned");
  scoreHelp.classList.toggle("is-dismissed", suppressDiscovery);
  scoreHelpButton.setAttribute("aria-expanded", "false");
}

function positionScoreHelp() {
  const trigger = scoreHelpButton.getBoundingClientRect();
  const width = Math.min(440, Math.max(240, window.innerWidth - 24));
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, trigger.right - width));
  const height = Math.min(scoreHelp.querySelector(".score-help-popover")?.scrollHeight ?? 280, window.innerHeight - 24);
  const below = trigger.bottom + 9;
  const top = below + height <= window.innerHeight - 12 ? below : Math.max(12, trigger.top - height - 9);
  scoreHelp.style.setProperty("--score-help-left", `${left}px`);
  scoreHelp.style.setProperty("--score-help-top", `${top}px`);
  scoreHelp.style.setProperty("--score-help-width", `${width}px`);
}

function withPendingAutoSwitchFallback(message) {
  const reason = pendingAutoSwitch?.fallback?.reason;
  return reason
    ? `${t("status.autoSwitchFallbackContext", { reason: fallbackReasonLabel(reason) })} ${message}`
    : message;
}

function renderQuotaWarning() {
  const current = accounts.find((account) => account.isCurrent);
  if (!current) {
    hideQuotaWarning();
    return;
  }
  const quota = quotaDisplayState(current);
  const remaining = quota.current ? lowestRemaining(current) : undefined;
  const executionLimited = quota.availability === "execution_limited" && remaining !== undefined;
  if (settings.autoSwitchStayAccountId === current.id) {
    showQuotaWarning(t("quota.autoSwitchHeld"), "actions.resumeAutoSwitch");
    return;
  }

  if (pendingAutoSwitch) {
    showQuotaWarning(
      withPendingAutoSwitchFallback(t(
        executionLimited ? "quota.pendingSwitchLimited" : "quota.pendingSwitch",
        { email: pendingAutoSwitch.emailMasked, remaining: formatQuotaPercent(remaining) }
      )),
      "actions.holdCurrentAccount"
    );
    return;
  }

  if (hasFreshUsableUsage(current)) {
    const exhausted = quota.availability === "exhausted";
    const shouldWarn = settings.lowQuotaWarningEnabled
      && remaining !== undefined
      && remaining <= settings.lowQuotaThresholdPercent;
    if (executionLimited || exhausted || shouldWarn) {
      showQuotaWarning(
        executionLimited
          ? t("quota.executionLimited", { remaining: formatQuotaPercent(remaining) })
          : exhausted
            ? t("quota.empty")
            : t("quota.low", { remaining: formatQuotaPercent(remaining) }),
        "actions.holdCurrentAccount"
      );
      return;
    }
  }

  showQuotaWarning(
    t("quota.autoSwitchAvailable"),
    "actions.holdCurrentAccount",
    "neutral"
  );
}

function showQuotaWarning(message, actionKey, tone = "warning") {
  quotaWarningLine.hidden = false;
  quotaWarningLine.classList.toggle("is-neutral", tone === "neutral");
  quotaWarningText.textContent = message;
  quotaAutoSwitchAction.hidden = !actionKey;
  quotaAutoSwitchAction.textContent = actionKey ? t(actionKey) : "";
}

function hideQuotaWarning() {
  quotaWarningLine.hidden = true;
  quotaWarningLine.classList.remove("is-neutral");
  quotaWarningText.textContent = "";
  quotaAutoSwitchAction.hidden = true;
  quotaAutoSwitchAction.textContent = "";
}

async function toggleCurrentAccountAutoSwitchHold() {
  const current = accounts.find((account) => account.isCurrent);
  if (!current) return;

  const held = settings.autoSwitchStayAccountId === current.id;
  if (held) {
    settings = await api.updateSettings({ autoSwitchStayAccountId: "" });
    syncSettingsControls();
    renderQuotaWarning();
    setStatus(t("status.autoSwitchResumed"));
    await evaluateQuotaActions("hold-resumed");
    return;
  }

  settings = await api.updateSettings({ autoSwitchStayAccountId: current.id });
  syncSettingsControls();
  await api.clearAutoSwitchState();
  clearPendingAutoSwitch();
  renderQuotaWarning();
  setStatus(t("status.autoSwitchHeld"));
}

async function evaluateQuotaActions(reason, requestId) {
  if (requestId !== undefined && requestId !== accountLoadRequestId) return;
  if (autoSwitchInProgress) {
    return;
  }
  if (reason === "manual-switch") {
    renderQuotaWarning();
    return;
  }
  const result = await api.evaluateAutoSwitch(reason);
  if (requestId !== undefined && requestId !== accountLoadRequestId) return;
  await syncAutoSwitchTargetState(requestId);
  if (requestId !== undefined && requestId !== accountLoadRequestId) return;
  await handleAutoSwitchEvaluation(result, requestId);
}

function clearPendingAutoSwitch(clearPersistedState = true) {
  pendingAutoSwitch = undefined;
  stopPendingAutoSwitchTimer();
  clearActivityDiagnostics();
  if (clearPersistedState) void api.clearAutoSwitchState();
}

function startPendingAutoSwitchTimer() {
  if (!pendingAutoSwitchTimer) {
    pendingAutoSwitchTimer = setInterval(checkPendingAutoSwitch, pendingAutoSwitchIntervalMs);
  }
  pendingAutoSwitchDisplayTimer ??= setInterval(renderPendingAutoSwitchStatus, 1_000);
  renderPendingAutoSwitchStatus();
}

function stopPendingAutoSwitchTimer() {
  if (pendingAutoSwitchTimer) {
    clearInterval(pendingAutoSwitchTimer);
    pendingAutoSwitchTimer = undefined;
  }
  if (pendingAutoSwitchDisplayTimer) {
    clearInterval(pendingAutoSwitchDisplayTimer);
    pendingAutoSwitchDisplayTimer = undefined;
  }
}

function renderPendingAutoSwitchStatus() {
  if (!pendingAutoSwitch) return;
  const values = {
    email: pendingAutoSwitch.emailMasked ?? t("labels.unknown")
  };
  if (pendingAutoSwitch.activeTasks?.length) {
    const activeTasks = pendingAutoSwitch.activeTasks;
    const unknownLabel = pendingAutoSwitch.threadIdUnavailable
      ? (currentLanguage() === "en" ? "(another unnamed task)" : "（另有未命名任务）")
      : "";
    const statusKey = pendingAutoSwitch.taskEvidenceSource === "mixed"
      && pendingAutoSwitch.activityReason === "active_registry_task"
      && pendingAutoSwitch.taskAssociationConfidence === "unavailable"
      ? "status.autoSwitchWaitingRegistryAndInferredTasks"
      : pendingAutoSwitch.taskEvidenceSource === "process_registry"
      && pendingAutoSwitch.taskAssociationConfidence === "unavailable"
      ? "status.autoSwitchWaitingRegistryTasks"
      : pendingAutoSwitch.taskAssociationConfidence === "partial"
      ? pendingAutoSwitch.activityReason === "task_lifecycle_confirming_end"
        ? "status.autoSwitchConfirmingMixedTasks"
        : "status.autoSwitchWaitingMixedTasks"
      : pendingAutoSwitch.taskAssociationConfidence !== "verified"
        ? pendingAutoSwitch.activityReason === "task_lifecycle_confirming_end"
        ? "status.autoSwitchConfirmingInferredTasks"
        : "status.autoSwitchWaitingInferredTasks"
        : pendingAutoSwitch.activityReason === "task_lifecycle_confirming_end"
          ? "status.autoSwitchConfirmingTasks"
          : "status.autoSwitchWaitingTasks";
    setStatus(withPendingAutoSwitchFallback(t(statusKey, {
      ...values,
      tasks: `${activeTasks.map((task) => task.displayName || t("labels.unnamedTask")).join("、")}${unknownLabel ? ` ${unknownLabel}` : ""}`
    })), { preserveActivityDiagnostics: true });
    showActivityDiagnostics(pendingAutoSwitch.activeThreadIds, pendingAutoSwitch.processRegistryState, pendingAutoSwitch.processRegistryDiagnostic);
    return;
  }
  if (pendingAutoSwitch.activityReason === "recent_session_activity") {
    setStatus(withPendingAutoSwitchFallback(t("status.autoSwitchConfirmingRecentActivity", values)), { preserveActivityDiagnostics: true });
    showActivityDiagnostics(pendingAutoSwitch.activeThreadIds, pendingAutoSwitch.processRegistryState, pendingAutoSwitch.processRegistryDiagnostic);
    return;
  }
  if (
    pendingAutoSwitch.activityBusy ||
    ["active_chat_process", "active_registry_task", "active_task_lifecycle", "task_lifecycle_uncertain"].includes(pendingAutoSwitch.activityReason)
  ) {
    setStatus(withPendingAutoSwitchFallback(t(pendingAutoSwitch.activityReason === "unassociated_official_process"
      ? "status.autoSwitchWaitingUnassociatedProcess"
      : "status.autoSwitchWaitingUnknownThreads", values)), { preserveActivityDiagnostics: true });
    showActivityDiagnostics(pendingAutoSwitch.activeThreadIds, pendingAutoSwitch.processRegistryState, pendingAutoSwitch.processRegistryDiagnostic);
    return;
  }
  const seconds = autoSwitchQuietSecondsRemaining(pendingAutoSwitch);
  const unassociatedProcesses = pendingAutoSwitch.activityReason === "unassociated_official_process";
  setStatus(withPendingAutoSwitchFallback(pendingAutoSwitch.reason === "manual-switch-inspection" && seconds > 0
    ? t("status.manualSwitchInspectionCountdown", { ...values, seconds })
    : unassociatedProcesses
    ? seconds > 0
      ? t("status.autoSwitchQuietCountdownUnassociatedProcess", { ...values, seconds })
      : t("status.autoSwitchReadyUnassociatedProcess", values)
    : seconds > 0
      ? t("status.autoSwitchQuietCountdown", { ...values, seconds })
      : t("status.autoSwitchQueued", values)), { preserveActivityDiagnostics: true });
  showActivityDiagnostics(pendingAutoSwitch.activeThreadIds, pendingAutoSwitch.processRegistryState, pendingAutoSwitch.processRegistryDiagnostic);
}

async function checkPendingAutoSwitch() {
  if (!pendingAutoSwitch || autoSwitchInProgress || pendingAutoSwitchCheckInProgress) {
    return;
  }

  pendingAutoSwitchCheckInProgress = true;
  try {
    void watchAutoResumeQueue(++autoResumeQueueWatchGeneration);
    const result = await api.evaluateAutoSwitch("queued-check");
    await syncAutoSwitchTargetState();
    await handleAutoSwitchEvaluation(result);
  } catch (error) {
    setStatus(errorMessage(error), { preserveActivityDiagnostics: true });
  } finally {
    pendingAutoSwitchCheckInProgress = false;
  }
}

async function syncAutoSwitchTargetState(requestId) {
  const previousMode = settings.autoSwitchTargetMode;
  const previousTarget = settings.manualAutoSwitchTargetAccountId;
  const nextSettings = await api.readSettings();
  if (requestId !== undefined && requestId !== accountLoadRequestId) return;
  settings = nextSettings;
  syncSettingsControls();
  if (previousMode === settings.autoSwitchTargetMode && previousTarget === settings.manualAutoSwitchTargetAccountId) {
    return;
  }
  if (currentView !== "accounts") {
    accountSurfacesDirty = true;
    return;
  }
  for (const row of accountsEl.querySelectorAll(".account-row")) {
    const account = accounts.find((item) => item.id === row.dataset.accountId);
    if (!account || account.isCurrent) continue;
    const isTarget = settings.autoSwitchTargetMode === "manual" && settings.manualAutoSwitchTargetAccountId === account.id;
    const badge = row.querySelector('[data-field="badge"]');
    badge.textContent = isTarget ? t("labels.autoTarget") : t("labels.switchable");
    badge.classList.toggle("target-badge", isTarget);
  }
  renderDetail();
}

async function handleAutoSwitchEvaluation(result, requestId) {
  if (requestId !== undefined && requestId !== accountLoadRequestId) return;
  if (result?.status === "not_ready" && !result.pending) {
    clearPendingAutoSwitch();
    renderQuotaWarning();
    return;
  }
  if (result?.status === "held") {
    clearPendingAutoSwitch();
    renderQuotaWarning();
    return;
  }
  if (!result || result.status === "disabled" || result.status === "idle" || result.status === "not_ready") {
    const nextPendingAutoSwitch = (await api.getAutoSwitchState()).pending;
    if (requestId !== undefined && requestId !== accountLoadRequestId) return;
    pendingAutoSwitch = nextPendingAutoSwitch;
    renderQuotaWarning();
    return;
  }

  if (result.status === "queued") {
    pendingAutoSwitch = result.pending;
    startPendingAutoSwitchTimer();
    renderQuotaWarning();
    return;
  }

  if (result.status === "cancelled") {
    clearPendingAutoSwitch();
    await loadAccounts(t("status.autoSwitchQueueCleared"), { reason: "auto-switch-cancelled" });
    return;
  }

  if (result.status === "target_unavailable") {
    clearPendingAutoSwitch();
    setStatus(result.mode === "manual" ? t("status.manualTargetUnavailable") : t("status.exhaustedNoTarget"));
    renderQuotaWarning();
    return;
  }

  if (result.status === "blocked" || (result.status === "failed" && result.retryable === false)) {
    clearPendingAutoSwitch(false);
    setStatus(autoSwitchBlockedMessage(result));
    renderQuotaWarning();
    return;
  }

  if (result.status === "failed") {
    const nextPendingAutoSwitch = (await api.getAutoSwitchState()).pending;
    if (requestId !== undefined && requestId !== accountLoadRequestId) return;
    pendingAutoSwitch = nextPendingAutoSwitch;
    startPendingAutoSwitchTimer();
    setStatus(result.error || t("status.backgroundFailed", { error: t("labels.unknown") }), {
      preserveActivityDiagnostics: Boolean(pendingAutoSwitch && !activityDiagnostics.hidden && activityDiagnosticIds.textContent)
    });
    renderQuotaWarning();
    return;
  }

  if (result.status === "switched") {
    await finishAutoSwitch(result.target, result.result, result.fallback);
  }
}

async function finishAutoSwitch(target, switchResult, fallback) {
  autoSwitchInProgress = true;
  try {
    clearPendingAutoSwitch();
    selectedAccountId = target?.id;
    const switchMessage = fallback
      ? t("status.autoSwitchFallbackSwitched", {
          email: target?.emailMasked ?? t("labels.unknown"),
          count: switchResult?.closedCodexProcesses ?? 0,
          reason: fallbackReasonLabel(fallback.reason),
          launch: switchLaunchMessage(switchResult)
        })
      : t("status.autoSwitched", {
          email: target?.emailMasked ?? t("labels.unknown"),
          count: switchResult?.closedCodexProcesses ?? 0,
          launch: switchLaunchMessage(switchResult)
        });
    const autoResume = switchResult?.autoResume;
    const resumeStatusKey = {
      started: "status.autoResumeStarted",
      failed: "status.autoResumeFailed",
      uncertain: "status.autoResumeUncertain",
      candidate_pending_verification: "status.autoResumeCandidatePendingVerification",
      needs_attention: "status.autoResumeNeedsAttention",
      skipped_no_candidate: "status.autoResumeSkippedNoCandidate",
      skipped_multiple_candidates: "status.autoResumeSkippedMultipleCandidates",
      skipped: "status.autoResumeSkipped"
    }[autoResume?.status];
    const dshAuthSyncMessage = switchResult?.dshAuthSync?.status === "pending_busy"
      ? ` ${t("status.dshAuthSyncPendingBusy")}`
      : switchResult?.dshAuthSync?.status === "pending_retry"
        ? ` ${t("status.dshAuthSyncPendingRetry")}`
        : switchResult?.dshAuthSync?.status === "failed"
      ? ` ${t("status.dshAuthSyncFailed")}`
      : switchResult?.dshAuthSync?.status === "skipped"
        ? ` ${t("status.dshAuthSyncSkipped")}`
        : "";
    const resumeMessage = autoResume?.status === "multi_pending"
      ? formatAutoResumeProgress(autoResume) || t("status.autoResumeMultiPending", autoResume)
      : autoResume?.status === "multi_complete"
        ? t("status.autoResumeMultiComplete", autoResume)
        : resumeStatusKey ? t(resumeStatusKey) : "";
    const switchedMessage = `${switchMessage}${dshAuthSyncMessage}`;
    const message = resumeMessage ? `${switchedMessage} ${resumeMessage}` : switchedMessage;
    await loadAccounts(message, { reason: "auto-switch" });
    if (autoResume?.status === "multi_pending") {
      void watchAutoResumeQueue(++autoResumeQueueWatchGeneration);
    }
  } finally {
    autoSwitchInProgress = false;
  }
}

async function refreshAccountUsage(account) {
  try {
    await api.refreshUsage(account.id, true);
    await loadAccounts(t("status.accountUsageRefreshed"), { deferWhileScrolling: true });
  } catch (error) {
    const message = isUsageAuthExpiredError(error)
      ? t("status.accountUsageAuthExpired", { email: account.emailMasked })
      : t("status.accountRefreshFailed", { email: account.emailMasked, error: errorMessage(error) });
    await loadAccounts(message, { deferWhileScrolling: true });
  }
}

function renderAccounts() {
  const query = searchInput.value.trim().toLowerCase();
  const filtered = accounts.filter((account) =>
    [account.emailMasked, account.planType, account.status, account.accountId].some((value) =>
      String(value ?? "").toLowerCase().includes(query)
    )
  );
  resultCount.textContent = settings.uiLanguage === "en" ? `${filtered.length} accounts` : `${filtered.length} 个账号`;
  accountsEl.replaceChildren();

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `
      <span class="empty-icon" aria-hidden="true"></span>
      <h3>${accounts.length === 0 ? t("empty.noAccounts") : t("empty.noMatches")}</h3>
      <p>${accounts.length === 0 ? t("empty.noAccountsHelp") : t("empty.noMatchesHelp")}</p>
    `;
    accountsEl.append(empty);
    return;
  }

  for (const account of filtered) {
    const quota = quotaDisplayState(account);
    const node = template.content.firstElementChild.cloneNode(true);
    translateTree(node);
    node.dataset.accountId = account.id;
    node.classList.toggle("current", account.isCurrent);
    node.classList.toggle("selected", account.id === selectedAccountId);
    node.querySelector('[data-field="avatar"]').textContent = initials(account);
    node.querySelector('[data-field="plan"]').textContent = normalizePlan(account.planType);
    node.querySelector('[data-field="plan"]').classList.add(planClass(account.planType));
    node.querySelector('[data-field="email"]').textContent = account.emailMasked;
    node.querySelector('[data-field="meta"]').textContent = `${statusLabel(account.status)} · ${t("labels.localRecord", { id: shortId(account.id) })}`;
    const isManualTarget = settings.autoSwitchTargetMode === "manual" && settings.manualAutoSwitchTargetAccountId === account.id && !account.isCurrent;
    node.querySelector('[data-field="badge"]').textContent = account.isCurrent ? t("labels.current") : (isManualTarget ? t("labels.autoTarget") : t("labels.switchable"));
    node.querySelector('[data-field="badge"]').classList.toggle("current-badge", account.isCurrent);
    node.querySelector('[data-field="badge"]').classList.toggle("target-badge", isManualTarget);
    const fiveRing = node.querySelector('[data-field="five-ring"]');
    const weekRing = node.querySelector('[data-field="week-ring"]');
    fiveRing.hidden = account.isCurrent && account.usage?.source === "codex_app_server" && !quota.fiveHour;
    weekRing.hidden = account.isCurrent && account.usage?.source === "codex_app_server" && !quota.oneWeek;
    fiveRing.replaceChildren(usageRing("5h", quota.fiveHour));
    weekRing.replaceChildren(usageRing("7d", quota.oneWeek));
    node.querySelector('[data-field="error"]').textContent = account.usageError
      ?? (!quota.current && account.usage ? t("quota.stale") : "");
    node.addEventListener("click", () => {
      selectAccount(account.id);
    });
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectAccount(account.id);
      }
    });
    node.querySelector('[data-action="switch"]').disabled = account.isCurrent;
    node.querySelector('[data-action="switch"]').addEventListener("click", stopAndRun(async () => switchAccount(account)));
    node.querySelector('[data-action="refresh"]').addEventListener("click", stopAndRun(async () => refreshAccountUsage(account)));
    node.querySelector('[data-action="delete"]').addEventListener("click", stopAndRun(async () => deleteAccount(account)));
    accountsEl.append(node);
  }
}

function selectAccount(accountId) {
  selectedAccountId = accountId;
  for (const row of accountsEl.querySelectorAll(".account-row")) {
    row.classList.toggle("selected", row.dataset.accountId === accountId);
  }
  renderDetail();
}

function renderDetail() {
  const account = accounts.find((item) => item.id === selectedAccountId);
  if (!account) {
    detailEl.innerHTML = `
      <section class="detail-empty">
        <span class="empty-icon" aria-hidden="true"></span>
        <h3>${t("detail.selectAccount")}</h3>
        <p>${t("detail.selectHelp")}</p>
      </section>
    `;
    return;
  }
  const quota = quotaDisplayState(account);
  const isManualTarget = settings.autoSwitchTargetMode === "manual" && settings.manualAutoSwitchTargetAccountId === account.id && !account.isCurrent;
  detailEl.innerHTML = `
    <section class="detail-header">
      <span class="detail-avatar">${escapeHtml(initials(account))}</span>
      <div>
        <div class="detail-badges">
          <span class="badge plan ${planClass(account.planType)}">${escapeHtml(normalizePlan(account.planType))}</span>
          ${account.isCurrent ? `<span class="badge current-badge">${t("labels.current")}</span>` : `<span class="badge state">${t("labels.candidate")}</span>`}
          ${isManualTarget ? `<span class="badge target-badge">${t("labels.autoTarget")}</span>` : ""}
          ${account.isAutoSwitchExcluded ? `<span class="badge excluded-badge">${t("labels.autoExcluded")}</span>` : ""}
        </div>
        <h3>${escapeHtml(account.emailMasked)}</h3>
        <p>${escapeHtml(t("detail.fingerprint", { id: shortId(account.accountId) }))}</p>
        <div class="detail-remark">
          <span>${escapeHtml(t("detail.remark"))}</span>
          <strong>${escapeHtml(account.remark ?? t("detail.remarkEmpty"))}</strong>
          <button id="detail-edit-remark" class="secondary-action" type="button">${escapeHtml(t("actions.editRemark"))}</button>
        </div>
      </div>
    </section>

    <section class="detail-section auto-target-section">
      <div>
        <h4>${t("detail.autoSwitchPolicy")}</h4>
        <p>${account.isCurrent ? t("detail.autoSwitchTargetCurrentHelp") : t("detail.autoSwitchTargetHelp")}</p>
      </div>
      <button id="detail-auto-target" class="${isManualTarget ? "" : "secondary-action"}" type="button" ${account.isCurrent ? "disabled" : ""}>
        <span class="button-icon target-icon" aria-hidden="true"></span>
        <span>${isManualTarget ? t("actions.clearAutoSwitchTarget") : t("actions.setAutoSwitchTarget")}</span>
      </button>
    </section>

    <section class="detail-section detail-exclusion-section">
      <label class="detail-toggle-row">
        <span>
          <strong>${t("detail.autoSwitchExcluded")}</strong>
          <small>${account.isCurrent ? t("detail.autoSwitchExcludedCurrentHelp") : t("detail.autoSwitchExcludedHelp")}</small>
        </span>
        <input id="detail-auto-excluded" type="checkbox" ${account.isAutoSwitchExcluded ? "checked" : ""} />
      </label>
    </section>

    <section class="detail-section">
      <h4>${t("detail.usage")}</h4>
      <div class="reset-card">
        <div class="detail-score-row">
          <span class="detail-score-label">
            ${t("detail.immediateState")}
            <span class="detail-score-help">
              <button class="detail-score-help-button" type="button" aria-label="${escapeHtml(t("detail.scoreHelpLabel"))}"><svg class="help-circle-icon" aria-hidden="true"><use href="#help-circle-symbol"></use></svg></button>
              <span class="detail-score-help-popover" role="tooltip">
                <strong>${t("detail.scoreHelpTitle")}</strong>
                <span>${t("detail.scoreHelpFormula")}</span>
                <span>${t("detail.scoreHelpMeaning")}</span>
              </span>
            </span>
          </span>
          <strong>${formatImmediateState(account)}</strong>
        </div>
        <div class="detail-recovery-row">
          <span>${t("detail.overallQuota")}</span>
          <strong>${hasCompleteCurrentQuota(account) ? `${formatScore(quotaBalanceScore(account))} ${t("labels.scoreUnit")}` : t("labels.unknown")}</strong>
        </div>
        <div class="detail-recovery-row">
          <span>${t("detail.expectedRecovery")}</span>
          <strong>${formatExpectedRecovery(account)}</strong>
        </div>
      </div>
      <div class="detail-usage-grid">
        ${quota.fiveHour ? detailUsageCard(t("detail.fiveHour"), "success", quota.fiveHour) : ""}
        ${quota.oneWeek ? detailUsageCard(t("detail.oneWeek"), "info", quota.oneWeek) : ""}
      </div>
      <div class="reset-card">
        <span>${t("detail.resetTime")}</span>
        ${quota.fiveHour ? resetRow(settings.uiLanguage === "en" ? "5 hours" : "5 小时", quota.fiveHour) : ""}
        ${quota.oneWeek ? resetRow(settings.uiLanguage === "en" ? "7 days" : "7 天", quota.oneWeek) : ""}
      </div>
      <div class="quota-provenance">
        <span>${escapeHtml(t("detail.quotaSource", { source: account.usage?.source === "codex_app_server" ? "Codex app-server" : account.usage?.source === "chatgpt_usage_api" ? "ChatGPT/Codex usage API" : t("labels.unknown") }))}</span>
        <span>${escapeHtml(t("detail.quotaLastRefresh", { time: formatTime(account.usage?.fetchedAt) }))}</span>
        <span>${escapeHtml(t("detail.quotaSnapshotAge", { age: formatSnapshotAge(account.usage?.fetchedAt) }))}</span>
        <strong>${isFreshQuotaSnapshot(account) ? t("detail.quotaFresh") : t("detail.quotaStale")}</strong>
      </div>
      ${account.usageError ? `<p class="usage-error">${escapeHtml(account.usageError)}</p>` : ""}
    </section>

    <section class="detail-section">
      <h4>${t("detail.localStatus")}</h4>
      <div class="meta-grid">
        <span>${escapeHtml(t("detail.status", { value: statusLabel(account.status) }))}</span>
        <span>${escapeHtml(t("detail.created", { value: formatTime(account.createdAt) }))}</span>
        <span>${escapeHtml(t("detail.updated", { value: formatTime(account.updatedAt) }))}</span>
      </div>
    </section>

    <section class="detail-section detail-controls">
      <h4>${t("detail.controls")}</h4>
      <label class="detail-toggle-row">
        <span>
          <strong>${t("detail.accountHttpOnly")}</strong>
          <small>${t("detail.accountHttpOnlyHelp")}</small>
        </span>
        <input id="detail-http-only" type="checkbox" ${account.httpOnlyModeEnabled ? "checked" : ""} />
      </label>
      <label class="detail-toggle-row">
        <span>
          <strong>${t("detail.accountDisableGpu")}</strong>
          <small>${t("detail.accountDisableGpuHelp")}</small>
        </span>
        <input id="detail-disable-gpu" type="checkbox" ${account.disableGpuModeEnabled ? "checked" : ""} />
      </label>
      <div class="detail-action-row" aria-label="${escapeHtml(t("detail.actions"))}">
        <button id="detail-switch" class="primary-action" ${account.isCurrent ? "disabled" : ""} type="button">
          <span class="button-icon switch-icon" aria-hidden="true"></span>
          <span>${t("detail.switchTo")}</span>
        </button>
        <button id="detail-refresh" type="button">
          <span class="button-icon refresh-icon" aria-hidden="true"></span>
          <span>${t("actions.refresh")}</span>
        </button>
        <button id="detail-delete" class="danger" type="button">
          <span class="button-icon trash-icon" aria-hidden="true"></span>
          <span>${t("actions.delete")}</span>
        </button>
      </div>
    </section>
  `;

  detailEl.querySelector("#detail-switch")?.addEventListener("click", runAction(async () => switchAccount(account)));
  detailEl.querySelector("#detail-refresh")?.addEventListener("click", runAction(async () => refreshAccountUsage(account)));
  detailEl.querySelector("#detail-edit-remark")?.addEventListener("click", runAction(async () => editAccountRemark(account)));
  detailEl.querySelector("#detail-auto-target")?.addEventListener("click", runAction(async () => toggleAutoSwitchTarget(account)));
  detailEl.querySelector("#detail-auto-excluded")?.addEventListener("change", runAction(async (event) => {
    await toggleAutoSwitchExcluded(account, event.target.checked);
  }));
  detailEl.querySelector("#detail-delete")?.addEventListener("click", runAction(async () => deleteAccount(account)));
  const detailHttpOnlyInput = detailEl.querySelector("#detail-http-only");
  detailHttpOnlyInput?.addEventListener("change", runAction(async () => {
    await setAccountHttpOnlyMode(account, detailHttpOnlyInput.checked);
  }));
  const detailDisableGpuInput = detailEl.querySelector("#detail-disable-gpu");
  detailDisableGpuInput?.addEventListener("change", runAction(async () => {
    const requested = detailDisableGpuInput.checked;
    if (account.isCurrent && !confirm(t("confirm.disableGpu"))) {
      detailDisableGpuInput.checked = !requested;
      return;
    }
    await setAccountDisableGpuMode(account, requested);
  }));
  for (const ring of detailEl.querySelectorAll("[data-progress]")) {
    ring.style.setProperty("--quota-progress", `${ring.dataset.progress}%`);
  }
}

function formatExpectedRecovery(account) {
  const quota = quotaDisplayState(account);
  if (!quota.current) return t("labels.unknown");
  const resetAt = exhaustedResetAt(account);
  if (resetAt) return formatTime(resetAt);
  return quota.fiveHour && quota.oneWeek && remainingScore(account) > 0
    ? t("detail.availableNow")
    : t("labels.unknown");
}

function formatImmediateState(account) {
  const quota = quotaDisplayState(account);
  if (!quota.current) return t("labels.unknown");
  if (quota.availability === "execution_limited") {
    return t("detail.executionLimited", { remaining: formatQuotaPercent(lowestRemaining(account)) });
  }
  const fiveBlocked = Number(quota.fiveHour?.usedPercent) >= 100;
  const weekBlocked = Number(quota.oneWeek?.usedPercent) >= 100;
  if (fiveBlocked && weekBlocked) return t("detail.waitBoth");
  if (fiveBlocked) return t("detail.waitFiveHour");
  if (weekBlocked) return t("detail.waitOneWeek");
  if (!quota.fiveHour || !quota.oneWeek) return t("labels.unknown");
  return t("detail.availableNow");
}

async function setAccountHttpOnlyMode(account, enabled) {
  const result = await api.setAccountHttpOnlyMode(account.id, enabled);
  const launch = result.closedCodexProcesses > 0
    ? (result.launchedCodex ? t("status.launchOk") : t("status.launchFailed"))
    : "";
  await loadAccounts(t(enabled ? "status.accountHttpOnlyOn" : "status.accountHttpOnlyOff", {
    email: account.emailMasked,
    launch
  }));
}

async function setAccountDisableGpuMode(account, enabled) {
  const result = await api.setAccountDisableGpuMode(account.id, enabled);
  const launch = result.closedCodexProcesses > 0
    ? (result.launchedCodex ? t("status.launchOk") : t("status.launchFailed"))
    : "";
  await loadAccounts(t(enabled ? "status.accountDisableGpuOn" : "status.accountDisableGpuOff", {
    email: account.emailMasked,
    launch
  }));
}

async function editAccountRemark(account) {
  const remark = await chooseAccountRemark(account.remark ?? "");
  if (remark === undefined) return;
  await api.setAccountRemark(account.id, remark);
  await loadAccounts(t("status.accountRemarkSaved", { email: account.emailMasked }), { reason: "account-remark" });
}

function chooseAccountRemark(currentRemark) {
  remarkInput.value = currentRemark;
  remarkInput.setCustomValidity("");
  remarkDialog.returnValue = "";
  return new Promise((resolve) => {
    const onClose = () => {
      remarkDialog.removeEventListener("close", onClose);
      resolve(remarkDialog.returnValue === "save" ? remarkInput.value : undefined);
    };
    remarkDialog.addEventListener("close", onClose);
    remarkDialog.showModal();
    remarkInput.focus();
    remarkInput.select();
  });
}

async function toggleAutoSwitchTarget(account) {
  if (settings.autoSwitchTargetMode === "manual" && settings.manualAutoSwitchTargetAccountId === account.id) {
    settings = await api.clearAutoSwitchTarget();
    syncSettingsControls();
    await loadAccounts(t("status.manualTargetCleared"), { reason: "target-cleared" });
    return;
  }
  settings = await api.setAutoSwitchTarget(account.id);
  syncSettingsControls();
  selectedAccountId = account.id;
  await loadAccounts(t("status.manualTargetSet", { email: account.emailMasked }), { reason: "target-set" });
}

async function toggleAutoSwitchExcluded(account, excluded) {
  settings = await api.setAutoSwitchExcluded(account.id, excluded);
  syncSettingsControls();
  await loadAccounts(t(excluded ? "status.autoSwitchExcluded" : "status.autoSwitchIncluded", { email: account.emailMasked }), {
    reason: excluded ? "exclusion-set" : "exclusion-cleared"
  });
}

async function switchAccount(account) {
  if (manualSwitchInProgress) return;
  manualSwitchInProgress = true;
  try {
    const choice = await chooseManualSwitch(account);
    if (!choice) return;
    clearPendingAutoSwitch();
    const options = {
      manualInspection: true,
      resumeQuotaInterruptedTask: choice.resumeQuotaInterruptedTask,
      forceSwitch: choice.forceSwitch
    };
    let result = await api.switchAccount(account.id, options);
    if (result?.status === "continuation_in_progress" || result?.status === "switch_in_progress") {
      setStatus(t(result.status === "continuation_in_progress" ? "status.continuationInProgress" : "status.switchInProgress"));
      return;
    }
    if (result?.status === "projection_blocked") {
      const detail = autoSwitchBlockedMessage(result);
      if (!confirm(t("confirm.forceProjectionSwitch", { detail, email: account.emailMasked }))) {
        setStatus(detail);
        return;
      }
      result = await api.switchAccount(account.id, {
        ...options,
        manualInspection: true,
        forceProjectionSwitch: true
      });
    }
    settings = await api.readSettings();
    selectedAccountId = account.id;
    await loadAccounts(switchMessage(t("status.switched", { email: account.emailMasked }), result), { reason: "manual-switch" });
    if (result?.manualResume?.status === "pending") {
      void watchManualResume(++manualResumeWatchGeneration);
    }
  } finally {
    manualSwitchInProgress = false;
  }
}

async function watchManualResume(generation) {
  for (let attempt = 0; attempt < 40 && generation === manualResumeWatchGeneration; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (generation !== manualResumeWatchGeneration) return;
    let progress;
    try {
      progress = await api.getAutoResumeStatus();
    } catch {
      return;
    }
    const status = progress?.status;
    const key = {
      turn_started: "status.manualResumeStarted",
      completed: "status.manualResumeStarted",
      failed: "status.manualResumeFailed",
      uncertain: "status.manualResumeUncertain",
      multi_complete: "status.autoResumeMultiComplete"
    }[status];
    if (key) {
      setStatus(t(key, progress));
      return;
    }
    if (["multi_pending", "prepared", "launch_verified", "waiting_for_desktop"].includes(status)) {
      setStatus(formatAutoResumeProgress(progress));
      continue;
    }
  }
}

async function watchAutoResumeQueue(generation) {
  for (let attempt = 0; attempt < 120 && generation === autoResumeQueueWatchGeneration; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (generation !== autoResumeQueueWatchGeneration) return;
    let status;
    try {
      status = await api.getAutoResumeStatus();
    } catch {
      return;
    }
    if (status?.status === "multi_complete") {
      if (pendingAutoSwitchCheckInProgress || autoSwitchInProgress) continue;
      setStatus(t("status.autoResumeMultiComplete", status));
      return;
    }
    if (!["multi_pending", "prepared", "launch_verified", "waiting_for_desktop"].includes(status?.status)) {
      if (pendingAutoSwitchCheckInProgress || autoSwitchInProgress) continue;
      return;
    }
    setStatus(formatAutoResumeProgress(status));
  }
}

function formatAutoResumeProgress(progress) {
  if (!progress || !["multi_pending", "prepared", "launch_verified", "waiting_for_desktop"].includes(progress.status)) return "";
  const phaseKeys = {
    prepared: "status.autoResumePhasePrepared",
    launch_verified: "status.autoResumePhaseLaunchVerified",
    waiting_for_desktop: "status.autoResumePhaseWaitingDesktop",
    deep_link_opened: "status.autoResumePhaseDeepLink",
    window_scan_started: "status.autoResumePhaseDeepLink",
    window_scan_completed: "status.autoResumePhaseDeepLink",
    composer_scan_started: "status.autoResumePhaseDeepLink",
    composer_scan_completed: "status.autoResumePhaseDeepLink",
    window_restored: "status.autoResumePhaseWindowRestored",
    composer_found: "status.autoResumePhaseComposerFound",
    submit_found: "status.autoResumePhaseSubmitFound",
    focus_verified: "status.autoResumePhaseFocusVerified",
    invoke_started: "status.autoResumePhaseInvokeStarted",
    invoke_no_effect: "status.autoResumePhaseInvokeNoEffect",
    fallback_invoke_started: "status.autoResumePhaseFallbackInvokeStarted",
    prompt_consumed: "status.autoResumePhasePromptConsumed"
  };
  const total = Math.max(1, Number(progress.total) || 1);
  const currentIndex = Math.min(total, Math.max(1, Number(progress.currentIndex) || 1));
  const phaseKey = phaseKeys[progress.desktopPhase] || phaseKeys[progress.currentStage];
  const parts = [
    t("status.autoResumeProgressPosition", { currentIndex, total }),
    phaseKey ? t(phaseKey) : t("status.autoResumeMultiPending", progress)
  ];
  if (Number.isFinite(progress.phaseRemainingSeconds)) {
    parts.push(t("status.autoResumeProgressRemaining", { seconds: Math.max(0, progress.phaseRemainingSeconds) }));
  } else {
    parts.push(t("status.autoResumeProgressElapsed", { seconds: Math.max(0, Number(progress.elapsedSeconds) || 0) }));
  }
  if (Number.isFinite(progress.queueRemainingUpperBoundSeconds)) {
    parts.push(t("status.autoResumeProgressQueue", {
      seconds: Math.max(0, progress.queueRemainingUpperBoundSeconds)
    }));
  }
  parts.push(t("status.autoResumeProgressCounts", progress));
  return parts.join(" · ");
}

async function chooseManualSwitch(account) {
  manualSwitchDialogIntro.textContent = t("modal.manualSwitchIntro", { email: account.emailMasked });
  manualSwitchResume.checked = true;
  manualSwitchForce.checked = false;
  // Continuation is based on unfinished-task evidence, not the source quota
  // snapshot. Quota may be stale or unavailable during a manual switch.
  manualSwitchResume.disabled = false;
  manualSwitchDialog.returnValue = "";
  return new Promise((resolve) => {
    const onClose = () => {
      manualSwitchDialog.removeEventListener("close", onClose);
      resolve(manualSwitchDialog.returnValue === "confirm"
        ? { resumeQuotaInterruptedTask: manualSwitchResume.checked, forceSwitch: manualSwitchForce.checked }
        : undefined);
    };
    manualSwitchDialog.addEventListener("close", onClose);
    manualSwitchDialog.showModal();
  });
}

async function deleteAccount(account) {
  if (account.isCurrent) {
    const candidates = accounts.filter((item) => item.id !== account.id);
    const action = await chooseCurrentDeleteAction(candidates);
    if (!action) {
      return;
    }

    if (action.mode === "login_new") {
      const result = await api.deleteAccount(account.id, { mode: "login_new" });
      clearPendingAutoSwitch();
      selectedAccountId = undefined;
      await loadAccounts(loginNewMessage(result));
      return;
    }

    const result = await api.deleteAccount(account.id, { replacementAccountId: action.replacement.id });
    clearPendingAutoSwitch();
    selectedAccountId = result.switchedTo?.id ?? action.replacement.id;
    await loadAccounts(switchMessage(t("status.currentDeletedSwitched", { email: action.replacement.emailMasked }), result));
    return;
  }

  if (!confirm(t("confirm.delete", { email: account.emailMasked }))) {
    return;
  }
  const result = await api.deleteAccount(account.id);
  if (pendingAutoSwitch?.accountId === account.id) {
    clearPendingAutoSwitch();
  }
  if (selectedAccountId === account.id) {
    selectedAccountId = undefined;
  }
  await loadAccounts(t("status.deletedUnaffected"));
}

function chooseCurrentDeleteAction(candidates) {
  replacementSelect.replaceChildren();
  for (const candidate of candidates) {
    const option = document.createElement("option");
    option.value = candidate.id;
    option.textContent = `${candidate.emailMasked} · ${statusLabel(candidate.status)} · ${formatScore(remainingScore(candidate))} ${t("labels.scoreUnit")}`;
    replacementSelect.append(option);
  }

  return new Promise((resolve) => {
    const switchInput = replacementDialog.querySelector('input[name="delete-current-mode"][value="switch"]');
    const loginNewInput = replacementDialog.querySelector('input[name="delete-current-mode"][value="login_new"]');
    switchInput.disabled = candidates.length === 0;
    switchInput.checked = candidates.length > 0;
    loginNewInput.checked = candidates.length === 0;

    const selectedMode = () => replacementDialog.querySelector('input[name="delete-current-mode"]:checked')?.value ?? "login_new";
    const refreshDialogState = () => {
      const mode = selectedMode();
      replacementField.hidden = mode !== "switch" || candidates.length === 0;
    replacementConfirm.textContent = mode === "login_new" ? t("modal.deleteLogin") : t("modal.deleteSwitch");
    };
    const onClose = () => {
      replacementDialog.removeEventListener("close", onClose);
      switchInput.removeEventListener("change", refreshDialogState);
      loginNewInput.removeEventListener("change", refreshDialogState);
      if (replacementDialog.returnValue !== "confirm") {
        resolve(undefined);
        return;
      }
      if (selectedMode() === "login_new") {
        resolve({ mode: "login_new" });
        return;
      }
      const replacement = candidates.find((candidate) => candidate.id === replacementSelect.value);
      resolve(replacement ? { mode: "switch", replacement } : undefined);
    };
    replacementDialog.addEventListener("close", onClose);
    switchInput.addEventListener("change", refreshDialogState);
    loginNewInput.addEventListener("change", refreshDialogState);
    refreshDialogState();
    replacementDialog.showModal();
  });
}

function switchMessage(prefix, result) {
  const dshAuthSync = result?.dshAuthSync?.status === "pending_busy"
    ? ` ${t("status.dshAuthSyncPendingBusy")}`
    : result?.dshAuthSync?.status === "pending_retry"
      ? ` ${t("status.dshAuthSyncPendingRetry")}`
      : result?.dshAuthSync?.status === "failed"
    ? ` ${t("status.dshAuthSyncFailed")}`
    : result?.dshAuthSync?.status === "skipped"
      ? ` ${t("status.dshAuthSyncSkipped")}`
      : "";
  if (result.alreadyCurrent) {
    return `${t("status.currentAlready", { prefix })}${dshAuthSync}`;
  }
  const closed = result.closedCodexProcesses ?? 0;
  const launch = switchLaunchMessage(result);
  const warning = result.transportWarning ? ` ${t("status.transportWarning", { error: result.transportWarning })}` : "";
  const auth = result.targetUsageAuthExpired ? ` ${t("status.accountUsageAuthExpired", { email: result.switchedTo?.emailMasked ?? t("labels.unknown") })}` : "";
  const resumeStatusKey = {
    pending: "status.manualResumePending",
    started: "status.manualResumeStarted",
      failed: "status.manualResumeFailed",
      uncertain: "status.manualResumeUncertain",
      candidate_pending_verification: "status.manualResumeCandidatePendingVerification",
      needs_attention: "status.manualResumeNeedsAttention",
      skipped_no_candidate: "status.manualResumeSkippedNoCandidate",
    skipped_multiple_candidates: "status.manualResumeSkippedMultipleCandidates",
    skipped_source_not_exhausted: "status.manualResumeSkippedSourceNotExhausted",
    skipped_target_unavailable: "status.manualResumeSkippedTargetUnavailable",
    skipped_target_current_or_missing: "status.manualResumeSkipped",
    skipped_previous_attempt: "status.manualResumeSkipped",
    skipped_already_current: "status.manualResumeSkipped"
  }[result?.manualResume?.status];
  const resume = resumeStatusKey ? ` ${t(resumeStatusKey)}` : "";
  return `${t("status.switchResult", { prefix, count: closed, launch })}${warning}${auth}${dshAuthSync}${resume}`;
}

function autoSwitchBlockedMessage(result) {
  if (result?.reasonCode === "codex_thread_projection_unhealthy") {
    return t("status.autoSwitchProjectionMetadataBlocked");
  }
  if (result?.reasonCode === "codex_thread_projection_unavailable") {
    return t("status.autoSwitchProjectionUnavailable");
  }
  return result?.error || t("status.backgroundFailed", { error: t("labels.unknown") });
}

function switchLaunchMessage(result) {
  if (result?.launchRecovered) return t("status.launchRecovered");
  if (result?.launchedCodex) return t(result.verifiedCodexClosure ? "status.launchOk" : "status.launchFresh");
  return t("status.launchFailed");
}

function loginNewMessage(result) {
  const closed = result.closedCodexProcesses ?? 0;
  const launch = switchLaunchMessage(result);
  const warning = result.transportWarning ? ` ${t("status.transportWarning", { error: result.transportWarning })}` : "";
  return `${t("status.loginNew", { count: closed, launch })}${warning}`;
}

function usageRing(label, window) {
  const remaining = window?.remainingPercent;
  const wrapper = document.createElement("div");
  wrapper.className = "quota-ring";
  wrapper.style.setProperty("--quota-progress", `${remaining ?? 0}%`);
  wrapper.setAttribute("aria-label", window
    ? t("quota.remainingLabel", { label, remaining: formatQuotaPercent(remaining) })
    : t("quota.staleLabel", { label }));
  wrapper.innerHTML = `
    <div class="quota-ring-center">
      <span>${label}</span>
      <strong>${window ? formatQuotaPercent(remaining) : "?"}</strong>
    </div>
  `;
  return wrapper;
}

function detailUsageCard(title, tone, window) {
  const remaining = window?.remainingPercent;
  const used = window ? formatQuotaPercent(window.usedPercent) : "?";
  return `
    <div class="detail-usage-card quota-ring-card ${tone}">
      <div class="quota-ring" data-progress="${remaining ?? 0}">
        <div class="quota-ring-center">
          <span>${tone === "success" ? "5h" : "7d"}</span>
          <strong>${window ? formatQuotaPercent(remaining) : "?"}</strong>
        </div>
      </div>
      <div>
        <span>${title}</span>
        <strong>${t("detail.used", { used })}</strong>
      </div>
    </div>
  `;
}

function resetRow(label, window) {
  return `
    <div class="reset-row">
      <span>${label}</span>
      <strong>${window?.resetAt ? formatBeijingTime(window.resetAt * 1000) : t("labels.unknown")}</strong>
    </div>
  `;
}

function renderUsageView() {
  const totals = tokenUsageStats?.totals ?? {};
  const today = totals.today ?? {};
  const sevenDays = totals.sevenDays ?? {};
  const month = totals.month ?? {};
  usageTotalToday.textContent = tokenUsageLoading ? "..." : formatCompactNumber(today.totalTokens ?? 0);
  usageTotalSevenDays.textContent = tokenUsageLoading ? "..." : formatCompactNumber(sevenDays.totalTokens ?? 0);
  usageTotalMonth.textContent = tokenUsageLoading ? "..." : formatCompactNumber(month.totalTokens ?? 0);
  usageAverageCache.textContent = tokenUsageLoading ? "..." : formatPercent(cacheHitRate(sevenDays));
  if (tokenUsageLoading) {
    usageBarChart.innerHTML = usageLoadingMarkup();
    usagePieChart.innerHTML = usageLoadingMarkup();
    return;
  }
  usageBarChart.innerHTML = usageBarChartMarkup((tokenUsageStats?.dailySevenDays ?? []).map((day) => ({
    label: formatUsageDate(day.date),
    value: day.totalTokens ?? 0
  })));
  usagePieChart.innerHTML = usageCacheHitMarkup((tokenUsageStats?.dailySevenDays ?? []).map((day) => ({
    label: formatUsageDate(day.date),
    bucket: day
  })));
  applyUsageBarWidths();
}

function usageLoadingMarkup() {
  return `<div class="usage-no-data usage-loading">${t("usage.loading")}</div>`;
}

function formatUsageDate(dateText) {
  if (!dateText) {
    return t("labels.unknown");
  }
  const date = new Date(`${dateText}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) {
    return dateText;
  }
  return new Intl.DateTimeFormat(currentLanguage(), { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit" }).format(date);
}

function usageBarChartMarkup(items) {
  if (!items.length) {
    return `<div class="usage-no-data">${t("usage.noData")}</div>`;
  }
  const maxValue = Math.max(1, ...items.map((item) => item.value));
  const nonZeroValues = items.map((item) => item.value).filter((value) => value > 0);
  const minNonZeroValue = nonZeroValues.length ? Math.min(...nonZeroValues) : undefined;
  return items
    .map((item) => {
      const width = Math.round((item.value / maxValue) * 100);
      const ratio = Math.round((item.value / maxValue) * 100);
      const isMax = item.value > 0 && item.value === maxValue;
      const isMin = minNonZeroValue !== undefined && item.value === minNonZeroValue && item.value !== maxValue;
      const marker = isMax ? t("usage.maxDay") : isMin ? t("usage.minDay") : "";
      return `
        <div class="usage-bar-row ${isMax ? "max" : ""} ${isMin ? "min" : ""}">
          <span>${escapeHtml(item.label)}</span>
          <div class="usage-bar-track"><div class="usage-bar-fill" data-fill-percent="${width}"></div></div>
          <strong class="usage-bar-value">
            <em class="usage-extrema-marker">${marker ? escapeHtml(marker) : "&nbsp;"}</em>
            <span>${formatCompactNumber(item.value)}</span>
            <small>${ratio}%</small>
          </strong>
        </div>
      `;
    })
    .join("");
}

function usageCacheHitMarkup(items) {
  if (!items.some((item) => (item.bucket?.inputTokens ?? 0) > 0)) {
    return `<div class="usage-no-data">${t("usage.noData")}</div>`;
  }
  return items
    .map((item) => {
      const bucket = item.bucket ?? {};
      const rate = Math.round(cacheHitRate(bucket));
      return `
        <div class="usage-bar-row hit-rate">
          <span>${escapeHtml(item.label)}</span>
          <div class="usage-bar-track"><div class="usage-bar-fill" data-fill-percent="${rate}"></div></div>
          <strong class="usage-bar-value">
            <em class="usage-extrema-marker">&nbsp;</em>
            <span>${formatPercent(rate)}</span>
            <small>${formatCompactNumber(bucket.cachedInputTokens ?? 0)} / ${formatCompactNumber(bucket.inputTokens ?? 0)}</small>
          </strong>
        </div>
      `;
    })
    .join("");
}

function applyUsageBarWidths() {
  for (const fill of document.querySelectorAll(".usage-bar-fill[data-fill-percent]")) {
    const percent = Math.max(0, Math.min(100, Number(fill.dataset.fillPercent) || 0));
    fill.style.width = `${percent}%`;
  }
}

function cacheHitRate(bucket) {
  const input = Number(bucket?.inputTokens ?? 0);
  const cached = Number(bucket?.cachedInputTokens ?? 0);
  return input > 0 ? Math.max(0, Math.min(100, (cached / input) * 100)) : 0;
}

function formatPercent(value) {
  return `${Math.round(Number(value) || 0)}%`;
}

function formatCompactNumber(value) {
  return new Intl.NumberFormat(currentLanguage(), {
    notation: Math.abs(Number(value)) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1
  }).format(Number(value) || 0);
}

function reportCacheKey(mode = reportMode, date = reportsWeekInput.value) {
  return `${mode}:${date}`;
}

function reportCacheIsFresh(entry, mode = reportMode, date = reportsWeekInput.value) {
  return Boolean(
    entry?.updatedAt &&
    (!reportRangeIncludesToday(mode, date) || entry.dataRevision === reportDataRevision) &&
    Date.now() - entry.updatedAt < clampRefreshInterval(settings.usageRefreshIntervalMinutes) * 60_000
  );
}

function markReportDataChanged(results = []) {
  if (results.some((item) => item?.ok)) reportDataRevision += 1;
}

function reportRangeIncludesToday(mode = reportMode, date = reportsWeekInput.value) {
  const start = new Date(`${date}T00:00:00+08:00`);
  if (!Number.isFinite(start.getTime())) return false;
  const end = new Date(start.getTime() + (mode === "weekly" ? 7 : 1) * 86400000);
  const today = new Date(beijingDayStart());
  return start.getTime() <= today.getTime() && today.getTime() < end.getTime();
}

function hydrateReportCache() {
  const entry = reportCache.get(reportCacheKey());
  if (!entry) return false;
  weeklyReport = entry.report;
  weeklyReportUpdatedAt = entry.updatedAt;
  renderReportsView();
  return true;
}

async function refreshWeeklyReport({ force = false, background = false } = {}) {
  const mode = reportMode;
  const date = reportsWeekInput.value;
  const key = reportCacheKey(mode, date);
  const cached = reportCache.get(key);
  if (cached) {
    weeklyReport = cached.report;
    weeklyReportUpdatedAt = cached.updatedAt;
  }
  if (!force && reportCacheIsFresh(cached, mode, date)) {
    if (currentView === "reports") renderReportsView();
    return;
  }
  const requestId = ++weeklyReportRequestId;
  let superseded = false;
  weeklyReportLoading = !background || !cached;
  if (currentView === "reports") renderReportsView();
  if (!background) setStatus(t("reports.loading"));
  try {
    reportDates[mode] = date;
    let operation = reportRequests.get(key);
    if (!operation) {
      operation = { dataRevision: reportDataRevision };
      operation.promise = (mode === "daily"
        ? api.getDailyUsageReport({ date })
        : api.getWeeklyUsageReport({ weekStart: date }))
        .finally(() => {
          if (reportRequests.get(key) === operation) reportRequests.delete(key);
        });
      reportRequests.set(key, operation);
    }
    const next = await operation.promise;
    const updatedAt = Date.now();
    reportCache.set(key, { report: next, updatedAt, dataRevision: operation.dataRevision });
    superseded = reportRangeIncludesToday(mode, date) && operation.dataRevision !== reportDataRevision;
    if (requestId === weeklyReportRequestId && key === reportCacheKey()) {
      weeklyReport = next;
      weeklyReportUpdatedAt = updatedAt;
    }
  } finally {
    if (requestId === weeklyReportRequestId) {
      weeklyReportLoading = false;
      if (currentView === "reports") renderReportsView();
      if (superseded && currentView === "reports" && key === reportCacheKey()) {
        void refreshWeeklyReport({ background: true });
      }
    }
  }
}

function renderReportsView() {
  hideTokenCompositionPopover(true);
  expandedModelDisclosure = undefined;
  reportsNav.title = t("nav.reports");
  reportsView.setAttribute("aria-label", t("reports.title"));
  reportsTitle.textContent = t(reportMode === "daily" ? "reports.dailyTitle" : "reports.weeklyTitle");
  reportsDateLabel.textContent = t(reportMode === "daily" ? "reports.date" : "reports.week");
  reportsModeDaily.setAttribute("aria-pressed", String(reportMode === "daily"));
  reportsModeWeekly.setAttribute("aria-pressed", String(reportMode === "weekly"));
  reportsWeekInput.max = currentReportMaximum(reportMode);
  reportsTodayButton.hidden = reportMode !== "daily";
  reportsSourceNote.textContent = `${t("reports.localOnly")} ${t(reportMode === "daily" ? "reports.dailyBoundary" : "reports.weeklyBoundary")}`;
  reportsFiveCapacity.title = t("reports.observedEstimate");
  reportsWeekCapacity.title = t("reports.observedEstimate");
  reportsRefreshState.textContent = weeklyReportLoading
    ? t("reports.updatingCached", { time: weeklyReportUpdatedAt ? formatBeijingTime(weeklyReportUpdatedAt) : t("labels.unknown") })
    : weeklyReportUpdatedAt
      ? t("reports.lastUpdated", { time: formatBeijingTime(weeklyReportUpdatedAt) })
      : t("reports.notUpdated");
  const headerHelp = ["reports.accountHelp", "reports.accountHelp", "reports.compositionHelp", "reports.accountHelp", "reports.accountHelp"];
  document.querySelectorAll("#reports-account-table th").forEach((cell, index) => { cell.title = t(headerHelp[index]); });
  if (weeklyReportLoading && !weeklyReport) {
    reportsAccountTable.innerHTML = `<tr><td colspan="5">${escapeHtml(t("reports.loading"))}</td></tr>`;
    reportsModelGroups.innerHTML = `<p class="reports-empty">${escapeHtml(t("reports.loading"))}</p>`;
    return;
  }

  const report = weeklyReport;
  const orderedAccounts = report?.source === "local_observation" ? orderReportAccounts(accounts, report.accounts) : [];
  syncReportFilters(report, orderedAccounts);
  const presentation = buildReportPresentation(orderedAccounts, {
    accountId: reportsAccountFilter.value,
    model: reportsModelFilter.value,
    effort: reportsEffortFilter.value,
    confidence: reportsConfidenceFilter.value
  }, report?.confidence);
  const rows = presentation.accounts;
  const attributedTokens = rows.reduce((sum, item) => sum + item.totalTokens, 0);
  const unattributedTokens = report?.coverage?.unattributedTokens ?? report?.unattributed?.totalTokens ?? 0;
  const totalTokens = attributedTokens + unattributedTokens;
  reportsTotalTokens.textContent = formatCompactNumber(totalTokens);
  reportsAttributedTokens.textContent = formatCompactNumber(attributedTokens);
  reportsUnattributedSummary.textContent = formatCompactNumber(unattributedTokens);
  reportsAttributionCoverage.textContent = `${totalTokens ? ((attributedTokens / totalTokens) * 100).toFixed(1) : "0.0"}%`;
  reportsFiveCapacity.textContent = formatCapacity(report?.capacity?.fiveHour);
  reportsWeekCapacity.textContent = formatCapacity(report?.capacity?.oneWeek);
  reportsUnattributed.textContent = formatCompactNumber(report?.unattributed?.totalTokens ?? 0);
  reportsCapacityAccounts.innerHTML = rows.length ? rows.map((account) => `
    <div class="reports-capacity-account"><strong>${formatReportAccountLabel(account)}</strong>${account.hasUsage ? `<span>5h ${formatAccountCapacityEvidence(report?.capacity?.fiveHour, account.accountId)}</span><span>7d ${formatAccountCapacityEvidence(report?.capacity?.oneWeek, account.accountId)}</span>` : `<span>${escapeHtml(t("reports.noUsageInRange"))}</span>`}</div>
  `).join("") : `<p class="reports-empty">${escapeHtml(t(reportMode === "daily" ? "reports.dailyNoData" : "reports.weeklyNoData"))}</p>`;

  if (!rows.length) {
    reportsAccountTable.innerHTML = `<tr><td colspan="5">${escapeHtml(t(reportMode === "daily" ? "reports.dailyNoData" : "reports.weeklyNoData"))}</td></tr>`;
  } else {
    reportsAccountTable.innerHTML = rows.map((account) => `
      <tr class="report-account-row">
        <td data-label="${escapeHtml(t("reports.account"))}"><strong>${formatReportAccountLabel(account)}</strong><small>${escapeHtml(account.planType)}</small></td>
        <td data-label="${escapeHtml(t("reports.attributedTokens"))}">${formatCompactNumber(account.totalTokens)}</td>
        <td data-label="${escapeHtml(t("reports.composition"))}">${account.hasUsage ? formatTokenComposition(account) : escapeHtml(t("reports.noUsageInRange"))}</td>
        <td class="report-usage-overview" data-label="${escapeHtml(t("reports.usageOverview"))}">${account.hasUsage ? `<strong>${Number(account.sharePercent ?? 0).toFixed(1)}%</strong><small>${escapeHtml(t("reports.sessions"))} ${account.sessionCount ?? 0} · ${escapeHtml(t("reports.averageSession"))} ${formatCompactNumber(account.averageTokensPerSession ?? 0)}</small>` : escapeHtml(t("reports.noUsageInRange"))}</td>
        <td data-label="${escapeHtml(t("reports.attributionConfidence"))}">${account.hasUsage ? escapeHtml(t(account.attributionConfidence === "medium" ? "reports.confidenceMedium" : "reports.confidenceHigh")) : "—"}</td>
      </tr>
    `).join("");
  }

  const modelRows = presentation.modelRows;
  reportsModelGroups.innerHTML = modelRows.length ? modelRows.map(({ account, model, reasoning }, index) => `
    <div class="report-model-item">
      <div class="report-model-row">
        <span class="report-model-account" data-label="${escapeHtml(t("reports.account"))}">${formatReportAccountLabel(account)}</span>
        <strong class="report-model-name" data-label="${escapeHtml(t("reports.model"))}">${escapeHtml(model.model)}</strong>
        <span class="report-model-effort" data-label="${escapeHtml(t("reports.effort"))}">${escapeHtml(reasoning.reasoningEffort)}</span>
        <strong class="report-model-tokens" data-label="${escapeHtml(t("reports.attributedTokens"))}">${formatCompactNumber(reasoning.totalTokens)}</strong>
        <span class="report-model-composition" data-label="${escapeHtml(t("reports.composition"))}">${formatTokenComposition(reasoning)}</span>
        <button class="model-disclosure-button" type="button" aria-expanded="false" aria-controls="model-evidence-${index}" title="${escapeHtml(t("reports.expandEvidence"))}"></button>
      </div>
      <div id="model-evidence-${index}" class="model-evidence-panel" hidden>
        ${formatTokenCompositionDetails(reasoning)}
        <div class="model-capacity-evidence">${formatDimensionCapacity(report?.capacity, model.model, reasoning.reasoningEffort)}</div>
      </div>
    </div>
  `).join("") : `<p class="reports-empty">${escapeHtml(t(reportMode === "daily" ? "reports.dailyNoData" : "reports.weeklyNoData"))}</p>`;
  applyTokenCompositionBars();

  reportsResetHistory.innerHTML = report?.resets?.length ? report.resets.map((reset) => `
    <div class="report-event-row">
      <strong>${escapeHtml(reset.emailMasked)}</strong>
      <span>${escapeHtml(reset.window === "fiveHour" ? "5h" : "7d")}</span>
      <strong>${escapeHtml(reset.cause === "reset_card" ? t("reports.resetCard") : reset.kind === "scheduled" ? t("reports.scheduledReset") : t("reports.observedUnscheduled"))}</strong>
      <time>${escapeHtml(t("reports.detectedAt"))} ${escapeHtml(formatBeijingTime(reset.atMs))}</time>
    </div>
  `).join("") : `<p class="reports-empty">${escapeHtml(t(reportMode === "daily" ? "reports.dailyNoData" : "reports.weeklyNoData"))}</p>`;
}

function setReportMode(mode) {
  if (mode === reportMode) return;
  reportDates[reportMode] = reportsWeekInput.value;
  reportMode = mode;
  reportsWeekInput.value = reportDates[mode];
  reportsWeekInput.max = currentReportMaximum(reportMode);
  weeklyReport = undefined;
  weeklyReportUpdatedAt = undefined;
  hydrateReportCache();
  renderReportsView();
  void refreshWeeklyReport({ background: true });
}

function currentReportMaximum(mode) {
  const date = new Date(mode === "weekly" ? previousBeijingWeekStart() : beijingDayStart());
  return localDateInputValue(date);
}

function syncReportFilters(report, orderedAccounts) {
  const accountOptions = orderedAccounts.map((item) => ({ value: item.accountId, label: item.emailMasked }));
  const models = [...new Set((report?.accounts ?? []).flatMap((account) => account.models.map((model) => model.model)))].sort();
  const efforts = [...new Set((report?.accounts ?? []).flatMap((account) => account.models.flatMap((model) => model.reasoning.map((item) => item.reasoningEffort))))].sort();
  populateReportFilter(reportsAccountFilter, accountOptions, t("reports.all"));
  populateReportFilter(reportsModelFilter, models, t("reports.all"));
  populateReportFilter(reportsEffortFilter, efforts, t("reports.all"));
  populateReportFilter(reportsConfidenceFilter, ["high", "medium", "low", "insufficient"], t("reports.all"));
}

function populateReportFilter(select, values, allLabel) {
  const selected = select.value;
  const normalized = values.map((item) => typeof item === "string" ? { value: item, label: item } : item);
  select.replaceChildren(new Option(allLabel, ""), ...normalized.map((item) => new Option(item.label, item.value)));
  select.value = normalized.some((item) => item.value === selected) ? selected : "";
}

function formatReportAccountLabel(account) {
  return `${escapeHtml(account.emailMasked)}${account.isCurrent ? ` <span class="report-current-label">${escapeHtml(t("labels.current"))}</span>` : ""}`;
}

function formatCapacity(summary) {
  if (!summary?.count) return t("labels.unknown");
  const value = summary.median ?? summary.mean ?? summary.samples?.[0]?.estimatedTokens;
  return `${formatCompactNumber(value)} · ${t("reports.samples", { count: summary.count })}`;
}

function formatAccountCapacity(summary, accountId) {
  const values = (summary?.samples ?? []).filter((item) => item.accountId === accountId).map((item) => item.estimatedTokens).sort((left, right) => left - right);
  if (!values.length) return t("labels.unknown");
  const middle = values.length % 2 ? values[(values.length - 1) / 2] : Math.round((values[values.length / 2 - 1] + values[values.length / 2]) / 2);
  return formatCompactNumber(middle);
}

function formatAccountCapacityEvidence(summary, accountId) {
  const values = (summary?.samples ?? []).filter((item) => item.accountId === accountId).map((item) => item.estimatedTokens).sort((left, right) => left - right);
  if (!values.length) return t("labels.unknown");
  const representative = formatAccountCapacity(summary, accountId);
  return `${t("reports.representative")} ${representative} · ${t("reports.range")} ${formatCompactNumber(values[0])}-${formatCompactNumber(values.at(-1))} · ${t("reports.sampleCount")} ${values.length} · ${formatConfidence(summary.confidence)}`;
}

function formatTokenComposition(usage) {
  const segments = tokenCompositionSegments(usage);
  const total = segments.reduce((sum, item) => sum + item[1], 0) || 1;
  const bars = segments.map(([key, value, label]) => `<span class="token-segment-${key}" data-weight="${value / total}" title="${escapeHtml(label)} ${formatCompactNumber(value)}"></span>`).join("");
  const values = segments.map(([, value]) => value).join(",");
  return `<button class="token-composition-trigger" type="button" aria-expanded="false" aria-label="${escapeHtml(t("reports.compositionAria"))}" data-values="${values}"><span class="token-composition-bar" aria-hidden="true">${bars}</span></button>`;
}

function tokenCompositionSegments(usage) {
  const nonCachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return [
    ["input", nonCachedInput, t("reports.nonCachedInput")],
    ["cached", usage.cachedInputTokens, t("reports.cachedInput")],
    ["output", usage.outputTokens, t("reports.output")],
    ["reasoning", usage.reasoningOutputTokens, t("reports.reasoning")]
  ];
}

function formatTokenCompositionDetails(usage) {
  return compositionDetailsMarkup(tokenCompositionSegments(usage));
}

function compositionDetailsMarkup(segments) {
  const total = segments.reduce((sum, item) => sum + item[1], 0) || 1;
  return `<div class="composition-detail-list">${segments.map(([key, value, label]) => `
    <div><span class="composition-swatch token-segment-${key}"></span><span>${escapeHtml(label)}</span><strong>${formatCompactNumber(value)}</strong><span>${((value / total) * 100).toFixed(1)}%</span></div>
  `).join("")}</div><p>${escapeHtml(t("reports.localAggregate"))}</p>`;
}

function applyTokenCompositionBars() {
  document.querySelectorAll(".token-composition-bar [data-weight]").forEach((segment) => {
    segment.style.flex = `${Number(segment.dataset.weight) || 0} 0 0`;
  });
}

function showTokenCompositionPopover(trigger, pinned = false) {
  const values = String(trigger.dataset.values ?? "").split(",").map(Number);
  const labels = [t("reports.nonCachedInput"), t("reports.cachedInput"), t("reports.output"), t("reports.reasoning")];
  const keys = ["input", "cached", "output", "reasoning"];
  const segments = keys.map((key, index) => [key, Number.isFinite(values[index]) ? values[index] : 0, labels[index]]);
  const total = segments.reduce((sum, item) => sum + item[1], 0) || 1;
  const stops = [];
  let cursor = 0;
  const colors = ["#2878b5", "#19a07b", "#d18a16", "#8a63b8"];
  segments.forEach(([, value], index) => {
    const end = cursor + (value / total) * 100;
    stops.push(`${colors[index]} ${cursor}% ${end}%`);
    cursor = end;
  });
  tokenCompositionPopoverBody.innerHTML = `<div class="composition-popover-header"><div class="composition-donut" aria-hidden="true"></div><strong>${escapeHtml(t("reports.compositionTitle"))}</strong></div>${compositionDetailsMarkup(segments)}`;
  tokenCompositionPopoverBody.querySelector(".composition-donut").style.background = `conic-gradient(${stops.join(",")})`;
  tokenCompositionPopover.hidden = false;
  positionTokenCompositionPopover(trigger);
  compositionPreviewTrigger = trigger;
  if (pinned) compositionPinnedTrigger = trigger;
  trigger.setAttribute("aria-expanded", "true");
}

function hideTokenCompositionPopover(force = false) {
  if (compositionPinnedTrigger && !force) return;
  document.querySelectorAll(".token-composition-trigger[aria-expanded='true']").forEach((item) => item.setAttribute("aria-expanded", "false"));
  tokenCompositionPopover.hidden = true;
  compositionPreviewTrigger = undefined;
  if (force) compositionPinnedTrigger = undefined;
}

function positionTokenCompositionPopover(trigger) {
  const anchor = trigger.getBoundingClientRect();
  const width = Math.min(340, window.innerWidth - 24);
  tokenCompositionPopover.style.width = `${width}px`;
  const height = tokenCompositionPopover.offsetHeight;
  const left = Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12));
  const preferredTop = anchor.bottom + 8;
  const candidateTop = preferredTop + height <= window.innerHeight - 12 ? preferredTop : anchor.top - height - 8;
  const top = Math.max(12, Math.min(candidateTop, window.innerHeight - height - 12));
  tokenCompositionPopover.style.left = `${left}px`;
  tokenCompositionPopover.style.top = `${top}px`;
}

function formatExpectedResets(value = {}) {
  const five = value.fiveHour ? formatBeijingTime(value.fiveHour) : t("labels.unknown");
  const week = value.oneWeek ? formatBeijingTime(value.oneWeek) : t("labels.unknown");
  return `${t("reports.expectedReset")} 5h ${five} · 7d ${week}`;
}

function formatConfidence(value) {
  return t(value === "high" ? "reports.confidenceHigh" : value === "medium" ? "reports.confidenceMedium" : "labels.unknown");
}

function formatQuotaRates(account) {
  const five = Number.isFinite(account.fiveHourQuotaRatePerHour) ? `${account.fiveHourQuotaRatePerHour}%` : "?";
  const week = Number.isFinite(account.oneWeekQuotaRatePerHour) ? `${account.oneWeekQuotaRatePerHour}%` : "?";
  return `5h ${five} · 7d ${week}`;
}

function formatDuration(durationMs) {
  if (!durationMs) return t("labels.unknown");
  const hours = durationMs / 3_600_000;
  return currentLanguage() === "en" ? `${hours.toFixed(1)} observed hours` : `${hours.toFixed(1)} 观测小时`;
}

function formatDimensionCapacity(capacity, model, reasoningEffort) {
  const five = capacity?.fiveHour?.groups?.find((item) => item.model === model && item.reasoningEffort === reasoningEffort);
  const week = capacity?.oneWeek?.groups?.find((item) => item.model === model && item.reasoningEffort === reasoningEffort);
  const evidence = (summary) => summary
    ? `${t("reports.representative")} ${formatCompactNumber(summary.median)} · ${t("reports.range")} ${formatCompactNumber(summary.min)}-${formatCompactNumber(summary.max)} · ${t("reports.sampleCount")} ${summary.count}`
    : t("labels.unknown");
  const fiveText = evidence(five);
  const weekText = evidence(week);
  return `5h ${fiveText} · 7d ${weekText}`;
}

function clearActivityDiagnostics() {
  activityDiagnostics.hidden = true;
  activityDiagnostics.open = false;
  activityDiagnosticIds.textContent = "";
}

function setStatus(message, { preserveActivityDiagnostics = false } = {}) {
  if (statusLine.textContent !== message) statusLine.textContent = message;
  if (!preserveActivityDiagnostics) clearActivityDiagnostics();
}

function showActivityDiagnostics(activeThreadIds = [], processRegistryState, processRegistryDiagnostic) {
  const ids = activeThreadIds.filter((id) => typeof id === "string" && id);
  processRegistryState ??= processRegistryDiagnostic?.state;
  const reasonKey = {
    all_zero: "status.processRegistryReasonAllZero",
    malformed_json: "status.processRegistryReasonMalformedJson",
    not_found: "status.processRegistryReasonNotFound",
    unreadable: "status.processRegistryReasonUnreadable",
    unstable: "status.processRegistryReasonUnstable"
  }[processRegistryDiagnostic?.reason];
  const registryStateWarning = ["missing", "corrupt"].includes(processRegistryState)
    ? [
        t("status.processRegistryCorrupt", {
          state: t(processRegistryState === "missing" ? "status.processRegistryStateMissing" : "status.processRegistryStateCorrupt")
        }),
        reasonKey ? t(reasonKey) : "",
        Number.isFinite(processRegistryDiagnostic?.lastWriteMs)
          ? t("status.processRegistryLastWrite", { time: formatBeijingTime(processRegistryDiagnostic.lastWriteMs) })
          : "",
        processRegistryDiagnostic?.predatesAppServerStart === true
          && Number.isFinite(processRegistryDiagnostic?.latestOfficialAppServerStartMs)
          ? t("status.processRegistryPredatesCodexStart", {
              time: formatBeijingTime(processRegistryDiagnostic.latestOfficialAppServerStartMs)
            })
          : ""
      ].filter(Boolean).join("\n")
    : "";
  const staleRegistryWarning = Number.isInteger(processRegistryDiagnostic?.ignoredStaleTaskCount)
    && processRegistryDiagnostic.ignoredStaleTaskCount > 0
    ? t("status.processRegistryIgnoredStale", {
        count: processRegistryDiagnostic.ignoredStaleTaskCount,
        time: Number.isFinite(processRegistryDiagnostic.oldestStaleEvidenceAtMs)
          ? formatBeijingTime(processRegistryDiagnostic.oldestStaleEvidenceAtMs)
          : t("labels.unknown")
      })
    : "";
  const registryWarning = [registryStateWarning, staleRegistryWarning].filter(Boolean).join("\n");
  if (ids.length === 0 && !registryWarning) {
    clearActivityDiagnostics();
    return;
  }
  activityDiagnostics.hidden = false;
  activityDiagnosticIds.textContent = [registryWarning, ...ids].filter(Boolean).join("\n");
}

function stopAndRun(fn) {
  return (event) => {
    event.stopPropagation();
    return runAction(fn)(event);
  };
}

function runAction(fn) {
  return async (event) => {
    try {
      document.body.classList.add("busy");
      setStatus(t("status.processing"));
      await fn(event);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      document.body.classList.remove("busy");
    }
  };
}

function addAccountMessage(result) {
  const closed = result.closedCodexProcesses ?? 0;
  const launch = switchLaunchMessage(result);
  const warning = result.transportWarning ? ` ${t("status.transportWarning", { error: result.transportWarning })}` : "";
  return `${t("status.addAccount", { count: closed, launch })}${warning}`;
}

function runRefreshAction(fn) {
  return async (event) => {
    refreshAllButton.disabled = true;
    try {
      setStatus(t("status.processing"));
      await fn(event);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      refreshAllButton.disabled = false;
    }
  };
}

function lowestRemaining(account) {
  const quota = quotaDisplayState(account);
  const values = [quota.fiveHour, quota.oneWeek]
    .filter(Boolean)
    .map((window) => window.remainingPercent);
  return values.length > 0 ? Math.min(...values) : undefined;
}

function hasFreshUsableUsage(account) {
  return quotaDisplayState(account).current;
}

function hasCompleteCurrentQuota(account) {
  const quota = quotaDisplayState(account);
  return Boolean(quota.current && quota.fiveHour && quota.oneWeek);
}

function refreshSummary(results, successMessage) {
  const summary = classifyRefreshResults(results);
  const skippedResults = Array.isArray(results)
    ? results.filter((result) => result?.skipped === true || result?.attempted === false)
    : [];
  const authSkipped = skippedResults.filter((result) => result?.skipReason === "usage_auth_expired").length;
  const cached = skippedResults.filter((result) => result?.skipReason === "fresh_cache").length;
  let message;
  if (summary.failures === 0) {
    message = successMessage;
  } else if (summary.authExpiredFailures > 0 && summary.otherFailures === 0) {
    message = t("status.refreshAuthExpired", { message: successMessage, count: summary.authExpiredFailures });
  } else if (summary.authExpiredFailures > 0) {
    message = t("status.refreshMixedFailures", {
      message: successMessage,
      count: summary.failures,
      authExpiredCount: summary.authExpiredFailures
    });
  } else {
    message = t("status.refreshFailures", { message: successMessage, count: summary.failures });
  }
  if (cached > 0) message = t("status.refreshCached", { message, count: cached });
  return authSkipped > 0 ? t("status.refreshSkipped", { message, count: authSkipped }) : message;
}

function initials(account) {
  const source = String(account.emailMasked || account.accountId || "CS").replace(/@.*$/, "");
  const parts = source.split(/[\s._*-]+/).filter(Boolean);
  return `${parts[0]?.[0] ?? "C"}${parts[1]?.[0] ?? parts[0]?.[1] ?? "S"}`.toUpperCase();
}

function normalizePlan(plan) {
  const normalized = String(plan || "").trim().toLowerCase();
  if (!normalized || normalized === "unknown") return t("labels.planUnknown");
  return normalized.toUpperCase();
}

function planClass(plan) {
  const normalized = String(plan || "").trim().toUpperCase();
  if (normalized === "PLUS") return "plus-plan";
  if (normalized === "PRO") return "pro-plan";
  if (normalized === "FREE") return "free-plan";
  if (!normalized || normalized === "UNKNOWN") return "unknown-plan";
  return "team-plan";
}

function shortId(value) {
  const text = String(value || "");
  return text.length > 18 ? `${text.slice(0, 8)}...${text.slice(-6)}` : text;
}

function statusLabel(status) {
  if (status === "ready") return t("statusLabel.ready");
  if (status === "usage_failed") return t("statusLabel.usage_failed");
  if (status === "usage_auth_expired") return t("statusLabel.usage_auth_expired");
  return String(status || t("labels.unknown"));
}

function fallbackReasonLabel(reason) {
  return t(`fallback.${reason}`);
}

function formatTime(unixSeconds) {
  return unixSeconds ? formatBeijingTime(unixSeconds * 1000) : t("labels.unknown");
}

function formatSnapshotAge(unixSeconds) {
  if (!unixSeconds) return t("labels.unknown");
  const minutes = Math.max(0, Math.floor((Date.now() / 1000 - unixSeconds) / 60));
  return minutes < 1 ? (currentLanguage() === "en" ? "under 1 minute" : "不到 1 分钟") : (currentLanguage() === "en" ? `${minutes} minutes` : `${minutes} 分钟`);
}

function isFreshQuotaSnapshot(account) {
  return quotaDisplayState(account).current;
}

function applyTranslations() {
  document.documentElement.lang = currentLanguage();
  translateTree(document);
  replacementConfirm.textContent = t("modal.continue");
  renderTransportDiagnostics(latestTransportDiagnostics);
  if (recoveryBackups) renderRecoveryBackupOptions();
  if (latestRecoveryPreview) renderRecoveryPreview(latestRecoveryPreview);
  if (conversationBackupProgress) renderConversationBackupProgress();
}

function translateTree(root) {
  for (const node of root.querySelectorAll("[data-i18n]")) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of root.querySelectorAll("[data-i18n-placeholder]")) {
    node.placeholder = t(node.dataset.i18nPlaceholder);
  }
  for (const node of root.querySelectorAll("[data-i18n-title]")) {
    node.title = t(node.dataset.i18nTitle);
  }
  for (const node of root.querySelectorAll("[data-i18n-aria-label]")) {
    node.setAttribute("aria-label", t(node.dataset.i18nAriaLabel));
  }
}

function currentLanguage() {
  return settings.uiLanguage === "en" ? "en" : "zh-CN";
}

function t(key, values = {}) {
  const table = messages[currentLanguage()] ?? messages["zh-CN"];
  const fallback = messages["zh-CN"][key] ?? key;
  return String(table[key] ?? fallback).replace(/\{(\w+)\}/g, (_match, name) => values[name] ?? "");
}

function errorMessage(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, "")
    .trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
