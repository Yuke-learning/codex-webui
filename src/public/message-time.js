const DISPLAY_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const TITLE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function timestampMilliseconds(timestamp) {
  if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0) {
    return timestamp > 1e12 ? timestamp : timestamp * 1000;
  }

  if (typeof timestamp === "string" && timestamp.trim()) {
    const numeric = Number(timestamp);
    if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1000;
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  return null;
}

export function messageTimeParts(timestamp) {
  const milliseconds = timestampMilliseconds(timestamp);
  if (!milliseconds) return null;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return null;
  return {
    dateTime: date.toISOString(),
    label: DISPLAY_FORMATTER.format(date),
    title: TITLE_FORMATTER.format(date),
  };
}
