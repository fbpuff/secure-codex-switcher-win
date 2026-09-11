import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const preload = fs.readFileSync(new URL("../src/edge-preload.cjs", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../src/renderer/edge-window.js", import.meta.url), "utf8");
const dashboard = fs.readFileSync(new URL("../src/renderer/app.js", import.meta.url), "utf8");
const accountService = fs.readFileSync(new URL("../src/services/account-service.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../src/renderer/edge-window.html", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/renderer/edge-window.css", import.meta.url), "utf8");
const handleHtml = fs.readFileSync(new URL("../src/renderer/edge-handle.html", import.meta.url), "utf8");
const handleStyles = fs.readFileSync(new URL("../src/renderer/edge-handle.css", import.meta.url), "utf8");

test("edge token response cannot populate a different account after a switch", async () => {
  const callbacks = {};
  let resolveUsage;
  const context = {
    tokenAccountId: "account-a", tokenDetails: { fiveHour: false, oneWeek: false }, tokenValues: {},
    api: { getTokenUsage: () => new Promise((resolve) => { resolveUsage = resolve; }) },
    document: { querySelector: (id) => ({ addEventListener: (event, callback) => { callbacks[id + event] = callback; } }) },
    renderTokenDetail: () => {}, setStatus: () => {}
  };
  const setup = app.slice(app.indexOf('for (const [key, id]'), app.indexOf('document.addEventListener("pointerenter"'));
  vm.runInNewContext(setup, context);
  callbacks["#five-hour-meterclick"]();
  context.tokenAccountId = "account-b";
  resolveUsage({ totalTokens: 123 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(Object.hasOwn(context.tokenValues, "fiveHour"), false);
});

test("edge recovery recreates a missing enabled panel but respects disable and quit", () => {
  const recovery = main.match(/function scheduleEdgeRendererRecovery\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(recovery);
  for (const disabled of [false, true]) {
    for (const quitting of [false, true]) {
      let created = 0;
      const context = {
        edgeRendererRecoveryTimer: undefined, edgeWindow: undefined, isQuitting: quitting,
        edgeRendererRecoveryAttempts: 0, edgeCollapsed: false,
        accountService: { readSettings: () => ({ edgeWindowEnabled: !disabled }) },
        recordEdgeLifecycle: () => {}, appendMainProcessLog: () => {},
        createEdgeWindow: () => { created++; return { isDestroyed: () => false }; },
        reprojectEdgeWindows: () => {}, setTimeout: (fn) => { context.pending = fn; return { unref() {} }; }
      };
      vm.runInNewContext(recovery + "\nscheduleEdgeRendererRecovery();", context);
      context.pending?.();
      assert.equal(created, !disabled && !quitting ? 1 : 0);
    }
  }
  const closeBody = main.slice(main.indexOf('recordEdgeLifecycle("panel_closed"'), main.indexOf("function setEdgeHandleSide"));
  assert.match(closeBody, /scheduleEdgeRendererRecovery\(\)/);
});

test("main process owns one secure frameless edge window and exact thread opener", () => {
  assert.match(main, /frame:\s*false/);
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /edge:getData/);
  assert.match(main, /edge:openThread/);
  assert.match(main, /buildCodexThreadUri/);
  assert.match(main, /target\.on\("will-move", markEdgeNativeMove\)/);
  assert.match(main, /target\.on\("move", \(\) => \{\s+if \(!edgeInternalMove && !edgeNativeResizeActive\) markEdgeNativeMove\(\)/);
  const nativeMoveMarker = main.match(/function markEdgeNativeMove\(\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.doesNotMatch(nativeMoveMarker, /preventDefault|setEdgeBounds|updateSettings/);
  assert.match(main, /screen\.getCursorScreenPoint\(\)/);
  assert.match(main, /startEdgePointerWatcher\(\)/);
  assert.match(main, /isPointerNearEdgeMarker/);
  assert.match(main, /const marker = collapsedEdgeBounds\(/);
  assert.match(main, /let edgeHandleWindow/);
  assert.match(main, /function createEdgeHandleWindow\(bounds,\s*side\)/);
  assert.match(main, /focusable:\s*false/);
  assert.match(main, /resizable:\s*false/);
  assert.match(main, /transparent:\s*true/);
  assert.match(main, /backgroundColor:\s*"#00000000"/);
  assert.doesNotMatch(main, /backgroundColor:\s*"#55789f"/);
  assert.match(main, /target\.loadFile\(\s*path\.join\(__dirname,\s*"renderer",\s*"edge-handle\.html"\),\s*\{\s*hash:\s*requestedSide\s*\}\s*\)/);
  assert.match(main, /createEdgeHandleWindow\(marker,\s*settings\.edgeWindowDockSide\)/);
  assert.equal((handleHtml.match(/class="edge-handle"/g) ?? []).length, 2);
  assert.match(handleHtml, /id="left"/);
  assert.match(handleHtml, /id="right"/);
  assert.match(handleStyles, /\.edge-handle\s*\{[^}]*width:\s*12px;[^}]*height:\s*72px;[^}]*background:\s*#55789f;/s);
  assert.match(handleStyles, /#left:target\s*\{[^}]*display:\s*block;[^}]*left:\s*0;/s);
  assert.match(handleStyles, /#right:target\s*\{[^}]*display:\s*block;[^}]*right:\s*0;/s);
  assert.match(main, /edgeWindow\.hide\(\)/);
  assert.match(main, /edgeHandleWindow\.showInactive\(\)/);
  assert.doesNotMatch(main, /hiddenEdgeBounds/);
  assert.match(main, /resizable:\s*true/);
  assert.match(main, /minWidth:\s*EDGE_WINDOW_MIN_WIDTH/);
  assert.match(main, /minHeight:\s*EDGE_WINDOW_MIN_HEIGHT/);
  assert.match(main, /target\.on\("will-resize", \(event\) => \{\s+if \(edgeNativeMoveActive\) \{\s+recordEdgeLifecycle\("resize_settled"/);
  assert.match(main, /if \(!edgeInternalMove && !edgeNativeResizeActive\) markEdgeNativeMove\(\)/);
  assert.match(main, /if \(edgeCollapsed \|\| edgeNativeResizeActive \|\| !edgeWindow \|\| edgeWindow\.isDestroyed\(\)\) return/);
  assert.match(main, /edgePendingPlacementKind === "resize" \|\| kind === "resize"/);
  assert.match(main, /target\.on\("resize", \(\) => scheduleEdgePlacementSave\(edgeNativeResizeActive \? "resize" : "move"\)\)/);
  assert.doesNotMatch(main, /edgeNativeMoveActive \? "move" : "resize"/);
  assert.match(main, /if \(edgeCollapsed \|\| edgeInternalMove/);
  assert.match(main, /edgePlacementUpdate/);
  assert.match(main, /restoredEdgeBounds/);
  assert.match(main, /edgeWindowDocked/);
  assert.match(main, /edgeWindowX/);
  assert.match(main, /edge:interactionState/);
  assert.doesNotMatch(main, /edgeSnapActive|animateEdgeSnap|interpolateEdgeBounds/);
  assert.match(main, /if \(!settings\.edgeWindowDocked\) \{/);
  assert.match(main, /edgeInternalMove = false;[\s\S]*edgeNativeMoveActive = false;[\s\S]*edgeNativeResizeActive = false;/);
  assert.match(main, /edgeWindowSize\(settings\)/);
  assert.match(main, /return normalizeEdgeWindowSize\(/);
  assert.match(main, /saveEdgePlacement\(pendingKind\);\s+\}, 180\);/);
  assert.match(main, /edgePendingPlacementKind = undefined;\s+edgeInternalMove = false;\s+edgeInternalMoveTimer = undefined;\s+edgeNativeMoveActive = false;\s+edgeNativeMoveTimer = undefined;\s+edgeNativeResizeActive = false;\s+edgeNativeResizeTimer = undefined;/);
  assert.match(html, /class="drag-grip"[^>]*id="drag-grip"[^>]*>拖动窗口<\/span>/);
  assert.match(styles, /\.window-controls[^}]*-webkit-app-region: drag/);
  assert.match(styles, /\.account-strip[^}]*-webkit-app-region: drag/);
  assert.match(styles, /\.window-controls[^}]*min-height: 32px/);
  assert.doesNotMatch(styles, /\.drag-grip \{ -webkit-app-region: drag; \}/);
  assert.doesNotMatch(styles, /\.account-block[^}]*-webkit-app-region: drag/);
  assert.match(styles, /\.drag-grip[^}]*cursor: move/);
});

test("collapsed handle survives display changes and edge renderer exits", () => {
  assert.match(main, /screen\.on\("display-added", \(\) => reprojectEdgeWindows\("display_added"\)\)/);
  assert.match(main, /screen\.on\("display-removed", \(\) => reprojectEdgeWindows\("display_removed"\)\)/);
  assert.match(main, /screen\.on\("display-metrics-changed", \(\) => reprojectEdgeWindows\("display_metrics_changed"\)\)/);
  assert.match(main, /function reprojectEdgeWindows\(reasonCode = "display_change"\)/);
  assert.match(main, /positionEdgeHandle\(edgeHandleWindow, bounds, side\)/);
  assert.doesNotMatch(main, /edgeHandleWindow\.setBounds\(marker, false\)/);
  assert.match(main, /target\.webContents\.on\("render-process-gone"/);
  assert.match(main, /scheduleEdgeRendererRecovery\(\)/);
});

test("edge preload exposes only compact window operations", () => {
  assert.match(preload, /getData/);
  assert.match(preload, /getTokenUsage/);
  assert.match(preload, /switchNextAccount/);
  assert.match(preload, /openThread/);
  assert.match(preload, /pointerEntered/);
  assert.match(preload, /pointerLeft/);
  assert.match(preload, /openCompletedThread/);
  assert.match(preload, /onSwitchProgress/);
  assert.match(preload, /onInteractionState/);
  assert.doesNotMatch(preload, /setDockSide/);
  assert.match(preload, /setAutoHide/);
  assert.doesNotMatch(preload, /setPinned/);
  assert.doesNotMatch(preload, /ipcRenderer\.send/);
});

test("edge switching stays visible, resumes unfinished work, and rejects duplicate clicks", () => {
  assert.match(main, /let edgeSwitchInProgress = false/);
  assert.match(main, /if \(!settings\.edgeWindowAutoHide\)/);
  assert.match(main, /if \(edgeCollapsed\)/);
  assert.match(main, /if \(edgeSwitchInProgress\)/);
  assert.match(main, /if \(edgeWindow\.isFocused\(\)/);
  assert.match(app, /#auto-hide-window/);
  assert.match(html, />自动收起<\/label>/);
  assert.match(app, /已吸附 · 拖动调整位置/);
  assert.doesNotMatch(app, /已吸附左侧|已吸附右侧/);
  assert.match(main, /resumeQuotaInterruptedTask:\s*true/);
  assert.match(main, /verifiedAccountSwitch/);
  assert.match(main, /edge:switchProgress/);
  assert.match(app, /setInterval\(renderSwitchProgress, 250\)/);
  assert.match(app, /Date\.now\(\) - Math\.max\(0, progress\.elapsedMs\)/);
  assert.match(main, /forceSwitch:\s*true/);
  assert.match(main, /强制切换/);
  assert.match(main, /refreshInterruptionEvidence:\s*false/);
  assert.match(accountService, /options\.projectionValidated !== true/);
  assert.match(accountService, /projectionValidated:\s*options\.manualInspection === true/);
  assert.match(accountService, /operation\.cancel = \(\) =>/);
  assert.match(accountService, /child\?\.kill\(\)/);
  assert.doesNotMatch(main, /resumeQuotaInterruptedTask:\s*false/);
  assert.match(app, /let switchInProgress = false/);
  assert.match(app, /if \(switchInProgress\) return/);
  assert.match(app, /switchButton\.disabled = switchInProgress \|\| !view\?\.next\?\.id/);
  assert.match(app, /validating_projection/);
  assert.match(app, /let interactionPaused = false/);
  assert.match(app, /onInteractionState/);
  assert.doesNotMatch(app, /document\.documentElement\.dataset\.collapsed/);
  assert.doesNotMatch(app, /document\.documentElement\.dataset\.dockSide/);
  assert.match(app, /if \(!interactionPaused && timestamp - lastAnimationFrame >= 100\)/);
  assert.match(app, /setInterval\(\(\) => \{ if \(!interactionPaused\) void loadData\(false\); \}, 2_000\)/);
  assert.doesNotMatch(app, /loadData\(true\)/);
  assert.doesNotMatch(main, /refreshUsage\(current\.id, true\)/);
  assert.match(main, /accounts = await accountService\.listAccountsWithQuotaEvidence\(\{ refreshInterruptionEvidence: false \}\);\s+const settings = accountService\.readSettings\(\);/);
});

test("main and edge windows render the same shared continuation countdown", () => {
  assert.match(main, /autoSwitch:\s*accountService\.getAutoSwitchState\(\)/);
  assert.match(main, /continuation:\s*accountService\.getAutoResumeStatus\(\)/);
  assert.match(app, /formatContinuationProgress\(view\?\.continuation/);
  assert.match(app, /phaseRemainingSeconds/);
  assert.match(app, /queueRemainingUpperBoundSeconds/);
  assert.match(app, /invoke_no_effect: "首次发送未生效，正在安全重试"/);
  assert.match(app, /fallback_invoke_started: "已执行备用发送，正在核验结果"/);
  assert.match(dashboard, /formatAutoResumeProgress/);
  assert.match(dashboard, /invoke_no_effect: "status\.autoResumePhaseInvokeNoEffect"/);
  assert.match(dashboard, /fallback_invoke_started: "status\.autoResumePhaseFallbackInvokeStarted"/);
  assert.match(dashboard, /setTimeout\(resolve, 1_000\)/);
  assert.match(dashboard, /phaseRemainingSeconds/);
  assert.match(dashboard, /queueRemainingUpperBoundSeconds/);
});

test("compact renderer has two responsive liquid meters and low-quota treatment", () => {
  assert.match(html, /id="five-hour-meter"/);
  assert.equal((html.match(/官方剩余/g) ?? []).length, 2);
  assert.match(app, /quota\?\.executionLimited \? "执行受限" : "额度不足"/);
  assert.match(app, /view\?\.quota\?\.availability === "execution_limited"/);
  assert.match(html, /id="one-week-meter"/);
  assert.match(html, /<canvas/);
  assert.doesNotMatch(html, /class="edge-handle"/);
  assert.match(app, /is-low/);
  assert.doesNotMatch(app, /meter\.hidden/);
  assert.doesNotMatch(app, /dismissedCompletedTasks/);
  assert.match(app, /pointermove/);
  assert.match(app, /pointerenter[\s\S]*Math\.abs\(event\.clientY - window\.innerHeight \/ 2\) <= 36/);
  assert.doesNotMatch(html, /id="move-edge"/);
  assert.doesNotMatch(app, /localStorage\.setItem/);
  assert.match(app, /api\.getTokenUsage/);
  assert.match(app, /nextTokenAccountId !== tokenAccountId/);
  assert.match(app, /delete tokenValues\.fiveHour/);
  assert.match(app, /api\.openCompletedThread/);
  assert.match(main, /completedTasks:\s*view\.completedTasks\.filter/);
  assert.match(main, /getDismissedCompletedThreadIds\(\)/);
  assert.match(main, /markCompletedThreadRead\(threadId\)/);
  assert.match(app, /\["quota", "continuation", "auto-switch"\]\.includes\(statusSource\)/);
  assert.match(app, /quota\?\.executionLimited/);
  assert.match(accountService, /executionLimitSource:\s*"codex_usage_limit_exceeded"/);
  assert.match(dashboard, /quota\.pendingSwitchLimited/);
  assert.match(dashboard, /quota\.executionLimited/);
  assert.match(html, /查看当前账号 5 小时周期 token/);
  assert.match(app, /本次账号周期内/);
  assert.doesNotMatch(html, /data-collapsed|data-dock-side/);
  assert.doesNotMatch(styles, /data-collapsed|data-dock-side|edge-handle/);
  assert.doesNotMatch(styles, /@media\s*\(\s*max-width/);
  assert.doesNotMatch(styles, /translateX/);
  assert.doesNotMatch(styles, /panel-in-left|border-radius:\s*0 18px 18px 0|border-radius:\s*18px 0 0 18px/);
});

test("minimum-height edge content remains reachable through a visible right-side scroller", () => {
  assert.match(html, /<div class="edge-content" id="edge-content">/);
  assert.match(html, /id="edge-content"[\s\S]*id="completed-tasks"[\s\S]*id="status"/);
  assert.match(styles, /\.edge-panel\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*auto minmax\(0,1fr\);[^}]*overflow:\s*hidden;/s);
  assert.match(styles, /\.edge-content\s*\{[^}]*min-height:\s*0;[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*scroll;[^}]*scrollbar-gutter:\s*stable;/s);
  assert.match(styles, /\.edge-content::-webkit-scrollbar\s*\{[^}]*width:\s*10px;/s);
  assert.match(styles, /\.edge-content::-webkit-scrollbar-thumb\s*\{[^}]*background:/s);
  assert.match(styles, /\.edge-content\s*\{[^}]*-webkit-app-region:\s*no-drag;/s);
  assert.match(styles, /\.account-strip\s*\{[^}]*-webkit-app-region:\s*drag;/s);
});

test("edge lifecycle diagnostics cover disappearance and recovery paths", () => {
  assert.match(main, /edge-window-lifecycle\.jsonl/);
  assert.match(main, /createEdgeWindowLifecycleRecord/);
  assert.match(main, /panel_hidden/);
  assert.match(main, /panel_closed/);
  assert.match(main, /panel_renderer_gone/);
  assert.match(main, /handle_created/);
  assert.match(main, /handle_hidden/);
  assert.match(main, /handle_closed/);
  assert.match(main, /handle_renderer_gone/);
  assert.match(main, /auto_hide_scheduled/);
  assert.match(main, /auto_hide_skipped/);
  assert.match(main, /reproject_applied/);
  assert.match(main, /recovery_scheduled/);
  assert.match(main, /let edgeHandleRecoveryAttempts = 0;/);
  assert.match(main, /edgeHandleRecoveryAttempts \+= 1;/);
  assert.match(main, /move_started/);
  assert.match(main, /move_settled/);
  assert.match(main, /resize_started/);
  assert.match(main, /resize_settled/);
  assert.match(main, /edge:reportLifecycle/);
  assert.match(preload, /reportLifecycle/);
  assert.match(app, /renderer_boot/);
  assert.match(app, /renderer_visibility/);
  assert.match(app, /renderer_pagehide/);
  assert.match(app, /renderer_error/);
  assert.match(app, /renderer_unhandled_rejection/);
});
