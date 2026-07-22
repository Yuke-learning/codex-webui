import assert from "node:assert/strict";
import test from "node:test";

import { inspectTailscale } from "../src/tailscale-monitor.mjs";

const connectedStatus = JSON.stringify({
  BackendState: "Running",
  Self: { Online: true, DNSName: "mac.example.ts.net." },
});

test("reports an existing matching Tailscale Serve route", async () => {
  const calls = [];
  const result = await inspectTailscale({
    target: "http://127.0.0.1:8787",
    runCommand: async (args) => {
      calls.push(args);
      if (args[0] === "status") return connectedStatus;
      return JSON.stringify({ Web: { "mac.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } } } });
    },
  });

  assert.equal(result.connected, true);
  assert.equal(result.serveReady, true);
  assert.equal(result.url, "https://mac.example.ts.net/");
  assert.equal(calls.length, 2);
});

test("configures Tailscale Serve when no route exists", async () => {
  let configured = false;
  const calls = [];
  const result = await inspectTailscale({
    target: "http://127.0.0.1:8787",
    runCommand: async (args) => {
      calls.push(args);
      if (args[0] === "status") return connectedStatus;
      if (args[0] === "serve" && args[1] === "--bg") {
        configured = true;
        return "";
      }
      return configured
        ? JSON.stringify({ Web: { "mac.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } } } })
        : "{}";
    },
  });

  assert.equal(result.serveReady, true);
  assert.ok(calls.some((args) => args.join(" ") === "serve --bg --yes http://127.0.0.1:8787"));
});

test("does not overwrite a conflicting Tailscale Serve configuration", async () => {
  const calls = [];
  const result = await inspectTailscale({
    target: "http://127.0.0.1:8787",
    runCommand: async (args) => {
      calls.push(args);
      if (args[0] === "status") return connectedStatus;
      return JSON.stringify({ Web: { "mac.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } });
    },
  });

  assert.equal(result.serveReady, false);
  assert.match(result.error, /not overwritten/i);
  assert.equal(calls.some((args) => args[1] === "--bg"), false);
});

test("reports a disconnected Tailscale backend without checking Serve", async () => {
  const calls = [];
  const result = await inspectTailscale({
    target: "http://127.0.0.1:8787",
    runCommand: async (args) => {
      calls.push(args);
      return JSON.stringify({ BackendState: "Stopped", Self: { Online: false } });
    },
  });

  assert.equal(result.connected, false);
  assert.equal(result.serveReady, false);
  assert.equal(calls.length, 1);
});
