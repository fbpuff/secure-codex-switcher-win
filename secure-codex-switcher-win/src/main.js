import { app, BrowserWindow, ipcMain, shell, Menu, nativeImage, Tray } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAccountService } from "./services/account-service.js";
import { createProxyAwareFetch } from "./core/proxy-fetch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow;
let accountService;
let tray;
let isQuitting = false;
let wasMinimizedByClose = false;
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

  mainWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }

    const closeBehavior = accountService.readSettings().closeBehavior;
    if (closeBehavior === "quit") {
      isQuitting = true;
      return;
    }

    if (closeBehavior === "minimize") {
      if (wasMinimizedByClose || mainWindow.isMinimized() || !mainWindow.isVisible()) {
        isQuitting = true;
        return;
      }
      event.preventDefault();
      wasMinimizedByClose = true;
      mainWindow.minimize();
      return;
    }

    if (closeBehavior === "tray") {
      event.preventDefault();
      hideToTray();
      return;
    }

    event.preventDefault();
    mainWindow.webContents.send("app:requestCloseDecision");
  });

  mainWindow.on("closed", () => {
    mainWindow = undefined;
    wasMinimizedByClose = false;
  });

  mainWindow.on("focus", () => {
    wasMinimizedByClose = false;
  });
}

function createTray() {
  if (tray) {
    return tray;
  }

  tray = new Tray(fallbackTrayIcon());
  tray.setToolTip("Codex Switcher");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示窗口", click: showMainWindow },
      { type: "separator" },
      {
        label: "退出应用",
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );
  tray.on("double-click", showMainWindow);
  tray.on("click", showMainWindow);
  syncTrayIconWithExecutable();
  return tray;
}

function fallbackTrayIcon() {
  const icon = nativeImage
    .createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAZ0lEQVR4nGNgGAWDCYgraf6nBx51AEEHKC9fAMejDhhUDrj+5T1BTEgd2Q5ANgAfJkbN0HUAMfE76oABdwBNcwGxDiDkuFEHDF0HUMMRQ9cB4gNdGVETjzqAoANojUcdgNMBo2AgAABScHzxDr45UAAAAABJRU5ErkJggg=="
    )
    .resize({ width: 16, height: 16 });
  icon.setTemplateImage(false);
  return icon;
}

function syncTrayIconWithExecutable() {
  app
    .getFileIcon(process.execPath, { size: "normal" })
    .then((icon) => {
      if (!tray || icon.isEmpty()) {
        return;
      }
      const trayIcon = icon.resize({ width: 16, height: 16 });
      trayIcon.setTemplateImage(false);
      tray.setImage(trayIcon);
    })
    .catch(() => {});
}

function hideToTray() {
  createTray();
  if (!mainWindow) {
    return;
  }
  mainWindow.setSkipTaskbar(true);
  mainWindow.hide();
}

function showMainWindow() {
  if (!mainWindow) {
    createMainWindow();
  }
  if (!mainWindow) {
    return;
  }
  wasMinimizedByClose = false;
  mainWindow.setSkipTaskbar(false);
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function registerIpc() {
  const handlers = {
    "accounts:list": () => accountService.listAccounts(),
    "accounts:importCurrent": () => accountService.importCurrentAuth(),
    "accounts:refreshUsage": (_event, accountId, force) => accountService.refreshUsage(accountId, Boolean(force)),
    "accounts:refreshAllUsage": () => accountService.refreshAllUsage(),
    "accounts:switch": (_event, accountId, options) => accountService.switchAccount(accountId, options),
    "accounts:delete": (_event, accountId, options) => accountService.deleteAccount(accountId, options),
    "accounts:pickBest": () => accountService.pickBestAccount(),
    "tokens:stats": (_event, options) => accountService.getTokenUsageStats(options),
    "settings:read": () => accountService.readSettings(),
    "settings:update": (_event, patch) => accountService.updateSettings(patch),
    "settings:setHttpOnly": (_event, enabled) => accountService.setHttpOnlyMode(enabled),
    "app:quit": () => {
      isQuitting = true;
      app.quit();
      return { quitting: true };
    },
    "app:applyCloseDecision": (_event, decision) => {
      const action = decision?.action === "quit" || decision?.action === "tray" ? decision.action : "minimize";
      const remembered = Boolean(decision?.remember);
      if (remembered) {
        accountService.updateSettings({ closeBehavior: action });
      }
      if (action === "quit") {
        isQuitting = true;
        app.quit();
        return { action, remembered };
      }
      if (action === "tray") {
        hideToTray();
        return { action, remembered };
      }
      wasMinimizedByClose = true;
      mainWindow?.minimize();
      return { action, remembered };
    },
    "app:countCodexProcesses": () => accountService.countOfficialCodexProcesses(),
    "app:getCodexActivityStatus": () => accountService.getCodexActivityStatus(),
    "system:openCodexFolder": () => shell.openPath(accountService.codexDir)
  };

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (...args) => handler(...args));
  }
}

if (gotSingleInstanceLock) {
  app.on("second-instance", () => {
    if (mainWindow) {
      showMainWindow();
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

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
