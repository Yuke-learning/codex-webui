const state = {
  threads: [],
  selectedId: null,
  selectedThread: null,
  health: null,
  refreshTimer: null,
};

const $ = (selector) => document.querySelector(selector);
const elements = {
  status: $("#connection-status"),
  list: $("#thread-list"),
  count: $("#thread-count"),
  search: $("#search"),
  header: $("#thread-header"),
  title: $("#thread-title"),
  cwd: $("#thread-cwd"),
  empty: $("#empty-state"),
  view: $("#thread-view"),
  messages: $("#messages"),
  composer: $("#composer"),
  messageInput: $("#message-input"),
  turnStatus: $("#turn-status"),
  interrupt: $("#interrupt-turn"),
  approval: $("#approval-notice"),
  dialog: $("#new-thread-dialog"),
  newThreadForm: $("#new-thread-form"),
  cwdInput: $("#cwd-input"),
  modelInput: $("#model-input"),
  toast: $("#toast-region"),
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  if (response.status === 204) return undefined;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload;
}

async function refreshHealth() {
  const health = await api("/api/health");
  state.health = health;
  elements.status.textContent = health.ok ? "Mac 上的 Codex 已连接" : "Codex 服务未连接";
  elements.status.className = `connection-status ${health.ok ? "online" : "offline"}`;
  if (!health.ok) showToast(health.hint ?? health.error, "error", 8000);
}

async function loadThreads() {
  const search = elements.search.value.trim();
  const payload = await api(`/api/threads?archived=false&search=${encodeURIComponent(search)}`);
  state.threads = payload.data;
  elements.count.textContent = `${payload.data.length} 个对话`;
  renderThreadList();
}

function renderThreadList() {
  elements.list.replaceChildren();
  for (const thread of state.threads) {
    const button = document.createElement("button");
    button.className = `thread-row${thread.id === state.selectedId ? " selected" : ""}`;
    button.type = "button";
    button.title = thread.cwd || "";
    button.addEventListener("click", () => selectThread(thread.id));

    const title = document.createElement("div");
    title.className = "thread-row-title";
    title.textContent = threadTitle(thread);
    const meta = document.createElement("div");
    meta.className = "thread-row-meta";
    const dot = document.createElement("span");
    dot.className = `status-dot${isRunning(thread.status) ? " running" : ""}`;
    const info = document.createElement("span");
    info.textContent = relativeTime(thread.updatedAt || thread.createdAt);
    meta.append(dot, info);
    button.append(title, meta);
    elements.list.append(button);
  }
}

async function selectThread(threadId) {
  state.selectedId = threadId;
  renderThreadList();
  elements.messages.replaceChildren(messageNode("正在加载对话…", "tool", "状态"));
  try {
    const payload = await api(`/api/threads/${encodeURIComponent(threadId)}`);
    state.selectedThread = payload.thread;
    renderSelectedThread();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function renderSelectedThread() {
  const thread = state.selectedThread;
  if (!thread) return;
  elements.empty.classList.add("hidden");
  elements.header.classList.remove("hidden");
  elements.view.classList.remove("hidden");
  elements.composer.classList.remove("hidden");
  elements.title.textContent = threadTitle(thread);
  elements.cwd.textContent = thread.cwd || "未知工作目录";
  elements.turnStatus.textContent = isRunning(thread.status) ? "Codex 正在执行" : "准备就绪";
  elements.interrupt.disabled = !isRunning(thread.status);
  renderMessages(thread);
}

function renderMessages(thread) {
  elements.messages.replaceChildren();
  const items = (thread.turns ?? []).flatMap((turn) => turn.items ?? []);
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "empty-messages";
    empty.textContent = "这个线程还没有可显示的消息。发送第一条指令开始吧。";
    elements.messages.append(empty);
    return;
  }
  for (const item of items) {
    const text = itemText(item);
    if (!text) continue;
    elements.messages.append(messageNode(text, itemRole(item), itemLabel(item)));
  }
  elements.view.scrollTop = elements.view.scrollHeight;
}

function messageNode(text, role, label) {
  const node = document.createElement("article");
  node.className = `message ${role}`;
  const heading = document.createElement("span");
  heading.className = "message-label";
  heading.textContent = label;
  const content = document.createElement("div");
  content.textContent = text;
  node.append(heading, content);
  return node;
}

function itemRole(item) {
  const type = String(item.type ?? "").toLowerCase();
  if (type.includes("user")) return "user";
  if (type.includes("agent") || type.includes("assistant")) return "assistant";
  return "tool";
}

function itemLabel(item) {
  const role = itemRole(item);
  return role === "user" ? "你" : role === "assistant" ? "Codex" : item.type ?? "事件";
}

function itemText(item) {
  const direct = item.text ?? item.message ?? item.content;
  if (typeof direct === "string") return direct;
  if (Array.isArray(direct)) {
    return direct.map((part) => part.text ?? part.content ?? "").filter(Boolean).join("\n");
  }
  const output = item.output ?? item.arguments ?? item.command;
  if (typeof output === "string") return output;
  if (output && typeof output === "object") return JSON.stringify(output, null, 2);
  return "";
}

function threadTitle(thread) {
  if (typeof thread.name === "string" && thread.name.trim()) return thread.name.trim();
  const preview = typeof thread.preview === "string" ? thread.preview.replace(/\s+/g, " ").trim() : "";
  if (!preview) return "未命名对话";
  return preview.length > 96 ? `${preview.slice(0, 96)}…` : preview;
}

function isRunning(status) {
  if (typeof status === "string") return status === "running" || status === "active";
  return status?.type === "running" || status?.status === "running";
}

function relativeTime(timestamp) {
  if (!timestamp) return "刚刚";
  const value = timestamp > 1e12 ? timestamp : timestamp * 1000;
  const minutes = Math.round((Date.now() - value) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} 小时前`;
  return `${Math.round(minutes / 1440)} 天前`;
}

function showNewThreadDialog() {
  if (typeof elements.dialog.showModal === "function") elements.dialog.showModal();
}

function showToast(message, kind = "info", duration = 4200) {
  const toast = document.createElement("div");
  toast.className = `toast ${kind}`;
  toast.textContent = message;
  elements.toast.append(toast);
  setTimeout(() => toast.remove(), duration);
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(async () => {
    try {
      await loadThreads();
      if (state.selectedId) await selectThread(state.selectedId);
    } catch (error) {
      console.warn(error);
    }
  }, 450);
}

$("#new-thread").addEventListener("click", showNewThreadDialog);
$("#empty-new-thread").addEventListener("click", showNewThreadDialog);
$("#close-dialog").addEventListener("click", () => elements.dialog.close());
$("#cancel-dialog").addEventListener("click", () => elements.dialog.close());
$("#refresh-threads").addEventListener("click", () => loadThreads().catch((error) => showToast(error.message, "error")));
elements.search.addEventListener("input", () => {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => loadThreads().catch((error) => showToast(error.message, "error")), 250);
});

elements.newThreadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = await api("/api/threads", {
      method: "POST",
      body: JSON.stringify({ cwd: elements.cwdInput.value, model: elements.modelInput.value }),
    });
    elements.dialog.close();
    await loadThreads();
    await selectThread(payload.thread.id);
    showToast("已创建新线程。现在可以发送指令。", "info");
  } catch (error) {
    showToast(error.message, "error");
  }
});

elements.composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedId) return;
  const text = elements.messageInput.value.trim();
  if (!text) return;
  elements.messageInput.value = "";
  try {
    const result = await api(`/api/threads/${encodeURIComponent(state.selectedId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    elements.turnStatus.textContent = result.mode === "steer" ? "已追加指令" : "Codex 正在执行";
    elements.interrupt.disabled = false;
    scheduleRefresh();
  } catch (error) {
    elements.messageInput.value = text;
    showToast(error.message, "error");
  }
});

elements.interrupt.addEventListener("click", async () => {
  if (!state.selectedId) return;
  try {
    await api(`/api/threads/${encodeURIComponent(state.selectedId)}/interrupt`, { method: "POST", body: "{}" });
    elements.turnStatus.textContent = "已请求停止";
    elements.interrupt.disabled = true;
    scheduleRefresh();
  } catch (error) {
    showToast(error.message, "error");
  }
});

$("#rename-thread").addEventListener("click", async () => {
  if (!state.selectedThread) return;
  const name = window.prompt("新的对话名称", state.selectedThread.name || state.selectedThread.preview || "");
  if (!name?.trim()) return;
  try {
    await api(`/api/threads/${encodeURIComponent(state.selectedId)}`, { method: "PATCH", body: JSON.stringify({ name }) });
    await loadThreads();
    await selectThread(state.selectedId);
  } catch (error) {
    showToast(error.message, "error");
  }
});

$("#archive-thread").addEventListener("click", async () => {
  if (!state.selectedId || !window.confirm("归档此对话？之后可以通过 Codex 恢复。")) return;
  try {
    await api(`/api/threads/${encodeURIComponent(state.selectedId)}/archive`, { method: "POST", body: "{}" });
    state.selectedId = null;
    state.selectedThread = null;
    elements.header.classList.add("hidden");
    elements.view.classList.add("hidden");
    elements.composer.classList.add("hidden");
    elements.empty.classList.remove("hidden");
    await loadThreads();
  } catch (error) {
    showToast(error.message, "error");
  }
});

$("#delete-thread").addEventListener("click", async () => {
  if (!state.selectedId || !window.confirm("永久删除此对话？此操作不可撤销。")) return;
  try {
    await api(`/api/threads/${encodeURIComponent(state.selectedId)}`, { method: "DELETE", body: "{}" });
    state.selectedId = null;
    state.selectedThread = null;
    elements.header.classList.add("hidden");
    elements.view.classList.add("hidden");
    elements.composer.classList.add("hidden");
    elements.empty.classList.remove("hidden");
    await loadThreads();
  } catch (error) {
    showToast(error.message, "error");
  }
});

const events = new EventSource("/api/events");
events.addEventListener("codex", scheduleRefresh);
events.addEventListener("approval", (event) => {
  const request = JSON.parse(event.data);
  elements.approval.textContent = `Codex 正在等待审批（${request.method}）。为安全起见，第一版仅展示该提示；请在桌面 Codex App 中审阅。`;
  elements.approval.classList.remove("hidden");
  showToast("Codex 正在等待审批，请在桌面 App 中审阅。", "error", 8000);
});
events.addEventListener("transport-error", () => refreshHealth().catch(() => undefined));

(async () => {
  try {
    await refreshHealth();
    if (state.health?.ok) await loadThreads();
  } catch (error) {
    showToast(error.message, "error", 8000);
  }
})();
