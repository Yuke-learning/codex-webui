const LIST_EVENTS = new Set([
  "thread/started",
  "thread/archived",
  "thread/deleted",
  "thread/unarchived",
  "thread/name/updated",
  "thread/status/changed",
  "turn/started",
  "turn/completed",
]);

const DETAIL_EVENTS = new Set([
  "turn/completed",
  "thread/compacted",
  "thread/name/updated",
  "thread/settings/updated",
]);

export function threadIdFromEvent(event) {
  const params = event?.params ?? {};
  return params.threadId ?? params.thread?.id ?? params.turn?.threadId ?? null;
}

export function classifyCodexEvent(event, selectedThreadId) {
  const method = event?.method ?? "";
  const threadId = threadIdFromEvent(event);
  const isSelectedThread = Boolean(threadId && threadId === selectedThreadId);

  return {
    threadId,
    isSelectedThread,
    refreshList: LIST_EVENTS.has(method),
    refreshDetail: isSelectedThread && DETAIL_EVENTS.has(method),
    clearSelection: isSelectedThread && method === "thread/deleted",
    markRunning: isSelectedThread && method === "turn/started",
  };
}

export function shouldForwardCodexEvent(event) {
  const method = event?.method ?? "";
  return !method.startsWith("thread/goal/") && method !== "thread/tokenUsage/updated";
}
