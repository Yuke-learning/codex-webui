import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { ProviderManager } from "../src/provider-manager.mjs";

class FakeGateway extends EventEmitter {
  active = false;
  reconnectCalls = 0;
  listModelCalls = 0;
  reconnectResults = [];
  hasActiveTurns() { return this.active; }
  async listModels() {
    this.listModelCalls += 1;
    return [{ id: "model-a", model: "model-a" }];
  }
  async reconnect() {
    this.reconnectCalls += 1;
    const next = this.reconnectResults.shift();
    if (next instanceof Error) throw next;
    return next ?? { models: [{ id: "model-b", model: "model-b" }] };
  }
}

class FakeAdapter {
  constructor({ mode = "proxy" } = {}) {
    this.current = "official";
    this.mode = mode;
    this.activations = [];
  }
  async inspect() {
    return {
      available: true,
      compatible: true,
      providers: [
        { id: "official", name: "OpenAI", active: this.current === "official" },
        { id: "kimi", name: "Kimi", active: this.current === "kimi" },
      ],
      currentProviderId: this.current,
      mode: this.mode,
      requiresRestart: this.mode !== "proxy",
    };
  }
  async activate(id) {
    this.activations.push(id);
    this.current = id;
  }
}

test("queues a proxy switch while a turn is active and applies it when idle", async () => {
  const gateway = new FakeGateway();
  gateway.active = true;
  const adapter = new FakeAdapter();
  const manager = new ProviderManager({ adapter, gateway });
  const events = [];
  manager.on("event", (event) => events.push(event));

  const queued = await manager.activate("kimi", { idempotencyKey: "request-0001" });
  assert.equal(queued.state, "queued");
  assert.deepEqual(adapter.activations, []);

  gateway.active = false;
  gateway.emit("idle");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(adapter.activations, ["kimi"]);
  assert.deepEqual(events.map((event) => event.phase), ["queued", "started", "completed"]);
});

test("deduplicates activation requests with the same idempotency key", async () => {
  const gateway = new FakeGateway();
  const adapter = new FakeAdapter();
  const manager = new ProviderManager({ adapter, gateway });
  const first = manager.activate("kimi", { idempotencyKey: "same-request" });
  const second = manager.activate("kimi", { idempotencyKey: "same-request" });
  assert.equal(first, second);
  assert.equal((await first).state, "completed");
  assert.deepEqual(adapter.activations, ["kimi"]);
});

test("rejects config switching until the reconnect phase is enabled", async () => {
  const manager = new ProviderManager({
    adapter: new FakeAdapter({ mode: "config" }),
    gateway: new FakeGateway(),
    allowConfigSwitch: false,
  });
  await assert.rejects(
    manager.activate("kimi", { idempotencyKey: "config-request" }),
    /当前不是代理接管模式/,
  );
});

test("reconnects Codex and refreshes models after a config switch", async () => {
  const gateway = new FakeGateway();
  const adapter = new FakeAdapter({ mode: "config" });
  const manager = new ProviderManager({ adapter, gateway });
  const result = await manager.activate("kimi", { idempotencyKey: "config-reconnect" });
  assert.equal(result.state, "completed");
  assert.equal(result.gatewayRestarted, true);
  assert.deepEqual(result.models, [{ id: "model-b", model: "model-b" }]);
  assert.equal(gateway.reconnectCalls, 1);
  assert.equal(adapter.current, "kimi");
});

test("rolls back the provider when config reconnect verification fails", async () => {
  const gateway = new FakeGateway();
  gateway.reconnectResults.push(new Error("reconnect failed"), { models: [{ id: "old", model: "old" }] });
  const adapter = new FakeAdapter({ mode: "config" });
  const manager = new ProviderManager({ adapter, gateway });

  await assert.rejects(
    manager.activate("kimi", { idempotencyKey: "rollback-request" }),
    /已自动恢复原服务商/,
  );
  assert.deepEqual(adapter.activations, ["kimi", "official"]);
  assert.equal(adapter.current, "official");
  assert.equal(gateway.reconnectCalls, 2);
});
