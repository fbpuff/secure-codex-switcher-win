export function localDateInputValue(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

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
