export { beijingDate as localDateInputValue } from "./beijing-time.js";

export function nextUsageDateState({ value, today, followsToday }) {
  const currentValue = typeof value === "string" ? value : "";
  const shouldFollowToday = Boolean(followsToday) || currentValue === "" || currentValue > today;
  if (shouldFollowToday) {
    return { value: today, followsToday: true };
  }
  return { value: currentValue, followsToday: currentValue === today };
}

export function usageDateFollowsToday(value, today) {
  return !value || value === today;
}
