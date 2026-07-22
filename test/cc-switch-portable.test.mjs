import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PortableCcSwitchInstaller, validateArchiveEntries } from "../src/cc-switch-portable.mjs";

function responseFor(buffer) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => name.toLowerCase() === "content-length" ? String(buffer.length) : null },
    arrayBuffer: async () => buffer,
  };
}

test("installs a pinned portable binary only after checksum and version verification", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "cc-switch-portable-"));
  const archive = Buffer.from("verified archive fixture");
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const installer = new PortableCcSwitchInstaller({
    runtimeRoot,
    platform: "darwin",
    arch: "arm64",
    manifest: {
      version: "5.9.2",
      assets: { "darwin-arm64": { name: "fixture.tar.gz", sha256, size: archive.length } },
    },
    fetchImpl: async () => responseFor(archive),
    extractor: async (_archivePath, destination) => {
      const binary = path.join(destination, "cc-switch");
      await writeFile(binary, "portable fixture");
      return binary;
    },
    verifier: async () => "5.9.2",
  });

  const result = await installer.install();
  assert.equal(result.installed, true);
  assert.equal(result.version, "5.9.2");
  await access(installer.targetPath());
});

test("rejects a portable download with the wrong checksum", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "cc-switch-checksum-"));
  const installer = new PortableCcSwitchInstaller({
    runtimeRoot,
    platform: "darwin",
    arch: "arm64",
    manifest: {
      version: "5.9.2",
      assets: { "darwin-arm64": { name: "fixture.tar.gz", sha256: "0".repeat(64), size: 3 } },
    },
    fetchImpl: async () => responseFor(Buffer.from("bad")),
  });
  await assert.rejects(installer.install(), /SHA-256 校验失败/);
});

test("rejects archive traversal entries", () => {
  assert.deepEqual(validateArchiveEntries("cc-switch\nLICENSE\n"), ["cc-switch", "LICENSE"]);
  assert.throws(() => validateArchiveEntries("../cc-switch\n"), /不安全路径/);
  assert.throws(() => validateArchiveEntries("/tmp/cc-switch\n"), /不安全路径/);
});

test("rejects an extracted binary symlink that escapes the private directory", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "cc-switch-symlink-"));
  const outside = path.join(runtimeRoot, "outside-binary");
  await writeFile(outside, "outside");
  const archive = Buffer.from("symlink archive fixture");
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const installer = new PortableCcSwitchInstaller({
    runtimeRoot,
    platform: "darwin",
    arch: "arm64",
    manifest: {
      version: "5.9.2",
      assets: { "darwin-arm64": { name: "fixture.tar.gz", sha256, size: archive.length } },
    },
    fetchImpl: async () => responseFor(archive),
    extractor: async (_archivePath, destination) => {
      const binary = path.join(destination, "cc-switch");
      await symlink(outside, binary);
      return binary;
    },
  });
  await assert.rejects(installer.install(), /解压目录之外/);
});
