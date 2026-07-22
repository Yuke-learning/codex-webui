import assert from "node:assert/strict";
import test from "node:test";

import { createLaunchAgentPlist, LAUNCHD_LABEL } from "../src/launchd-service.mjs";

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
  });

  assert.match(plist, new RegExp(`<string>${LAUNCHD_LABEL}</string>`));
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>HOST<\/key>\s*<string>127\.0\.0\.1<\/string>/);
  assert.match(plist, /<key>PORT<\/key>\s*<string>8787<\/string>/);
  assert.match(plist, /node &amp; stable/);
  assert.doesNotMatch(plist, /\/bin\/(?:ba|z|fi)?sh<\/string>/);
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
