import { classifyCodexEvent } from "./refresh-policy.js";
import { describeLiveActivity } from "./live-activity.js";
import { toTranscript, transcriptSignature } from "./transcript.js";

const THEME_IDS = new Set([
  "default",
  "liquid-glass",
  "swiss-modernism",
  "glassmorphism",
  "real-time-monitoring",
  "data-dense-dashboard",
  "accessible-ethical",
]);

const state = {
  threads: [],
  models: [],
  threadSettings: new Map(),
  collapsedProjectKeys: loadCollapsedProjectKeys(),
  selectedId: null,
  selectedThread: null,
  health: null,
  listRefreshTimer: null,
  detailRefreshTimer: null,
  runningRefreshTimer: null,
  detailRefreshInFlight: false,
  liveActivity: null,
  listRequestId: 0,
  detailRequestId: 0,
  renderedThreadSignature: null,
  activeView: "console",
  theme: loadThemePreference(),
  mobileSidebarOpen: false,
};

const $ = (selector) => document.querySelector(selector);
const elements = {
  status: $("#connection-status"),
  sidebar: $("#sidebar"),
  mobileSidebarToggle: $("#open-mobile-sidebar"),
  mobileSidebarClose: $("#close-mobile-sidebar"),
  mobileSidebarBackdrop: $("#mobile-sidebar-backdrop"),
  list: $("#thread-list"),
  count: $("#thread-count"),
  search: $("#search"),
  header: $("#thread-header"),
  title: $("#thread-title"),
  cwd: $("#thread-cwd"),
  threadModel: $("#thread-model"),
  threadEffort: $("#thread-effort"),
  empty: $("#empty-state"),
  view: $("#thread-view"),
  messages: $("#messages"),
  liveActivity: $("#live-activity"),
  liveActivityTitle: $("#live-activity-title"),
  liveActivityDetail: $("#live-activity-detail"),
  automationEvents: $("#automation-events"),
  automationEventCount: $("#automation-event-count"),
  automationEventList: $("#automation-event-list"),
  composer: $("#composer"),
  messageInput: $("#message-input"),
  turnStatus: $("#turn-status"),
  interrupt: $("#interrupt-turn"),
  approval: $("#approval-notice"),
  settingsButton: $("#open-settings"),
  settingsView: $("#settings-view"),
  closeSettings: $("#close-settings"),
  themeOptions: document.querySelectorAll("input[name=theme]"),
  dialog: $("#new-thread-dialog"),
  newThreadForm: $("#new-thread-form"),
  cwdInput: $("#cwd-input"),
  modelInput: $("#model-input"),
  effortInput: $("#effort-input"),
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

async function loadModels() {
  const payload = await api("/api/models");
  state.models = payload.data ?? [];
  renderNewThreadSettings();
  if (state.selectedThread) renderThreadSettings(state.selectedThread);
}

async function loadThreads() {
  const requestId = ++state.listRequestId;
  const search = elements.search.value.trim();
  const payload = await api(`/api/threads?archived=false&search=${encodeURIComponent(search)}`);
  if (requestId !== state.listRequestId) return false;
  state.threads = payload.data;
  elements.count.textContent = `${payload.data.length} 个对话`;
  renderThreadList();
  return true;
}

function renderThreadList() {
  const scrollTop = elements.list.scrollTop;
  elements.list.replaceChildren();

  for (const [groupIndex, group] of groupThreads(state.threads).entries()) {
    const section = document.createElement("section");
    const collapsed = state.collapsedProjectKeys.has(group.key);
    const isUngrouped = group.key === "other";
    const rowsId = `project-threads-${groupIndex}`;
    section.className = `project-group${collapsed ? " is-collapsed" : ""}${isUngrouped ? " is-ungrouped" : ""}`;
    section.setAttribute("aria-label", `${group.name}，${group.threads.length} 个对话`);

    const heading = document.createElement("button");
    heading.className = "project-heading";
    heading.type = "button";
    heading.setAttribute("aria-expanded", String(!collapsed));
    heading.setAttribute("aria-controls", rowsId);
    heading.title = `${collapsed ? "展开" : "收起"} ${group.name}${isUngrouped ? "" : `\n${group.description}`}`;
    heading.addEventListener("click", () => toggleProjectGroup(group.key));

    const mark = document.createElement("span");
    mark.className = "project-mark";
    mark.setAttribute("aria-hidden", "true");
    const chevron = document.createElement("span");
    chevron.className = "project-chevron";
    chevron.setAttribute("aria-hidden", "true");
    const title = document.createElement("div");
    title.className = "project-heading-text";
    const name = document.createElement("strong");
    name.textContent = group.name;
    const description = document.createElement("span");
    description.className = "project-path";
    description.textContent = group.description;
    const count = document.createElement("span");
    count.className = "project-count";
    count.textContent = String(group.threads.length);
    count.setAttribute("aria-label", `${group.threads.length} 个对话`);
    title.append(name, description);
    heading.append(mark, chevron, title, count);

    section.append(heading);
    const rows = document.createElement("div");
    rows.id = rowsId;
    rows.className = "project-threads";
    rows.hidden = collapsed;
    for (const thread of group.threads) rows.append(threadRow(thread));
    section.append(rows);
    elements.list.append(section);
  }

  persistCollapsedProjectKeys();
  elements.list.scrollTop = scrollTop;
}

function groupThreads(threads) {
  const projects = new Map();
  const ungrouped = [];

  for (const thread of threads) {
    if (!thread.isProject || !thread.cwd) {
      ungrouped.push(thread);
      continue;
    }
    const group = projects.get(thread.cwd) ?? {
      key: `project:${thread.cwd}`,
      name: projectName(thread.cwd),
      description: thread.cwd,
      threads: [],
    };
    group.threads.push(thread);
    projects.set(thread.cwd, group);
  }

  const groups = [...projects.values()].sort((left, right) => latestGroupTime(right) - latestGroupTime(left));
  if (ungrouped.length) {
    groups.push({
      key: "other",
      name: "不在项目中",
      description: "未检测到 Git 项目元数据",
      threads: ungrouped,
    });
  }
  return groups;
}

function toggleProjectGroup(key) {
  if (state.collapsedProjectKeys.has(key)) {
    state.collapsedProjectKeys.delete(key);
  } else {
    state.collapsedProjectKeys.add(key);
  }
  renderThreadList();
}

function loadCollapsedProjectKeys() {
  try {
    const stored = JSON.parse(localStorage.getItem("codex-webui.collapsed-projects.v1") ?? "[]");
    return new Set(Array.isArray(stored) ? stored.filter((key) => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

function persistCollapsedProjectKeys() {
  try {
    localStorage.setItem("codex-webui.collapsed-projects.v1", JSON.stringify([...state.collapsedProjectKeys]));
  } catch {
    // The page still works when browser storage is unavailable.
  }
}

function latestGroupTime(group) {
  return Math.max(...group.threads.map((thread) => timestampValue(thread.updatedAt || thread.createdAt)));
}

function projectName(cwd) {
  const segments = cwd.split("/").filter(Boolean);
  return segments.at(-1) || cwd;
}

function threadRow(thread) {
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
  return button;
}

async function selectThread(threadId, { follow = true } = {}) {
  const isNewSelection = state.selectedId !== threadId;
  if (isNewSelection) {
    stopRunningRefresh();
    state.liveActivity = null;
  }
  state.selectedId = threadId;
  setMobileSidebar(false);
  const requestId = ++state.detailRequestId;
  renderThreadList();
  if (isNewSelection) elements.messages.replaceChildren(messageNode("正在加载对话…", "tool", "状态"));
  try {
    const payload = await api(`/api/threads/${encodeURIComponent(threadId)}`);
    if (requestId !== state.detailRequestId || threadId !== state.selectedId) return;
    state.selectedThread = payload.thread;
    state.renderedThreadSignature = null;
    renderSelectedThread({ follow });
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function refreshSelectedThread({ follow = false } = {}) {
  const threadId = state.selectedId;
  if (!threadId || state.detailRefreshInFlight) return;
  state.detailRefreshInFlight = true;
  const requestId = ++state.detailRequestId;

  try {
    const payload = await api(`/api/threads/${encodeURIComponent(threadId)}`);
    if (requestId !== state.detailRequestId || threadId !== state.selectedId) return;
    state.selectedThread = payload.thread;
    renderSelectedThread({ follow });
  } catch (error) {
    console.warn(error);
  } finally {
    state.detailRefreshInFlight = false;
  }
}

function renderSelectedThread({ follow = false } = {}) {
  const thread = state.selectedThread;
  if (!thread || state.activeView !== "console") return;
  elements.empty.classList.add("hidden");
  elements.header.classList.remove("hidden");
  elements.view.classList.remove("hidden");
  elements.composer.classList.remove("hidden");
  elements.title.textContent = threadTitle(thread);
  elements.cwd.textContent = thread.cwd || "未知工作目录";
  syncRunningRefresh(thread);
  const busy = isThreadBusy(thread);
  elements.turnStatus.textContent = busy ? state.liveActivity?.title ?? "Codex 正在执行" : "准备就绪";
  elements.interrupt.disabled = !busy;
  renderThreadSettings(thread);
  renderMessages(thread, { follow });
  renderLiveActivity(thread);
}

function renderThreadSettings(thread) {
  ensureCurrentModel(thread.settings?.model, thread.settings?.effort);
  const settings = settingsFor(thread);
  populateModelSelect(elements.threadModel, settings.model);
  const currentModel = modelFor(settings.model);
  const effort = supportedEffort(currentModel, settings.effort) ? settings.effort : currentModel?.defaultReasoningEffort;
  populateEffortSelect(elements.threadEffort, currentModel, effort);
  elements.threadModel.disabled = state.models.length === 0;
  elements.threadEffort.disabled = !currentModel || currentModel.supportedReasoningEfforts.length === 0;
}

function renderNewThreadSettings() {
  const defaultModel = defaultModelForPicker();
  const selectedModel = modelFor(elements.modelInput.value) ?? defaultModel;
  populateModelSelect(elements.modelInput, selectedModel?.model);
  const currentModel = modelFor(elements.modelInput.value) ?? defaultModel;
  populateEffortSelect(elements.effortInput, currentModel, currentModel?.defaultReasoningEffort);
  elements.modelInput.disabled = state.models.length === 0;
  elements.effortInput.disabled = !currentModel || currentModel.supportedReasoningEfforts.length === 0;
}

function populateModelSelect(select, selected) {
  select.replaceChildren();
  if (!state.models.length) {
    select.append(option("", "没有可用模型"));
    return;
  }
  for (const model of state.models) {
    const item = option(model.model, model.displayName || model.model);
    item.title = model.description || "";
    item.selected = model.model === selected;
    select.append(item);
  }
  if (!select.value) select.value = defaultModelForPicker()?.model ?? state.models[0].model;
}

function populateEffortSelect(select, model, selected) {
  select.replaceChildren();
  if (!model?.supportedReasoningEfforts?.length) {
    select.append(option("", "使用模型默认值"));
    return;
  }
  for (const effort of model.supportedReasoningEfforts) {
    const item = option(effort.reasoningEffort, effortLabel(effort));
    item.title = effort.description || "";
    item.selected = effort.reasoningEffort === selected;
    select.append(item);
  }
  if (!select.value) select.value = model.defaultReasoningEffort;
}

function option(value, label) {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = label;
  return item;
}

function effortLabel(effort) {
  const labels = {
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "超高",
    max: "最大",
    ultra: "极限",
  };
  return labels[effort.reasoningEffort] ?? effort.reasoningEffort;
}

function settingsFor(thread) {
  const fromService = thread.settings ?? {};
  const selected = state.threadSettings.get(thread.id) ?? {};
  const preferredModel = modelFor(selected.model ?? fromService.model) ?? defaultModelForPicker();
  return {
    model: preferredModel?.model ?? "",
    effort: selected.effort ?? fromService.effort ?? preferredModel?.defaultReasoningEffort ?? "",
  };
}

function defaultModelForPicker() {
  return state.models.find((model) => model.isDefault) ?? state.models[0];
}

function modelFor(modelName) {
  return state.models.find((model) => model.model === modelName || model.id === modelName);
}

function ensureCurrentModel(modelName, effort) {
  if (!modelName || modelFor(modelName)) return;
  state.models.unshift({
    id: modelName,
    model: modelName,
    displayName: `${modelName}（当前配置）`,
    description: "当前线程使用的本机 Codex Provider 模型。",
    isDefault: false,
    defaultReasoningEffort: effort || "",
    supportedReasoningEfforts: effort
      ? [{ reasoningEffort: effort, description: "当前线程的推理强度" }]
      : [],
  });
}

function supportedEffort(model, effort) {
  return model?.supportedReasoningEfforts?.some((item) => item.reasoningEffort === effort);
}

async function updateCurrentThreadSettings(changes) {
  if (!state.selectedId) return;
  const previous = settingsFor(state.selectedThread);
  const next = { ...previous, ...changes };
  const selectedModel = modelFor(next.model);
  if (changes.model && !supportedEffort(selectedModel, next.effort)) {
    next.effort = selectedModel?.defaultReasoningEffort ?? "";
  }

  elements.threadModel.disabled = true;
  elements.threadEffort.disabled = true;
  try {
    await api(`/api/threads/${encodeURIComponent(state.selectedId)}/settings`, {
      method: "PATCH",
      body: JSON.stringify(next),
    });
    state.threadSettings.set(state.selectedId, next);
    renderThreadSettings(state.selectedThread);
    showToast("模型设置会在后续对话中生效。", "info");
  } catch (error) {
    renderThreadSettings(state.selectedThread);
    showToast(error.message, "error");
  }
}

function renderMessages(thread, { follow = false } = {}) {
  const transcript = toTranscript(thread);
  const signature = transcriptSignature(transcript);
  if (signature === state.renderedThreadSignature) return;
  const shouldFollow = follow || isNearBottom(elements.view);
  elements.messages.replaceChildren();
  if (!transcript.messages.length) {
    const empty = document.createElement("p");
    empty.className = "empty-messages";
    empty.textContent = "这个线程还没有可显示的消息。发送第一条指令开始吧。";
    elements.messages.append(empty);
  }
  for (const message of transcript.messages) elements.messages.append(messageNode(message.text, message.role, message.label));
  renderAutomationEvents(transcript.automationEvents);
  state.renderedThreadSignature = signature;
  if (shouldFollow) elements.view.scrollTop = elements.view.scrollHeight;
}

function setLiveActivity(threadId, activity, { running = true } = {}) {
  if (!threadId || !activity) return;
  state.liveActivity = { threadId, running, ...activity };
  if (threadId === state.selectedId && state.selectedThread && state.activeView === "console") {
    elements.turnStatus.textContent = activity.title;
    elements.interrupt.disabled = !isThreadBusy(state.selectedThread);
    renderLiveActivity(state.selectedThread);
  }
}

function renderLiveActivity(thread) {
  const activity = state.liveActivity?.threadId === thread?.id ? state.liveActivity : null;
  if (!activity) {
    elements.liveActivity.classList.add("hidden");
    return;
  }
  elements.liveActivityTitle.textContent = activity.title;
  elements.liveActivityDetail.textContent = activity.detail || "正在更新任务进度。";
  elements.liveActivity.classList.remove("hidden");
}

function isThreadBusy(thread) {
  return isRunning(thread?.status) || Boolean(state.liveActivity?.running && state.liveActivity.threadId === thread?.id);
}

function syncRunningRefresh(thread) {
  if (!thread?.id) return;
  const activity = state.liveActivity?.threadId === thread.id ? state.liveActivity : null;
  if (isRunning(thread.status)) {
    if (!activity || !activity.running) {
      setLiveActivity(thread.id, { title: "Codex 正在思考", detail: "正在分析下一步操作。" });
    }
    startRunningRefresh();
    return;
  }
  if (activity?.running) {
    startRunningRefresh();
    return;
  }
  if (activity) state.liveActivity = null;
  stopRunningRefresh();
}

function startRunningRefresh() {
  if (state.runningRefreshTimer) return;
  state.runningRefreshTimer = setInterval(() => {
    if (!state.selectedId || state.activeView !== "console" || !isThreadBusy(state.selectedThread)) {
      stopRunningRefresh();
      return;
    }
    refreshSelectedThread({ follow: false });
  }, 1400);
}

function stopRunningRefresh() {
  if (state.runningRefreshTimer) clearInterval(state.runningRefreshTimer);
  state.runningRefreshTimer = null;
}

function renderAutomationEvents(events) {
  elements.automationEventList.replaceChildren();
  if (!events.length) {
    elements.automationEvents.classList.add("hidden");
    elements.automationEvents.open = false;
    return;
  }

  elements.automationEventCount.textContent = String(events.length);
  for (const event of events) {
    const row = document.createElement("article");
    row.className = "automation-event";
    const heading = document.createElement("div");
    heading.className = "automation-event-heading";
    const type = document.createElement("span");
    type.className = "automation-event-kind";
    type.textContent = event.kind;
    const source = document.createElement("span");
    source.textContent = `${event.automationId} · ${event.decision}`;
    heading.append(type, source);
    row.append(heading);
    if (event.message) {
      const message = document.createElement("p");
      message.className = "automation-event-message";
      message.textContent = event.message;
      row.append(message);
    }
    if (event.count > 1) {
      const count = document.createElement("span");
      count.className = "automation-event-repeat";
      count.textContent = `相邻重复 ${event.count} 次`;
      row.append(count);
    }
    elements.automationEventList.append(row);
  }
  elements.automationEvents.classList.remove("hidden");
}

function isNearBottom(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 120;
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

function timestampValue(timestamp) {
  if (!timestamp) return 0;
  return timestamp > 1e12 ? timestamp : timestamp * 1000;
}

function relativeTime(timestamp) {
  if (!timestamp) return "刚刚";
  const minutes = Math.round((Date.now() - timestampValue(timestamp)) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} 小时前`;
  return `${Math.round(minutes / 1440)} 天前`;
}

function showNewThreadDialog() {
  setMobileSidebar(false);
  renderNewThreadSettings();
  if (typeof elements.dialog.showModal === "function") elements.dialog.showModal();
}

function isMobileViewport() {
  return window.matchMedia?.("(max-width: 760px)").matches ?? false;
}

function setMobileSidebar(open) {
  const shouldOpen = Boolean(open && isMobileViewport());
  state.mobileSidebarOpen = shouldOpen;
  document.body.classList.toggle("mobile-sidebar-open", shouldOpen);
  elements.mobileSidebarToggle.setAttribute("aria-expanded", String(shouldOpen));
  elements.mobileSidebarBackdrop.classList.toggle("hidden", !shouldOpen);
  if (isMobileViewport()) {
    elements.sidebar.setAttribute("aria-hidden", String(!shouldOpen));
  } else {
    elements.sidebar.removeAttribute("aria-hidden");
  }
}

function loadThemePreference() {
  try {
    const theme = localStorage.getItem("codex-webui.theme.v1");
    return THEME_IDS.has(theme) ? theme : "default";
  } catch {
    return "default";
  }
}

function setTheme(theme) {
  if (!THEME_IDS.has(theme)) return;
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  for (const input of elements.themeOptions) {
    const selected = input.value === theme;
    input.checked = selected;
    input.closest(".theme-option")?.classList.toggle("is-selected", selected);
  }
  try {
    localStorage.setItem("codex-webui.theme.v1", theme);
  } catch {
    // The chosen theme remains active when browser storage is unavailable.
  }
}

function showSettings() {
  stopRunningRefresh();
  state.activeView = "settings";
  elements.header.classList.add("hidden");
  elements.empty.classList.add("hidden");
  elements.view.classList.add("hidden");
  elements.composer.classList.add("hidden");
  elements.settingsView.classList.remove("hidden");
  elements.settingsButton.classList.add("active");
  elements.settingsButton.setAttribute("aria-pressed", "true");
}

function showConsole() {
  state.activeView = "console";
  elements.settingsView.classList.add("hidden");
  elements.settingsButton.classList.remove("active");
  elements.settingsButton.setAttribute("aria-pressed", "false");
  if (state.selectedThread) {
    renderSelectedThread({ follow: false });
  } else {
    elements.empty.classList.remove("hidden");
  }
}

function showToast(message, kind = "info", duration = 4200) {
  const toast = document.createElement("div");
  toast.className = `toast ${kind}`;
  toast.textContent = message;
  elements.toast.append(toast);
  setTimeout(() => toast.remove(), duration);
}

function scheduleListRefresh(delay = 900) {
  clearTimeout(state.listRefreshTimer);
  state.listRefreshTimer = setTimeout(async () => {
    try {
      await loadThreads();
    } catch (error) {
      console.warn(error);
    }
  }, delay);
}

function scheduleDetailRefresh(delay = 300) {
  if (!state.selectedId) return;
  clearTimeout(state.detailRefreshTimer);
  state.detailRefreshTimer = setTimeout(() => refreshSelectedThread({ follow: false }), delay);
}

function handleCodexEvent(event) {
  const policy = classifyCodexEvent(event, state.selectedId);
  if (policy.clearSelection) {
    clearSelection();
    scheduleListRefresh();
    return;
  }

  if (policy.isSelectedThread && state.selectedThread) {
    const activity = policy.activity ? describeLiveActivity(event) : null;
    if (policy.markRunning) {
      state.selectedThread = { ...state.selectedThread, status: "running" };
      setLiveActivity(state.selectedId, activity ?? { title: "Codex 正在思考", detail: "正在分析下一步操作。" });
      startRunningRefresh();
    } else if (event.method === "thread/status/changed") {
      const status = event.params?.status ?? event.params?.thread?.status ?? state.selectedThread.status;
      state.selectedThread = { ...state.selectedThread, status };
      if (isRunning(status)) {
        setLiveActivity(state.selectedId, activity ?? { title: "Codex 正在执行", detail: "正在继续处理当前任务。" });
        startRunningRefresh();
      } else {
        setLiveActivity(state.selectedId, { title: "正在同步结果", detail: "Codex 已完成执行，正在加载最新对话。" }, { running: false });
      }
    } else if (activity) {
      setLiveActivity(state.selectedId, activity, { running: event.method !== "turn/completed" });
    }
    renderSelectedThread({ follow: false });
  }

  if (policy.refreshList) scheduleListRefresh();
  if (policy.refreshDetail) scheduleDetailRefresh(event.method === "turn/completed" ? 160 : 260);
}

$("#new-thread").addEventListener("click", showNewThreadDialog);
$("#empty-new-thread").addEventListener("click", showNewThreadDialog);
elements.settingsButton.addEventListener("click", () => {
  if (state.activeView === "settings") showConsole();
  else showSettings();
  setMobileSidebar(false);
});
elements.mobileSidebarToggle.addEventListener("click", () => setMobileSidebar(!state.mobileSidebarOpen));
elements.mobileSidebarClose.addEventListener("click", () => setMobileSidebar(false));
elements.mobileSidebarBackdrop.addEventListener("click", () => setMobileSidebar(false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.mobileSidebarOpen) setMobileSidebar(false);
});
const desktopViewport = window.matchMedia?.("(min-width: 761px)");
const closeMobileSidebarOnDesktop = (event) => {
  if (event.matches) setMobileSidebar(false);
};
if (desktopViewport?.addEventListener) desktopViewport.addEventListener("change", closeMobileSidebarOnDesktop);
else desktopViewport?.addListener?.(closeMobileSidebarOnDesktop);
elements.closeSettings.addEventListener("click", showConsole);
for (const input of elements.themeOptions) {
  input.addEventListener("change", () => setTheme(input.value));
}
$("#close-dialog").addEventListener("click", () => elements.dialog.close());
$("#cancel-dialog").addEventListener("click", () => elements.dialog.close());
$("#refresh-threads").addEventListener("click", () => loadThreads().catch((error) => showToast(error.message, "error")));
elements.search.addEventListener("input", () => {
  scheduleListRefresh(250);
});

elements.modelInput.addEventListener("change", () => {
  const selected = modelFor(elements.modelInput.value);
  populateEffortSelect(elements.effortInput, selected, selected?.defaultReasoningEffort);
});

elements.threadModel.addEventListener("change", () => {
  updateCurrentThreadSettings({ model: elements.threadModel.value });
});
elements.threadEffort.addEventListener("change", () => {
  updateCurrentThreadSettings({ effort: elements.threadEffort.value });
});

elements.newThreadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = await api("/api/threads", {
      method: "POST",
      body: JSON.stringify({
        cwd: elements.cwdInput.value,
        model: elements.modelInput.value,
        effort: elements.effortInput.value,
      }),
    });
    state.threadSettings.set(payload.thread.id, {
      model: elements.modelInput.value,
      effort: elements.effortInput.value,
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
    if (state.selectedThread) {
      state.selectedThread = { ...state.selectedThread, status: "running" };
      setLiveActivity(state.selectedId, {
        title: result.mode === "steer" ? "Codex 正在处理追加指令" : "Codex 正在思考",
        detail: result.mode === "steer" ? "正在将新指令合并到当前执行。" : "正在分析下一步操作。",
      });
      startRunningRefresh();
      renderSelectedThread({ follow: false });
    }
    scheduleDetailRefresh(160);
    scheduleListRefresh();
  } catch (error) {
    elements.messageInput.value = text;
    showToast(error.message, "error");
  }
});

elements.interrupt.addEventListener("click", async () => {
  if (!state.selectedId) return;
  try {
    await api(`/api/threads/${encodeURIComponent(state.selectedId)}/interrupt`, { method: "POST", body: "{}" });
    setLiveActivity(state.selectedId, { title: "已请求停止", detail: "正在等待 Codex 停止当前执行。" }, { running: false });
    renderSelectedThread({ follow: false });
    scheduleDetailRefresh(160);
    scheduleListRefresh();
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
    await refreshSelectedThread({ follow: false });
  } catch (error) {
    showToast(error.message, "error");
  }
});

$("#archive-thread").addEventListener("click", async () => {
  if (!state.selectedId || !window.confirm("归档此对话？之后可以通过 Codex 恢复。")) return;
  try {
    await api(`/api/threads/${encodeURIComponent(state.selectedId)}/archive`, { method: "POST", body: "{}" });
    clearSelection();
    await loadThreads();
  } catch (error) {
    showToast(error.message, "error");
  }
});

$("#delete-thread").addEventListener("click", async () => {
  if (!state.selectedId || !window.confirm("永久删除此对话？此操作不可撤销。")) return;
  try {
    await api(`/api/threads/${encodeURIComponent(state.selectedId)}`, { method: "DELETE", body: "{}" });
    clearSelection();
    await loadThreads();
  } catch (error) {
    showToast(error.message, "error");
  }
});

function clearSelection() {
  stopRunningRefresh();
  clearTimeout(state.detailRefreshTimer);
  state.detailRequestId += 1;
  state.selectedId = null;
  state.selectedThread = null;
  state.liveActivity = null;
  state.renderedThreadSignature = null;
  if (state.activeView === "console") {
    elements.header.classList.add("hidden");
    elements.view.classList.add("hidden");
    elements.composer.classList.add("hidden");
    elements.empty.classList.remove("hidden");
  }
}

const events = new EventSource("/api/events");
events.addEventListener("codex", (event) => {
  try {
    handleCodexEvent(JSON.parse(event.data));
  } catch (error) {
    console.warn("Ignored malformed Codex event.", error);
  }
});
events.addEventListener("approval", (event) => {
  const request = JSON.parse(event.data);
  elements.approval.textContent = `Codex 正在等待审批（${request.method}）。为安全起见，第一版仅展示该提示；请在桌面 Codex App 中审阅。`;
  elements.approval.classList.remove("hidden");
  showToast("Codex 正在等待审批，请在桌面 App 中审阅。", "error", 8000);
});
events.addEventListener("transport-error", () => refreshHealth().catch(() => undefined));

(async () => {
  try {
    setTheme(state.theme);
    setMobileSidebar(false);
    await refreshHealth();
    if (state.health?.ok) {
      await Promise.all([loadModels(), loadThreads()]);
    }
  } catch (error) {
    showToast(error.message, "error", 8000);
  }
})();
