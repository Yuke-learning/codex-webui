import { classifyCodexEvent } from "./refresh-policy.js";
import { describeLiveActivity } from "./live-activity.js";
import { messageTimeParts } from "./message-time.js";
import {
  loadCcSwitchVisibility,
  loadMessageTimeVisibility,
  saveCcSwitchVisibility,
  saveMessageTimeVisibility,
} from "./preferences.js";
import { appendRichContent } from "./rich-content.js";
import { mergeRecentTurns, prependOlderTurns } from "./thread-history.js";
import { toTranscript, transcriptSignature } from "./transcript.js";
import { parseCodexUiSegments } from "./ui-directives.js";

const RICH_MESSAGE_ROLES = new Set(["user", "assistant"]);
const MAX_RICH_MESSAGE_LENGTH = 100_000;
const THREAD_CACHE_LIMIT = 12;

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
  providers: [],
  providerStatus: null,
  providerSwitchInFlight: false,
  threadSettings: new Map(),
  collapsedProjectKeys: loadCollapsedProjectKeys(),
  expandedActivityGroupKeys: loadExpandedActivityGroupKeys(),
  selectedId: null,
  selectedThread: null,
  health: null,
  listRefreshTimer: null,
  detailRefreshTimer: null,
  runningRefreshTimer: null,
  detailRefreshInFlight: null,
  detailAbortController: null,
  historyAbortController: null,
  historyLoading: false,
  fullSyncInFlight: false,
  liveActivity: null,
  listRequestId: 0,
  detailRequestId: 0,
  renderedThreadSignature: null,
  renderedMessageSignatures: null,
  threadCache: new Map(),
  activeView: "console",
  theme: loadThemePreference(),
  showCcSwitch: loadCcSwitchVisibility(),
  showMessageTimes: loadMessageTimeVisibility(),
  mobileSidebarOpen: false,
};

const $ = (selector) => document.querySelector(selector);
const elements = {
  status: $("#connection-status"),
  networkAccess: $("#network-access"),
  sidebar: $("#sidebar"),
  mobileSidebarToggle: $("#open-mobile-sidebar"),
  mobileSidebarClose: $("#close-mobile-sidebar"),
  mobileSidebarBackdrop: $("#mobile-sidebar-backdrop"),
  list: $("#thread-list"),
  count: $("#thread-count"),
  refreshThreads: $("#refresh-threads"),
  search: $("#search"),
  header: $("#thread-header"),
  title: $("#thread-title"),
  cwd: $("#thread-cwd"),
  threadModel: $("#thread-model"),
  threadEffort: $("#thread-effort"),
  providerSwitch: $("#provider-switch"),
  providerSwitchLabel: $("#provider-switch-label"),
  providerDialog: $("#provider-dialog"),
  providerDialogNote: $("#provider-dialog-note"),
  providerList: $("#provider-list"),
  closeProviderDialog: $("#close-provider-dialog"),
  providerPortable: $("#provider-portable"),
  providerPortableDetail: $("#provider-portable-detail"),
  installProviderPortable: $("#install-provider-portable"),
  empty: $("#empty-state"),
  view: $("#thread-view"),
  historyLoader: $("#history-loader"),
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
  showCcSwitch: $("#show-cc-switch"),
  showMessageTimes: $("#show-message-times"),
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
  renderConnectionHealth();
  if (!health.ok) showToast(health.hint ?? health.error, "error", 8000);
}

function renderConnectionHealth() {
  const health = state.health ?? {};
  const network = health.network ?? {};
  const networkReady = Boolean(network.connected && network.serveReady && network.url);
  const networkChecked = Boolean(network.checkedAt);

  if (!health.ok) {
    elements.status.textContent = "Codex 服务未连接";
    elements.status.className = "connection-status offline";
  } else if (networkReady) {
    elements.status.textContent = "Codex 与 Tailscale 已连接";
    elements.status.className = "connection-status online";
  } else if (!networkChecked) {
    elements.status.textContent = "Codex 已连接 · 正在检查 Tailscale";
    elements.status.className = "connection-status";
  } else {
    elements.status.textContent = `Codex 已连接 · ${network.connected ? "Tailnet 入口不可用" : "Tailscale 未连接"}`;
    elements.status.className = "connection-status warning";
  }

  elements.networkAccess.classList.toggle("hidden", !networkReady);
  if (networkReady) {
    elements.networkAccess.href = network.url;
    elements.networkAccess.textContent = network.url.replace(/^https:\/\//, "").replace(/\/$/, "");
    elements.networkAccess.title = `在其他 Tailnet 设备打开 ${network.url}`;
  } else {
    elements.networkAccess.removeAttribute("href");
    elements.networkAccess.textContent = "";
    elements.networkAccess.title = network.error ?? "";
  }
}

async function loadModels() {
  const payload = await api("/api/models");
  state.models = payload.data ?? [];
  renderNewThreadSettings();
  if (state.selectedThread) renderThreadSettings(state.selectedThread);
}

async function loadProviders() {
  const payload = await api("/api/providers");
  state.providers = payload.data ?? [];
  state.providerStatus = payload;
  renderProviderStatus();
}

function renderProviderStatus() {
  const status = state.providerStatus;
  const current = state.providers.find((provider) => provider.id === status?.currentProviderId)
    ?? state.providers.find((provider) => provider.active);
  elements.providerSwitch.disabled = !status?.available
    || !status?.compatible
    || state.providers.length === 0
    || state.providerSwitchInFlight
    || status.switching;
  elements.providerSwitch.classList.toggle("is-unavailable", !status?.available || !status?.compatible);
  const pending = state.providers.find((provider) => provider.id === status?.pendingProviderId);
  elements.providerSwitchLabel.textContent = pending && current
    ? `${current.name} → ${pending.name}`
    : current?.name ?? (status?.available ? "状态不可用" : "未检测到 CC Switch");
  elements.providerSwitch.title = current
    ? `当前全局服务商：${current.name}。${status.mode === "proxy" ? "代理模式可在下一轮热切换。" : "配置模式需要重连 Codex。"}`
    : status?.error ?? "未检测到 CC Switch CLI。";
  renderProviderDialog();
}

function renderProviderDialog() {
  if (!elements.providerList) return;
  elements.providerList.replaceChildren();
  const status = state.providerStatus ?? {};
  elements.providerDialogNote.textContent = status.mode === "proxy"
    ? "代理接管模式：当前执行不会中断，切换从下一轮请求开始生效。"
    : "配置切换模式：当前执行不会中断，空闲后切换并自动重连 Codex。";
  const portable = status.portable ?? {};
  const needsPortable = !status.available || !status.compatible;
  elements.providerPortable.classList.toggle("hidden", !needsPortable || !portable.supported);
  elements.providerPortableDetail.textContent = portable.supported
    ? `固定版本 ${portable.version}，约 ${formatBytes(portable.downloadSize)}；下载后会校验 SHA-256。`
    : "当前系统暂无可用的便携组件。";
  elements.installProviderPortable.disabled = state.providerSwitchInFlight || portable.installing;
  elements.installProviderPortable.textContent = portable.installing ? "正在安装…" : "安装便携组件";

  for (const provider of state.providers) {
    const row = document.createElement("div");
    row.className = `provider-row${provider.active ? " is-active" : ""}`;
    row.setAttribute("role", "listitem");
    const copy = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = provider.name;
    const meta = document.createElement("span");
    meta.textContent = provider.active ? "当前服务商" : "用于后续所有 Codex 请求";
    copy.append(name, meta);
    const button = document.createElement("button");
    button.type = "button";
    button.className = provider.active ? "quiet-button" : "primary-button";
    button.textContent = provider.active ? "已启用" : "切换";
    button.disabled = provider.active || state.providerSwitchInFlight;
    button.addEventListener("click", () => activateProvider(provider.id));
    row.append(copy, button);
    elements.providerList.append(row);
  }
  if (!state.providers.length && status.available) {
    const empty = document.createElement("p");
    empty.className = "provider-empty";
    empty.textContent = status.error ?? "CC Switch 中还没有可用的 Codex 服务商。";
    elements.providerList.append(empty);
  }
}

async function installPortableProvider() {
  const portable = state.providerStatus?.portable;
  if (!portable?.supported || state.providerSwitchInFlight) return;
  if (!window.confirm(`从固定 GitHub Release 下载并安装 CC Switch CLI ${portable.version}？下载内容会经过 SHA-256 校验。`)) return;
  state.providerSwitchInFlight = true;
  renderProviderStatus();
  try {
    const result = await api("/api/providers/portable/install", { method: "POST", body: "{}" });
    state.providerStatus = result.status;
    state.providers = result.status.providers ?? [];
    renderProviderStatus();
    showToast(`CC Switch 便携组件 ${result.installed.version} 已安装。`, "info", 6000);
  } catch (error) {
    showToast(error.message, "error", 9000);
  } finally {
    state.providerSwitchInFlight = false;
    renderProviderStatus();
  }
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return "未知大小";
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

async function activateProvider(providerId) {
  if (state.providerSwitchInFlight) return;
  state.providerSwitchInFlight = true;
  renderProviderStatus();
  try {
    const result = await api(`/api/providers/${encodeURIComponent(providerId)}/activate`, {
      method: "POST",
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
    });
    if (result.state === "queued") {
      await loadProviders();
    } else {
      if (Array.isArray(result.models)) applyProviderModels(result.models);
      await loadProviders();
    }
    elements.providerDialog.close();
  } catch (error) {
    showToast(error.message, "error", 8000);
  } finally {
    state.providerSwitchInFlight = false;
    renderProviderStatus();
  }
}

function applyProviderModels(models) {
  const currentModel = state.selectedThread?.settings?.model;
  const supported = !currentModel || models.some((model) => model.model === currentModel || model.id === currentModel);
  state.models = models;
  renderNewThreadSettings();
  if (state.selectedThread) renderThreadSettings(state.selectedThread);
  if (!supported) {
    showToast(`当前任务使用的模型 ${currentModel} 不在新服务商模型列表中，请在发送下一条消息前重新选择。`, "error", 9000);
  }
}

async function loadThreads({ syncAll = false } = {}) {
  const requestId = ++state.listRequestId;
  const search = elements.search.value.trim();
  const requestSearch = syncAll ? "" : search;
  const payload = await api(`/api/threads?archived=false&search=${encodeURIComponent(requestSearch)}`);
  const allThreads = Array.isArray(payload.data) ? payload.data : [];
  const visibleThreads = syncAll && search ? allThreads.filter((thread) => threadMatchesSearch(thread, search)) : allThreads;
  if (requestId !== state.listRequestId) {
    return { applied: false, total: allThreads.length, visible: visibleThreads.length };
  }
  state.threads = visibleThreads;
  elements.count.textContent = `${visibleThreads.length} 个对话`;
  renderThreadList();
  return { applied: true, total: allThreads.length, visible: visibleThreads.length };
}

function threadMatchesSearch(thread, value) {
  const query = value.toLocaleLowerCase();
  return [threadTitle(thread), thread.cwd]
    .filter(Boolean)
    .some((candidate) => String(candidate).toLocaleLowerCase().includes(query));
}

async function syncAllThreads() {
  if (state.fullSyncInFlight) return;
  state.fullSyncInFlight = true;
  setFullSyncBusy(true);
  clearTimeout(state.listRefreshTimer);
  clearTimeout(state.detailRefreshTimer);

  try {
    const result = await loadThreads({ syncAll: true });
    const detailSynced = state.selectedId
      ? await refreshSelectedThread({ follow: false, force: true, throwOnError: true })
      : false;
    const visibleNote = result.visible === result.total ? "" : `，当前筛选显示 ${result.visible} 个`;
    showToast(`已同步 ${result.total} 个对话${detailSynced ? "及当前任务详情" : ""}${visibleNote}。`, "info");
  } catch (error) {
    showToast(`同步失败：${error.message}`, "error", 8000);
  } finally {
    state.fullSyncInFlight = false;
    setFullSyncBusy(false);
  }
}

function setFullSyncBusy(busy) {
  elements.refreshThreads.disabled = busy;
  elements.refreshThreads.classList.toggle("is-syncing", busy);
  elements.refreshThreads.setAttribute("aria-busy", String(busy));
  const label = busy ? "正在同步全部对话和当前任务" : "同步全部对话和当前任务";
  elements.refreshThreads.title = label;
  elements.refreshThreads.setAttribute("aria-label", label);
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

function loadExpandedActivityGroupKeys() {
  try {
    const stored = JSON.parse(localStorage.getItem("codex-webui.expanded-activity-groups.v1") ?? "[]");
    return new Set(Array.isArray(stored) ? stored.filter((key) => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

function persistExpandedActivityGroupKeys() {
  try {
    localStorage.setItem("codex-webui.expanded-activity-groups.v1", JSON.stringify([...state.expandedActivityGroupKeys]));
  } catch {
    // The selected groups remain expanded for this session when storage is unavailable.
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
  button.dataset.threadId = thread.id;
  button.setAttribute("aria-current", thread.id === state.selectedId ? "page" : "false");
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
    state.historyAbortController?.abort();
    state.historyAbortController = null;
    state.historyLoading = false;
  }
  state.selectedId = threadId;
  setMobileSidebar(false);
  setSelectedThreadRow(threadId);
  const cached = state.threadCache.get(threadId)?.thread;
  if (isNewSelection) {
    resetRenderedTranscript();
    if (cached) {
      state.selectedThread = cached;
      renderSelectedThread({ follow: false });
    } else {
      showThreadLoading(threadId);
    }
  }

  const { requestId, controller } = beginDetailRequest();
  try {
    const payload = await api(`/api/threads/${encodeURIComponent(threadId)}`, { signal: controller.signal });
    if (requestId !== state.detailRequestId || threadId !== state.selectedId) return;
    state.selectedThread = mergeThreadWithCachedTurns(payload.thread, state.selectedThread);
    cacheThread(state.selectedThread);
    renderSelectedThread({ follow });
  } catch (error) {
    if (isAbortError(error)) return;
    showToast(error.message, "error");
  } finally {
    endDetailRequest(controller);
  }
}

async function refreshSelectedThread({ follow = false, force = false, throwOnError = false } = {}) {
  const threadId = state.selectedId;
  if (!threadId || (!force && (state.detailRefreshInFlight || state.detailAbortController))) return false;
  const refreshToken = { threadId };
  state.detailRefreshInFlight = refreshToken;
  const { requestId, controller } = beginDetailRequest();

  try {
    const payload = await api(`/api/threads/${encodeURIComponent(threadId)}`, { signal: controller.signal });
    if (requestId !== state.detailRequestId || threadId !== state.selectedId) return false;
    state.selectedThread = mergeThreadWithCachedTurns(payload.thread, state.selectedThread);
    cacheThread(state.selectedThread);
    renderSelectedThread({ follow });
    return true;
  } catch (error) {
    if (isAbortError(error)) return false;
    if (throwOnError) throw error;
    console.warn(error);
    return false;
  } finally {
    endDetailRequest(controller);
    if (state.detailRefreshInFlight === refreshToken) state.detailRefreshInFlight = null;
  }
}

function beginDetailRequest() {
  state.detailAbortController?.abort();
  const controller = new AbortController();
  state.detailAbortController = controller;
  return { requestId: ++state.detailRequestId, controller };
}

function endDetailRequest(controller) {
  if (state.detailAbortController === controller) state.detailAbortController = null;
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function cacheThread(thread) {
  if (!thread?.id) return;
  state.threadCache.delete(thread.id);
  state.threadCache.set(thread.id, { thread, cachedAt: Date.now() });
  while (state.threadCache.size > THREAD_CACHE_LIMIT) {
    state.threadCache.delete(state.threadCache.keys().next().value);
  }
}

function mergeThreadWithCachedTurns(incoming, current) {
  if (!incoming?.id || incoming.id !== current?.id) return incoming;
  const currentTurns = current.turns ?? [];
  const recentTurns = incoming.turns ?? [];
  const keepOlderCursor = currentTurns.length > recentTurns.length && current.history?.nextCursor;
  return {
    ...incoming,
    turns: mergeRecentTurns(currentTurns, recentTurns),
    history: keepOlderCursor ? current.history : incoming.history,
  };
}

function showThreadLoading(threadId) {
  const summary = state.threads.find((thread) => thread.id === threadId);
  state.selectedThread = null;
  elements.empty.classList.add("hidden");
  elements.header.classList.add("hidden");
  elements.view.classList.remove("hidden");
  elements.composer.classList.add("hidden");
  elements.historyLoader.classList.add("hidden");
  elements.messages.replaceChildren(messageNode(`正在加载${summary ? `“${threadTitle(summary)}”` : "对话"}…`, "tool", "状态"));
}

function resetRenderedTranscript() {
  state.renderedThreadSignature = null;
  state.renderedMessageSignatures = null;
}

function setSelectedThreadRow(threadId) {
  for (const row of elements.list.querySelectorAll(".thread-row")) {
    const selected = row.dataset.threadId === threadId;
    row.classList.toggle("selected", selected);
    row.setAttribute("aria-current", selected ? "page" : "false");
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
  renderHistoryLoader(thread);
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
  const messageSignatures = transcript.messages.map(transcriptMessageSignature);
  const previous = state.renderedMessageSignatures;
  let sharedPrefix = 0;
  if (Array.isArray(previous) && elements.messages.children.length === previous.length) {
    const limit = Math.min(previous.length, messageSignatures.length);
    while (sharedPrefix < limit && previous[sharedPrefix] === messageSignatures[sharedPrefix]) sharedPrefix += 1;
  }

  if (!transcript.messages.length) {
    elements.messages.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "empty-messages";
    empty.textContent = "这个线程还没有可显示的消息。发送第一条指令开始吧。";
    elements.messages.append(empty);
    state.renderedMessageSignatures = [];
  } else {
    if (!Array.isArray(previous) || elements.messages.children.length !== previous.length) sharedPrefix = 0;
    while (elements.messages.children.length > sharedPrefix) elements.messages.lastElementChild.remove();
    for (let index = sharedPrefix; index < transcript.messages.length; index += 1) {
      const message = transcript.messages[index];
      elements.messages.append(message.role === "activityGroup"
        ? activityGroupNode(message)
        : messageNode(message.text, message.role, message.label, message.timestamp));
    }
    state.renderedMessageSignatures = messageSignatures;
  }
  renderAutomationEvents(transcript.automationEvents);
  state.renderedThreadSignature = signature;
  if (shouldFollow) elements.view.scrollTop = elements.view.scrollHeight;
}

function transcriptMessageSignature(message) {
  return JSON.stringify(message);
}

function renderHistoryLoader(thread) {
  const hasMore = Boolean(thread?.history?.nextCursor);
  elements.historyLoader.replaceChildren();
  elements.historyLoader.classList.toggle("hidden", !hasMore);
  if (!hasMore) return;

  const button = document.createElement("button");
  button.type = "button";
  button.disabled = state.historyLoading;
  button.textContent = state.historyLoading
    ? "正在加载更早的对话…"
    : `加载更早的对话（已加载 ${thread.turns?.length ?? 0} 轮）`;
  button.addEventListener("click", loadOlderTurns);
  elements.historyLoader.append(button);
}

async function loadOlderTurns() {
  const thread = state.selectedThread;
  const cursor = thread?.history?.nextCursor;
  if (!thread?.id || !cursor || state.historyLoading) return;

  const threadId = thread.id;
  const scrollTop = elements.view.scrollTop;
  const scrollHeight = elements.view.scrollHeight;
  const controller = new AbortController();
  state.historyAbortController?.abort();
  state.historyAbortController = controller;
  state.historyLoading = true;
  renderHistoryLoader(thread);

  try {
    const payload = await api(`/api/threads/${encodeURIComponent(threadId)}/turns?cursor=${encodeURIComponent(cursor)}`, {
      signal: controller.signal,
    });
    if (state.selectedId !== threadId || state.selectedThread !== thread) return;
    state.selectedThread = {
      ...thread,
      turns: prependOlderTurns(thread.turns, payload.data),
      history: { ...thread.history, nextCursor: payload.nextCursor ?? null, hasMore: Boolean(payload.nextCursor) },
    };
    cacheThread(state.selectedThread);
    resetRenderedTranscript();
    renderSelectedThread({ follow: false });
    elements.view.scrollTop = scrollTop + (elements.view.scrollHeight - scrollHeight);
  } catch (error) {
    if (!isAbortError(error)) showToast(`加载历史对话失败：${error.message}`, "error");
  } finally {
    if (state.historyAbortController === controller) state.historyAbortController = null;
    if (state.selectedId === threadId) {
      state.historyLoading = false;
      renderHistoryLoader(state.selectedThread);
    }
  }
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

function messageNode(text, role, label, timestamp) {
  const node = document.createElement("article");
  node.className = `message ${role}`;
  const heading = document.createElement("span");
  heading.className = "message-label";
  heading.textContent = label;
  const content = document.createElement("div");
  content.className = "message-content";
  if (RICH_MESSAGE_ROLES.has(role) && text.length <= MAX_RICH_MESSAGE_LENGTH) {
    content.classList.add("rich");
    try {
      if (role === "assistant") appendAssistantContent(content, text);
      else appendRichContent(content, text);
    } catch (error) {
      console.warn("Rich message rendering failed; using plain text.", error);
      content.className = "message-content plain";
      content.textContent = text;
    }
  } else {
    content.classList.add("plain");
    content.textContent = text;
  }
  node.append(heading, content);
  const messageTime = messageTimeParts(timestamp);
  if (messageTime && RICH_MESSAGE_ROLES.has(role)) {
    const time = document.createElement("time");
    time.className = "message-time";
    time.dateTime = messageTime.dateTime;
    time.title = messageTime.title;
    time.textContent = messageTime.label;
    node.append(time);
  }
  return node;
}

function appendAssistantContent(container, text) {
  const segments = parseCodexUiSegments(text);
  if (!segments.length) {
    appendRichContent(container, text);
    return;
  }

  for (const segment of segments) {
    if (segment.type === "markdown") appendRichContent(container, segment.text);
    else if (segment.type === "git") container.append(gitDirectiveCard(segment.directives));
  }
}

function gitDirectiveCard(directives) {
  const card = document.createElement("section");
  card.className = "codex-git-card";
  card.setAttribute("aria-label", "Git 操作");

  const heading = document.createElement("div");
  heading.className = "codex-git-card-heading";
  const mark = document.createElement("span");
  mark.className = "codex-git-card-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = "⑂";
  const title = document.createElement("strong");
  title.textContent = "Git 操作";
  heading.append(mark, title);

  const list = document.createElement("div");
  list.className = "codex-git-card-list";
  for (const directive of directives) list.append(gitDirectiveRow(directive));
  card.append(heading, list);

  const directories = [...new Set(directives.map((directive) => directive.attributes.cwd).filter(Boolean))];
  if (directories.length === 1) {
    const directory = document.createElement("div");
    directory.className = "codex-git-card-directory";
    directory.title = directories[0];
    directory.textContent = directories[0];
    card.append(directory);
  }
  return card;
}

function gitDirectiveRow(directive) {
  const presentation = {
    "git-stage": { icon: "✓", label: "已暂存更改" },
    "git-commit": { icon: "✓", label: "已创建提交" },
    "git-push": { icon: "↑", label: "已推送到远程仓库" },
    "git-create-branch": { icon: "⑂", label: "已创建分支" },
    "git-create-pr": { icon: "↗", label: directive.attributes.isDraft === "true" ? "已创建草稿 PR" : "已创建 PR" },
  }[directive.name] ?? { icon: "✓", label: directive.name };

  const row = document.createElement("div");
  row.className = `codex-git-card-row directive-${directive.name}`;
  const icon = document.createElement("span");
  icon.className = "codex-git-card-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = presentation.icon;
  const label = document.createElement("span");
  label.className = "codex-git-card-label";
  label.textContent = presentation.label;
  row.append(icon, label);

  const metadata = directive.name === "git-create-pr"
    ? directive.attributes.url
    : directive.attributes.branch || directive.attributes.url;
  if (metadata) {
    const detail = document.createElement(directive.name === "git-create-pr" && safeHttpsUrl(metadata) ? "a" : "span");
    detail.className = "codex-git-card-detail";
    detail.textContent = directive.attributes.branch || "打开 PR";
    if (detail.tagName === "A") {
      detail.href = metadata;
      detail.target = "_blank";
      detail.rel = "noopener noreferrer";
    }
    row.append(detail);
  }
  return row;
}

function safeHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function activityGroupNode(group) {
  const key = activityGroupKey(group.id);
  const node = document.createElement("details");
  node.className = `activity-group${group.hasProblem ? " has-problem" : ""}`;
  node.open = group.hasProblem || state.expandedActivityGroupKeys.has(key);
  node.dataset.activityGroupId = group.id;

  const summary = document.createElement("summary");
  const heading = document.createElement("div");
  heading.className = "activity-group-heading";
  const title = document.createElement("strong");
  title.textContent = group.label;
  const count = document.createElement("span");
  count.className = "activity-group-count";
  count.textContent = `${group.count} 项`;
  const types = document.createElement("span");
  types.className = "activity-group-types";
  types.textContent = group.summary;
  heading.append(title, count, types);

  const latest = document.createElement("span");
  latest.className = "activity-group-latest";
  latest.textContent = `最近：${group.latest.label} · ${group.latest.text}`;
  summary.append(heading, latest);
  node.append(summary);

  const list = document.createElement("div");
  list.className = "activity-group-list";
  for (const item of group.items) {
    const row = document.createElement("article");
    row.className = `activity-group-item activity-${item.activityType ?? "progress"}`;
    const itemLabel = document.createElement("span");
    itemLabel.className = "activity-group-item-label";
    itemLabel.textContent = item.label;
    const itemText = document.createElement("span");
    itemText.className = "activity-group-item-text";
    itemText.textContent = item.text;
    row.append(itemLabel, itemText);
    list.append(row);
  }
  node.append(list);
  node.addEventListener("toggle", () => {
    if (node.open) state.expandedActivityGroupKeys.add(key);
    else state.expandedActivityGroupKeys.delete(key);
    persistExpandedActivityGroupKeys();
  });
  return node;
}

function activityGroupKey(groupId) {
  return `${state.selectedId ?? "unknown"}\u0000${groupId}`;
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

function setCcSwitchVisibility(visible) {
  state.showCcSwitch = Boolean(visible);
  elements.providerSwitch.classList.toggle("hidden", !state.showCcSwitch);
  elements.showCcSwitch.checked = state.showCcSwitch;
  saveCcSwitchVisibility(state.showCcSwitch);
}

function setMessageTimeVisibility(visible) {
  state.showMessageTimes = Boolean(visible);
  elements.messages.classList.toggle("show-message-times", state.showMessageTimes);
  elements.showMessageTimes.checked = state.showMessageTimes;
  saveMessageTimeVisibility(state.showMessageTimes);
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
elements.showCcSwitch.addEventListener("change", () => {
  setCcSwitchVisibility(elements.showCcSwitch.checked);
});
elements.showMessageTimes.addEventListener("change", () => {
  setMessageTimeVisibility(elements.showMessageTimes.checked);
});
$("#close-dialog").addEventListener("click", () => elements.dialog.close());
$("#cancel-dialog").addEventListener("click", () => elements.dialog.close());
elements.refreshThreads.addEventListener("click", syncAllThreads);
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

elements.providerSwitch.addEventListener("click", () => {
  renderProviderDialog();
  elements.providerDialog.showModal();
});
elements.closeProviderDialog.addEventListener("click", () => elements.providerDialog.close());
elements.installProviderPortable.addEventListener("click", installPortableProvider);
elements.providerDialog.addEventListener("click", (event) => {
  if (event.target === elements.providerDialog) elements.providerDialog.close();
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
  state.detailAbortController?.abort();
  state.detailAbortController = null;
  state.historyAbortController?.abort();
  state.historyAbortController = null;
  state.historyLoading = false;
  state.detailRequestId += 1;
  state.detailRefreshInFlight = null;
  state.selectedId = null;
  state.selectedThread = null;
  state.liveActivity = null;
  resetRenderedTranscript();
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
events.addEventListener("network-status", (event) => {
  try {
    const previousReady = Boolean(state.health?.network?.serveReady);
    const network = JSON.parse(event.data);
    state.health = { ...(state.health ?? {}), network };
    renderConnectionHealth();
    if (previousReady && !network.serveReady) showToast(network.error ?? "Tailscale 连接已中断。", "error", 8000);
    else if (!previousReady && network.serveReady) showToast(`Tailnet 访问已就绪：${network.url}`, "info", 5000);
  } catch (error) {
    console.warn("Ignored malformed network status event.", error);
  }
});
events.addEventListener("provider-switch", (event) => {
  try {
    const update = JSON.parse(event.data);
    if (update.phase === "started") showToast("正在切换全局服务商…", "info");
    if (update.phase === "started") {
      state.providerSwitchInFlight = true;
      renderProviderStatus();
    }
    if (update.phase === "queued") {
      showToast("服务商切换已排队，将在当前轮次结束后执行。", "info", 6000);
      loadProviders().catch(() => undefined);
    }
    if (update.phase === "completed") {
      state.providerSwitchInFlight = false;
      if (Array.isArray(update.models)) applyProviderModels(update.models);
      showToast(update.gatewayRestarted ? "全局服务商切换完成，Codex 已重连。" : "全局服务商切换完成，下一轮请求开始生效。", "info");
      for (const warning of update.warnings ?? []) showToast(warning, "error", 8000);
      loadProviders().catch(() => undefined);
    }
    if (update.phase === "failed") {
      state.providerSwitchInFlight = false;
      renderProviderStatus();
      showToast(update.error ?? "服务商切换失败。", "error", 8000);
      loadProviders().catch(() => undefined);
    }
    if (update.phase === "portable-installed") {
      state.providerStatus = update.status;
      state.providers = update.status?.providers ?? [];
      renderProviderStatus();
    }
  } catch (error) {
    console.warn("Ignored malformed provider switch event.", error);
  }
});

(async () => {
  try {
    setTheme(state.theme);
    setCcSwitchVisibility(state.showCcSwitch);
    setMessageTimeVisibility(state.showMessageTimes);
    setMobileSidebar(false);
    await Promise.allSettled([
      refreshHealth(),
      loadProviders().catch((error) => {
        state.providerStatus = { available: false, compatible: false, error: error.message };
        renderProviderStatus();
      }),
    ]);
    if (state.health?.ok) {
      await Promise.all([loadModels(), loadThreads()]);
    }
  } catch (error) {
    showToast(error.message, "error", 8000);
  }
})();
