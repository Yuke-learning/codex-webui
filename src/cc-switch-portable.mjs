import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { CcSwitchError, parseVersion, runCommand } from "./cc-switch-adapter.mjs";

export const PORTABLE_CC_SWITCH_MANIFEST = Object.freeze({
  version: "5.9.2",
  repository: "https://github.com/SaladDay/cc-switch-cli",
  assets: Object.freeze({
    "darwin-arm64": Object.freeze({
      name: "cc-switch-cli-darwin-arm64.tar.gz",
      sha256: "4b11d35bd0b5c7773fdfc4be9b4eddc3194af1c99e658c28f5cf134c3b929b1a",
      size: 7_374_749,
    }),
    "darwin-x64": Object.freeze({
      name: "cc-switch-cli-darwin-x64.tar.gz",
      sha256: "8000d4792b9186c22e0a4a4cf6b5570144cd9773511aedce2f8edb91e48e2209",
      size: 8_014_183,
    }),
    "linux-arm64": Object.freeze({
      name: "cc-switch-cli-linux-arm64-musl.tar.gz",
      sha256: "2a94b345dd19dd63d1f1c9069e511aa6e0e09381c6ddb209e699a939becec9e2",
      size: 7_202_266,
    }),
    "linux-x64": Object.freeze({
      name: "cc-switch-cli-linux-x64-musl.tar.gz",
      sha256: "a3054cd910102c5afb024cc4367564edb9351c2defd6a3b53b7512e70c8a8108",
      size: 7_978_072,
    }),
  }),
});

export class PortableCcSwitchInstaller {
  #installing = null;

  constructor({
    runtimeRoot,
    manifest = PORTABLE_CC_SWITCH_MANIFEST,
    platform = process.platform,
    arch = process.arch,
    fetchImpl = globalThis.fetch,
    extractor = extractTarArchive,
    verifier = verifyPortableBinary,
  } = {}) {
    if (!path.isAbsolute(runtimeRoot ?? "")) throw new TypeError("runtimeRoot must be an absolute path.");
    this.runtimeRoot = runtimeRoot;
    this.manifest = manifest;
    this.platform = platform;
    this.arch = arch;
    this.fetchImpl = fetchImpl;
    this.extractor = extractor;
    this.verifier = verifier;
  }

  status() {
    const asset = this.#asset();
    return {
      supported: Boolean(asset),
      installing: Boolean(this.#installing),
      version: this.manifest.version,
      asset: asset?.name ?? null,
      downloadSize: asset?.size ?? null,
      target: `${this.platform}-${this.arch}`,
    };
  }

  install() {
    if (this.#installing) return this.#installing;
    const operation = this.#install();
    this.#installing = operation;
    return operation.finally(() => {
      if (this.#installing === operation) this.#installing = null;
    });
  }

  targetPath() {
    const executable = this.platform === "win32" ? "cc-switch.exe" : "cc-switch";
    return path.join(this.runtimeRoot, `${this.platform}-${this.arch}`, executable);
  }

  async #install() {
    const asset = this.#asset();
    if (!asset) {
      throw new CcSwitchError("当前系统没有可用的 CC Switch 便携组件。", {
        code: "PORTABLE_UNSUPPORTED",
        status: 409,
      });
    }
    if (typeof this.fetchImpl !== "function") {
      throw new CcSwitchError("当前 Node.js 运行时不支持安全下载。", {
        code: "FETCH_UNAVAILABLE",
        status: 500,
      });
    }

    const url = `https://github.com/SaladDay/cc-switch-cli/releases/download/v${this.manifest.version}/${asset.name}`;
    const response = await this.fetchImpl(url, {
      headers: { "User-Agent": "codex-webui-portable-installer" },
      redirect: "follow",
    });
    if (!response?.ok) {
      throw new CcSwitchError(`便携组件下载失败（HTTP ${response?.status ?? "unknown"}）。`, {
        code: "DOWNLOAD_FAILED",
      });
    }
    const declaredLength = Number.parseInt(response.headers?.get?.("content-length") ?? "0", 10);
    if (declaredLength > 32 * 1024 * 1024) throw outputLimitError();
    const archive = Buffer.from(await response.arrayBuffer());
    if (archive.length > 32 * 1024 * 1024) throw outputLimitError();
    const digest = createHash("sha256").update(archive).digest("hex");
    if (digest !== asset.sha256) {
      throw new CcSwitchError("便携组件 SHA-256 校验失败，安装已取消。", {
        code: "CHECKSUM_MISMATCH",
      });
    }

    await mkdir(this.runtimeRoot, { recursive: true, mode: 0o700 });
    const temporaryRoot = await mkdtemp(path.join(this.runtimeRoot, ".install-"));
    let temporaryTarget = null;
    try {
      const archivePath = path.join(temporaryRoot, asset.name);
      const extractRoot = path.join(temporaryRoot, "extract");
      await mkdir(extractRoot, { mode: 0o700 });
      await writeFile(archivePath, archive, { mode: 0o600 });
      const extractedBinary = await this.extractor(archivePath, extractRoot);
      await assertSafeExtractedBinary(extractedBinary, extractRoot);

      const targetPath = this.targetPath();
      const targetDirectory = path.dirname(targetPath);
      await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
      temporaryTarget = `${targetPath}.tmp-${process.pid}`;
      await copyFile(extractedBinary, temporaryTarget);
      await chmod(temporaryTarget, 0o700);
      const version = await this.verifier(temporaryTarget);
      if (version !== this.manifest.version) {
        throw new CcSwitchError("便携组件版本与固定清单不一致，安装已取消。", {
          code: "VERSION_MISMATCH",
        });
      }
      await rename(temporaryTarget, targetPath);
      return {
        installed: true,
        version,
        source: "portable",
        target: `${this.platform}-${this.arch}`,
      };
    } finally {
      if (temporaryTarget) await rm(temporaryTarget, { force: true });
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  #asset() {
    return this.manifest.assets[`${this.platform}-${this.arch}`] ?? null;
  }
}

export async function extractTarArchive(archivePath, destination, { tarBinary = defaultTarBinary() } = {}) {
  const listing = await runCommand(tarBinary, ["-tzf", archivePath], { timeoutMs: 15_000 });
  const entries = validateArchiveEntries(listing.stdout);
  const binaryEntry = entries.find((entry) => path.posix.basename(entry) === "cc-switch");
  if (!binaryEntry) {
    throw new CcSwitchError("便携组件压缩包中没有 cc-switch 可执行文件。", {
      code: "BINARY_MISSING",
    });
  }
  await runCommand(tarBinary, ["-xzf", archivePath, "-C", destination], { timeoutMs: 20_000 });
  return path.join(destination, ...binaryEntry.split("/"));
}

export function validateArchiveEntries(output) {
  const entries = String(output ?? "").split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  if (!entries.length || entries.length > 100) {
    throw new CcSwitchError("便携组件压缩包结构无效。", { code: "INVALID_ARCHIVE" });
  }
  for (const entry of entries) {
    const normalized = path.posix.normalize(entry);
    if (path.posix.isAbsolute(entry) || normalized === ".." || normalized.startsWith("../")) {
      throw new CcSwitchError("便携组件压缩包包含不安全路径。", { code: "UNSAFE_ARCHIVE" });
    }
  }
  return entries;
}

export async function verifyPortableBinary(binary) {
  const result = await runCommand(binary, ["--version"], { timeoutMs: 8_000 });
  const version = parseVersion(result.stdout);
  if (!version) throw new CcSwitchError("无法验证便携组件版本。", { code: "VERSION_UNKNOWN" });
  return version;
}

export async function installedPortableVersion(binary) {
  try {
    await access(binary, fsConstants.X_OK);
    return await verifyPortableBinary(binary);
  } catch {
    return null;
  }
}

export async function assertSafeExtractedBinary(binary, extractionRoot) {
  await access(binary, fsConstants.R_OK);
  const [resolvedBinary, resolvedRoot] = await Promise.all([realpath(binary), realpath(extractionRoot)]);
  const relative = path.relative(resolvedRoot, resolvedBinary);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new CcSwitchError("便携组件可执行文件指向解压目录之外。", { code: "UNSAFE_BINARY" });
  }
  const stats = await lstat(resolvedBinary);
  if (!stats.isFile()) {
    throw new CcSwitchError("便携组件可执行文件不是普通文件。", { code: "INVALID_BINARY" });
  }
  return resolvedBinary;
}

function defaultTarBinary() {
  if (process.platform === "darwin") return "/usr/bin/tar";
  return "tar";
}

function outputLimitError() {
  return new CcSwitchError("便携组件下载内容超过安全限制。", { code: "DOWNLOAD_TOO_LARGE" });
}
