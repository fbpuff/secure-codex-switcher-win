const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("codexSwitcher", {
  listAccounts: () => invoke("accounts:list"),
  importCurrentAuth: () => invoke("accounts:importCurrent"),
  refreshUsage: (accountId, force = false) => invoke("accounts:refreshUsage", accountId, force),
  refreshAllUsage: () => invoke("accounts:refreshAllUsage"),
  switchAccount: (accountId, options) => invoke("accounts:switch", accountId, options),
  deleteAccount: (accountId, options) => invoke("accounts:delete", accountId, options),
  pickBestAccount: () => invoke("accounts:pickBest"),
  getTokenUsageStats: (options) => invoke("tokens:stats", options),
  readSettings: () => invoke("settings:read"),
  updateSettings: (patch) => invoke("settings:update", patch),
  setHttpOnlyMode: (enabled) => invoke("settings:setHttpOnly", enabled),
  quitApp: () => invoke("app:quit"),
  applyCloseDecision: (decision) => invoke("app:applyCloseDecision", decision),
  countCodexProcesses: () => invoke("app:countCodexProcesses"),
  getCodexActivityStatus: () => invoke("app:getCodexActivityStatus"),
  onCloseDecisionRequested: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("app:requestCloseDecision", handler);
    return () => ipcRenderer.removeListener("app:requestCloseDecision", handler);
  },
  openCodexFolder: () => invoke("system:openCodexFolder")
});
