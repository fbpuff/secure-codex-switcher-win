const api = window.codexSwitcher;

const accountsEl = document.querySelector("#accounts");
const detailEl = document.querySelector("#detail");
const statusLine = document.querySelector("#status-line");
const quotaWarningLine = document.querySelector("#quota-warning-line");
const template = document.querySelector("#account-template");
const autoSwitchInput = document.querySelector("#auto-switch");
const lowQuotaWarningInput = document.querySelector("#low-quota-warning");
const searchInput = document.querySelector("#account-search");
const resultCount = document.querySelector("#result-count");
const metricTotal = document.querySelector("#metric-total");
const metricCurrent = document.querySelector("#metric-current");
const metricBest = document.querySelector("#metric-best");
const replacementDialog = document.querySelector("#replacement-dialog");
const replacementSelect = document.querySelector("#replacement-select");
const replacementField = document.querySelector("#replacement-field");
const replacementConfirm = document.querySelector("#replacement-confirm");
const languageSelect = document.querySelector("#language-select");
const accountsNav = document.querySelector("#accounts-nav");
const settingsNav = document.querySelector("#settings-nav");
const accountsView = document.querySelector("#accounts-view");
const accountsTopbar = document.querySelector("#accounts-topbar");
const metricsStrip = document.querySelector("#metrics-strip");
const accountsWorkspace = document.querySelector("#accounts-workspace");
const settingsView = document.querySelector("#settings-view");
const settingsLanguage = document.querySelector("#settings-language");
const settingsAutoSwitch = document.querySelector("#settings-auto-switch");
const settingsLowQuotaWarning = document.querySelector("#settings-low-quota-warning");
const settingsRequireSwitchConfirmation = document.querySelector("#settings-require-switch-confirmation");
const settingsRefreshInterval = document.querySelector("#settings-refresh-interval");
const settingsHttpOnly = document.querySelector("#settings-http-only");
const settingsThemeInputs = document.querySelectorAll('input[name="settings-theme"]');
const settingsOpenFolder = document.querySelector("#settings-open-folder");
const settingsQuitApp = document.querySelector("#settings-quit-app");
const closeDialog = document.querySelector("#close-dialog");
const closeRemember = document.querySelector("#close-remember");

const messages = {
  "zh-CN": {
    "brand.subtitle": "Windows Local",
    "nav.accounts": "账号",
    "nav.settings": "设置",
    "rail.dpapi": "DPAPI protected",
    "top.eyebrow": "本机账号保险箱",
    "top.title": "账号余量与切换",
    "top.language": "语言",
    "actions.importCurrent": "导入/新增当前",
    "actions.refreshAll": "刷新全部",
    "actions.bestAccount": "最佳账号",
    "actions.switch": "切换",
    "actions.refresh": "刷新",
    "actions.delete": "删除",
    "actions.cancel": "取消",
    "metrics.total": "账号数",
    "metrics.current": "当前账号",
    "metrics.best": "最佳账号分数",
    "toggles.autoSwitch": "用尽后自动切换",
    "toggles.lowWarning": "低余量提醒",
    "search.placeholder": "搜索账号、计划、状态",
    "modal.deleteCurrentTitle": "删除当前账号",
    "modal.deleteCurrentIntro": "删除当前账号前，先选择接下来要让官方 Codex 使用哪个登录态。",
    "modal.switchExisting": "切换已有账号",
    "modal.switchExistingHelp": "关闭官方 Codex，写入已保存账号，然后自动重新打开。",
    "modal.loginNew": "登录新账号",
    "modal.loginNewHelp": "关闭官方 Codex，移除当前 auth.json，然后打开官方 Codex 登录。",
    "modal.replacement": "替代账号",
    "settings.eyebrow": "基础行为",
    "settings.title": "设置",
    "settings.subtitle": "调整语言、余量刷新、切换确认和关闭窗口行为。",
    "settings.accountManagement": "账号管理",
    "settings.autoSwitch": "用尽后自动切换",
    "settings.autoSwitchHelp": "当前账号余量耗尽时自动选择可用账号。",
    "settings.confirmSwitch": "切换确认",
    "settings.confirmSwitchHelp": "手动切换账号前先确认。",
    "settings.lowWarning": "低余量提醒",
    "settings.lowWarningHelp": "低于阈值时在账号页显示红色提醒。",
    "settings.refreshTitle": "余量刷新",
    "settings.refreshInterval": "自动刷新间隔",
    "settings.minutes": "分钟",
    "settings.refreshHelp": "修改后立即生效，手动刷新不受影响。",
    "settings.networkTitle": "网络连接",
    "settings.httpOnly": "HTTP-only 模式",
    "settings.httpOnlyHelp": "通过 HTTPS/SSE 连接并迁移历史会话标记，避免代理环境下 WebSocket 反复重连。修改时会关闭 Codex，完成后按原状态重新打开。",
    "settings.interfaceTitle": "界面",
    "settings.language": "语言",
    "settings.theme": "颜色主题",
    "settings.themeSystem": "跟随系统设置",
    "settings.themeLight": "亮色",
    "settings.themeDark": "暗色",
    "settings.closeBehavior": "关闭窗口行为",
    "settings.closeAsk": "每次询问",
    "settings.closeMinimize": "最小化窗口",
    "settings.closeQuit": "关闭应用",
    "settings.appTitle": "应用",
    "settings.appHelp": "管理本地文件入口和应用退出。",
    "settings.quitApp": "退出应用",
    "settings.codexTitle": ".codex 文件夹",
    "settings.codexHelp": "打开官方 Codex auth.json 所在目录。",
    "settings.openCodexFolder": "打开 .codex",
    "close.title": "关闭 Codex Switcher？",
    "close.intro": "选择最小化到任务栏，或直接关闭应用。",
    "close.remember": "以后均保持此操作",
    "close.minimize": "最小化窗口",
    "close.quit": "关闭应用",
    "status.ready": "准备就绪",
    "status.processing": "处理中...",
    "status.importedRefreshed": "已导入当前账号，并刷新了余量",
    "status.importedRefreshFailed": "已导入当前账号；余量刷新失败：{error}",
    "status.usageRefreshDone": "余量刷新完成",
    "status.noCandidate": "没有可用的候选账号",
    "status.bestAccount": "最佳账号：{email}，分数 {score}",
    "status.autoSwitchOn": "已开启自动切换",
    "status.autoSwitchOff": "已关闭自动切换",
    "status.lowWarningOn": "已开启低余量提醒",
    "status.lowWarningOff": "已关闭低余量提醒",
    "status.switchConfirmOn": "已开启切换确认",
    "status.switchConfirmOff": "已关闭切换确认",
    "status.refreshIntervalSaved": "余量自动刷新间隔已更新",
    "status.httpOnlyOn": "已启用 HTTP-only，并迁移 {rollouts} 个会话、{threads} 条索引。{launch}",
    "status.httpOnlyOff": "已恢复默认网络传输，并还原 {rollouts} 个会话、{threads} 条索引。{launch}",
    "status.closeBehaviorSaved": "关闭窗口行为已保存",
    "status.themeSaved": "颜色主题已保存",
    "status.settingsSaved": "设置已保存",
    "status.languageSaved": "语言已切换为中文",
    "status.backgroundUpdated": "后台余量已更新",
    "status.backgroundFailed": "后台余量刷新失败：{error}",
    "status.exhaustedNoTarget": "当前账号已用尽，但没有可切换账号",
    "status.autoSwitched": "当前账号已用尽，已自动切换到 {email}，并关闭 {count} 个 Codex 进程。",
    "status.accountUsageRefreshed": "账号余量已刷新",
    "status.switched": "账号已切换到 {email}",
    "status.currentDeletedSwitched": "当前账号已删除，并切换到 {email}",
    "status.deletedUnaffected": "账号已删除。官方 Codex 未受影响。",
    "status.currentAlready": "{prefix}。该账号已经是当前账号，未重启官方 Codex。",
    "status.switchResult": "{prefix}，并关闭 {count} 个 Codex 进程。{launch}",
    "status.launchOk": "已自动打开官方 Codex。",
    "status.launchFailed": "未能自动打开官方 Codex，请手动打开。",
    "status.transportWarning": "HTTP-only 配置校验失败：{error}",
    "status.loginNew": "当前账号已删除，并关闭 {count} 个 Codex 进程。{launch}请在官方 Codex 完成新账号登录，然后回到这里点击“导入/新增当前”。",
    "status.refreshFailures": "{message}，{count} 个账号刷新失败",
    "quota.empty": "当前账号余量已用尽，建议切换账号；如果已开启自动切换，应用会选择可用账号并关闭官方 Codex。",
    "quota.low": "当前账号余量只剩 {remaining}%，建议切换账号。",
    "empty.noAccounts": "还没有账号",
    "empty.noMatches": "没有匹配账号",
    "empty.noAccountsHelp": "先导入当前 Codex auth.json。",
    "empty.noMatchesHelp": "换一个关键词再试。",
    "detail.selectAccount": "选择一个账号",
    "detail.selectHelp": "账号详情、余量窗口和切换操作会显示在这里。",
    "detail.fingerprint": "账号指纹 {id}",
    "detail.usage": "余量",
    "detail.fiveHour": "5 小时窗口",
    "detail.oneWeek": "7 天窗口",
    "detail.used": "已用 {used}",
    "detail.resetTime": "重置时间",
    "detail.localStatus": "本地状态",
    "detail.status": "状态：{value}",
    "detail.created": "添加：{value}",
    "detail.updated": "更新：{value}",
    "detail.actions": "操作",
    "detail.switchTo": "切换到此账号",
    "labels.none": "无",
    "labels.unknown": "未知",
    "labels.planUnknown": "计划未知",
    "labels.current": "当前",
    "labels.switchable": "可切换",
    "labels.candidate": "候选",
    "labels.localRecord": "本机记录 {id}",
    "statusLabel.ready": "可用",
    "statusLabel.usage_failed": "余量刷新失败",
    "statusLabel.needs_login": "登录态待刷新",
    "confirm.switch": "切换到 {email}？\n\n切换时会自动关闭正在运行的官方 Codex，并尝试自动重新打开。",
    "confirm.delete": "删除 {email} 的本地加密记录？\n\n该账号不是当前账号，不会关闭官方 Codex。",
    "confirm.httpOnly": "修改网络传输模式会完全关闭官方 Codex，并迁移历史会话标记。完成后会按原状态重新打开。\n\n继续吗？",
    "modal.deleteSwitch": "删除并切换",
    "modal.deleteLogin": "删除并登录新账号",
    "modal.continue": "继续"
  },
  en: {
    "brand.subtitle": "Windows Local",
    "nav.accounts": "Accounts",
    "nav.settings": "Settings",
    "rail.dpapi": "DPAPI protected",
    "top.eyebrow": "Local account vault",
    "top.title": "Usage & Switching",
    "top.language": "Language",
    "actions.importCurrent": "Import/Add Current",
    "actions.refreshAll": "Refresh All",
    "actions.bestAccount": "Best Account",
    "actions.switch": "Switch",
    "actions.refresh": "Refresh",
    "actions.delete": "Delete",
    "actions.cancel": "Cancel",
    "metrics.total": "Accounts",
    "metrics.current": "Current",
    "metrics.best": "Best Score",
    "toggles.autoSwitch": "Auto-switch on empty",
    "toggles.lowWarning": "Low-quota warning",
    "search.placeholder": "Search account, plan, status",
    "modal.deleteCurrentTitle": "Delete Current",
    "modal.deleteCurrentIntro": "Choose which login state official Codex should use next.",
    "modal.switchExisting": "Switch to saved account",
    "modal.switchExistingHelp": "Close official Codex, write a saved account, then reopen it.",
    "modal.loginNew": "Log in to new account",
    "modal.loginNewHelp": "Close official Codex, remove auth.json, then open official Codex for login.",
    "modal.replacement": "Replacement account",
    "settings.eyebrow": "Basic behavior",
    "settings.title": "Settings",
    "settings.subtitle": "Adjust language, usage refresh, switch confirmation, and window close behavior.",
    "settings.accountManagement": "Account Management",
    "settings.autoSwitch": "Auto-switch on empty",
    "settings.autoSwitchHelp": "Choose an available account when the current account is exhausted.",
    "settings.confirmSwitch": "Switch confirmation",
    "settings.confirmSwitchHelp": "Confirm before manually switching accounts.",
    "settings.lowWarning": "Low-quota warning",
    "settings.lowWarningHelp": "Show a red warning on the account page below the threshold.",
    "settings.refreshTitle": "Usage Refresh",
    "settings.refreshInterval": "Auto-refresh interval",
    "settings.minutes": "minutes",
    "settings.refreshHelp": "Changes apply immediately. Manual refresh is unaffected.",
    "settings.networkTitle": "Network",
    "settings.httpOnly": "HTTP-only mode",
    "settings.httpOnlyHelp": "Use HTTPS/SSE and migrate history provider tags to avoid repeated WebSocket reconnects behind proxies. Codex closes during the change and reopens if it was running.",
    "settings.interfaceTitle": "Interface",
    "settings.language": "Language",
    "settings.theme": "Color theme",
    "settings.themeSystem": "Follow system",
    "settings.themeLight": "Light",
    "settings.themeDark": "Dark",
    "settings.closeBehavior": "Window close behavior",
    "settings.closeAsk": "Ask every time",
    "settings.closeMinimize": "Minimize window",
    "settings.closeQuit": "Quit app",
    "settings.appTitle": "App",
    "settings.appHelp": "Manage local file access and app exit.",
    "settings.quitApp": "Quit App",
    "settings.codexTitle": ".codex Folder",
    "settings.codexHelp": "Open the folder where official Codex stores auth.json.",
    "settings.openCodexFolder": "Open .codex",
    "close.title": "Close Codex Switcher?",
    "close.intro": "Choose whether to minimize to the taskbar or quit the app.",
    "close.remember": "Always use this action",
    "close.minimize": "Minimize Window",
    "close.quit": "Quit App",
    "status.ready": "Ready",
    "status.processing": "Working...",
    "status.importedRefreshed": "Imported the current account and refreshed usage",
    "status.importedRefreshFailed": "Imported the current account; usage refresh failed: {error}",
    "status.usageRefreshDone": "Usage refresh completed",
    "status.noCandidate": "No usable candidate account",
    "status.bestAccount": "Best account: {email}, score {score}",
    "status.autoSwitchOn": "Auto-switch enabled",
    "status.autoSwitchOff": "Auto-switch disabled",
    "status.lowWarningOn": "Low-quota warning enabled",
    "status.lowWarningOff": "Low-quota warning disabled",
    "status.switchConfirmOn": "Switch confirmation enabled",
    "status.switchConfirmOff": "Switch confirmation disabled",
    "status.refreshIntervalSaved": "Usage auto-refresh interval updated",
    "status.httpOnlyOn": "HTTP-only enabled; migrated {rollouts} sessions and {threads} index rows. {launch}",
    "status.httpOnlyOff": "Default transport restored; reverted {rollouts} sessions and {threads} index rows. {launch}",
    "status.closeBehaviorSaved": "Window close behavior saved",
    "status.themeSaved": "Color theme saved",
    "status.settingsSaved": "Settings saved",
    "status.languageSaved": "Language switched to English",
    "status.backgroundUpdated": "Background usage updated",
    "status.backgroundFailed": "Background usage refresh failed: {error}",
    "status.exhaustedNoTarget": "Current account is exhausted, but no switch target is available",
    "status.autoSwitched": "Current account is exhausted; switched to {email} and closed {count} Codex processes.",
    "status.accountUsageRefreshed": "Account usage refreshed",
    "status.switched": "Switched to {email}",
    "status.currentDeletedSwitched": "Current account deleted and switched to {email}",
    "status.deletedUnaffected": "Account deleted. Official Codex was not affected.",
    "status.currentAlready": "{prefix}. This account is already current; official Codex was not restarted.",
    "status.switchResult": "{prefix}, and closed {count} Codex processes. {launch}",
    "status.launchOk": "Official Codex was reopened.",
    "status.launchFailed": "Could not reopen official Codex; please open it manually.",
    "status.transportWarning": "HTTP-only configuration check failed: {error}",
    "status.loginNew": "Current account deleted and {count} Codex processes were closed. {launch}Finish login in official Codex, then return here and click Import/Add Current.",
    "status.refreshFailures": "{message}, {count} accounts failed",
    "quota.empty": "The current account is exhausted. Switch accounts; if auto-switch is enabled, the app will choose a usable account and close official Codex.",
    "quota.low": "Current account has only {remaining}% remaining. Consider switching.",
    "empty.noAccounts": "No accounts yet",
    "empty.noMatches": "No matching accounts",
    "empty.noAccountsHelp": "Import the current Codex auth.json first.",
    "empty.noMatchesHelp": "Try another keyword.",
    "detail.selectAccount": "Select an account",
    "detail.selectHelp": "Account details, usage windows, and switch actions appear here.",
    "detail.fingerprint": "Account fingerprint {id}",
    "detail.usage": "Usage",
    "detail.fiveHour": "5-hour window",
    "detail.oneWeek": "7-day window",
    "detail.used": "Used {used}",
    "detail.resetTime": "Reset time",
    "detail.localStatus": "Local status",
    "detail.status": "Status: {value}",
    "detail.created": "Added: {value}",
    "detail.updated": "Updated: {value}",
    "detail.actions": "Actions",
    "detail.switchTo": "Switch to this account",
    "labels.none": "None",
    "labels.unknown": "Unknown",
    "labels.planUnknown": "Plan unknown",
    "labels.current": "Current",
    "labels.switchable": "Switchable",
    "labels.candidate": "Candidate",
    "labels.localRecord": "Local record {id}",
    "statusLabel.ready": "Ready",
    "statusLabel.usage_failed": "Usage refresh failed",
    "statusLabel.needs_login": "Login state needs refresh",
    "confirm.switch": "Switch to {email}?\n\nSwitching will close official Codex and try to reopen it.",
    "confirm.delete": "Delete the local encrypted record for {email}?\n\nThis account is not current, so official Codex will not be closed.",
    "confirm.httpOnly": "Changing the transport fully closes official Codex and migrates history provider tags. It reopens afterward if it was running.\n\nContinue?",
    "modal.deleteSwitch": "Delete and Switch",
    "modal.deleteLogin": "Delete and Log In",
    "modal.continue": "Continue"
  }
};

let accounts = [];
let selectedAccountId;
let settings = {
  autoSwitchEnabled: false,
  requireSwitchConfirmation: true,
  lowQuotaWarningEnabled: true,
  lowQuotaThresholdPercent: 15,
  uiLanguage: "zh-CN",
  closeBehavior: "ask",
  themeMode: "system",
  httpOnlyModeEnabled: false,
  usageRefreshIntervalMinutes: 5
};
let autoSwitchInProgress = false;
let backgroundRefreshTimer;
let currentView = "accounts";

document.querySelector("#import-current").addEventListener("click", runAction(async () => {
  const account = await api.importCurrentAuth();
  selectedAccountId = account.id;
  try {
    await api.refreshUsage(account.id, true);
    await loadAccounts(t("status.importedRefreshed"));
  } catch (error) {
    await loadAccounts(t("status.importedRefreshFailed", { error: errorMessage(error) }));
  }
}));

document.querySelector("#refresh-all").addEventListener("click", runAction(async () => {
  const results = await api.refreshAllUsage();
  await loadAccounts(refreshSummary(results, t("status.usageRefreshDone")));
}));

document.querySelector("#pick-best").addEventListener("click", runAction(async () => {
  const result = await api.pickBestAccount();
  if (!result.account) {
    setStatus(t("status.noCandidate"));
    return;
  }
  selectedAccountId = result.account.id;
  render();
  setStatus(t("status.bestAccount", { email: result.account.emailMasked, score: Math.round(result.score) }));
}));

settingsOpenFolder.addEventListener("click", runAction(async () => {
  await api.openCodexFolder();
}));

settingsQuitApp.addEventListener("click", runAction(async () => {
  await api.quitApp();
}));

accountsNav.addEventListener("click", () => showView("accounts"));
settingsNav.addEventListener("click", () => showView("settings"));

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

languageSelect.addEventListener("change", runAction(async () => {
  await saveLanguage(languageSelect.value);
}));

searchInput.addEventListener("input", () => render());

settingsAutoSwitch.addEventListener("change", runAction(async () => {
  settings = await api.updateSettings({ autoSwitchEnabled: settingsAutoSwitch.checked });
  syncSettingsControls();
  setStatus(t(settingsAutoSwitch.checked ? "status.autoSwitchOn" : "status.autoSwitchOff"));
  await evaluateQuotaActions("settings");
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

settingsHttpOnly.addEventListener("change", runAction(async () => {
  const requested = settingsHttpOnly.checked;
  if (!confirm(t("confirm.httpOnly"))) {
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
  if (action !== "minimize" && action !== "quit") {
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

api.onCloseDecisionRequested(() => {
  if (closeDialog.open) {
    return;
  }
  closeDialog.returnValue = "";
  closeRemember.checked = false;
  closeDialog.showModal();
});

initialize();

async function initialize() {
  await loadSettings();
  applyTheme();
  applyTranslations();
  showView(currentView);
  await loadAccounts(t("status.ready"));
  startBackgroundRefreshTimer();
}

async function loadSettings() {
  settings = await api.readSettings();
  syncSettingsControls();
}

function syncSettingsControls() {
  autoSwitchInput.checked = Boolean(settings.autoSwitchEnabled);
  lowQuotaWarningInput.checked = Boolean(settings.lowQuotaWarningEnabled);
  languageSelect.value = settings.uiLanguage === "en" ? "en" : "zh-CN";
  settingsAutoSwitch.checked = Boolean(settings.autoSwitchEnabled);
  settingsLowQuotaWarning.checked = Boolean(settings.lowQuotaWarningEnabled);
  settingsRequireSwitchConfirmation.checked = settings.requireSwitchConfirmation !== false;
  settingsHttpOnly.checked = Boolean(settings.httpOnlyModeEnabled);
  settingsLanguage.value = settings.uiLanguage === "en" ? "en" : "zh-CN";
  for (const input of settingsThemeInputs) {
    input.checked = input.value === normalizeThemeMode(settings.themeMode);
  }
  settingsRefreshInterval.value = String(clampRefreshInterval(settings.usageRefreshIntervalMinutes));
  const closeBehavior = settings.closeBehavior === "minimize" || settings.closeBehavior === "quit" ? settings.closeBehavior : "ask";
  const closeInput = document.querySelector(`input[name="settings-close-behavior"][value="${closeBehavior}"]`);
  if (closeInput) {
    closeInput.checked = true;
  }
}

async function saveLanguage(uiLanguage) {
  settings = await api.updateSettings({ uiLanguage });
  syncSettingsControls();
  applyTranslations();
  render();
  setStatus(t("status.languageSaved"));
}

function showView(view) {
  currentView = view === "settings" ? "settings" : "accounts";
  const showingSettings = currentView === "settings";
  accountsView.hidden = showingSettings;
  accountsTopbar.hidden = showingSettings;
  metricsStrip.hidden = showingSettings;
  accountsWorkspace.hidden = showingSettings;
  settingsView.hidden = !showingSettings;
  accountsView.style.display = showingSettings ? "none" : "";
  accountsTopbar.style.display = showingSettings ? "none" : "";
  metricsStrip.style.display = showingSettings ? "none" : "";
  accountsWorkspace.style.display = showingSettings ? "none" : "";
  settingsView.style.display = showingSettings ? "" : "none";
  document.body.classList.toggle("view-settings", showingSettings);
  document.body.classList.toggle("view-accounts", !showingSettings);
  accountsNav.classList.toggle("active", !showingSettings);
  settingsNav.classList.toggle("active", showingSettings);
  if (showingSettings) {
    settingsView.scrollTop = 0;
  }
}

function applyTheme() {
  document.documentElement.dataset.theme = normalizeThemeMode(settings.themeMode);
}

function normalizeThemeMode(value) {
  return value === "light" || value === "dark" ? value : "system";
}

function startBackgroundRefreshTimer() {
  if (backgroundRefreshTimer) {
    clearInterval(backgroundRefreshTimer);
  }
  backgroundRefreshTimer = setInterval(refreshAllUsageInBackground, clampRefreshInterval(settings.usageRefreshIntervalMinutes) * 60 * 1000);
}

function refreshAllUsageInBackground() {
  api.refreshAllUsage()
    .then((results) => loadAccounts(refreshSummary(results, t("status.backgroundUpdated")), { reason: "background" }))
    .catch((error) => setStatus(t("status.backgroundFailed", { error: errorMessage(error) })));
}

function clampRefreshInterval(value) {
  const minutes = Number(value);
  return Number.isFinite(minutes) ? Math.round(Math.max(1, Math.min(60, minutes))) : 5;
}

async function loadAccounts(message, options = {}) {
  accounts = await api.listAccounts();
  if (!selectedAccountId || !accounts.some((account) => account.id === selectedAccountId)) {
    selectedAccountId = accounts.find((account) => account.isCurrent)?.id ?? accounts[0]?.id;
  }
  render();
  setStatus(message);
  await evaluateQuotaActions(options.reason ?? "load");
}

function render() {
  renderMetrics();
  renderQuotaWarning();
  renderAccounts();
  renderDetail();
}

function renderMetrics() {
  const current = accounts.find((account) => account.isCurrent);
  const best = [...accounts].sort((left, right) => remainingScore(right) - remainingScore(left))[0];
  metricTotal.textContent = String(accounts.length);
  metricCurrent.textContent = current?.emailMasked ?? t("labels.none");
  metricBest.textContent = best?.usage ? `${Math.round(remainingScore(best))}%` : t("labels.unknown");
  metricBest.title =
    settings.uiLanguage === "en"
      ? "Score = 7-day remaining * 0.7 + 5-hour remaining * 0.3. Used to choose the best switch target."
      : "综合分数 = 7 天剩余 * 0.7 + 5 小时剩余 * 0.3，用于选择最适合切换的账号";
}

function renderQuotaWarning() {
  const current = accounts.find((account) => account.isCurrent);
  if (!hasFreshUsableUsage(current)) {
    quotaWarningLine.hidden = true;
    quotaWarningLine.textContent = "";
    return;
  }
  const remaining = lowestRemaining(current);
  if (!settings.lowQuotaWarningEnabled || remaining === undefined || remaining > settings.lowQuotaThresholdPercent) {
    quotaWarningLine.hidden = true;
    quotaWarningLine.textContent = "";
    return;
  }

  quotaWarningLine.hidden = false;
  quotaWarningLine.textContent =
    remaining <= 0
      ? t("quota.empty")
      : t("quota.low", { remaining: Math.round(remaining) });
}

async function evaluateQuotaActions(reason) {
  if (autoSwitchInProgress) {
    return;
  }
  const current = accounts.find((account) => account.isCurrent);
  if (!hasFreshUsableUsage(current)) {
    renderQuotaWarning();
    return;
  }
  const remaining = lowestRemaining(current);
  if (remaining === undefined) {
    return;
  }

  if (settings.autoSwitchEnabled && remaining <= 0 && reason !== "manual-switch") {
    const best = await api.pickBestAccount();
    const target = best.account?.id !== current.id ? best.account : undefined;
    if (!target) {
      setStatus(t("status.exhaustedNoTarget"));
      return;
    }
    autoSwitchInProgress = true;
    try {
      const result = await api.switchAccount(target.id);
      selectedAccountId = target.id;
      await loadAccounts(t("status.autoSwitched", { email: target.emailMasked, count: result.closedCodexProcesses ?? 0 }), { reason: "auto-switch" });
    } finally {
      autoSwitchInProgress = false;
    }
    return;
  }

  renderQuotaWarning();
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
    const node = template.content.firstElementChild.cloneNode(true);
    translateTree(node);
    node.classList.toggle("current", account.isCurrent);
    node.classList.toggle("selected", account.id === selectedAccountId);
    node.querySelector('[data-field="avatar"]').textContent = initials(account);
    node.querySelector('[data-field="plan"]').textContent = normalizePlan(account.planType);
    node.querySelector('[data-field="plan"]').classList.add(planClass(account.planType));
    node.querySelector('[data-field="email"]').textContent = account.emailMasked;
    node.querySelector('[data-field="meta"]').textContent = `${statusLabel(account.status)} · ${t("labels.localRecord", { id: shortId(account.id) })}`;
    node.querySelector('[data-field="badge"]').textContent = account.isCurrent ? t("labels.current") : t("labels.switchable");
    node.querySelector('[data-field="badge"]').classList.toggle("current-badge", account.isCurrent);
    node.querySelector('[data-field="five-ring"]').replaceChildren(usageRing("5h", account.usage?.fiveHour));
    node.querySelector('[data-field="week-ring"]').replaceChildren(usageRing("7d", account.usage?.oneWeek));
    node.querySelector('[data-field="error"]').textContent = account.usageError ?? "";
    node.addEventListener("click", () => {
      selectedAccountId = account.id;
      render();
    });
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectedAccountId = account.id;
        render();
      }
    });
    node.querySelector('[data-action="switch"]').disabled = account.isCurrent;
    node.querySelector('[data-action="switch"]').addEventListener("click", stopAndRun(async () => switchAccount(account)));
    node.querySelector('[data-action="refresh"]').addEventListener("click", stopAndRun(async () => {
      await api.refreshUsage(account.id, true);
      await loadAccounts(t("status.accountUsageRefreshed"));
    }));
    node.querySelector('[data-action="delete"]').addEventListener("click", stopAndRun(async () => deleteAccount(account)));
    accountsEl.append(node);
  }
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

  detailEl.innerHTML = `
    <section class="detail-header">
      <span class="detail-avatar">${initials(account)}</span>
      <div>
        <div class="detail-badges">
          <span class="badge plan ${planClass(account.planType)}">${normalizePlan(account.planType)}</span>
          ${account.isCurrent ? `<span class="badge current-badge">${t("labels.current")}</span>` : `<span class="badge state">${t("labels.candidate")}</span>`}
        </div>
        <h3>${escapeHtml(account.emailMasked)}</h3>
        <p>${escapeHtml(t("detail.fingerprint", { id: shortId(account.accountId) }))}</p>
      </div>
    </section>

    <section class="detail-section">
      <h4>${t("detail.usage")}</h4>
      <div class="detail-usage-grid">
        ${detailUsageCard(t("detail.fiveHour"), "success", account.usage?.fiveHour)}
        ${detailUsageCard(t("detail.oneWeek"), "info", account.usage?.oneWeek)}
      </div>
      <div class="reset-card">
        <span>${t("detail.resetTime")}</span>
        ${resetRow(settings.uiLanguage === "en" ? "5 hours" : "5 小时", account.usage?.fiveHour)}
        ${resetRow(settings.uiLanguage === "en" ? "7 days" : "7 天", account.usage?.oneWeek)}
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

    <section class="detail-section detail-actions">
      <h4>${t("detail.actions")}</h4>
      <div>
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
  detailEl.querySelector("#detail-refresh")?.addEventListener("click", runAction(async () => {
    await api.refreshUsage(account.id, true);
    await loadAccounts(t("status.accountUsageRefreshed"));
  }));
  detailEl.querySelector("#detail-delete")?.addEventListener("click", runAction(async () => deleteAccount(account)));
  for (const ring of detailEl.querySelectorAll("[data-progress]")) {
    ring.style.setProperty("--quota-progress", `${ring.dataset.progress}%`);
  }
}

async function switchAccount(account) {
  if (
    settings.requireSwitchConfirmation !== false &&
    !confirm(t("confirm.switch", { email: account.emailMasked }))
  ) {
    return;
  }
  const result = await api.switchAccount(account.id);
  selectedAccountId = account.id;
  await loadAccounts(switchMessage(t("status.switched", { email: account.emailMasked }), result), { reason: "manual-switch" });
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
      selectedAccountId = undefined;
      await loadAccounts(loginNewMessage(result));
      return;
    }

    const result = await api.deleteAccount(account.id, { replacementAccountId: action.replacement.id });
    selectedAccountId = result.switchedTo?.id ?? action.replacement.id;
    await loadAccounts(switchMessage(t("status.currentDeletedSwitched", { email: action.replacement.emailMasked }), result));
    return;
  }

  if (!confirm(t("confirm.delete", { email: account.emailMasked }))) {
    return;
  }
  const result = await api.deleteAccount(account.id);
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
    option.textContent = `${candidate.emailMasked} · ${statusLabel(candidate.status)} · ${Math.round(remainingScore(candidate))}%`;
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
  if (result.alreadyCurrent) {
    return t("status.currentAlready", { prefix });
  }
  const closed = result.closedCodexProcesses ?? 0;
  const launch = result.launchedCodex ? t("status.launchOk") : t("status.launchFailed");
  const warning = result.transportWarning ? ` ${t("status.transportWarning", { error: result.transportWarning })}` : "";
  return `${t("status.switchResult", { prefix, count: closed, launch })}${warning}`;
}

function loginNewMessage(result) {
  const closed = result.closedCodexProcesses ?? 0;
  const launch = result.launchedCodex ? t("status.launchOk") : t("status.launchFailed");
  const warning = result.transportWarning ? ` ${t("status.transportWarning", { error: result.transportWarning })}` : "";
  return `${t("status.loginNew", { count: closed, launch })}${warning}`;
}

function usageRing(label, window) {
  const remaining = window ? Math.max(0, 100 - window.usedPercent) : 0;
  const wrapper = document.createElement("div");
  wrapper.className = "quota-ring";
  wrapper.style.setProperty("--quota-progress", `${Math.round(remaining)}%`);
  wrapper.innerHTML = `
    <div class="quota-ring-center">
      <span>${label}</span>
      <strong>${window ? `${Math.round(remaining)}%` : "?"}</strong>
    </div>
  `;
  return wrapper;
}

function detailUsageCard(title, tone, window) {
  const remaining = window ? Math.max(0, 100 - window.usedPercent) : 0;
  const used = window ? Math.round(window.usedPercent) : "?";
  return `
    <div class="detail-usage-card quota-ring-card ${tone}">
      <div class="quota-ring" data-progress="${Math.round(remaining)}">
        <div class="quota-ring-center">
          <span>${tone === "success" ? "5h" : "7d"}</span>
          <strong>${window ? `${Math.round(remaining)}%` : "?"}</strong>
        </div>
      </div>
      <div>
        <span>${title}</span>
        <strong>${t("detail.used", { used: `${used}${window ? "%" : ""}` })}</strong>
      </div>
    </div>
  `;
}

function resetRow(label, window) {
  return `
    <div class="reset-row">
      <span>${label}</span>
      <strong>${window?.resetAt ? new Date(window.resetAt * 1000).toLocaleString() : t("labels.unknown")}</strong>
    </div>
  `;
}

function setStatus(message) {
  statusLine.textContent = message;
}

function stopAndRun(fn) {
  return (event) => {
    event.stopPropagation();
    return runAction(fn)();
  };
}

function runAction(fn) {
  return async () => {
    try {
      document.body.classList.add("busy");
      setStatus(t("status.processing"));
      await fn();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      document.body.classList.remove("busy");
    }
  };
}

function remainingScore(account) {
  const oneWeekUsed = account.usage?.oneWeek?.usedPercent ?? 100;
  const fiveHourUsed = account.usage?.fiveHour?.usedPercent ?? 100;
  return Math.max(0, 100 - oneWeekUsed) * 0.7 + Math.max(0, 100 - fiveHourUsed) * 0.3;
}

function lowestRemaining(account) {
  const values = [account?.usage?.fiveHour, account?.usage?.oneWeek]
    .filter(Boolean)
    .map((window) => Math.max(0, 100 - window.usedPercent));
  return values.length > 0 ? Math.min(...values) : undefined;
}

function hasFreshUsableUsage(account) {
  const now = Math.floor(Date.now() / 1000);
  return Boolean(account?.status === "ready" && account.usage?.fetchedAt && now - account.usage.fetchedAt <= 10 * 60);
}

function refreshSummary(results, successMessage) {
  const failures = Array.isArray(results) ? results.filter((result) => !result.ok).length : 0;
  return failures > 0 ? t("status.refreshFailures", { message: successMessage, count: failures }) : successMessage;
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
  if (status === "needs_login") return t("statusLabel.needs_login");
  return String(status || t("labels.unknown"));
}

function formatTime(unixSeconds) {
  return unixSeconds ? new Date(unixSeconds * 1000).toLocaleString() : t("labels.unknown");
}

function applyTranslations() {
  document.documentElement.lang = currentLanguage();
  translateTree(document);
  replacementConfirm.textContent = t("modal.continue");
}

function translateTree(root) {
  for (const node of root.querySelectorAll("[data-i18n]")) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of root.querySelectorAll("[data-i18n-placeholder]")) {
    node.placeholder = t(node.dataset.i18nPlaceholder);
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
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
