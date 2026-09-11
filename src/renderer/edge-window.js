const api = window.edgeSwitcher;
import { formatBeijingTime } from "../core/beijing-time.js";
function reportLifecycle(event, details = {}) {
  try {
    const pending = api.reportLifecycle?.(event, details);
    pending?.catch?.(() => {});
  } catch {}
}

reportLifecycle("renderer_boot", { reasonCode: "boot", rendererState: "boot" });
document.addEventListener("visibilitychange", () => {
  const state = document.visibilityState === "hidden" ? "hidden" : "visible";
  reportLifecycle("renderer_visibility", { reasonCode: state, rendererState: state, visible: state === "visible" });
});
window.addEventListener("pagehide", () => reportLifecycle("renderer_pagehide", { reasonCode: "pagehide", rendererState: "unloading" }));
window.addEventListener("error", () => reportLifecycle("renderer_error", { reasonCode: "window_error", errorCode: "window_error" }));
window.addEventListener("unhandledrejection", () => reportLifecycle("renderer_unhandled_rejection", { reasonCode: "promise_rejection", errorCode: "unhandled_rejection" }));
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const meters = {
  fiveHour: document.querySelector("#five-hour-meter"),
  oneWeek: document.querySelector("#one-week-meter")
};
let currentView;
let currentViewSignature;
let phases = { fiveHour: 0, oneWeek: 2.2 };
let dataLoading = false;
let switchInProgress = false;
let interactionPaused = false;
let pointerInside = false;
let revealState = "idle";
let tokenAccountId;
let statusSource = "idle";
let switchElapsedStartedAt;
let switchElapsedTimer;
let switchPhaseText = "正在执行账号切换…";
const tokenDetails = { fiveHour: false, oneWeek: false };
const tokenValues = {};
const switchProgressText = {
  validating_projection: "正在校验本地任务状态…",
  preparing_continuation: "正在识别需要续接的任务…",
  switching_auth: "正在安全替换目标账号认证…",
  launching_codex: "认证已替换，正在重新打开 Codex…",
  verifying_target: "正在验证目标账号和 Codex 进程…",
  completed: "切换事务已结束，正在确认结果…"
};
const continuationProgressText = {
  prepared: "等待开始续接",
  launch_verified: "正在连接 Codex Desktop",
  waiting_for_desktop: "等待 Codex Desktop 可用",
  deep_link_opened: "正在查找任务输入框和发送按钮",
  window_scan_started: "正在查找任务输入框和发送按钮",
  window_scan_completed: "正在查找任务输入框和发送按钮",
  composer_scan_started: "正在查找任务输入框和发送按钮",
  composer_scan_completed: "正在查找任务输入框和发送按钮",
  window_restored: "已恢复目标任务窗口",
  composer_found: "已找到任务输入框",
  submit_found: "已找到发送按钮",
  focus_verified: "正在核验目标任务焦点",
  invoke_started: "已调用发送，正在核验结果",
  invoke_no_effect: "首次发送未生效，正在安全重试",
  fallback_invoke_started: "已执行备用发送，正在核验结果",
  prompt_consumed: "消息已离开输入框，正在核验任务记录"
};

api.onSwitchProgress?.((progress) => {
  if (!switchInProgress) return;
  if (Number.isFinite(progress?.elapsedMs)) switchElapsedStartedAt = Date.now() - Math.max(0, progress.elapsedMs);
  switchPhaseText = switchProgressText[progress?.phase] || "正在执行账号切换…";
  renderSwitchProgress();
});

api.onInteractionState?.((state) => {
  const wasPaused = interactionPaused;
  interactionPaused = Boolean(state?.active);
  if (wasPaused && !interactionPaused) void loadData(false);
});

for (const [key, id] of [["fiveHour", "five-hour-meter"], ["oneWeek", "one-week-meter"]]) {
  const meter = document.querySelector(`#${id}`);
  const toggle = async () => {
    tokenDetails[key] = !tokenDetails[key];
    renderTokenDetail(key);
    if (!tokenDetails[key] || Object.hasOwn(tokenValues, key)) return;
    const requestedAccountId = tokenAccountId;
    try {
      const totalTokens = (await api.getTokenUsage(key))?.totalTokens;
      if (requestedAccountId !== tokenAccountId) return;
      tokenValues[key] = totalTokens;
      renderTokenDetail(key);
    } catch (error) {
      if (requestedAccountId !== tokenAccountId) return;
      tokenDetails[key] = false;
      setStatus(error?.message || "暂时无法统计当前账号 token");
      renderTokenDetail(key);
    }
  };
  meter.addEventListener("click", () => void toggle());
  meter.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void toggle(); }
  });
}

document.addEventListener("pointerenter", (event) => {
  pointerInside = true;
  if (Math.abs(event.clientY - window.innerHeight / 2) <= 36) requestReveal(event.clientY);
});
document.addEventListener("pointermove", (event) => {
  if (Math.abs(event.clientY - window.innerHeight / 2) <= 36) requestReveal(event.clientY);
});
document.addEventListener("pointerleave", () => {
  pointerInside = false;
  revealState = "idle";
  void api.pointerLeft();
});
document.querySelector("#auto-hide-window").addEventListener("change", (event) => void api.setAutoHide(event.target.checked));
const switchButton = document.querySelector("#switch-account");
switchButton.addEventListener("click", async () => {
  if (switchInProgress) return;
  switchInProgress = true;
  switchButton.disabled = true;
  startSwitchProgress();
  try {
    const result = await api.switchNextAccount();
    setStatus(result?.cancelled ? "已取消切换" : result?.message || "切换流程已完成");
    await loadData(false);
  } catch (error) {
    setStatus(error?.message || "暂时无法切换账号");
  } finally {
    stopSwitchProgress();
    switchInProgress = false;
    switchButton.disabled = !currentView?.next?.id;
  }
});

function startSwitchProgress() {
  switchElapsedStartedAt = Date.now();
  switchPhaseText = "正在准备安全切换…";
  renderSwitchProgress();
  clearInterval(switchElapsedTimer);
  switchElapsedTimer = setInterval(renderSwitchProgress, 250);
}

function stopSwitchProgress() {
  clearInterval(switchElapsedTimer);
  switchElapsedTimer = undefined;
  switchElapsedStartedAt = undefined;
}

function renderSwitchProgress() {
  if (!switchInProgress || !Number.isFinite(switchElapsedStartedAt)) return;
  const seconds = Math.max(0, Math.floor((Date.now() - switchElapsedStartedAt) / 1000));
  setStatus(`${switchPhaseText}（${seconds} 秒）`);
}

async function loadData(refreshCurrent) {
  if (dataLoading || interactionPaused) return;
  dataLoading = true;
  try {
    const nextView = await api.getData(refreshCurrent);
    if (interactionPaused) return;
    const nextSignature = JSON.stringify(nextView);
    if (nextSignature !== currentViewSignature) {
      currentView = nextView;
      currentViewSignature = nextSignature;
      render(currentView);
    }
  } catch (error) {
    setStatus(error?.message || "暂时无法读取额度");
  } finally {
    dataLoading = false;
  }
}

function render(view) {
  const nextTokenAccountId = view?.current?.id;
  if (nextTokenAccountId !== tokenAccountId) {
    tokenAccountId = nextTokenAccountId;
    tokenDetails.fiveHour = false;
    tokenDetails.oneWeek = false;
    delete tokenValues.fiveHour;
    delete tokenValues.oneWeek;
  }
  document.querySelector("#current-account").textContent = view?.current?.label || "未识别";
  document.querySelector("#next-account").textContent = view?.next?.label || "暂无可用账号";
  switchButton.disabled = switchInProgress || !view?.next?.id;
  document.querySelector("#auto-hide-window").checked = Boolean(view?.autoHide);
  const docked = view?.docked !== false;
  document.documentElement.dataset.docked = docked ? "true" : "false";
  document.querySelector("#drag-grip").textContent = docked
    ? "已吸附 · 拖动调整位置"
    : "自由位置 · 拖动窗口";
  renderMeter("fiveHour", view?.quota?.fiveHour);
  renderMeter("oneWeek", view?.quota?.oneWeek);
  renderTokenDetail("fiveHour");
  renderTokenDetail("oneWeek");
  renderTasks("active-tasks", "active-count", view?.activeTasks, false);
  renderTasks("completed-tasks", "completed-count", view?.completedTasks, true);
  const continuationMessage = formatContinuationProgress(view?.continuation);
  const autoSwitchMessage = formatAutoSwitchProgress(view?.autoSwitch);
  const remaining = [view?.quota?.fiveHour, view?.quota?.oneWeek]
    .filter(Boolean)
    .map((window) => window.remainingPercent)
    .filter(Number.isFinite);
  if (continuationMessage) {
    setStatus(continuationMessage, "continuation");
  } else if (autoSwitchMessage) {
    setStatus(autoSwitchMessage, "auto-switch");
  } else if (view?.quota?.availability === "execution_limited" && remaining.length) {
    setStatus(`Codex 已返回额度限制；官方快照仍显示剩余 ${formatPercent(Math.min(...remaining))}%，当前周期按执行受限处理`, "quota");
  } else if (!view?.quota?.current) {
    setStatus(view?.quota?.state === "stale" ? "额度快照已过期，正在等待刷新" : "当前额度不可用", "quota");
  } else if (["quota", "continuation", "auto-switch"].includes(statusSource)) {
    setStatus("", "idle");
  }
}

function renderTokenDetail(key) {
  const id = key === "fiveHour" ? "five-hour-tokens" : "one-week-tokens";
  const collapsed = key === "fiveHour" ? "点击查看本周期 token" : "点击查看本周 token";
  const value = tokenValues[key];
  document.querySelector(`#${id}`).textContent = !tokenDetails[key]
    ? collapsed
    : !Object.hasOwn(tokenValues, key)
      ? "正在统计当前账号…"
      : Number.isFinite(value) ? `本次账号周期内 · ${value.toLocaleString()} tokens` : "当前账号周期 token 不可用";
}

async function requestReveal(pointerY) {
  if (revealState !== "idle") return;
  revealState = "pending";
  try {
    const result = await api.pointerEntered(pointerY);
    revealState = pointerInside && result?.visible ? "visible" : "idle";
  } catch {
    revealState = "idle";
  }
}

function renderMeter(key, quota) {
  const meter = meters[key];
  const value = meter.querySelector(".liquid-label strong");
  meter.classList.toggle("is-low", Boolean(quota?.low || quota?.executionLimited));
  meter.querySelector(".liquid-label em").textContent = quota?.executionLimited ? "执行受限" : "额度不足";
  value.textContent = Number.isFinite(quota?.remainingPercent) ? `${formatPercent(quota.remainingPercent)}%` : "—";
  meter.querySelector("time").textContent = `预计重置：${formatReset(quota?.resetAt)}`;
  meter.querySelector("canvas").setAttribute("aria-label", `${key === "fiveHour" ? "5 小时" : "7 天"}剩余额度${value.textContent}`);
  drawMeter(key, quota);
}

function renderTasks(listId, countId, tasks = [], completed) {
  const list = document.querySelector(`#${listId}`);
  const safeTasks = Array.isArray(tasks) ? tasks : [];
  document.querySelector(`#${countId}`).textContent = `${safeTasks.length} 个项目`;
  if (!safeTasks.length) {
    const empty = document.createElement("div");
    empty.className = "empty-tasks";
    empty.textContent = completed ? "暂无最近完成项目" : "当前没有运行中的项目";
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...safeTasks.map((task) => taskRow(task, completed)));
}

function taskRow(task, completed) {
  const row = document.createElement(task.threadId ? "button" : "div");
  if (task.threadId) row.type = "button";
  row.className = `task-row${completed ? " completed" : ""}`;
  const dot = document.createElement("span");
  dot.className = "task-dot";
  const copy = document.createElement("span");
  copy.className = "task-copy";
  const title = document.createElement("strong");
  title.textContent = task.title;
  const detail = document.createElement("small");
  detail.textContent = completed ? formatCompleted(task.updatedAtMs) : "进行中";
  copy.append(title, detail);
  const action = document.createElement("span");
  action.className = "task-action";
  action.textContent = task.threadId ? "打开 Codex ›" : "仅显示";
  row.append(dot, copy, action);
  if (task.threadId) row.addEventListener("click", async () => {
    try {
      if (completed) {
        await api.openCompletedThread(task.threadId);
        await loadData(false);
      } else {
        await api.openThread(task.threadId);
      }
      setStatus(`已请求打开“${task.title}”`);
    } catch (error) {
      setStatus(error?.message || "无法打开该任务");
    }
  });
  return row;
}

function drawMeter(key, quota) {
  const canvas = meters[key].querySelector("canvas");
  const ctx = canvas.getContext("2d");
  const size = canvas.width;
  const center = size / 2;
  const radius = size * .405;
  const remaining = Number.isFinite(quota?.remainingPercent) ? Math.max(0, Math.min(100, quota.remainingPercent)) : 0;
  const low = remaining < 10 && quota;
  const colors = low
    ? { shell: "rgba(181,116,36,.34)", glow: "rgba(211,151,67,.24)", top: "#f0bd6a", bottom: "#c98325", empty: "rgba(181,116,36,.065)" }
    : { shell: "rgba(82,123,183,.27)", glow: "rgba(82,123,183,.20)", top: "#739fe1", bottom: "#4776bd", empty: "rgba(82,123,183,.05)" };
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.shadowColor = colors.glow;
  ctx.shadowBlur = low ? 30 : 22;
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.fillStyle = colors.empty;
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.clip();
  const baseline = center + radius - radius * 2 * (remaining / 100);
  const gradient = ctx.createLinearGradient(0, baseline - 20, 0, center + radius);
  gradient.addColorStop(0, colors.top);
  gradient.addColorStop(1, colors.bottom);
  ctx.beginPath();
  ctx.moveTo(center - radius - 5, center + radius + 5);
  for (let x = center - radius - 5; x <= center + radius + 5; x += 3) {
    ctx.lineTo(x, baseline + Math.sin(x / 20 + phases[key]) * (low ? 7 : 5) + Math.sin(x / 35 - phases[key] * .7) * 2.5);
  }
  ctx.lineTo(center + radius + 5, center + radius + 5);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.lineWidth = low ? 4 : 2.5;
  ctx.strokeStyle = colors.shell;
  ctx.stroke();
}

let lastAnimationFrame = 0;
function animate(timestamp) {
  if (!interactionPaused && timestamp - lastAnimationFrame >= 100) {
    lastAnimationFrame = timestamp;
    phases.fiveHour += .21;
    phases.oneWeek += .144;
    drawMeter("fiveHour", currentView?.quota?.fiveHour);
    drawMeter("oneWeek", currentView?.quota?.oneWeek);
  }
  requestAnimationFrame(animate);
}

function formatPercent(value) { return Math.round(Number(value) * 10) / 10; }
function formatReset(value) { return Number.isFinite(value) ? formatBeijingTime(value * 1000, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"; }
function formatCompleted(value) { return Number.isFinite(value) ? `${formatBeijingTime(value)} 完成` : "已完成"; }
function formatContinuationProgress(progress, nowMs = Date.now()) {
  if (!progress || !["multi_pending", "prepared", "launch_verified", "waiting_for_desktop"].includes(progress.status)) return "";
  const total = Math.max(1, Number(progress.total) || 1);
  const currentIndex = Math.min(total, Math.max(1, Number(progress.currentIndex) || 1));
  const phase = continuationProgressText[progress.desktopPhase]
    || continuationProgressText[progress.currentStage]
    || "正在续接未完成任务";
  const phaseRemainingSeconds = Number.isFinite(progress.phaseDeadlineAtMs)
    ? Math.max(0, Math.ceil((progress.phaseDeadlineAtMs - nowMs) / 1_000))
    : Number.isFinite(progress.phaseRemainingSeconds) ? Math.max(0, progress.phaseRemainingSeconds) : undefined;
  const timing = Number.isFinite(phaseRemainingSeconds)
    ? "本阶段最多还剩 " + phaseRemainingSeconds + " 秒"
    : "本阶段已用 " + Math.max(0, Number(progress.elapsedSeconds) || 0) + " 秒";
  const queue = Number.isFinite(progress.queueRemainingUpperBoundSeconds)
    ? " · 整队列最多约 " + Math.max(0, progress.queueRemainingUpperBoundSeconds) + " 秒"
    : "";
  return "续接 " + currentIndex + "/" + total + " · " + phase + " · " + timing + queue
    + " · 成功 " + (progress.started || 0) + " / 失败 " + (progress.failed || 0)
    + " / 不确定 " + (progress.uncertain || 0);
}
function formatAutoSwitchProgress(autoSwitch, nowMs = Date.now()) {
  const pending = autoSwitch?.pending;
  if (!pending) return "";
  if (Number.isFinite(pending.quietUntilMs)) {
    const remainingSeconds = Math.max(0, Math.ceil((pending.quietUntilMs - nowMs) / 1_000));
    if (remainingSeconds > 0) return "自动切换已排队 · 安静期还剩 " + remainingSeconds + " 秒";
  }
  return "自动切换已排队 · 等待当前任务结束（没有固定倒计时）";
}
function setStatus(message, source = "action") {
  statusSource = source;
  document.querySelector("#status").textContent = message;
}

void loadData(false);
setInterval(() => { if (!interactionPaused) void loadData(false); }, 2_000);
if (!reducedMotion) requestAnimationFrame(animate);
