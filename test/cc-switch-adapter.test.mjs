import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CcSwitchAdapter, assertProviderId, isCompatibleCcSwitchVersion, parseProviderList, parseProxyEnabled, parseVersion } from "../src/cc-switch-adapter.mjs";

test("parses provider table without returning API URLs", () => {
  const result = parseProviderList(`
┌───┬──────────┬──────────────┬──────────────────────────┐
│   │ ID       │ Name         │ API URL                  │
├───┼──────────┼──────────────┼──────────────────────────┤
│ ✓ │ official │ OpenAI 官方  │ https://api.openai.com   │
│   │ kimi     │ Kimi         │ https://secret.invalid   │
└───┴──────────┴──────────────┴──────────────────────────┘
ℹ Application: codex
→ Current: official
`);

  assert.deepEqual(result, {
    currentProviderId: "official",
    providers: [
      { id: "official", name: "OpenAI 官方", active: true },
      { id: "kimi", name: "Kimi", active: false },
    ],
  });
  assert.doesNotMatch(JSON.stringify(result), /api\.openai|secret\.invalid/);
});

test("accepts future JSON provider output", () => {
  const result = parseProviderList(JSON.stringify({
    currentProviderId: "moonshot",
    providers: [
      { id: "moonshot", name: "Moonshot", apiKey: "must-not-leak" },
      { id: "openai", name: "OpenAI" },
    ],
  }));
  assert.deepEqual(result.providers, [
    { id: "moonshot", name: "Moonshot", active: true },
    { id: "openai", name: "OpenAI", active: false },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak/);
});

test("extracts semantic versions and validates provider ids", () => {
  assert.equal(parseVersion("cc-switch 5.9.2"), "5.9.2");
  assert.equal(assertProviderId("provider:name-1"), "provider:name-1");
  assert.throws(() => assertProviderId("provider; touch /tmp/no"), /无效的服务商 ID/);
  assert.equal(isCompatibleCcSwitchVersion("5.9.2"), true);
  assert.equal(isCompatibleCcSwitchVersion("5.10.0"), true);
  assert.equal(isCompatibleCcSwitchVersion("5.9.1"), false);
  assert.equal(isCompatibleCcSwitchVersion("6.0.0"), false);
});

test("does not touch provider state when the CLI version is incompatible", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cc-switch-incompatible-"));
  const binary = path.join(directory, "cc-switch");
  await writeFile(binary, "#!/bin/sh\nexit 0\n");
  await chmod(binary, 0o700);
  const calls = [];
  const adapter = new CcSwitchAdapter({
    bin: binary,
    runner: async (_binary, args) => {
      calls.push(args);
      return { stdout: "cc-switch 6.0.0\n", stderr: "", code: 0 };
    },
  });
  const status = await adapter.inspect();
  assert.equal(status.available, true);
  assert.equal(status.compatible, false);
  assert.deepEqual(calls, [["--version"]]);
});

test("detects Codex proxy takeover status", () => {
  assert.equal(parseProxyEnabled("│ Codex │ enabled │ running │"), true);
  assert.equal(parseProxyEnabled("Codex proxy: disabled"), false);
  assert.equal(parseProxyEnabled('{"codex":{"enabled":true}}'), true);
});

test("detects a configured executable and returns sanitized provider status", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cc-switch-adapter-"));
  const binary = path.join(directory, "cc-switch");
  await writeFile(binary, "#!/bin/sh\nexit 0\n");
  await chmod(binary, 0o700);
  const calls = [];
  const adapter = new CcSwitchAdapter({
    bin: binary,
    runner: async (_binary, args) => {
      calls.push(args);
      if (args.includes("--version")) return { stdout: "cc-switch 5.9.2\n", stderr: "", code: 0 };
      if (args.includes("proxy")) return { stdout: "Codex proxy: enabled\n", stderr: "", code: 0 };
      return {
        stdout: "│ ✓ │ official │ OpenAI │ https://api.openai.com │\n→ Current: official\n",
        stderr: "",
        code: 0,
      };
    },
  });

  const status = await adapter.inspect();
  assert.equal(status.available, true);
  assert.equal(status.compatible, true);
  assert.equal(status.source, "configured");
  assert.equal(status.version, "5.9.2");
  assert.deepEqual(status.providers, [{ id: "official", name: "OpenAI", active: true }]);
  assert.deepEqual(calls, [
    ["--version"],
    ["--app", "codex", "provider", "list"],
    ["--app", "codex", "proxy", "show"],
  ]);
});
