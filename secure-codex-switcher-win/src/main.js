import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAccountService } from "./services/account-service.js";
import { createProxyAwareFetch } from "./core/proxy-fetch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow;
let accountService;
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    title: "Secure Codex Switcher",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) {
      event.preventDefault();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
}

function registerIpc() {
  const handlers = {
    "accounts:list": () => accountService.listAccounts(),
    "accounts:importCurrent": () => accountService.importCurrentAuth(),
    "accounts:refreshUsage": (_event, accountId, force) => accountService.refreshUsage(accountId, Boolean(force)),
    "accounts:refreshAllUsage": () => accountService.refreshAllUsage(),
    "accounts:switch": (_event, accountId) => accountService.switchAccount(accountId),
    "accounts:delete": (_event, accountId, options) => accountService.deleteAccount(accountId, options),
    "accounts:pickBest": () => accountService.pickBestAccount(),
    "settings:read": () => accountService.readSettings(),
    "settings:update": (_event, patch) => accountService.updateSettings(patch),
    "system:openCodexFolder": () => shell.openPath(accountService.codexDir)
  };

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (...args) => handler(...args));
  }
}

if (gotSingleInstanceLock) {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
      return;
    }
    createMainWindow();
  });

  app.whenReady().then(() => {
    accountService = createAccountService(app.getPath("userData"), { fetchImpl: createProxyAwareFetch(fetch) });
    registerIpc();
    createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
