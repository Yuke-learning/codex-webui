import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";

const DEFAULT_INTERVAL_MS = 15_000;

export class TailscaleMonitor extends EventEmitter {
  #autoConfigure;
  #inFlight = null;
  #intervalMs;
  #runCommand;
  #status;
  #tailscaleBin;
  #target;
  #timer = null;

  constructor({
    target,
    tailscaleBin = "tailscale",
    intervalMs = DEFAULT_INTERVAL_MS,
    autoConfigure = true,
    runCommand = undefined,
  } = {}) {
    super();
    this.#target = normalizeTarget(target);
    this.#tailscaleBin = tailscaleBin;
    this.#intervalMs = Math.max(5_000, Number(intervalMs) || DEFAULT_INTERVAL_MS);
    this.#autoConfigure = autoConfigure;
    this.#runCommand = runCommand ?? ((args) => execTailscale(this.#tailscaleBin, args));
    this.#status = {
      available: null,
      connected: false,
      serveReady: false,
      url: null,
      dnsName: null,
      checkedAt: null,
      error: null,
    };
  }

  start() {
    if (this.#timer) return;
    void this.check();
    this.#timer = setInterval(() => void this.check(), this.#intervalMs);
    this.#timer.unref?.();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  current() {
    return { ...this.#status };
  }

  async check() {
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = this.#performCheck().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #performCheck() {
    const previousSignature = statusSignature(this.#status);
    let next;
    try {
      next = await inspectTailscale({
        target: this.#target,
        autoConfigure: this.#autoConfigure,
        runCommand: this.#runCommand,
      });
    } catch (error) {
      next = {
        available: error?.code !== "ENOENT",
        connected: false,
        serveReady: false,
        url: null,
        dnsName: null,
        error: compactError(error),
      };
    }
    this.#status = { ...next, checkedAt: new Date().toISOString() };
    if (statusSignature(this.#status) !== previousSignature) this.emit("change", this.current());
    return this.current();
  }
}

export async function inspectTailscale({ target, autoConfigure = true, runCommand }) {
  const normalizedTarget = normalizeTarget(target);
  const status = parseJson(await runCommand(["status", "--json"]), "Tailscale status");
  const dnsName = String(status?.Self?.DNSName ?? "").replace(/\.$/, "") || null;
  const connected = status?.BackendState === "Running" && status?.Self?.Online !== false;
  const base = {
    available: true,
    connected,
    serveReady: false,
    url: null,
    dnsName,
    error: connected ? null : `Tailscale is ${status?.BackendState || "not connected"}.`,
  };
  if (!connected) return base;

  let serveConfig = parseJson(await runCommand(["serve", "status", "--json"]), "Tailscale Serve status");
  let serveUrl = findServeUrl(serveConfig, normalizedTarget);
  if (!serveUrl && autoConfigure && canAutoConfigureServe(serveConfig)) {
    await runCommand(["serve", "--bg", "--yes", normalizedTarget]);
    serveConfig = parseJson(await runCommand(["serve", "status", "--json"]), "Tailscale Serve status");
    serveUrl = findServeUrl(serveConfig, normalizedTarget);
  }

  if (!serveUrl) {
    return {
      ...base,
      error: canAutoConfigureServe(serveConfig)
        ? "Tailscale Serve could not expose the WebUI."
        : "Tailscale Serve is already configured for another local service; the WebUI configuration was not overwritten.",
    };
  }
  return { ...base, serveReady: true, url: serveUrl, error: null };
}

export function findServeUrl(config, target) {
  const normalizedTarget = normalizeTarget(target);
  for (const [host, web] of Object.entries(config?.Web ?? {})) {
    const proxy = web?.Handlers?.["/"]?.Proxy;
    if (normalizeTarget(proxy) !== normalizedTarget) continue;
    return `https://${host.replace(/:443$/, "")}/`;
  }
  return null;
}

function canAutoConfigureServe(config) {
  return Object.keys(config?.Web ?? {}).length === 0 && Object.keys(config?.TCP ?? {}).length === 0;
}

function normalizeTarget(value) {
  return typeof value === "string" ? value.replace(/\/+$/, "") : "";
}

function parseJson(text, label) {
  try {
    return JSON.parse(text || "{}");
  } catch (error) {
    throw new Error(`${label} returned invalid JSON.`, { cause: error });
  }
}

function statusSignature(status) {
  return JSON.stringify({
    available: status.available,
    connected: status.connected,
    serveReady: status.serveReady,
    url: status.url,
    dnsName: status.dnsName,
    error: status.error,
  });
}

function compactError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown Tailscale error");
  return message.replace(/\s+/g, " ").trim().slice(0, 240);
}

function execTailscale(binary, args) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 8_000 }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}${stderr?.trim() ? `: ${stderr.trim()}` : ""}`;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}
