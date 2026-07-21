export function describeLiveActivity(event) {
  const method = event?.method ?? "";
  const params = event?.params ?? {};

  if (method === "turn/started") return { title: "Codex 正在思考", detail: "正在分析下一步操作。" };
  if (method === "turn/completed") return { title: "正在同步结果", detail: "Codex 已完成执行，正在加载最新对话。" };
  if (method === "thread/status/changed" && isRunningStatus(params.status ?? params.thread?.status)) {
    return { title: "Codex 正在执行", detail: "正在继续处理当前任务。" };
  }

  const item = params.item ?? params.threadItem ?? params;
  const activity = describeItemActivity(item);
  if (activity) return activity;
  if (method.startsWith("item/")) return { title: "Codex 正在执行下一步", detail: "正在更新任务进度。" };
  return null;
}

export function describeItemActivity(item) {
  if (!item || typeof item !== "object") return null;
  const type = String(item.type ?? "").toLowerCase();

  if (type === "reasoning") return { title: "Codex 正在思考", detail: "正在分析下一步操作。" };
  if (type === "commandexecution") {
    return {
      title: isRunningStatus(item.status) ? "正在运行命令" : "已运行命令",
      detail: compactText(item.command) || "终端命令",
    };
  }
  if (type === "filechange" || type === "filechangeproposal") {
    return { title: isRunningStatus(item.status) ? "正在编辑文件" : "已编辑文件", detail: changedFiles(item) || "文件已更新。" };
  }
  if (type.includes("browser") || type.includes("websearch")) {
    return { title: "正在使用浏览器", detail: compactText(item.query ?? item.url ?? item.command) || "正在处理浏览器操作。" };
  }
  if (type.includes("mcp") || type.includes("toolcall")) {
    return { title: "正在调用工具", detail: compactText(item.toolName ?? item.name ?? item.server) || "正在执行工具调用。" };
  }
  if (type === "agentmessage" && String(item.phase ?? "").toLowerCase() === "commentary") {
    return { title: "Codex 正在执行", detail: compactText(item.text) || "正在更新任务进度。" };
  }
  return null;
}

function changedFiles(item) {
  const changes = item.changes ?? item.files ?? item.fileChanges;
  if (!Array.isArray(changes)) return compactText(item.path ?? item.filePath ?? item.filename);
  const paths = changes
    .map((change) => compactText(change?.path ?? change?.filePath ?? change?.filename))
    .filter(Boolean);
  if (!paths.length) return "文件已更新。";
  const visible = paths.slice(0, 2).join(" · ");
  return paths.length > 2 ? `${visible} 等 ${paths.length} 个文件` : visible;
}

function compactText(value) {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

function isRunningStatus(status) {
  if (typeof status === "string") return /running|active|in.?progress/i.test(status);
  if (!status || typeof status !== "object") return false;
  return isRunningStatus(status?.status ?? status?.type);
}
