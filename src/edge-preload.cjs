const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("edgeSwitcher", {
  getData: (refreshCurrent = false) => invoke("edge:getData", Boolean(refreshCurrent)),
  reportLifecycle: (event, details) => invoke("edge:reportLifecycle", event, details),
  getTokenUsage: (windowName) => invoke("edge:getTokenUsage", windowName),
  switchNextAccount: () => invoke("edge:switchNext"),
  openThread: (threadId) => invoke("edge:openThread", threadId),
  openCompletedThread: (threadId) => invoke("edge:openCompletedThread", threadId),
  onSwitchProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("edge:switchProgress", listener);
    return () => ipcRenderer.removeListener("edge:switchProgress", listener);
  },
  onInteractionState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("edge:interactionState", listener);
    return () => ipcRenderer.removeListener("edge:interactionState", listener);
  },
  pointerEntered: (pointerY) => invoke("edge:pointerEntered", Number(pointerY)),
  pointerLeft: () => invoke("edge:pointerLeft"),
  setAutoHide: (autoHide) => invoke("edge:setAutoHide", Boolean(autoHide))
});
