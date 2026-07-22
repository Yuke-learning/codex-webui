import assert from "node:assert/strict";
import test from "node:test";

import { createLaunchAgentPlist, LAUNCHD_LABEL, LEGACY_LAUNCHD_LABELS } from "../src/launchd-service.mjs";

test("creates a loopback-only keepalive LaunchAgent without shell interpolation", () => {
  const plist = createLaunchAgentPlist({
    nodeBinary: "/Users/test/.local/share/fnm/node & stable/bin/node",
    runnerPath: "/Users/test/Code/codex web/scripts/run-service.mjs",
    workingDirectory: "/Users/test/Code/codex web",
    stdoutPath: "/Users/test/Code/codex web/logs/stdout.log",
    stderrPath: "/Users/test/Code/codex web/logs/stderr.log",
    homeDirectory: "/Users/test",
    pathValue: "/stable/node/bin:/usr/bin:/bin",
    codexBinary: "/Users/test/.npm-global/bin/codex",
    tailscaleBinary: "/usr/local/bin/tailscale",
    ccSwitchBinary: "/Users/test/.local/bin/cc-switch",
    ccSwitchConfigDir: "/Users/test/.cc-switch",
    ccSwitchMode: "auto",
  });

  assert.match(plist, new RegExp(`<string>${LAUNCHD_LABEL}</string>`));
  assert.equal(LAUNCHD_LABEL, "io.github.yuke-learning.codex-webui");
  assert.deepEqual([...LEGACY_LAUNCHD_LABELS], ["com.yuke.codex-webui"]);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>HOST<\/key>\s*<string>127\.0\.0\.1<\/string>/);
  assert.match(plist, /<key>PORT<\/key>\s*<string>8787<\/string>/);
  assert.match(plist, /node &amp; stable/);
  assert.match(plist, /<key>CC_SWITCH_BIN<\/key>\s*<string>\/Users\/test\/\.local\/bin\/cc-switch<\/string>/);
  assert.match(plist, /<key>CC_SWITCH_CONFIG_DIR<\/key>\s*<string>\/Users\/test\/\.cc-switch<\/string>/);
  assert.match(plist, /<key>CC_SWITCH_MODE<\/key>\s*<string>auto<\/string>/);
  assert.doesNotMatch(plist, /\/bin\/(?:ba|z|fi)?sh<\/string>/);
});

test("allows local-only installation when Tailscale is not installed", () => {
  const plist = createLaunchAgentPlist({
    nodeBinary: "/opt/node/bin/node",
    runnerPath: "/Users/test/codex-webui/scripts/run-service.mjs",
    workingDirectory: "/Users/test/codex-webui",
    stdoutPath: "/Users/test/codex-webui/logs/stdout.log",
    stderrPath: "/Users/test/codex-webui/logs/stderr.log",
    homeDirectory: "/Users/test",
    pathValue: "/opt/node/bin:/usr/bin:/bin",
    codexBinary: "/usr/local/bin/codex",
    tailscaleBinary: null,
  });

  assert.doesNotMatch(plist, /TAILSCALE_BIN/);
});

test("rejects relative executable and working paths", () => {
  assert.throws(() => createLaunchAgentPlist({
    nodeBinary: "node",
    runnerPath: "/tmp/run.mjs",
    workingDirectory: "/tmp/project",
    stdoutPath: "/tmp/out.log",
    stderrPath: "/tmp/err.log",
    homeDirectory: "/Users/test",
    pathValue: "/usr/bin:/bin",
    codexBinary: "/usr/local/bin/codex",
    tailscaleBinary: "/usr/local/bin/tailscale",
  }), /nodeBinary must be an absolute path/);
});
