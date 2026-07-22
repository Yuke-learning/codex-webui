import { EventEmitter } from "node:events";
import path from "node:path";

import { CodexRpcClient, CodexRpcError } from "./codex-rpc.mjs";

export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "InputError";
    this.status = status;
  }
}

class KeyedQueue {
  #tails = new Map();

  run(key, task) {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.#tails.set(key, next);
    return next.finally(() => {
      if (this.#tails.get(key) === next) this.#tails.delete(key);
    });
  }
}

export class CodexGateway extends EventEmitter {
  #client = null;
  #connecting = null;
  #activeTurns = new Map();
  #runningThreads = new Set();
  #queue = new KeyedQueue();
  #transport = null;
  #connectionGeneration = 0;

  constructor({ codexBin = "codex" } = {}) {
    super();
    this.codexBin = codexBin;
  }

  async health() {
    try {
      const client = await this.#getClient();
      return { ok: true, connected: true, codexBin: this.codexBin, transport: this.#transport };
    } catch (error) {
      return {
        ok: false,
        connected: false,
        error: error instanceof Error ? error.message : "Codex app-server is unavailable.",
        hint: "Start a local Codex app-server, then refresh this page. See the README for the standalone daemon and direct app-server modes.",
      };
    }
  }

  async listThreads({ archived = false, searchTerm, cwd } = {}) {
    const params = {
      archived,
      searchTerm: optionalText(searchTerm),
      cwd: optionalText(cwd),
      sortKey: "updated_at",
      sortDirection: "desc",
      limit: 100,
    };
    const threads = await collectPaginatedThreadData((cursor) => this.#request("thread/list", {
      ...params,
      ...(cursor ? { cursor } : {}),
    }));
    for (const thread of threads) {
      if (!thread?.id) continue;
      if (isThreadRunning(thread.status)) this.#runningThreads.add(thread.id);
      else if (!this.#activeTurns.has(thread.id)) this.#runningThreads.delete(thread.id);
    }
    return threads.map(toThreadSummary);
  }

  async listModels() {
    const result = await this.#request("model/list", { limit: 100, includeHidden: false });
    return (result.data ?? []).map(toModelSummary);
  }

  async readThread(threadId) {
    assertThreadId(threadId);
    const resume = await this.#request("thread/resume", { threadId, excludeTurns: true });
    const result = await this.#request("thread/read", { threadId, includeTurns: true });
    const thread = {
      ...result.thread,
      settings: {
        model: resume.model,
        effort: resume.reasoningEffort,
      },
    };
    if (isThreadRunning(thread.status)) this.#runningThreads.add(threadId);
    else this.#runningThreads.delete(threadId);
    if (this.#activeTurns.has(threadId) && !isThreadRunning(thread.status)) thread.status = "running";
    return thread;
  }

  async createThread({ cwd, model, effort } = {}) {
    const safeCwd = assertAbsolutePath(cwd);
    const safeModel = optionalText(model);
    const safeEffort = optionalText(effort);
    const params = {
      cwd: safeCwd,
      approvalPolicy: "on-request",
      ...(safeModel ? { model: safeModel } : {}),
    };
    const result = await this.#request("thread/start", params);
    if (safeEffort) {
      await this.#request("thread/settings/update", {
        threadId: result.thread.id,
        effort: safeEffort,
      });
    }
    return result.thread;
  }

  async updateThreadSettings(threadId, { model, effort } = {}) {
    assertThreadId(threadId);
    const safeModel = optionalText(model);
    const safeEffort = optionalText(effort);
    if (!safeModel && !safeEffort) throw new InputError("Choose a model or reasoning effort to update.");
    await this.#request("thread/settings/update", {
      threadId,
      ...(safeModel ? { model: safeModel } : {}),
      ...(safeEffort ? { effort: safeEffort } : {}),
    });
    return { model: safeModel, effort: safeEffort };
  }

  async renameThread(threadId, name) {
    assertThreadId(threadId);
    const safeName = assertText(name, "Thread name", 120);
    const result = await this.#request("thread/name/set", { threadId, name: safeName });
    return result.thread ?? (await this.readThread(threadId));
  }

  async sendMessage(threadId, text) {
    assertThreadId(threadId);
    const safeText = assertText(text, "Message", 30_000);

    return this.#queue.run(threadId, async () => {
      const input = [{ type: "text", text: safeText }];
      const activeTurnId = this.#activeTurns.get(threadId);

      if (activeTurnId) {
        const result = await this.#request("turn/steer", { threadId, expectedTurnId: activeTurnId, input });
        return { mode: "steer", turn: result.turn };
      }

      await this.#request("thread/resume", { threadId, excludeTurns: true });
      const result = await this.#request("turn/start", { threadId, input });
      const turnId = result.turn?.id;
      if (turnId) this.#activeTurns.set(threadId, turnId);
      this.#runningThreads.add(threadId);
      return { mode: "start", turn: result.turn };
    });
  }

  async interruptTurn(threadId) {
    assertThreadId(threadId);
    const turnId = this.#activeTurns.get(threadId);
    if (!turnId) throw new InputError("This WebUI session has no active turn for the thread. Refresh the thread before stopping it.", 409);
    const result = await this.#request("turn/interrupt", { threadId, turnId });
    this.#activeTurns.delete(threadId);
    this.#runningThreads.delete(threadId);
    this.#emitIdleIfNeeded();
    return result;
  }

  async archiveThread(threadId) {
    assertThreadId(threadId);
    await this.#request("thread/archive", { threadId });
    this.#activeTurns.delete(threadId);
    this.#runningThreads.delete(threadId);
    this.#emitIdleIfNeeded();
  }

  async deleteThread(threadId) {
    assertThreadId(threadId);
    await this.#request("thread/delete", { threadId });
    this.#activeTurns.delete(threadId);
    this.#runningThreads.delete(threadId);
    this.#emitIdleIfNeeded();
  }

  hasActiveTurns() {
    return this.#activeTurns.size > 0 || this.#runningThreads.size > 0;
  }

  async reconnect() {
    if (this.hasActiveTurns()) {
      throw new InputError("Codex 正在执行任务，不能重连服务商配置。", 409);
    }
    this.close();
    const health = await this.health();
    if (!health.ok) {
      throw new CodexRpcError(health.error ?? "Codex app-server reconnect failed.");
    }
    const models = await this.listModels();
    const result = { health, models };
    this.emit("reconnected", result);
    return result;
  }

  close() {
    this.#connectionGeneration += 1;
    this.#client?.close();
    this.#client = null;
    this.#connecting = null;
    this.#transport = null;
  }

  async #request(method, params) {
    try {
      const client = await this.#getClient();
      return await client.request(method, params);
    } catch (error) {
      if (error instanceof CodexRpcError) throw error;
      throw new CodexRpcError(`Codex ${method} failed.`, { cause: error });
    }
  }

  async #getClient() {
    if (this.#client) return this.#client;
    if (this.#connecting) return this.#connecting;

    const generation = this.#connectionGeneration;
    const connecting = (async () => {
      const createClient = (args) => {
        const client = new CodexRpcClient({ codexBin: this.codexBin, args });
        client.on("notification", (event) => this.#handleNotification(event));
        client.on("serverRequest", (event) => this.emit("serverRequest", event));
        client.on("transportError", (event) => this.emit("transportError", event));
        client.on("stderr", (message) => this.emit("transportError", { message }));
        client.on("disconnected", (event) => {
          if (this.#client === client) {
            this.#client = null;
            this.#transport = null;
          }
          this.emit("transportError", event);
        });
        return client;
      };

      const proxyClient = createClient(["app-server", "proxy"]);
      try {
        await proxyClient.connect();
        if (generation !== this.#connectionGeneration) {
          proxyClient.close();
          throw new CodexRpcError("Codex connection was reset while connecting.");
        }
        this.#client = proxyClient;
        this.#transport = "managed-daemon proxy";
        return proxyClient;
      } catch (proxyError) {
        proxyClient.close();
        if (generation !== this.#connectionGeneration) throw proxyError;
        this.emit("transportError", {
          message: `Managed daemon is unavailable; using a direct local app-server instead. (${proxyError.message})`,
        });
      }

      const client = createClient(["app-server", "--stdio"]);
      await client.connect();
      if (generation !== this.#connectionGeneration) {
        client.close();
        throw new CodexRpcError("Codex connection was reset while connecting.");
      }
      this.#client = client;
      this.#transport = "direct local app-server";
      return client;
    })();
    this.#connecting = connecting;

    try {
      return await connecting;
    } finally {
      if (this.#connecting === connecting) this.#connecting = null;
    }
  }

  #handleNotification(event) {
    const params = event.params ?? {};
    const threadId = params.threadId ?? params.thread?.id ?? params.turn?.threadId;
    const turnId = params.turnId ?? params.turn?.id;

    if (event.method === "turn/started" && threadId && turnId) {
      this.#activeTurns.set(threadId, turnId);
      this.#runningThreads.add(threadId);
    }
    if (event.method === "turn/completed" && threadId) {
      this.#activeTurns.delete(threadId);
      this.#runningThreads.delete(threadId);
      this.#emitIdleIfNeeded();
    }
    if (event.method === "thread/status/changed" && threadId) {
      if (isThreadRunning(params.status ?? params.thread?.status)) this.#runningThreads.add(threadId);
      else {
        this.#activeTurns.delete(threadId);
        this.#runningThreads.delete(threadId);
        this.#emitIdleIfNeeded();
      }
    }
    this.emit("notification", event);
  }

  #emitIdleIfNeeded() {
    if (!this.hasActiveTurns()) this.emit("idle");
  }
}

function assertThreadId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{6,200}$/.test(value)) {
    throw new InputError("Invalid thread id.");
  }
  return value;
}

function assertText(value, label, limit) {
  if (typeof value !== "string") throw new InputError(`${label} is required.`);
  const text = value.trim();
  if (!text) throw new InputError(`${label} cannot be empty.`);
  if (text.length > limit) throw new InputError(`${label} is too long.`);
  return text;
}

function assertAbsolutePath(value) {
  const text = assertText(value, "Working directory", 2_000);
  if (!path.isAbsolute(text)) throw new InputError("Working directory must be an absolute path.");
  return text;
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isThreadRunning(status) {
  if (typeof status === "string") return ["running", "active"].includes(status);
  return status?.type === "running" || status?.status === "running";
}

export async function collectPaginatedThreadData(fetchPage) {
  const threads = [];
  const seenThreadIds = new Set();
  const seenCursors = new Set();
  let cursor;

  do {
    const result = await fetchPage(cursor);
    for (const thread of result?.data ?? []) {
      if (thread?.id && seenThreadIds.has(thread.id)) continue;
      if (thread?.id) seenThreadIds.add(thread.id);
      threads.push(thread);
    }

    const nextCursor = optionalText(result?.nextCursor);
    if (!nextCursor) break;
    if (seenCursors.has(nextCursor)) throw new CodexRpcError("Codex thread/list returned a repeated pagination cursor.");
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);

  return threads;
}

function toThreadSummary(thread) {
  return {
    id: thread.id,
    name: optionalText(thread.name),
    preview: summarizePreview(thread.preview),
    cwd: thread.cwd,
    status: thread.status,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    modelProvider: thread.modelProvider,
    parentThreadId: thread.parentThreadId ?? null,
    isProject: Boolean(thread.gitInfo?.branch || thread.gitInfo?.sha || thread.gitInfo?.originUrl),
  };
}

function summarizePreview(value) {
  if (typeof value !== "string") return "";
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > 96 ? `${compact.slice(0, 96)}…` : compact;
}

function toModelSummary(model) {
  return {
    id: model.id,
    model: model.model,
    displayName: model.displayName,
    description: model.description,
    isDefault: model.isDefault,
    defaultReasoningEffort: model.defaultReasoningEffort,
    supportedReasoningEfforts: model.supportedReasoningEfforts ?? [],
  };
}
