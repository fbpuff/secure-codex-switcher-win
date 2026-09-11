import { app, BrowserWindow, dialog, ipcMain, shell, Menu, nativeImage, screen, Tray } from "electron";
import fs from "node:fs";
import { beijingTimestamp } from "./core/beijing-time.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCodexThreadUri, createAccountService } from "./services/account-service.js";
import { buildEdgeQuotaView } from "./core/edge-quota-view.js";
import {
  collapsedEdgeBounds,
  positionEdgeHandle,
  sameEdgeBounds,
  detectEdgeDock,
  edgePlacementUpdate,
  EDGE_WINDOW_HEIGHT,
  EDGE_WINDOW_MIN_HEIGHT,
  EDGE_WINDOW_MIN_WIDTH,
  EDGE_WINDOW_WIDTH,
  isDockEdgeExposed,
  isPointerNearEdgeMarker,
  normalizeEdgeWindowSize,
  restoredEdgeBounds,
  shownEdgeBounds
} from "./core/edge-window.js";
import { createProxyAwareFetch, resolveProxyUrl } from "./core/proxy-fetch.js";
import { diagnoseTransport } from "./core/transport-diagnostics.js";
import { formatMainProcessError, getMainProcessErrorCode } from "./core/main-errors.js";
import { stopBackgroundJobs } from "./core/background-jobs.js";
import { markIntentionalSwitcherExit, startSwitcherWatchdog } from "./core/switcher-watchdog.js";
import {
  appendMainProcessLifecycleRecord,
  createMainProcessLifecycleRecord,
  normalizeMainProcessLifecycleToken,
  shouldQuitAfterAllWindowsClosed
} from "./core/main-process-lifecycle.js";
import {
  createEdgeLifecycleWriter,
  createEdgeWindowLifecycleRecord,
  normalizeEdgeWindowLifecycleToken
} from "./core/edge-window-lifecycle.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultUserDataPath = process.platform === "win32"
  ? (app.isPackaged
    ? "D:\\Secure Codex Switcher Workspace\\Data"
    : path.join(process.env.APPDATA || __dirname, "secure-codex-switcher-win"))
  : undefined;

if (defaultUserDataPath && !app.commandLine.hasSwitch("user-data-dir")) {
  app.setPath("userData", defaultUserDataPath);
}
app.setName("Secure Codex Switcher");
app.setAppUserModelId("com.securecodexswitcher.windows");

let mainWindow;
let edgeWindow;
let edgeHandleWindow;
let edgeHandleSide;
let edgeLastDockSide;
let edgeLogWriter;
let edgeLogQuitReady = false;
let edgeHandleCloseReason;
let accountService;
let tray;
let edgeHideTimer;
let edgeMoveTimer;
let edgePendingPlacementKind;
let edgePointerTimer;
let edgeInternalMove = false;
let edgeInternalMoveTimer;
let edgeNativeMoveTimer;
let edgeNativeMoveActive = false;
let edgeNativeResizeTimer;
let edgeNativeResizeActive = false;
let edgeCollapsed = false;
let edgeSwitchInProgress = false;
let conversationBackupTimer;
let isQuitting = false;
let wasMinimizedByClose = false;
let lifecyclePhase = "startup";
let runtimeVersion;
let rendererRecoveryTimer;
let rendererRecoveryPending = false;
let rendererRecoveryAttempts = 0;
let edgeRendererRecoveryTimer;
let edgeRendererRecoveryAttempts = 0;
let edgeHandleRecoveryTimer;
let edgeHandleRecoveryAttempts = 0;
let watchdog;
const recoverableWarningState = new Map();
const gotSingleInstanceLock = app.requestSingleInstanceLock();

process.on("uncaughtException", (error) => {
  handleMainProcessFailure("uncaughtException", error);
});

process.on("unhandledRejection", (reason) => {
  handleMainProcessFailure("unhandledRejection", reason);
});

process.on("exit", (exitCode) => {
  lifecyclePhase = "exiting";
  recordLifecycle("process_exit", exitCode === 0 ? "exit_0" : "exit_nonzero");
});

recordLifecycle("process_start", "startup");

if (!gotSingleInstanceLock) {
  requestAppQuit("duplicate_instance");
}

function handleMainProcessFailure(source, error) {
  const reasonCode = getMainProcessErrorCode(error);
  const recoverable = reasonCode !== "unclassified";
  recordEdgeLifecycle("edge_error", { reasonCode: source, errorCode: reasonCode });
  appendMainProcessLog(source, error);
  if (!recoverable) {
    recordLifecycle("fatal_error", reasonCode);
    sendMainWindowMessage("app:mainProcessWarning", {
      message: "Codex Switcher 主进程发生错误，已记录到日志。"
    });
    app.exit(1);
    return;
  }

  if (shouldEmitRecoverableIncident(reasonCode)) {
    recordLifecycle("recoverable_error", reasonCode);
    sendMainWindowMessage("app:mainProcessWarning", {
      message: "后台网络连接被代理或远端关闭，Codex Switcher 已继续运行。"
    });
  }
}

function appendMainProcessLog(source, error) {
  try {
    const userDataPath = resolveUserDataPath();
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.appendFileSync(
      path.join(userDataPath, "main-process.log"),
      `[${beijingTimestamp()}] ${source}\n${formatMainProcessError(error)}\n\n`,
      "utf8"
    );
  } catch {}
}

function handleStartupFailure(error) {
  appendMainProcessLog("startupFailure", error);
  recordLifecycle("fatal_error", "startup_failure", "startup");
  dialog.showErrorBox(
    "Secure Codex Switcher 无法启动",
    "本地账号数据损坏且无法自动恢复。损坏文件已保留，请先恢复账号数据后再启动。"
  );
  app.exit(1);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    title: "Secure Codex Switcher",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });
  recordLifecycle("window_created", "created", "window");

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.on("did-finish-load", () => {
    rendererRecoveryPending = false;
    rendererRecoveryAttempts = 0;
    if (rendererRecoveryTimer) {
      clearTimeout(rendererRecoveryTimer);
      rendererRecoveryTimer = undefined;
    }
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    recordLifecycle(
      "renderer_gone",
      normalizeMainProcessLifecycleToken(details?.reason, "unknown"),
      "renderer"
    );
    rendererRecoveryPending = true;
    ensureTrayRecoveryEntry();
    scheduleRendererRecovery();
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }

    const closeBehavior = accountService?.readSettings?.()?.closeBehavior || "quit";
    if (closeBehavior === "quit") {
      requestAppQuit("window_close_quit");
      return;
    }

    if (closeBehavior === "minimize") {
      if (wasMinimizedByClose || mainWindow.isMinimized() || !mainWindow.isVisible()) {
        requestAppQuit("window_close_minimize");
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
    if (!sendMainWindowMessage("app:requestCloseDecision")) {
      hideToTray();
    }
  });

  mainWindow.on("closed", () => {
    if (rendererRecoveryTimer) {
      clearTimeout(rendererRecoveryTimer);
      rendererRecoveryTimer = undefined;
    }
    recordLifecycle("window_closed", "closed", "window");
    mainWindow = undefined;
    wasMinimizedByClose = false;
    rendererRecoveryPending = false;
    rendererRecoveryAttempts = 0;
    if (!isQuitting) {
      ensureTrayRecoveryEntry();
    }
  });

  mainWindow.on("focus", () => {
    wasMinimizedByClose = false;
  });
}

function createEdgeWindow() {
  if (edgeWindow && !edgeWindow.isDestroyed()) return edgeWindow;
  const settings = accountService.readSettings();
  if (!settings.edgeWindowEnabled) return undefined;
  recordEdgeLifecycle("panel_create_requested", { reasonCode: "create" });
  const display = initialEdgeDisplay(settings);
  const bounds = restoredEdgeBounds(display.workArea, edgeWindowSize(settings), {
    docked: settings.edgeWindowDocked,
    side: settings.edgeWindowDockSide,
    x: settings.edgeWindowX,
    y: settings.edgeWindowY
  });
  edgeWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: true,
    minWidth: EDGE_WINDOW_MIN_WIDTH,
    minHeight: EDGE_WINDOW_MIN_HEIGHT,
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "edge-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  const target = edgeWindow;
  recordEdgeLifecycle("panel_created", { target, reasonCode: "created" });
  target.removeMenu();
  recordEdgeLifecycle("panel_load_started", { target, reasonCode: "load_file" });
  target.loadFile(path.join(__dirname, "renderer", "edge-window.html"));
  target.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  target.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) event.preventDefault();
  });
  target.webContents.on("did-finish-load", () => {
    const recoveryAttempt = edgeRendererRecoveryAttempts;
    recordEdgeLifecycle("panel_renderer_ready", {
      target,
      reasonCode: "did_finish_load",
      recoveryAttempt,
      rendererState: "ready"
    });
    if (recoveryAttempt > 0) {
      recordEdgeLifecycle("recovery_completed", {
        target,
        reasonCode: "edge_renderer_reload",
        recoveryAttempt,
        rendererState: "ready"
      });
    }
    edgeRendererRecoveryAttempts = 0;
    clearTimeout(edgeRendererRecoveryTimer);
    edgeRendererRecoveryTimer = undefined;
    sendEdgeCollapseState();
    if (edgeCollapsed) target.hide();
  });
  target.webContents.on("render-process-gone", (_event, details) => {
    recordEdgeLifecycle("panel_renderer_gone", {
      target,
      reasonCode: normalizeMainProcessLifecycleToken(details?.reason, "unknown"),
      errorCode: Number.isSafeInteger(details?.exitCode) ? `exit_${details.exitCode}` : "renderer_exit",
      rendererState: "gone"
    });
    recordLifecycle(
      "edge_renderer_gone",
      normalizeMainProcessLifecycleToken(details?.reason, "unknown"),
      "edge_renderer"
    );
    scheduleEdgeRendererRecovery();
  });
  target.once("ready-to-show", () => {
    recordEdgeLifecycle("panel_ready_to_show", { target, reasonCode: edgeCollapsed ? "collapsed" : "ready" });
    if (edgeCollapsed) return;
    target.showInactive();
    scheduleEdgeHide();
  });
  startEdgePointerWatcher();
  target.on("show", () => recordEdgeLifecycle("panel_shown", { target, reasonCode: "native_show" }));
  target.on("hide", () => recordEdgeLifecycle("panel_hidden", { target, reasonCode: edgeCollapsed ? "collapsed" : "native_hide" }));
  target.on("focus", () => {
    recordEdgeLifecycle("panel_focus", { target, reasonCode: "focus" });
    cancelEdgeHide("focus");
  });
  target.on("blur", () => {
    recordEdgeLifecycle("panel_blur", { target, reasonCode: "blur" });
    scheduleEdgeHide("blur");
  });
  target.on("will-move", markEdgeNativeMove);
  target.on("will-resize", (event) => {
    if (edgeNativeMoveActive) {
      recordEdgeLifecycle("resize_settled", { target, reasonCode: "blocked_by_move" });
      event.preventDefault();
      return;
    }
    markEdgeNativeResize();
  });
  target.on("move", () => {
    if (!edgeInternalMove && !edgeNativeResizeActive) markEdgeNativeMove();
    scheduleEdgePlacementSave(edgeNativeResizeActive ? "resize" : "move");
  });
  target.on("resize", () => scheduleEdgePlacementSave(edgeNativeResizeActive ? "resize" : "move"));
  target.on("closed", () => {
    recordEdgeLifecycle("panel_closed", { target, reasonCode: isQuitting ? "app_quit" : "native_close", destroyed: true });
    if (edgeWindow !== target) return;
    const wasCollapsed = edgeCollapsed;
    cancelEdgeHide("panel_closed");
    clearTimeout(edgeMoveTimer);
    clearTimeout(edgeInternalMoveTimer);
    clearTimeout(edgeNativeMoveTimer);
    clearTimeout(edgeNativeResizeTimer);
    clearTimeout(edgeRendererRecoveryTimer);
    clearTimeout(edgeHandleRecoveryTimer);
    edgeMoveTimer = undefined;
    edgePendingPlacementKind = undefined;
    edgeInternalMove = false;
    edgeInternalMoveTimer = undefined;
    edgeNativeMoveActive = false;
    edgeNativeMoveTimer = undefined;
    edgeNativeResizeActive = false;
    edgeNativeResizeTimer = undefined;
    edgeRendererRecoveryTimer = undefined;
    edgeHandleRecoveryTimer = undefined;
    edgeWindow = undefined;
    edgeCollapsed = false;
    closeEdgeHandleWindow("panel_closed");
    stopEdgePointerWatcher();
    edgeCollapsed = wasCollapsed;
    scheduleEdgeRendererRecovery();
  });
  return target;
}

function setEdgeHandleSide(target, side) {
  const nextSide = side === "left" ? "left" : "right";
  if (edgeHandleSide === nextSide) return;
  const alreadyLoaded = edgeHandleSide !== undefined;
  edgeHandleSide = nextSide;
  if (alreadyLoaded) {
    if (!target.webContents.isLoading()) {
      void target.webContents.executeJavaScript(`location.hash = ${JSON.stringify(nextSide)}`).catch(() => {
        recordEdgeLifecycle("edge_error", { surface: "handle", target, reasonCode: "side_update_failed" });
      });
    }
    return;
  }
  const requestedSide = nextSide;
  recordEdgeLifecycle("handle_load_started", {
    surface: "handle",
    target,
    reasonCode: `side_${requestedSide}`
  });
  void target.loadFile(
    path.join(__dirname, "renderer", "edge-handle.html"),
    { hash: requestedSide }
  ).catch(() => {
    if (edgeHandleWindow !== target || target.isDestroyed() || edgeHandleSide !== requestedSide) return;
    recordEdgeLifecycle("recovery_failed", {
      surface: "handle",
      target,
      reasonCode: "handle_load_failed",
      errorCode: "load_file"
    });
    edgeHandleCloseReason = "handle_load_failed";
    edgeHandleSide = undefined;
    target.destroy();
  });
}

function createEdgeHandleWindow(bounds, side) {
  if (edgeHandleWindow && !edgeHandleWindow.isDestroyed()) {
    if (positionEdgeHandle(edgeHandleWindow, bounds, side)) {
      recordEdgeLifecycle("handle_geometry", { surface: "handle", target: edgeHandleWindow, side, reasonCode: "reposition", requestedBounds: bounds });
    }
    setEdgeHandleSide(edgeHandleWindow, side);
    return edgeHandleWindow;
  }
  edgeHandleSide = undefined;
  recordEdgeLifecycle("handle_create_requested", { surface: "handle", reasonCode: "create" });
  edgeHandleWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  const target = edgeHandleWindow;
  positionEdgeHandle(target, bounds, side);
  recordEdgeLifecycle("handle_geometry", { surface: "handle", target, side, reasonCode: "native_size", requestedBounds: bounds });
  recordEdgeLifecycle("handle_created", { surface: "handle", target, reasonCode: "created" });
  target.removeMenu();
  target.webContents.on("did-finish-load", () => {
    if (edgeHandleWindow === target && !target.isDestroyed()) {
      void target.webContents.executeJavaScript(`location.hash = ${JSON.stringify(edgeHandleSide)}`).catch(() => {});
    }
    const recoveryAttempt = edgeHandleRecoveryAttempts;
    recordEdgeLifecycle("handle_renderer_ready", {
      surface: "handle",
      target,
      reasonCode: "did_finish_load",
      recoveryAttempt,
      rendererState: "ready"
    });
    if (recoveryAttempt > 0) {
      recordEdgeLifecycle("recovery_completed", {
        surface: "handle",
        target,
        reasonCode: "handle_reproject",
        recoveryAttempt,
        rendererState: "ready"
      });
    }
    edgeHandleRecoveryAttempts = 0;
  });
  target.webContents.on("render-process-gone", () => {
    recordEdgeLifecycle("handle_renderer_gone", {
      surface: "handle",
      target,
      reasonCode: "render_process_gone",
      errorCode: "renderer_exit",
      rendererState: "gone"
    });
    if (edgeHandleWindow === target) {
      edgeHandleWindow = undefined;
      edgeHandleSide = undefined;
    }
    edgeHandleCloseReason = "render_process_gone";
    if (!target.isDestroyed()) target.destroy();
    scheduleEdgeHandleRecovery();
  });
  target.on("show", () => recordEdgeLifecycle("handle_shown", { surface: "handle", target, reasonCode: "native_show" }));
  target.on("hide", () => recordEdgeLifecycle("handle_hidden", { surface: "handle", target, reasonCode: "native_hide" }));
  target.on("closed", () => {
    recordEdgeLifecycle("handle_closed", {
      surface: "handle",
      target,
      reasonCode: edgeHandleCloseReason || "native_close",
      destroyed: true
    });
    edgeHandleCloseReason = undefined;
    if (edgeHandleWindow === target) {
      edgeHandleWindow = undefined;
      edgeHandleSide = undefined;
    }
    scheduleEdgeHandleRecovery();
  });
  setEdgeHandleSide(target, side);
  return target;
}

function closeEdgeHandleWindow(reasonCode = "surface_transition") {
  clearTimeout(edgeHandleRecoveryTimer);
  edgeHandleRecoveryTimer = undefined;
  edgeHandleRecoveryAttempts = 0;
  const target = edgeHandleWindow;
  edgeHandleCloseReason = reasonCode;
  edgeHandleWindow = undefined;
  edgeHandleSide = undefined;
  if (target && !target.isDestroyed()) {
    recordEdgeLifecycle("handle_destroy_requested", { surface: "handle", target, reasonCode });
    target.destroy();
  }
}

function scheduleEdgeHandleRecovery() {
  if (edgeHandleRecoveryTimer || isQuitting || !edgeCollapsed) return;
  edgeHandleRecoveryAttempts += 1;
  recordEdgeLifecycle("recovery_scheduled", {
    surface: "handle",
    reasonCode: "handle_missing",
    recoveryAttempt: edgeHandleRecoveryAttempts
  });
  edgeHandleRecoveryTimer = setTimeout(() => {
    edgeHandleRecoveryTimer = undefined;
    recordEdgeLifecycle("recovery_started", {
      surface: "handle",
      reasonCode: "handle_missing",
      recoveryAttempt: edgeHandleRecoveryAttempts
    });
    reprojectEdgeWindows("handle_recovery");
  }, 100);
  edgeHandleRecoveryTimer.unref?.();
}

function initialEdgeDisplay(settings) {
  const displayId = String(settings.edgeWindowDisplayId || "");
  return screen.getAllDisplays().find((display) => String(display.id) === displayId) || screen.getPrimaryDisplay();
}

function edgeDisplay() {
  if (!edgeWindow || edgeWindow.isDestroyed()) return screen.getPrimaryDisplay();
  return screen.getDisplayMatching(edgeWindow.getBounds()) || screen.getPrimaryDisplay();
}

function edgeWindowSize(settings) {
  return normalizeEdgeWindowSize({
    width: Number.isFinite(settings?.edgeWindowWidth) ? settings.edgeWindowWidth : EDGE_WINDOW_WIDTH,
    height: Number.isFinite(settings?.edgeWindowHeight) ? settings.edgeWindowHeight : EDGE_WINDOW_HEIGHT
  });
}

function edgeProjection(settings = accountService.readSettings()) {
  edgeLastDockSide = settings.edgeWindowDockSide;
  const display = initialEdgeDisplay(settings);
  const panel = restoredEdgeBounds(display.workArea, edgeWindowSize(settings), {
    docked: settings.edgeWindowDocked,
    side: settings.edgeWindowDockSide,
    x: settings.edgeWindowX,
    y: settings.edgeWindowY
  });
  return {
    display,
    panel,
    marker: collapsedEdgeBounds(display.workArea, panel, settings.edgeWindowDockSide)
  };
}

function setEdgeBounds(bounds) {
  if (!edgeWindow || edgeWindow.isDestroyed()) return;
  if (sameEdgeBounds(edgeWindow.getBounds(), bounds)) return;
  edgeInternalMove = true;
  clearTimeout(edgeInternalMoveTimer);
  edgeWindow.setBounds(bounds, false);
  edgeInternalMoveTimer = setTimeout(() => { edgeInternalMove = false; edgeInternalMoveTimer = undefined; }, 180);
  edgeInternalMoveTimer.unref?.();
}

function revealEdgeWindow() {
  recordEdgeLifecycle("reveal_requested", { reasonCode: "pointer_or_command" });
  const target = createEdgeWindow();
  if (!target) {
    recordEdgeLifecycle("reproject_skipped", { reasonCode: "edge_window_disabled" });
    return;
  }
  cancelEdgeHide("reveal");
  const settings = accountService.readSettings();
  const { panel } = edgeProjection(settings);
  edgeCollapsed = false;
  if (edgeHandleWindow && !edgeHandleWindow.isDestroyed()) edgeHandleWindow.hide();
  setEdgeBounds(panel);
  sendEdgeCollapseState(settings);
  target.showInactive();
  recordEdgeLifecycle("reveal_applied", { target, reasonCode: "expanded" });
}

function reprojectEdgeWindows(reasonCode = "display_change") {
  recordEdgeLifecycle("reproject_requested", { reasonCode });
  const settings = accountService?.readSettings?.();
  if (!settings?.edgeWindowEnabled) {
    recordEdgeLifecycle("reproject_skipped", { reasonCode: "edge_window_disabled" });
    return;
  }
  const target = createEdgeWindow();
  if (!target) {
    recordEdgeLifecycle("reproject_skipped", { reasonCode: "panel_unavailable" });
    return;
  }
  const { panel, marker } = edgeProjection(settings);
  setEdgeBounds(panel);
  if (edgeCollapsed && settings.edgeWindowDocked && settings.edgeWindowAutoHide) {
    createEdgeHandleWindow(marker, settings.edgeWindowDockSide);
    target.hide();
    edgeHandleWindow.showInactive();
    recordEdgeLifecycle("reproject_applied", {
      target: edgeHandleWindow,
      surface: "handle",
      reasonCode,
      rendererState: "ready"
    });
    return;
  }
  edgeCollapsed = false;
  if (edgeHandleWindow && !edgeHandleWindow.isDestroyed()) edgeHandleWindow.hide();
  sendEdgeCollapseState(settings);
  target.showInactive();
  recordEdgeLifecycle("reproject_applied", { target, reasonCode });
}

function startEdgePointerWatcher() {
  if (edgePointerTimer) return;
  edgePointerTimer = setInterval(() => {
    if (!edgeCollapsed || edgeSwitchInProgress || isQuitting) return;
    if (!edgeHandleWindow || edgeHandleWindow.isDestroyed()) {
      scheduleEdgeHandleRecovery();
      return;
    }
    const marker = edgeHandleWindow.getContentBounds();
    const display = screen.getDisplayMatching(marker);
    if (!edgeHandleWindow.isVisible()) edgeHandleWindow.showInactive();
    const point = screen.getCursorScreenPoint();
    if (isPointerNearEdgeMarker(display.workArea, marker, edgeHandleSide, point)) revealEdgeWindow();
  }, 100);
  edgePointerTimer.unref?.();
}

function stopEdgePointerWatcher() {
  clearInterval(edgePointerTimer);
  edgePointerTimer = undefined;
}

function hideEdgeWindow() {
  if (!edgeWindow || edgeWindow.isDestroyed()) {
    recordEdgeLifecycle("auto_hide_skipped", { reasonCode: "panel_absent" });
    return;
  }
  const settings = accountService.readSettings();
  if (!settings.edgeWindowDocked) {
    recordEdgeLifecycle("auto_hide_skipped", { reasonCode: "floating" });
    return;
  }
  if (!settings.edgeWindowAutoHide) {
    recordEdgeLifecycle("auto_hide_skipped", { reasonCode: "disabled" });
    return;
  }
  if (edgeCollapsed) {
    recordEdgeLifecycle("auto_hide_skipped", { reasonCode: "already_collapsed" });
    return;
  }
  if (edgeSwitchInProgress) {
    recordEdgeLifecycle("auto_hide_skipped", { reasonCode: "switch_in_progress" });
    return;
  }
  if (edgeWindow.isFocused()) {
    recordEdgeLifecycle("auto_hide_skipped", { reasonCode: "focused" });
    return;
  }
  const display = edgeDisplay();
  const shown = shownEdgeBounds(
    display.workArea,
    edgeWindowSize(settings),
    settings.edgeWindowDockSide,
    settings.edgeWindowY
  );
  const marker = collapsedEdgeBounds(display.workArea, shown, settings.edgeWindowDockSide);
  createEdgeHandleWindow(marker, settings.edgeWindowDockSide);
  recordEdgeLifecycle("auto_hide_executing", { reasonCode: "focus_or_pointer_left" });
  edgeCollapsed = true;
  sendEdgeCollapseState(settings);
  edgeWindow.hide();
  edgeHandleWindow.showInactive();
}

function sendEdgeCollapseState(settings = accountService.readSettings()) {
  if (!edgeWindow || edgeWindow.isDestroyed() || edgeWindow.webContents.isDestroyed()) return;
  edgeWindow.webContents.send("edge:interactionState", {
    active: edgeNativeMoveActive || edgeNativeResizeActive,
    collapsed: edgeCollapsed,
    dockSide: settings.edgeWindowDockSide === "left" ? "left" : "right"
  });
}

function cancelEdgeHide(reasonCode = "cancelled") {
  if (edgeHideTimer) recordEdgeLifecycle("auto_hide_cancelled", { reasonCode });
  clearTimeout(edgeHideTimer);
  edgeHideTimer = undefined;
}

function scheduleEdgeHide(reasonCode = "blur_or_pointer_left") {
  cancelEdgeHide("rescheduled");
  edgeHideTimer = setTimeout(hideEdgeWindow, 650);
  recordEdgeLifecycle("auto_hide_scheduled", { reasonCode });
  edgeHideTimer.unref?.();
}

function saveEdgePlacement(kind = "move") {
  if (edgeCollapsed || !edgeWindow || edgeWindow.isDestroyed()) return;
  const bounds = edgeWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const detectedSide = detectEdgeDock(display.workArea, bounds);
  const side = detectedSide && isDockEdgeExposed(display, screen.getAllDisplays(), detectedSide, bounds)
    ? detectedSide
    : undefined;
  const update = edgePlacementUpdate({
    displayId: display.id,
    workArea: display.workArea,
    bounds,
    side,
    kind,
    currentSize: edgeWindowSize(accountService.readSettings())
  });
  const shown = update.bounds;
  accountService.updateSettings(update.settings);
  recordEdgeLifecycle("placement_saved", {
    reasonCode: kind,
    side,
    bounds: shown
  });
  if (bounds.x !== shown.x || bounds.y !== shown.y || bounds.width !== shown.width || bounds.height !== shown.height) {
    setEdgeBounds(shown);
  }
}

function scheduleEdgePlacementSave(kind = "move") {
  if (edgeCollapsed || edgeInternalMove || !edgeWindow || edgeWindow.isDestroyed()) return;
  edgePendingPlacementKind = edgePendingPlacementKind === "resize" || kind === "resize" ? "resize" : "move";
  clearTimeout(edgeMoveTimer);
  edgeMoveTimer = setTimeout(() => {
    edgeMoveTimer = undefined;
    const pendingKind = edgePendingPlacementKind;
    edgePendingPlacementKind = undefined;
    saveEdgePlacement(pendingKind);
  }, 180);
  edgeMoveTimer.unref?.();
}

function sendEdgeInteractionState() {
  if (!edgeWindow || edgeWindow.isDestroyed()) return;
  edgeWindow.webContents.send("edge:interactionState", {
    active: edgeNativeMoveActive || edgeNativeResizeActive
  });
}

function markEdgeNativeResize() {
  const wasActive = edgeNativeMoveActive || edgeNativeResizeActive;
  edgeNativeResizeActive = true;
  if (!wasActive) {
    recordEdgeLifecycle("resize_started", { reasonCode: "native_resize" });
    sendEdgeInteractionState();
  }
  clearTimeout(edgeNativeResizeTimer);
  edgeNativeResizeTimer = setTimeout(() => {
    edgeNativeResizeActive = false;
    edgeNativeResizeTimer = undefined;
    recordEdgeLifecycle("resize_settled", { reasonCode: "native_resize" });
    sendEdgeInteractionState();
  }, 220);
  edgeNativeResizeTimer.unref?.();
}

function markEdgeNativeMove() {
  if (edgeCollapsed || edgeNativeResizeActive || !edgeWindow || edgeWindow.isDestroyed()) return;
  const wasActive = edgeNativeMoveActive || edgeNativeResizeActive;
  edgeNativeMoveActive = true;
  if (!wasActive) {
    recordEdgeLifecycle("move_started", { reasonCode: "native_move" });
    sendEdgeInteractionState();
  }
  clearTimeout(edgeNativeMoveTimer);
  edgeNativeMoveTimer = setTimeout(() => {
    edgeNativeMoveActive = false;
    edgeNativeMoveTimer = undefined;
    recordEdgeLifecycle("move_settled", { reasonCode: "native_move" });
    sendEdgeInteractionState();
  }, 220);
  edgeNativeMoveTimer.unref?.();
}

function closeEdgeWindow() {
  recordEdgeLifecycle("panel_destroy_requested", { reasonCode: "settings_disabled_or_close" });
  cancelEdgeHide("panel_close");
  edgeCollapsed = false;
  closeEdgeHandleWindow("panel_destroyed");
  clearTimeout(edgeRendererRecoveryTimer);
  edgeRendererRecoveryTimer = undefined;
  edgeRendererRecoveryAttempts = 0;
  if (edgeWindow && !edgeWindow.isDestroyed()) edgeWindow.destroy();
  edgeWindow = undefined;
}

function updateEdgeWindowEnabled(enabled) {
  const settings = accountService.updateSettings({ edgeWindowEnabled: Boolean(enabled) });
  if (settings.edgeWindowEnabled) revealEdgeWindow();
  else closeEdgeWindow();
  updateTrayMenu();
  return settings;
}

function createTray() {
  if (tray && !tray.isDestroyed()) {
    return tray;
  }

  if (tray?.isDestroyed?.()) {
    recordLifecycle("tray_destroyed", "detected_destroyed", "tray");
  }
  tray = undefined;
  tray = new Tray(loadTrayIcon());
  recordLifecycle("tray_created", "created", "tray");
  tray.setToolTip("Secure Codex Switcher");
  updateTrayMenu();
  tray.on("double-click", showMainWindow);
  tray.on("click", showMainWindow);
  return tray;
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const settings = accountService?.readSettings?.() || {};
  const enabled = Boolean(settings.edgeWindowEnabled);
  const english = settings.uiLanguage === "en";
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: english ? "Show main window" : "显示主窗口", click: showMainWindow },
    { label: english ? "Show edge quota window" : "显示边缘额度窗", enabled, click: revealEdgeWindow },
    {
      label: english ? "Enable edge quota window" : "启用边缘额度窗",
      type: "checkbox",
      checked: enabled,
      click: (item) => updateEdgeWindowEnabled(item.checked)
    },
    { type: "separator" },
    { label: english ? "Quit" : "退出应用", click: () => requestAppQuit("tray_menu") }
  ]));
}

function loadTrayIcon() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "tray-icon-2.5.3.png")
    : path.join(__dirname, "..", "build", "icon.png");
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  icon.setTemplateImage(false);
  return icon;
}

function hideToTray() {
  createTray();
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.setSkipTaskbar(true);
  mainWindow.hide();
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = undefined;
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

function ensureTrayRecoveryEntry() {
  try {
    createTray();
    return true;
  } catch (error) {
    appendMainProcessLog("trayRecovery", error);
    return false;
  }
}

function scheduleRendererRecovery() {
  if (rendererRecoveryTimer || !mainWindow || mainWindow.isDestroyed() || isQuitting) return;
  if (rendererRecoveryAttempts >= 3) return;

  rendererRecoveryAttempts += 1;
  rendererRecoveryTimer = setTimeout(() => {
    rendererRecoveryTimer = undefined;
    const target = mainWindow;
    if (!target || target.isDestroyed() || isQuitting) return;
    try {
      target.reload();
    } catch (error) {
      appendMainProcessLog("rendererRecovery", error);
    }
  }, 100);
  rendererRecoveryTimer.unref?.();
}

function scheduleEdgeRendererRecovery() {
  if (edgeRendererRecoveryTimer || isQuitting || !accountService.readSettings().edgeWindowEnabled) return;
  if (edgeRendererRecoveryAttempts >= 3) {
    recordEdgeLifecycle("recovery_failed", {
      reasonCode: "renderer_retry_limit",
      errorCode: "retry_limit",
      recoveryAttempt: edgeRendererRecoveryAttempts
    });
    return;
  }

  edgeRendererRecoveryAttempts += 1;
  const reasonCode = !edgeWindow || edgeWindow.isDestroyed() ? "panel_missing" : "edge_renderer_gone";
  recordEdgeLifecycle("recovery_scheduled", {
    reasonCode,
    errorCode: "renderer_exit",
    recoveryAttempt: edgeRendererRecoveryAttempts
  });
  edgeRendererRecoveryTimer = setTimeout(() => {
    edgeRendererRecoveryTimer = undefined;
    if (isQuitting || !accountService.readSettings().edgeWindowEnabled) return;
    let target = edgeWindow;
    recordEdgeLifecycle("recovery_started", {
      target,
      reasonCode,
      recoveryAttempt: edgeRendererRecoveryAttempts
    });
    try {
      if (!target || target.isDestroyed()) {
        target = createEdgeWindow();
        reprojectEdgeWindows("panel_recovery");
      } else {
        target.reload();
      }
      if (edgeCollapsed) target.hide();
    } catch (error) {
      recordEdgeLifecycle("recovery_failed", {
        target,
        reasonCode: "edge_renderer_reload",
        errorCode: "reload_failed",
        recoveryAttempt: edgeRendererRecoveryAttempts
      });
      appendMainProcessLog("edgeRendererRecovery", error);
    }
  }, 100);
  edgeRendererRecoveryTimer.unref?.();
}

function requestAppQuit(reasonCode = "app_quit") {
  if (!isQuitting) {
    recordLifecycle("quit_requested", reasonCode);
  }
  isQuitting = true;
  lifecyclePhase = "quitting";
  markIntentionalSwitcherExit(watchdog);
  app.quit();
}

function sendMainWindowMessage(channel, payload) {
  try {
    const target = mainWindow;
    if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return false;
    if (payload === undefined) {
      target.webContents.send(channel);
    } else {
      target.webContents.send(channel, payload);
    }
    return true;
  } catch (error) {
    const reasonCode = getMainProcessErrorCode(error);
    if (reasonCode !== "unclassified" && shouldEmitRecoverableIncident(reasonCode)) {
      recordLifecycle("recoverable_error", reasonCode);
    }
    return false;
  }
}

function shouldEmitRecoverableIncident(reasonCode) {
  const key = `${lifecyclePhase}:${reasonCode}`;
  const now = Date.now();
  const previous = recoverableWarningState.get(key);
  if (previous && now - previous < 30_000) return false;
  recoverableWarningState.set(key, now);
  if (recoverableWarningState.size > 64) {
    const oldestKey = recoverableWarningState.keys().next().value;
    recoverableWarningState.delete(oldestKey);
  }
  return true;
}

function recordLifecycle(event, reasonCode = "unspecified", phase = lifecyclePhase) {
  const record = createMainProcessLifecycleRecord({
    event,
    phase,
    reasonCode,
    pid: process.pid,
    version: getRuntimeVersion(),
    packaged: app.isPackaged
  });
  appendMainProcessLifecycleRecord(
    path.join(resolveUserDataPath(), "main-process-lifecycle.jsonl"),
    record
  );
}

function recordEdgeLifecycle(event, {
  surface = "panel",
  target,
  reasonCode = "unspecified",
  side,
  rendererState,
  recoveryAttempt,
  errorCode,
  visible,
  destroyed,
  bounds,
  requestedBounds
} = {}) {
  try {
    const safeSurface = surface === "handle" ? "handle" : "panel";
    const windowTarget = target || (safeSurface === "handle" ? edgeHandleWindow : edgeWindow);
    const snapshot = edgeLifecycleSnapshot(windowTarget);
    const record = createEdgeWindowLifecycleRecord({
      event,
      surface: safeSurface,
      phase: lifecyclePhase,
      reasonCode,
      side: side === "left" || side === "right"
        ? side
        : safeSurface === "handle" ? edgeHandleSide : edgeLastDockSide,
      visible: typeof visible === "boolean" ? visible : snapshot.visible,
      destroyed: typeof destroyed === "boolean" ? destroyed : snapshot.destroyed,
      bounds: bounds || snapshot.bounds,
      requestedBounds,
      contentBounds: windowTarget && !windowTarget.isDestroyed() ? windowTarget.getContentBounds() : undefined,
      scaleFactor: snapshot.bounds ? screen.getDisplayMatching(snapshot.bounds).scaleFactor : undefined,
      rendererState: rendererState || snapshot.rendererState,
      recoveryAttempt,
      errorCode,
      pid: process.pid,
      version: getRuntimeVersion(),
      packaged: app.isPackaged
    });
    edgeLogWriter ??= createEdgeLifecycleWriter(path.join(resolveUserDataPath(), "edge-window-lifecycle.jsonl"));
    edgeLogWriter.append(record);
  } catch {}
}

function edgeLifecycleSnapshot(target) {
  if (!target) return { visible: false, destroyed: true, rendererState: "absent" };
  let destroyed = false;
  let visible = false;
  let bounds;
  let rendererState = "unknown";
  try {
    destroyed = target.isDestroyed();
    if (!destroyed) {
      visible = target.isVisible();
      bounds = target.getBounds();
      const contents = target.webContents;
      rendererState = contents?.isDestroyed?.()
        ? "renderer_destroyed"
        : contents?.isLoading?.() ? "loading" : "ready";
    } else {
      rendererState = "destroyed";
    }
  } catch {
    rendererState = "unknown";
  }
  return { visible, destroyed, bounds, rendererState };
}

function getRuntimeVersion() {
  if (runtimeVersion) return runtimeVersion;
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    if (typeof packageJson.version === "string") runtimeVersion = packageJson.version;
  } catch {}
  if (!runtimeVersion) {
    try {
      runtimeVersion = app.getVersion();
    } catch {}
  }
  return runtimeVersion || "unknown";
}

function resolveUserDataPath() {
  try {
    if (app.commandLine.hasSwitch("user-data-dir")) {
      const explicitPath = app.commandLine.getSwitchValue("user-data-dir").trim();
      if (explicitPath) return path.resolve(explicitPath.replace(/^"(.*)"$/, "$1"));
    }
  } catch {}
  if (defaultUserDataPath) return defaultUserDataPath;
  try {
    return app.getPath("userData");
  } catch {}
  return path.join(process.env.APPDATA || __dirname, "secure-codex-switcher-win");
}

function assertRecoveryOperationId(operationId) {
  if (!Number.isSafeInteger(operationId) || operationId <= 0) {
    throw new Error("Invalid recovery progress request");
  }
}

function assertRecoveryValidationMode(full) {
  if (typeof full !== "boolean") throw new Error("Invalid recovery validation mode");
}

function assertEdgeSender(event) {
  if (!edgeWindow || edgeWindow.isDestroyed() || event.sender !== edgeWindow.webContents) {
    throw new Error("Invalid edge window request");
  }
}

async function getEdgeWindowData() {
  let accounts = await accountService.listAccountsWithQuotaEvidence({ refreshInterruptionEvidence: false });
  const currentId = accounts.find((account) => account.isCurrent)?.id;
  const dismissed = new Set(accountService.getDismissedCompletedThreadIds());
  const [resolved, activity, threads] = await Promise.all([
    currentId ? accountService.resolveAutoSwitchTarget(currentId) : undefined,
    accountService.getCodexActivityStatusForThreads(),
    accountService.searchLocalCodexThreads("")
  ]);
  accounts = await accountService.listAccountsWithQuotaEvidence({ refreshInterruptionEvidence: false });
  const settings = accountService.readSettings();
  const view = buildEdgeQuotaView({ accounts, nextAccountId: resolved?.target?.id, activity, threads });
  return {
    ...view,
    completedTasks: view.completedTasks.filter((thread) => !dismissed.has(thread.threadId)),
    autoHide: settings.edgeWindowAutoHide,
    collapsed: edgeCollapsed,
    docked: settings.edgeWindowDocked,
    dockSide: settings.edgeWindowDockSide,
    autoSwitch: accountService.getAutoSwitchState(),
    continuation: accountService.getAutoResumeStatus()
  };
}

async function switchEdgeWindowAccount(event) {
  assertEdgeSender(event);
  if (edgeSwitchInProgress) return { status: "switch_in_progress", retryable: true, message: "账号切换正在执行，请稍候，不要重复点击。" };
  edgeSwitchInProgress = true;
  cancelEdgeHide();
  const pendingPlacementKind = edgePendingPlacementKind;
  clearTimeout(edgeMoveTimer);
  edgeMoveTimer = undefined;
  edgePendingPlacementKind = undefined;
  saveEdgePlacement(pendingPlacementKind || "move");
  try {
    const accounts = accountService.listAccounts();
    const current = accounts.find((account) => account.isCurrent);
    if (!current) throw new Error("未识别当前账号，无法切换。");
    const resolved = await accountService.resolveAutoSwitchTarget(current.id);
    if (!resolved?.target || resolved.unavailableReason) throw new Error("当前没有可安全切换的下一个账号。");
    const settings = accountService.readSettings();
    if (settings.requireSwitchConfirmation !== false) {
      const answer = await dialog.showMessageBox(edgeWindow, {
        type: "warning",
        buttons: ["取消", "切换账号"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: "确认切换 Codex 账号",
        message: `切换到“${resolved.target.remark || resolved.target.emailMasked || "下一个账号"}”？`,
        detail: "切换会关闭并重新打开 ChatGPT Codex，当前正在执行的任务会被中断。"
      });
      if (answer.response !== 1) return { cancelled: true };
    }
    let result = await accountService.switchAccountPrioritized(resolved.target.id, {
      manualInspection: true,
      resumeQuotaInterruptedTask: true,
      onProgress: (progress) => {
        if (edgeWindow && !edgeWindow.isDestroyed()) edgeWindow.webContents.send("edge:switchProgress", progress);
      }
    });
    if (result?.status === "continuation_in_progress") {
      const forced = await dialog.showMessageBox(edgeWindow, {
        type: "warning",
        buttons: ["取消", "强制切换"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: "续接任务正在执行",
        message: "仍要强制切换账号？",
        detail: "强制切换会停止可取消的续接并保留不确定状态，避免重复提交；其他安全校验仍然执行。"
      });
      if (forced.response !== 1) return { ...result, cancelled: true, message: "已取消强制切换。" };
      result = await accountService.switchAccountPrioritized(resolved.target.id, {
        manualInspection: true,
        resumeQuotaInterruptedTask: true,
        forceSwitch: true,
        onProgress: (progress) => {
          if (edgeWindow && !edgeWindow.isDestroyed()) edgeWindow.webContents.send("edge:switchProgress", progress);
        }
      });
      if (result?.status === "continuation_in_progress") {
        return { ...result, message: "当前续接无法安全停止，强制切换尚未执行。" };
      }
    }
    if (result?.status === "switch_in_progress") {
      return { ...result, message: "账号切换正在执行，请稍候，不要重复点击。" };
    }
    if (result?.status === "projection_blocked") {
      return { ...result, message: "本机任务投影不完整，已阻止切换；请在主窗口检查后重试。" };
    }
    if (result?.verifiedAccountSwitch === true) {
      return { ...result, message: "目标账号认证与 Codex 重新启动均已验证。" };
    }
    if (result?.verifiedTargetAccount === true) {
      return { ...result, message: "目标账号认证已切换，但 Codex 重新启动尚未验证。" };
    }
    return { ...result, message: "切换流程已结束，但目标账号尚未验证，请勿视为切换成功。" };
  } finally {
    edgeSwitchInProgress = false;
    scheduleEdgeHide();
  }
}

function registerIpc() {
  const handlers = {
    "accounts:list": () => accountService.listAccountsWithQuotaEvidence({ refreshInterruptionEvidence: false }),
    "dshAuth:getState": () => accountService.getDshAuthSyncState(),
    "accounts:importCurrent": () => accountService.importCurrentAuth(),
    "accounts:beginAdd": () => accountService.beginAddAccountResponsive(),
    "accounts:completeAdd": (_event, preservedAccountId) => accountService.completeAddAccount(preservedAccountId),
    "accounts:refreshUsage": (_event, accountId, force) => accountService.refreshUsage(accountId, Boolean(force)),
    "accounts:refreshAllUsage": (event, operationId) => {
      if (!Number.isSafeInteger(operationId) || operationId <= 0) throw new Error("Invalid usage refresh request");
      return accountService.refreshAllUsage({
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send("accounts:refreshProgress", { operationId, progress });
        }
      });
    },
    "accounts:switch": (_event, accountId, options) => accountService.switchAccountPrioritized(accountId, options),
    "accounts:delete": (_event, accountId, options) => accountService.deleteAccount(accountId, options),
    "accounts:setHttpOnly": (_event, accountId, enabled) => accountService.setAccountHttpOnlyMode(accountId, Boolean(enabled)),
    "accounts:setDisableGpu": (_event, accountId, enabled) => accountService.setAccountDisableGpuMode(accountId, Boolean(enabled)),
    "accounts:setRemark": (_event, accountId, remark) => accountService.setAccountRemark(accountId, remark),
    "accounts:pickBest": () => accountService.pickBestAccount(),
    "autoSwitch:evaluate": (_event, reason) => accountService.evaluateAutoSwitch(reason),
    "autoSwitch:getState": () => accountService.getAutoSwitchState(),
    "autoSwitch:clearState": () => accountService.clearAutoSwitchState(),
    "autoResume:getStatus": () => accountService.getAutoResumeStatus(),
    "autoSwitch:setTarget": (_event, accountId) => accountService.setAutoSwitchTarget(accountId),
    "autoSwitch:clearTarget": () => accountService.clearAutoSwitchTarget(),
    "autoSwitch:setExcluded": (_event, accountId, excluded) => accountService.setAutoSwitchExcluded(accountId, Boolean(excluded)),
    "autoSwitch:clearExclusions": () => accountService.clearAutoSwitchExclusions(),
    "tokens:stats": (_event, options) => accountService.getTokenUsageStats(options),
    "reports:weekly": (_event, options) => accountService.getWeeklyUsageReport(options),
    "reports:daily": (_event, options) => accountService.getDailyUsageReport(options),
    "reports:clear": () => accountService.clearUsageObservations(),
    "app:getVersion": () => app.getVersion(),
    "transport:getDiagnostics": () => {
      let configText = "";
      let settings = {};
      try {
        configText = fs.readFileSync(path.join(accountService.codexDir, "config.toml"), "utf8");
      } catch {}
      try {
        settings = accountService.readSettings();
      } catch {}
      let environmentProxy = "";
      let windowsProxy = "";
      try {
        // Force the environment-only branch so the Windows registry is kept
        // as a separate evidence source below.
        environmentProxy = resolveProxyUrl(process.env, { platform: "linux" });
      } catch {}
      try {
        windowsProxy = resolveProxyUrl({}, { platform: process.platform });
      } catch {}
      return diagnoseTransport({
        configText,
        switcherHttpOnly: settings,
        environmentProxy,
        windowsProxy
      });
    },
    "settings:read": () => accountService.readSettings(),
    "settings:update": (_event, patch) => {
      const previous = accountService.readSettings().edgeWindowEnabled;
      const settings = accountService.updateSettings(patch);
      if (settings.edgeWindowEnabled !== previous) {
        if (settings.edgeWindowEnabled) revealEdgeWindow();
        else closeEdgeWindow();
        updateTrayMenu();
      }
      if (patch?.uiLanguage === "en" || patch?.uiLanguage === "zh-CN") updateTrayMenu();
      return settings;
    },
    "settings:setHttpOnly": (_event, enabled) => accountService.setHttpOnlyMode(enabled),
    "settings:setDisableGpu": (_event, enabled) => accountService.setDisableGpuMode(Boolean(enabled)),
    "backup:conversations": async (event, operationId) => {
      if (!Number.isSafeInteger(operationId) || operationId <= 0) throw new Error("Invalid conversation backup request");
      try {
        const result = await accountService.runConversationBackup("explicit", {
          onProgress: (progress) => {
            if (!event.sender.isDestroyed()) event.sender.send("backup:conversationProgress", { operationId, progress });
          }
        });
        return {
          counts: {
            active: result?.manifest?.counts?.activeSessions ?? 0,
            archived: result?.manifest?.counts?.archivedSessions ?? 0
          }
        };
      } catch (error) {
        if (error?.code === "CODEX_RUNNING") throw new Error("请完全关闭 ChatGPT Codex 后再创建完整恢复点。");
        throw new Error("Conversation backup failed. Please retry.");
      }
    },
    "backup:listCodexRecovery": async (event, full, operationId) => {
      assertRecoveryValidationMode(full);
      assertRecoveryOperationId(operationId);
      try {
        return await accountService.listCodexRecoveryBackups({
          full,
          onProgress: (progress) => {
            if (!event.sender.isDestroyed()) event.sender.send("backup:recoveryProgress", { operationId, progress });
          }
        });
      } catch {
        throw new Error("Recovery list failed. Please retry.");
      }
    },
    "backup:revalidateQuarantinedConversation": async (event, conversationId, operationId) => {
      assertRecoveryOperationId(operationId);
      try {
        return await accountService.revalidateQuarantinedConversationBackup(conversationId, {
          onProgress: (progress) => {
            if (!event.sender.isDestroyed()) event.sender.send("backup:recoveryProgress", { operationId, progress });
          }
        });
      } catch {
        throw new Error("Quarantined conversation backup revalidation failed. Please retry.");
      }
    },
    "backup:previewCodexRecovery": async (event, selection, operationId) => {
      assertRecoveryOperationId(operationId);
      try {
        return await accountService.previewCodexRecoveryById(selection, {
          onProgress: (progress) => {
            if (!event.sender.isDestroyed()) event.sender.send("backup:recoveryProgress", { operationId, progress });
          }
        });
      } catch {
        throw new Error("Recovery preview failed. Please retry.");
      }
    },
    "backup:prepareCodexReplacement": (_event, selection) => accountService.prepareCodexReplacement(selection),
    "backup:confirmCodexReplacement": (_event, request) => accountService.confirmCodexReplacement(request),
    "app:quit": () => {
      requestAppQuit("ipc_quit");
      return { quitting: true };
    },
    "app:applyCloseDecision": (_event, decision) => {
      const action = decision?.action === "quit" || decision?.action === "tray" ? decision.action : "minimize";
      const remembered = Boolean(decision?.remember);
      if (remembered) {
        accountService.updateSettings({ closeBehavior: action });
      }
      if (action === "quit") {
        requestAppQuit("close_decision_quit");
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
    "app:getCodexActivityStatus": () => accountService.getCodexActivityStatusForThreads(),
    "threads:getSidebarRevision": () => accountService.getCodexThreadSidebarStateRevision(),
    "threads:searchLocal": (_event, query) => accountService.searchLocalCodexThreads(query),
    "edge:getData": async (event) => {
      assertEdgeSender(event);
      return getEdgeWindowData();
    },
    "edge:reportLifecycle": (event, lifecycleEvent, details) => {
      assertEdgeSender(event);
      const safeReason = normalizeEdgeWindowLifecycleToken(details?.reasonCode, "renderer_report");
      const safeError = details?.errorCode === undefined
        ? undefined
        : normalizeEdgeWindowLifecycleToken(details.errorCode, "renderer_error");
      recordEdgeLifecycle(lifecycleEvent, {
        target: edgeWindow,
        reasonCode: safeReason,
        rendererState: normalizeEdgeWindowLifecycleToken(details?.rendererState, "renderer"),
        errorCode: safeError,
        visible: typeof details?.visible === "boolean" ? details.visible : undefined
      });
      return { logged: true };
    },
    "edge:getTokenUsage": async (event, windowName) => {
      assertEdgeSender(event);
      if (windowName !== "fiveHour" && windowName !== "oneWeek") throw new Error("Invalid quota window");
      const accounts = await accountService.listAccountsWithQuotaEvidence();
      const current = accounts.find((account) => account.isCurrent);
      return { totalTokens: await accountService.getEdgeTokenUsage(current?.id, current?.usage, windowName) };
    },
    "edge:pointerEntered": (event, pointerY) => {
      assertEdgeSender(event);
      if (!Number.isFinite(Number(pointerY))) return { visible: false };
      revealEdgeWindow();
      return { visible: true };
    },
    "edge:pointerLeft": (event) => {
      assertEdgeSender(event);
      scheduleEdgeHide();
      return { scheduled: true };
    },
    "edge:setAutoHide": (event, autoHide) => {
      assertEdgeSender(event);
      const settings = accountService.updateSettings({ edgeWindowAutoHide: Boolean(autoHide) });
      if (settings.edgeWindowAutoHide) scheduleEdgeHide();
      else revealEdgeWindow();
      return { autoHide: settings.edgeWindowAutoHide };
    },
    "edge:switchNext": (event) => switchEdgeWindowAccount(event),
    "edge:openThread": async (event, threadId) => {
      assertEdgeSender(event);
      await shell.openExternal(buildCodexThreadUri(threadId));
      return { opened: true };
    },
    "edge:openCompletedThread": async (event, threadId) => {
      assertEdgeSender(event);
      await shell.openExternal(buildCodexThreadUri(threadId));
      return accountService.markCompletedThreadRead(threadId);
    },
    "system:openCodexFolder": () => shell.openPath(accountService.codexDir)
  };

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (...args) => handler(...args));
  }
}

function startConversationBackupMaintenance() {
  const check = () => accountService.runConversationBackup("daily-idle")
    .catch((error) => appendMainProcessLog("conversationBackupMaintenance", error));
  conversationBackupTimer = setInterval(check, 60 * 60 * 1000);
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
    lifecyclePhase = "ready";
    recordLifecycle("app_ready", "ready", "ready");
    accountService = createAccountService(app.getPath("userData"), {
      fetchImpl: createProxyAwareFetch(fetch),
      enableDshAuthSyncStartup: true,
      resumeExecutorMode: "desktop",
      deferStartupMaintenance: true
    });
    watchdog = startSwitcherWatchdog({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      executablePath: process.execPath,
      userDataPath: app.getPath("userData")
    });
    registerIpc();
    startConversationBackupMaintenance();
    createTray();
    createMainWindow();
    createEdgeWindow();
    screen.on("display-added", () => reprojectEdgeWindows("display_added"));
    screen.on("display-removed", () => reprojectEdgeWindows("display_removed"));
    screen.on("display-metrics-changed", () => reprojectEdgeWindows("display_metrics_changed"));
    setTimeout(() => {
      accountService.runStartupMaintenance().catch((error) => handleStartupFailure(error));
    }, 250).unref?.();
    setTimeout(() => {
      accountService.resumeInterruptedAutoResume().catch((error) => appendMainProcessLog("autoResumeRecovery", error));
    }, 250).unref?.();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  }).catch(handleStartupFailure);
}

app.on("before-quit", () => {
  if (edgeLogQuitReady) return;
  if (!isQuitting) {
    recordLifecycle("quit_requested", "electron_quit");
  }
  isQuitting = true;
  markIntentionalSwitcherExit(watchdog);
  lifecyclePhase = "quitting";
  recordEdgeLifecycle("panel_destroy_requested", { reasonCode: "app_quit" });
  cancelEdgeHide("app_quit");
  clearTimeout(edgeMoveTimer);
  clearTimeout(edgeRendererRecoveryTimer);
  clearTimeout(edgeHandleRecoveryTimer);
  edgeRendererRecoveryTimer = undefined;
  edgeHandleRecoveryTimer = undefined;
  edgeHandleRecoveryAttempts = 0;
  if (tray && !tray.isDestroyed()) {
    try {
      tray.destroy();
      recordLifecycle("tray_destroyed", "app_quit", "tray");
    } catch {}
    tray = undefined;
  }
  accountService?.disposeDshAuthSync?.();
  clearInterval(conversationBackupTimer);
  stopEdgePointerWatcher();
  stopBackgroundJobs();
});

app.on("will-quit", (event) => {
  if (edgeLogQuitReady || !edgeLogWriter) return;
  event.preventDefault();
  void edgeLogWriter.flush().then((ok) => {
    if (!ok) recordLifecycle("edge_error", "edge_log_flush_failed");
  }).finally(() => { edgeLogQuitReady = true; app.quit(); });
});

app.on("window-all-closed", () => {
  if (process.platform === "darwin") return;
  if (shouldQuitAfterAllWindowsClosed({ platform: process.platform, isQuitting })) {
    if (!isQuitting) requestAppQuit("all_windows_closed");
    return;
  }
  lifecyclePhase = "background";
  ensureTrayRecoveryEntry();
});
