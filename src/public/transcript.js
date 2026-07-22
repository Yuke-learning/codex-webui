import { describeItemActivity } from "./live-activity.js";

const AUTOMATION_ENVELOPE_ROOT = "heartbeat";

export function toTranscript(thread) {
  const messages = [];
  const automationEvents = [];
  let rawIndex = 0;

  for (const [turnIndex, turn] of (thread?.turns ?? []).entries()) {
    const pendingActivities = [];
    const flushActivities = () => {
      if (!pendingActivities.length) return;
      messages.push(activityGroupFrom(pendingActivities, turnIndex));
      pendingActivities.length = 0;
    };

    for (const item of turn?.items ?? []) {
      const normalized = normalizeTranscriptItem(item);
      if (!normalized) {
        rawIndex += 1;
        continue;
      }

      if (normalized.kind === "automation") {
        flushActivities();
        appendAutomationEvent(automationEvents, normalized.event, rawIndex);
      } else if (normalized.message.role === "activity") {
        pendingActivities.push({ ...normalized.message, rawIndex });
      } else {
        flushActivities();
        messages.push(normalized.message);
      }
      rawIndex += 1;
    }
    flushActivities();
  }

  return { messages, automationEvents };
}

export function transcriptSignature(transcript) {
  return JSON.stringify(transcript);
}

export function normalizeTranscriptItem(item) {
  const message = messageFromItem(item);
  if (!message) return null;

  const automationEvent = parseAutomationEnvelope(message.text);
  if (automationEvent) return { kind: "automation", event: automationEvent };
  return { kind: "message", message };
}

export function parseAutomationEnvelope(text) {
  if (typeof text !== "string") return null;
  const root = new RegExp(`^\\s*<${AUTOMATION_ENVELOPE_ROOT}>\\s*([\\s\\S]*?)\\s*</${AUTOMATION_ENVELOPE_ROOT}>\\s*$`, "i");
  const match = root.exec(text);
  if (!match) return null;

  const automationId = xmlTagText(match[1], "automation_id");
  const decision = xmlTagText(match[1], "decision");
  if (!automationId || !decision) return null;

  return {
    kind: AUTOMATION_ENVELOPE_ROOT,
    automationId,
    decision,
    message: xmlTagText(match[1], "message"),
  };
}

function messageFromItem(item) {
  if (!item || typeof item !== "object") return null;

  if (item.type === "userMessage") {
    const text = textParts(item.content);
    return text ? { role: "user", label: "你", text } : null;
  }

  if (item.type === "agentMessage") {
    const text = nonEmptyText(item.text);
    if (!text) return null;
    const isCommentary = String(item.phase ?? "").toLowerCase() === "commentary";
    return isCommentary
      ? { role: "activity", activityType: "progress", label: "Codex 正在执行", text }
      : { role: "assistant", label: "Codex", text };
  }

  if (item.type === "reasoning") return null;

  const activity = describeItemActivity(item);
  if (activity) {
    return {
      role: "activity",
      activityType: activityTypeFor(item),
      label: activity.title,
      text: activity.detail,
      hasProblem: hasProblemStatus(item.status),
    };
  }

  return null;
}

function activityGroupFrom(items, turnIndex) {
  const counts = new Map();
  for (const item of items) counts.set(item.activityType, (counts.get(item.activityType) ?? 0) + 1);

  const latest = items.at(-1);
  return {
    role: "activityGroup",
    id: `activity-group-${turnIndex}-${items[0].rawIndex}`,
    label: "执行过程",
    count: items.length,
    summary: [...counts.entries()].map(([type, count]) => `${activityTypeLabel(type)} ${count}`).join(" · "),
    latest: { label: latest.label, text: latest.text },
    hasProblem: items.some((item) => item.hasProblem),
    items: items.map(({ rawIndex, ...item }) => item),
  };
}

function activityTypeFor(item) {
  const type = String(item?.type ?? "").toLowerCase();
  if (type === "commandexecution") return "command";
  if (type === "filechange" || type === "filechangeproposal") return "file";
  if (type.includes("browser") || type.includes("websearch")) return "browser";
  if (type.includes("mcp") || type.includes("toolcall")) return "tool";
  return "progress";
}

function activityTypeLabel(type) {
  return {
    command: "命令",
    file: "文件",
    browser: "浏览器",
    tool: "工具",
    progress: "进度",
  }[type] ?? "活动";
}

function hasProblemStatus(status) {
  const value = typeof status === "string" ? status : status?.status ?? status?.type ?? "";
  return /cancelled|canceled|denied|error|failed|interrupted|rejected/i.test(String(value));
}

function textParts(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text")
    .map((part) => nonEmptyText(part.text))
    .filter(Boolean)
    .join("\n");
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim() ? value : "";
}

function xmlTagText(xml, tagName) {
  const tag = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`, "i");
  const match = tag.exec(xml);
  return match?.[1].trim() ?? "";
}

function appendAutomationEvent(events, event, rawIndex) {
  const key = `${event.kind}\u0000${event.automationId}\u0000${event.decision}\u0000${event.message}`;
  const previous = events.at(-1);
  if (previous?.key === key && rawIndex - previous.lastRawIndex <= 1) {
    previous.count += 1;
    previous.lastRawIndex = rawIndex;
    return;
  }

  events.push({ ...event, key, count: 1, lastRawIndex: rawIndex });
}
