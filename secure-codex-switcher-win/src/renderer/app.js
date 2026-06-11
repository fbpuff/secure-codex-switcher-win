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

let accounts = [];
let selectedAccountId;
let settings = {
  autoSwitchEnabled: false,
  requireSwitchConfirmation: true,
  lowQuotaWarningEnabled: true,
  lowQuotaThresholdPercent: 15
};
let autoSwitchInProgress = false;

document.querySelector("#import-current").addEventListener("click", runAction(async () => {
  const account = await api.importCurrentAuth();
  selectedAccountId = account.id;
  try {
    await api.refreshUsage(account.id, true);
    await loadAccounts("已导入当前账号，并刷新了余量");
  } catch (error) {
    await loadAccounts(`已导入当前账号；余量刷新失败：${error instanceof Error ? error.message : String(error)}`);
  }
}));

document.querySelector("#refresh-all").addEventListener("click", runAction(async () => {
  const results = await api.refreshAllUsage();
  await loadAccounts(refreshSummary(results, "余量刷新完成"));
}));

document.querySelector("#pick-best").addEventListener("click", runAction(async () => {
  const result = await api.pickBestAccount();
  if (!result.account) {
    setStatus("没有可用的候选账号");
    return;
  }
  selectedAccountId = result.account.id;
  render();
  setStatus(`最佳账号：${result.account.emailMasked}，分数 ${Math.round(result.score)}`);
}));

document.querySelector("#open-folder").addEventListener("click", runAction(async () => {
  await api.openCodexFolder();
}));

autoSwitchInput.addEventListener("change", runAction(async () => {
  settings = await api.updateSettings({ autoSwitchEnabled: autoSwitchInput.checked });
  setStatus(autoSwitchInput.checked ? "已开启自动切换" : "已关闭自动切换");
  await evaluateQuotaActions("settings");
}));

lowQuotaWarningInput.addEventListener("change", runAction(async () => {
  settings = await api.updateSettings({ lowQuotaWarningEnabled: lowQuotaWarningInput.checked });
  setStatus(lowQuotaWarningInput.checked ? "已开启低余量提醒" : "已关闭低余量提醒");
}));

searchInput.addEventListener("input", () => render());

initialize();
setInterval(() => {
  api.refreshAllUsage()
    .then((results) => loadAccounts(refreshSummary(results, "后台余量已更新"), { reason: "background" }))
    .catch((error) => setStatus(`后台余量刷新失败：${error instanceof Error ? error.message : String(error)}`));
}, 5 * 60 * 1000);

async function initialize() {
  await loadSettings();
  await loadAccounts("准备就绪");
}

async function loadSettings() {
  settings = await api.readSettings();
  autoSwitchInput.checked = Boolean(settings.autoSwitchEnabled);
  lowQuotaWarningInput.checked = Boolean(settings.lowQuotaWarningEnabled);
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
  metricCurrent.textContent = current?.emailMasked ?? "无";
  metricBest.textContent = best?.usage ? `${Math.round(remainingScore(best))}%` : "未知";
  metricBest.title = "综合分数 = 7 天剩余 * 0.7 + 5 小时剩余 * 0.3，用于选择最适合切换的账号";
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
      ? "当前账号余量已用尽，建议切换账号；如果已开启自动切换，应用会选择可用账号并关闭官方 Codex。"
      : `当前账号余量只剩 ${Math.round(remaining)}%，建议切换账号。`;
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
      setStatus("当前账号已用尽，但没有可切换账号");
      return;
    }
    autoSwitchInProgress = true;
    try {
      const result = await api.switchAccount(target.id);
      selectedAccountId = target.id;
      await loadAccounts(`当前账号已用尽，已自动切换到 ${target.emailMasked}，并关闭 ${result.closedCodexProcesses ?? 0} 个 Codex 进程。`, { reason: "auto-switch" });
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
  resultCount.textContent = `${filtered.length} 个账号`;
  accountsEl.replaceChildren();

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `
      <span class="empty-icon" aria-hidden="true"></span>
      <h3>${accounts.length === 0 ? "还没有账号" : "没有匹配账号"}</h3>
      <p>${accounts.length === 0 ? "先导入当前 Codex auth.json。" : "换一个关键词再试。"}</p>
    `;
    accountsEl.append(empty);
    return;
  }

  for (const account of filtered) {
    const node = template.content.firstElementChild.cloneNode(true);
    node.classList.toggle("current", account.isCurrent);
    node.classList.toggle("selected", account.id === selectedAccountId);
    node.querySelector('[data-field="avatar"]').textContent = initials(account);
    node.querySelector('[data-field="plan"]').textContent = normalizePlan(account.planType);
    node.querySelector('[data-field="plan"]').classList.add(planClass(account.planType));
    node.querySelector('[data-field="email"]').textContent = account.emailMasked;
    node.querySelector('[data-field="meta"]').textContent = `${statusLabel(account.status)} · 本机记录 ${shortId(account.id)}`;
    node.querySelector('[data-field="badge"]').textContent = account.isCurrent ? "当前" : "可切换";
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
      await loadAccounts("账号余量已刷新");
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
        <h3>选择一个账号</h3>
        <p>账号详情、余量窗口和切换操作会显示在这里。</p>
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
          ${account.isCurrent ? '<span class="badge current-badge">当前</span>' : '<span class="badge state">候选</span>'}
        </div>
        <h3>${escapeHtml(account.emailMasked)}</h3>
        <p>账号指纹 ${escapeHtml(shortId(account.accountId))}</p>
      </div>
    </section>

    <section class="detail-section">
      <h4>余量</h4>
      <div class="detail-usage-grid">
        ${detailUsageCard("5 小时窗口", "success", account.usage?.fiveHour)}
        ${detailUsageCard("7 天窗口", "info", account.usage?.oneWeek)}
      </div>
      <div class="reset-card">
        <span>重置时间</span>
        ${resetRow("5 小时", account.usage?.fiveHour)}
        ${resetRow("7 天", account.usage?.oneWeek)}
      </div>
      ${account.usageError ? `<p class="usage-error">${escapeHtml(account.usageError)}</p>` : ""}
    </section>

    <section class="detail-section">
      <h4>本地状态</h4>
      <div class="meta-grid">
        <span>状态：${escapeHtml(statusLabel(account.status))}</span>
        <span>添加：${formatTime(account.createdAt)}</span>
        <span>更新：${formatTime(account.updatedAt)}</span>
      </div>
    </section>

    <section class="detail-section detail-actions">
      <h4>操作</h4>
      <div>
        <button id="detail-switch" class="primary-action" ${account.isCurrent ? "disabled" : ""} type="button">
          <span class="button-icon switch-icon" aria-hidden="true"></span>
          <span>切换到此账号</span>
        </button>
        <button id="detail-refresh" type="button">
          <span class="button-icon refresh-icon" aria-hidden="true"></span>
          <span>刷新余量</span>
        </button>
        <button id="detail-delete" class="danger" type="button">
          <span class="button-icon trash-icon" aria-hidden="true"></span>
          <span>删除</span>
        </button>
      </div>
    </section>
  `;

  detailEl.querySelector("#detail-switch")?.addEventListener("click", runAction(async () => switchAccount(account)));
  detailEl.querySelector("#detail-refresh")?.addEventListener("click", runAction(async () => {
    await api.refreshUsage(account.id, true);
    await loadAccounts("账号余量已刷新");
  }));
  detailEl.querySelector("#detail-delete")?.addEventListener("click", runAction(async () => deleteAccount(account)));
  for (const ring of detailEl.querySelectorAll("[data-progress]")) {
    ring.style.setProperty("--quota-progress", `${ring.dataset.progress}%`);
  }
}

async function switchAccount(account) {
  if (
    settings.requireSwitchConfirmation !== false &&
    !confirm(`切换到 ${account.emailMasked}？\n\n切换时会自动关闭正在运行的官方 Codex，并尝试自动重新打开。`)
  ) {
    return;
  }
  const result = await api.switchAccount(account.id);
  selectedAccountId = account.id;
  await loadAccounts(switchMessage(`账号已切换到 ${account.emailMasked}`, result), { reason: "manual-switch" });
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
    await loadAccounts(switchMessage(`当前账号已删除，并切换到 ${action.replacement.emailMasked}`, result));
    return;
  }

  if (!confirm(`删除 ${account.emailMasked} 的本地加密记录？\n\n该账号不是当前账号，不会关闭官方 Codex。`)) {
    return;
  }
  const result = await api.deleteAccount(account.id);
  if (selectedAccountId === account.id) {
    selectedAccountId = undefined;
  }
  await loadAccounts(`账号已删除。官方 Codex 未受影响。`);
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
      replacementConfirm.textContent = mode === "login_new" ? "删除并登录新账号" : "删除并切换";
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
    return `${prefix}。该账号已经是当前账号，未重启官方 Codex。`;
  }
  const closed = result.closedCodexProcesses ?? 0;
  const launch = result.launchedCodex ? "已自动打开官方 Codex。" : "未能自动打开官方 Codex，请手动打开。";
  return `${prefix}，并关闭 ${closed} 个 Codex 进程。${launch}`;
}

function loginNewMessage(result) {
  const closed = result.closedCodexProcesses ?? 0;
  const launch = result.launchedCodex ? "已自动打开官方 Codex。" : "未能自动打开官方 Codex，请手动打开。";
  return `当前账号已删除，并关闭 ${closed} 个 Codex 进程。${launch}请在官方 Codex 完成新账号登录，然后回到这里点击“导入/新增当前”。`;
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
        <strong>已用 ${used}${window ? "%" : ""}</strong>
      </div>
    </div>
  `;
}

function resetRow(label, window) {
  return `
    <div class="reset-row">
      <span>${label}</span>
      <strong>${window?.resetAt ? new Date(window.resetAt * 1000).toLocaleString() : "未刷新"}</strong>
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
      setStatus("处理中...");
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
  return failures > 0 ? `${successMessage}，${failures} 个账号刷新失败` : successMessage;
}

function initials(account) {
  const source = String(account.emailMasked || account.accountId || "CS").replace(/@.*$/, "");
  const parts = source.split(/[\s._*-]+/).filter(Boolean);
  return `${parts[0]?.[0] ?? "C"}${parts[1]?.[0] ?? parts[0]?.[1] ?? "S"}`.toUpperCase();
}

function normalizePlan(plan) {
  const normalized = String(plan || "").trim().toLowerCase();
  if (!normalized || normalized === "unknown") return "计划未知";
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
  if (status === "ready") return "可用";
  if (status === "usage_failed") return "余量刷新失败";
  if (status === "needs_login") return "登录态待刷新";
  return String(status || "未知");
}

function formatTime(unixSeconds) {
  return unixSeconds ? new Date(unixSeconds * 1000).toLocaleString() : "未知";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
