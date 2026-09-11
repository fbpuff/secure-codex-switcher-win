const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
let usageRefreshOperationId = 0;
let conversationBackupOperationId = 0;
let recoveryOperationId = 0;

contextBridge.exposeInMainWorld("codexSwitcher", {
  listAccounts: () => invoke("accounts:list"),
  getDshAuthSyncState: () => invoke("dshAuth:getState"),
  importCurrentAuth: () => invoke("accounts:importCurrent"),
  beginAddAccount: () => invoke("accounts:beginAdd"),
  completeAddAccount: (preservedAccountId) => invoke("accounts:completeAdd", preservedAccountId),
  refreshUsage: (accountId, force = false) => invoke("accounts:refreshUsage", accountId, force),
  refreshAllUsage: () => invoke("accounts:refreshAllUsage", ++usageRefreshOperationId),
  onUsageRefreshProgress: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("accounts:refreshProgress", handler);
    return () => ipcRenderer.removeListener("accounts:refreshProgress", handler);
  },
  switchAccount: (accountId, options) => invoke("accounts:switch", accountId, options),
  deleteAccount: (accountId, options) => invoke("accounts:delete", accountId, options),
  setAccountHttpOnlyMode: (accountId, enabled) => invoke("accounts:setHttpOnly", accountId, enabled),
  setAccountDisableGpuMode: (accountId, enabled) => invoke("accounts:setDisableGpu", accountId, enabled),
  setAccountRemark: (accountId, remark) => invoke("accounts:setRemark", accountId, remark),
  pickBestAccount: () => invoke("accounts:pickBest"),
  evaluateAutoSwitch: (reason) => invoke("autoSwitch:evaluate", reason),
  getAutoSwitchState: () => invoke("autoSwitch:getState"),
  clearAutoSwitchState: () => invoke("autoSwitch:clearState"),
  getAutoResumeStatus: () => invoke("autoResume:getStatus"),
  setAutoSwitchTarget: (accountId) => invoke("autoSwitch:setTarget", accountId),
  clearAutoSwitchTarget: () => invoke("autoSwitch:clearTarget"),
  setAutoSwitchExcluded: (accountId, excluded) => invoke("autoSwitch:setExcluded", accountId, excluded),
  clearAutoSwitchExclusions: () => invoke("autoSwitch:clearExclusions"),
  getTokenUsageStats: (options) => invoke("tokens:stats", options),
  getWeeklyUsageReport: (options) => invoke("reports:weekly", options),
  getDailyUsageReport: (options) => invoke("reports:daily", options),
  clearUsageObservations: () => invoke("reports:clear"),
  getTransportDiagnostics: () => invoke("transport:getDiagnostics"),
  getAppVersion: () => invoke("app:getVersion"),
  runConversationBackup: () => invoke("backup:conversations", ++conversationBackupOperationId),
  onConversationBackupProgress: (callback) => {
    const handler = (_event, envelope) => {
      if (envelope?.operationId === conversationBackupOperationId) callback(envelope.progress);
    };
    ipcRenderer.on("backup:conversationProgress", handler);
    return () => ipcRenderer.removeListener("backup:conversationProgress", handler);
  },
  listCodexRecoveryBackups: ({ full = true } = {}) => invoke("backup:listCodexRecovery", full, ++recoveryOperationId),
  revalidateQuarantinedConversation: (conversationId) => invoke("backup:revalidateQuarantinedConversation", conversationId, ++recoveryOperationId),
  previewCodexRecovery: (selection) => invoke("backup:previewCodexRecovery", selection, ++recoveryOperationId),
  onRecoveryProgress: (callback) => {
    const handler = (_event, envelope) => {
      if (envelope?.operationId === recoveryOperationId) callback(envelope.progress);
    };
    ipcRenderer.on("backup:recoveryProgress", handler);
    return () => ipcRenderer.removeListener("backup:recoveryProgress", handler);
  },
  prepareCodexReplacement: (selection) => invoke("backup:prepareCodexReplacement", selection),
  confirmCodexReplacement: (request) => invoke("backup:confirmCodexReplacement", request),
  readSettings: () => invoke("settings:read"),
  updateSettings: (patch) => invoke("settings:update", patch),
  setHttpOnlyMode: (enabled) => invoke("settings:setHttpOnly", enabled),
  setDisableGpuMode: (enabled) => invoke("settings:setDisableGpu", enabled),
  quitApp: () => invoke("app:quit"),
  applyCloseDecision: (decision) => invoke("app:applyCloseDecision", decision),
  countCodexProcesses: () => invoke("app:countCodexProcesses"),
  getCodexActivityStatus: () => invoke("app:getCodexActivityStatus"),
  getCodexThreadSidebarStateRevision: () => invoke("threads:getSidebarRevision"),
  searchLocalCodexThreads: (query) => invoke("threads:searchLocal", typeof query === "string" ? query : ""),
  onCloseDecisionRequested: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("app:requestCloseDecision", handler);
    return () => ipcRenderer.removeListener("app:requestCloseDecision", handler);
  },
  onMainProcessWarning: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("app:mainProcessWarning", handler);
    return () => ipcRenderer.removeListener("app:mainProcessWarning", handler);
  },
  openCodexFolder: () => invoke("system:openCodexFolder")
});
