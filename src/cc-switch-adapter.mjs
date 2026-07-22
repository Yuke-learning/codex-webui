import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const MINIMUM_SUPPORTED_VERSION = "5.9.2";

export class CcSwitchError extends Error {
  constructor(message, { code = "CC_SWITCH_ERROR", cause, status = 502 } = {}) {
    super(message, { cause });
    this.name = "CcSwitchError";
    this.code = code;
    this.status = status;
  }
}

export class CcSwitchAdapter {
  #resolvedBinary = null;

  constructor({
    bin = process.env.CC_SWITCH_BIN,
    configDir = process.env.CC_SWITCH_CONFIG_DIR,
    runtimeRoot = path.join(projectRoot, ".runtime", "cc-switch"),
    env = process.env,
    platform = process.platform,
    arch = process.arch,
    mode = process.env.CC_SWITCH_MODE ?? "auto",
    runner = runCommand,
  } = {}) {
    this.bin = optionalText(bin);
    this.configDir = optionalAbsolutePath(configDir, "CC_SWITCH_CONFIG_DIR");
    this.runtimeRoot = runtimeRoot;
    this.env = env;
    this.platform = platform;
    this.arch = arch;
    this.mode = normalizeMode(mode);
    this.runner = runner;
  }

  async inspect() {
    const resolved = await this.resolveBinary();
    if (!resolved) {
      return unavailableStatus("未检测到 CC Switch CLI。", "not-found");
    }

    try {
      const versionResult = await this.#run(["--version"]);
      const version = parseVersion(versionResult.stdout);
      if (!isCompatibleCcSwitchVersion(version)) {
        return {
          available: true,
          compatible: false,
          source: resolved.source,
          version,
          providers: [],
          currentProviderId: null,
          mode: "unknown",
          requiresRestart: null,
          error: `CC Switch CLI 版本不兼容，需要 ${MINIMUM_SUPPORTED_VERSION} 或同一主版本的更新版本。`,
        };
      }
      const [providerResult, proxyStatus] = await Promise.all([
        this.#run(["--app", "codex", "provider", "list"]),
        this.proxyStatus(),
      ]);
      const parsed = parseProviderList(providerResult.stdout);
      return {
        available: true,
        compatible: true,
        source: resolved.source,
        version,
        providers: parsed.providers,
        currentProviderId: parsed.currentProviderId,
        mode: proxyStatus.mode,
        requiresRestart: proxyStatus.requiresRestart,
        error: null,
      };
    } catch (error) {
      return {
        available: true,
        compatible: false,
        source: resolved.source,
        version: null,
        providers: [],
        currentProviderId: null,
        mode: "unknown",
        requiresRestart: null,
        error: publicError(error),
      };
    }
  }

  async activate(providerId) {
    const id = assertProviderId(providerId);
    await this.#run(["--app", "codex", "provider", "switch", id], { timeoutMs: 30_000 });
    return { providerId: id };
  }

  async proxyStatus() {
    if (this.mode === "proxy") return { mode: "proxy", requiresRestart: false };
    if (this.mode === "config") return { mode: "config", requiresRestart: true };

    try {
      const result = await this.#run(["--app", "codex", "proxy", "show"]);
      const enabled = parseProxyEnabled(result.stdout);
      return { mode: enabled ? "proxy" : "config", requiresRestart: !enabled };
    } catch {
      return { mode: "config", requiresRestart: true };
    }
  }

  async resolveBinary({ refresh = false } = {}) {
    if (!refresh && this.#resolvedBinary) return this.#resolvedBinary;

    const candidates = [];
    if (this.bin) {
      if (!path.isAbsolute(this.bin)) {
        throw new CcSwitchError("CC_SWITCH_BIN 必须是绝对路径。", {
          code: "INVALID_BINARY_PATH",
          status: 500,
        });
      }
      candidates.push({ path: this.bin, source: "configured" });
    }

    const executableName = this.platform === "win32" ? "cc-switch.exe" : "cc-switch";
    const portablePath = path.join(this.runtimeRoot, `${this.platform}-${this.arch}`, executableName);
    candidates.push({ path: portablePath, source: "portable" });

    for (const directory of String(this.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
      candidates.push({ path: path.join(directory, executableName), source: "path" });
    }

    if (this.platform === "darwin") {
      candidates.push(
        { path: "/opt/homebrew/bin/cc-switch", source: "system" },
        { path: "/usr/local/bin/cc-switch", source: "system" },
        { path: path.join(os.homedir(), ".local", "bin", "cc-switch"), source: "user" },
      );
    }

    const seen = new Set();
    for (const candidate of candidates) {
      if (seen.has(candidate.path)) continue;
      seen.add(candidate.path);
      if (await isExecutable(candidate.path)) {
        this.#resolvedBinary = candidate;
        return candidate;
      }
    }

    this.#resolvedBinary = null;
    return null;
  }

  async #run(args, options = {}) {
    const resolved = await this.resolveBinary();
    if (!resolved) {
      throw new CcSwitchError("未检测到 CC Switch CLI。", {
        code: "CC_SWITCH_NOT_FOUND",
        status: 503,
      });
    }
    return this.runner(resolved.path, args, {
      ...options,
      env: commandEnvironment(this.env, this.configDir),
    });
  }
}

export function parseProviderList(output) {
  const clean = stripAnsi(String(output ?? ""));
  const json = tryParseJson(clean);
  if (json) return parseJsonProviders(json);

  const currentProviderId = extractCurrentProviderId(clean);
  const providers = [];
  const seen = new Set();

  for (const line of clean.split(/\r?\n/)) {
    if (!line.includes("│") && !line.includes("|")) continue;
    const cells = line
      .split(line.includes("│") ? "│" : "|")
      .map((cell) => cell.trim())
      .filter((cell, index, array) => cell || (index > 0 && index < array.length - 1));
    if (cells.length < 3) continue;

    const [marker, id, name] = cells;
    if (/^id$/i.test(id) || /^name$/i.test(name) || !PROVIDER_ID_PATTERN.test(id) || seen.has(id)) continue;
    seen.add(id);
    providers.push({
      id,
      name: name || id,
      active: marker.includes("✓") || marker.includes("*") || id === currentProviderId,
    });
  }

  const inferredCurrent = currentProviderId ?? providers.find((provider) => provider.active)?.id ?? null;
  for (const provider of providers) provider.active = provider.id === inferredCurrent;
  return { providers, currentProviderId: inferredCurrent };
}

export function parseVersion(output) {
  const match = String(output ?? "").match(/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  return match?.[1] ?? null;
}

export function isCompatibleCcSwitchVersion(version) {
  const parsed = parseSemver(version);
  const minimum = parseSemver(MINIMUM_SUPPORTED_VERSION);
  if (!parsed || parsed.major !== minimum.major) return false;
  if (parsed.minor !== minimum.minor) return parsed.minor > minimum.minor;
  return parsed.patch >= minimum.patch;
}

export function parseProxyEnabled(output) {
  const clean = stripAnsi(String(output ?? ""));
  const json = tryParseJson(clean);
  if (json) {
    const candidate = json.codex ?? json.routes?.codex ?? json.apps?.codex ?? json;
    const state = candidate?.enabled ?? candidate?.active ?? candidate?.running ?? candidate?.takeover;
    if (typeof state === "boolean") return state;
    if (typeof state === "string") return /^(?:enabled|active|running|true|on)$/i.test(state.trim());
  }

  for (const line of clean.split(/\r?\n/)) {
    if (!/codex/i.test(line)) continue;
    if (/disabled|inactive|stopped|关闭|禁用|未启用/i.test(line)) return false;
    if (/enabled|active|running|takeover|接管|启用|运行中/i.test(line)) return true;
  }
  return /takeover\s*[:：]?\s*codex|codex\s+proxy\s+(?:enabled|running)/i.test(clean);
}

export function assertProviderId(value) {
  if (typeof value !== "string" || !PROVIDER_ID_PATTERN.test(value)) {
    throw new CcSwitchError("无效的服务商 ID。", { code: "INVALID_PROVIDER_ID", status: 400 });
  }
  return value;
}

export function publicError(error) {
  if (error instanceof CcSwitchError) return error.message;
  const combined = `${error?.message ?? ""}\n${error?.stderr ?? ""}`.toLowerCase();
  if (combined.includes("newer version") || combined.includes("较新版本") || combined.includes("schema")) {
    return "CC Switch 数据库版本与当前便携组件不兼容。";
  }
  if (combined.includes("not initialized") || combined.includes("尚未初始化")) {
    return "Codex 尚未初始化，无法读取服务商状态。";
  }
  return "无法读取 CC Switch 服务商状态。";
}

export function runCommand(binary, args, { env = process.env, timeoutMs = 12_000, maxOutputBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const collect = (target, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill("SIGTERM");
        finish(() => reject(new CcSwitchError("CC Switch 输出超过安全限制。", { code: "OUTPUT_LIMIT" })));
        return target;
      }
      return target + chunk.toString("utf8");
    };

    child.stdout.on("data", (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = collect(stderr, chunk); });
    child.on("error", (cause) => {
      finish(() => reject(new CcSwitchError("无法启动 CC Switch CLI。", { code: "SPAWN_FAILED", cause })));
    });
    child.on("close", (code, signal) => {
      finish(() => {
        if (code === 0) resolve({ stdout, stderr, code });
        else {
          const error = new Error(`CC Switch exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}.`);
          error.code = code;
          error.stderr = stderr;
          reject(error);
        }
      });
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new CcSwitchError("CC Switch 操作超时。", { code: "TIMEOUT" })));
    }, timeoutMs);
    timer.unref?.();
  });
}

function parseJsonProviders(value) {
  const items = Array.isArray(value) ? value : value.providers ?? value.data ?? [];
  const declaredCurrent = optionalText(value.currentProviderId ?? value.current ?? value.current_id);
  const providers = [];
  for (const item of items) {
    const id = optionalText(item?.id ?? item?.providerId ?? item?.provider_id);
    if (!id || !PROVIDER_ID_PATTERN.test(id)) continue;
    providers.push({
      id,
      name: optionalText(item?.name ?? item?.displayName) ?? id,
      active: Boolean(item?.active ?? item?.isCurrent ?? item?.is_current) || id === declaredCurrent,
    });
  }
  const currentProviderId = declaredCurrent ?? providers.find((provider) => provider.active)?.id ?? null;
  for (const provider of providers) provider.active = provider.id === currentProviderId;
  return { providers, currentProviderId };
}

function extractCurrentProviderId(output) {
  const match = output.match(/(?:Current|当前)(?:\s+Provider)?\s*[:：]\s*([^\s]+)/i);
  const id = optionalText(match?.[1]);
  return id && PROVIDER_ID_PATTERN.test(id) ? id : null;
}

function stripAnsi(value) {
  return value.replace(ANSI_PATTERN, "");
}

function tryParseJson(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function unavailableStatus(error, source) {
  return {
    available: false,
    compatible: false,
    source,
    version: null,
    providers: [],
    currentProviderId: null,
    mode: "unavailable",
    requiresRestart: null,
    error,
  };
}

function commandEnvironment(env, configDir) {
  return {
    ...env,
    NO_COLOR: "1",
    CLICOLOR: "0",
    TERM: "dumb",
    ...(configDir ? { CC_SWITCH_CONFIG_DIR: configDir } : {}),
  };
}

async function isExecutable(candidate) {
  try {
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalAbsolutePath(value, label) {
  const text = optionalText(value);
  if (!text) return undefined;
  if (!path.isAbsolute(text)) {
    throw new CcSwitchError(`${label} 必须是绝对路径。`, { code: "INVALID_CONFIG_PATH", status: 500 });
  }
  return text;
}

function normalizeMode(value) {
  const mode = String(value ?? "auto").trim().toLowerCase();
  if (!["auto", "proxy", "config"].includes(mode)) {
    throw new CcSwitchError("CC_SWITCH_MODE 必须是 auto、proxy 或 config。", {
      code: "INVALID_MODE",
      status: 500,
    });
  }
  return mode;
}

function parseSemver(value) {
  const match = String(value ?? "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}
