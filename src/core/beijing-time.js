const OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function beijingDate(value = Date.now()) {
  return beijingTimestamp(value).slice(0, 10);
}

export function beijingDayStart(value = Date.now()) {
  return Date.parse(`${beijingDate(value)}T00:00:00+08:00`);
}

export function previousBeijingWeekStart(value = Date.now()) {
  const daysSinceMonday = (new Date(`${beijingDate(value)}T00:00:00Z`).getUTCDay() + 6) % 7;
  return beijingDayStart(value) - (daysSinceMonday + 7) * DAY_MS;
}

// Fixed UTC+08:00; never change the instant used for ordering or deadlines.
export function beijingTimestamp(value = Date.now()) {
  return new Date(new Date(value).getTime() + OFFSET_MS).toISOString().replace(/Z$/, "+08:00");
}

export function formatBeijingTime(value, options = {}) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return `${date.toLocaleString("zh-CN", { ...options, timeZone: "Asia/Shanghai", hour12: false })} 北京时间`;
}
