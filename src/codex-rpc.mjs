import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";

export class CodexRpcError extends Error {
  constructor(message, { code, data, cause } = {}) {
    super(message, { cause });
    this.name = "CodexRpcError";
    this.code = code;
    this.data = data;
  }
}

export class JsonRpcStreamParser {
  #buffer = Buffer.alloc(0);

  push(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const messages = [];

    while (this.#buffer.length > 0) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      const firstLineEnd = this.#buffer.indexOf("\n");
      const header = headerEnd >= 0 ? this.#buffer.subarray(0, headerEnd).toString("ascii") : "";
      const contentLength = /^Content-Length:\s*(\d+)\s*(?:\r?\n|$)/im.exec(header);

      if (contentLength) {
        const size = Number.parseInt(contentLength[1], 10);
        const contentStart = headerEnd + 4;
        if (this.#buffer.length < contentStart + size) break;
        messages.push(this.#parse(this.#buffer.subarray(contentStart, contentStart + size)));
        this.#buffer = this.#buffer.subarray(contentStart + size);
        continue;
      }

      if (firstLineEnd < 0) break;
      const line = this.#buffer.subarray(0, firstLineEnd).toString("utf8").trim();
      this.#buffer = this.#buffer.subarray(firstLineEnd + 1);
      if (line) messages.push(this.#parse(Buffer.from(line)));
    }

    return messages;
  }

  #parse(buffer) {
    try {
      return JSON.parse(buffer.toString("utf8"));
    } catch (cause) {
      throw new CodexRpcError("Codex app-server emitted invalid JSON-RPC data.", { cause });
    }
  }
}

export class CodexRpcClient extends EventEmitter {
  #child = null;
  #parser = new JsonRpcStreamParser();
  #pending = new Map();
  #nextId = 1;
  #closed = false;

  constructor({ codexBin = "codex", args = ["app-server", "proxy"], requestTimeoutMs = 30_000 } = {}) {
    super();
    this.codexBin = codexBin;
    this.args = args;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async connect() {
    if (this.#child && !this.#closed) return;
    this.#closed = false;

    try {
      this.#child = spawn(this.codexBin, this.args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (cause) {
      throw new CodexRpcError(`Unable to start \`${this.codexBin} ${this.args.join(" ")}\`.`, { cause });
    }

    this.#child.stdout.on("data", (chunk) => this.#handleData(chunk));
    this.#child.stderr.on("data", (chunk) => {
      this.emit("stderr", chunk.toString("utf8").trim());
    });
    this.#child.on("error", (cause) => this.#disconnect(cause));
    this.#child.on("exit", (code, signal) => {
      this.#disconnect(new CodexRpcError(`Codex app-server proxy exited (${code ?? signal ?? "unknown"}).`));
    });

    await this.request("initialize", {
      clientInfo: { name: "codex-webui", version: "0.1.0", title: "Codex WebUI" },
      capabilities: { experimentalApi: true },
    });
  }

  async request(method, params = {}) {
    await this.connect();
    if (!this.#child?.stdin.writable) {
      throw new CodexRpcError("Codex app-server proxy is not available.");
    }

    const id = this.#nextId++;
    const request = { id, method, params };
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CodexRpcError(`Timed out waiting for Codex method ${method}.`));
      }, this.requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timeout, method });
    });

    this.#child.stdin.write(`${JSON.stringify(request)}\n`);
    return response;
  }

  respond(id, result) {
    if (!this.#child?.stdin.writable) throw new CodexRpcError("Codex app-server proxy is not available.");
    this.#child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  close() {
    this.#closed = true;
    this.#child?.kill();
    this.#disconnect(new CodexRpcError("Codex app-server proxy was closed."));
  }

  #handleData(chunk) {
    let messages;
    try {
      messages = this.#parser.push(chunk);
    } catch (error) {
      this.emit("transportError", { message: error.message });
      return;
    }

    for (const message of messages) {
      if (Object.hasOwn(message, "method") && Object.hasOwn(message, "id")) {
        this.emit("serverRequest", message);
        continue;
      }

      if (Object.hasOwn(message, "method")) {
        this.emit("notification", message);
        continue;
      }

      const pending = this.#pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timeout);
      this.#pending.delete(message.id);

      if (message.error) {
        pending.reject(new CodexRpcError(message.error.message ?? `Codex method ${pending.method} failed.`, {
          code: message.error.code,
          data: message.error.data,
        }));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  #disconnect(error) {
    if (this.#closed && !this.#child) return;
    const child = this.#child;
    this.#child = null;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    if (child && !child.killed) child.kill();
    this.emit("disconnected", { message: error.message });
  }
}
