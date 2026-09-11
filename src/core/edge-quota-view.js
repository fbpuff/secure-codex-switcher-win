import { quotaDisplayState } from "../renderer/quota-display.js";

const THREAD_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function buildEdgeQuotaView({ accounts = [], nextAccountId, activity = {}, threads = [], nowSeconds = Date.now() / 1000 } = {}) {
  const currentAccount = accounts.find((account) => account?.isCurrent);
  const nextAccount = accounts.find((account) => account?.id === nextAccountId && !account?.isCurrent);
  const quota = quotaDisplayState(currentAccount, nowSeconds);
  return {
    current: accountIdentity(currentAccount),
    next: accountIdentity(nextAccount),
    quota: {
      current: quota.current,
      source: currentAccount?.usage?.source,
      state: quota.state,
      availability: quota.availability,
      fetchedAt: quota.fetchedAt,
      executionLimited: quota.executionLimited,
      executionLimitWindow: quota.executionLimitWindow,
      executionLimitSource: quota.executionLimitSource,
      fiveHour: quotaWindow(quota.fiveHour, quota.executionLimited && quota.executionLimitWindow === "fiveHour"),
      oneWeek: quotaWindow(quota.oneWeek, quota.executionLimited && quota.executionLimitWindow === "oneWeek")
    },
    activeTasks: (Array.isArray(activity?.activeTasks) ? activity.activeTasks : []).slice(0, 3).map((task) => taskProjection(task, "running")),
    completedTasks: threads
      .filter(isCompletedRootThread)
      .sort((left, right) => (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0))
      .slice(0, 2)
      .map((thread) => taskProjection(thread, "completed"))
  };
}

function accountIdentity(account) {
  if (!account) return undefined;
  return {
    id: account.id,
    label: account.remark || account.emailMasked || "未知账号"
  };
}

function quotaWindow(window, executionLimited = false) {
  if (!window) return undefined;
  return {
    remainingPercent: window.remainingPercent,
    resetAt: window.resetAt,
    executionLimited,
    low: Number(window.remainingPercent) < 10
  };
}

function taskProjection(task, state) {
  const rawId = typeof task?.id === "string" ? task.id.trim() : "";
  const title = task?.displayName || task?.title || task?.projectName || "未命名任务";
  return {
    title,
    state,
    updatedAtMs: Number.isFinite(task?.updatedAtMs) ? task.updatedAtMs : undefined,
    ...(THREAD_ID_PATTERN.test(rawId) ? { threadId: rawId } : {})
  };
}

function isCompletedRootThread(thread) {
  return thread?.turnState === "completed"
    && thread?.archived !== true
    && thread?.entityType !== "project"
    && thread?.threadSource !== "subagent"
    && !thread?.parentThreadId;
}
