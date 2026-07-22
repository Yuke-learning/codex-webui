import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import { CcSwitchError, assertProviderId } from "./cc-switch-adapter.mjs";

export class ProviderManager extends EventEmitter {
  #operation = null;
  #pending = null;
  #idempotency = new Map();

  constructor({ adapter, gateway, allowConfigSwitch = true } = {}) {
    super();
    if (!adapter || !gateway) throw new TypeError("ProviderManager requires adapter and gateway.");
    this.adapter = adapter;
    this.gateway = gateway;
    this.allowConfigSwitch = allowConfigSwitch;
    this.gateway.on("idle", () => this.#drainPending());
  }

  async status() {
    const status = await this.adapter.inspect();
    return {
      ...status,
      switching: Boolean(this.#operation),
      pendingProviderId: this.#pending?.providerId ?? null,
    };
  }

  activate(providerId, { idempotencyKey = randomUUID() } = {}) {
    const id = assertProviderId(providerId);
    const key = assertIdempotencyKey(idempotencyKey);
    if (this.#idempotency.has(key)) return this.#idempotency.get(key);

    const request = this.#requestActivation(id, key);
    this.#idempotency.set(key, request);
    if (this.#idempotency.size > 100) this.#idempotency.delete(this.#idempotency.keys().next().value);
    return request;
  }

  async #requestActivation(providerId, idempotencyKey) {
    if (this.gateway.hasActiveTurns() || this.#operation) {
      const replacedProviderId = this.#pending?.providerId ?? null;
      this.#pending = { providerId, idempotencyKey };
      const result = {
        ok: true,
        state: "queued",
        providerId,
        idempotencyKey,
        effectiveFrom: "next-turn",
        replacedProviderId,
      };
      this.#emit("queued", result);
      return result;
    }
    return this.#performSwitch(providerId, idempotencyKey);
  }

  async #performSwitch(providerId, idempotencyKey) {
    const operation = this.#switchNow(providerId, idempotencyKey);
    this.#operation = operation;
    try {
      return await operation;
    } finally {
      if (this.#operation === operation) this.#operation = null;
      queueMicrotask(() => this.#drainPending());
    }
  }

  async #switchNow(providerId, idempotencyKey) {
    const before = await this.adapter.inspect();
    ensureUsable(before);
    if (!before.providers.some((provider) => provider.id === providerId)) {
      throw new CcSwitchError("所选服务商不存在或已被删除。", {
        code: "PROVIDER_NOT_FOUND",
        status: 404,
      });
    }
    if (before.mode !== "proxy" && !this.allowConfigSwitch) {
      throw new CcSwitchError("当前不是代理接管模式，暂不能进行免重启切换。", {
        code: "CONFIG_SWITCH_DISABLED",
        status: 409,
      });
    }
    if (before.currentProviderId === providerId) {
      return {
        ok: true,
        state: "unchanged",
        providerId,
        idempotencyKey,
        effectiveFrom: "already-active",
        mode: before.mode,
        gatewayRestarted: false,
      };
    }

    this.#emit("started", { providerId, idempotencyKey, mode: before.mode });
    let providerChanged = false;
    try {
      await this.adapter.activate(providerId);
      providerChanged = true;
      const after = await this.adapter.inspect();
      ensureUsable(after);
      if (after.currentProviderId !== providerId) {
        throw new CcSwitchError("CC Switch 未确认目标服务商已启用。", {
          code: "SWITCH_NOT_CONFIRMED",
        });
      }
      let gatewayRestarted = false;
      let models = null;
      const warnings = [];
      if (after.mode === "config") {
        const reconnect = await this.gateway.reconnect();
        gatewayRestarted = true;
        models = reconnect.models;
      } else {
        try {
          models = await this.gateway.listModels();
        } catch {
          warnings.push("服务商已切换，但模型列表暂时无法刷新。请稍后手动刷新页面。");
        }
      }

      const result = {
        ok: true,
        state: "completed",
        providerId,
        idempotencyKey,
        previousProviderId: before.currentProviderId,
        effectiveFrom: "next-turn",
        mode: after.mode,
        gatewayRestarted,
        models,
        warnings,
      };
      this.#emit("completed", result);
      return result;
    } catch (error) {
      const rollback = providerChanged && before.currentProviderId && before.currentProviderId !== providerId
        ? await this.#rollback(before.currentProviderId, before.mode)
        : { attempted: false, succeeded: false };
      const wrapped = rollback.attempted
        ? new CcSwitchError(
            rollback.succeeded
              ? "服务商切换验证失败，已自动恢复原服务商。"
              : "服务商切换失败，且自动恢复原服务商未完成；请在 Mac 上检查 CC Switch。",
            { code: rollback.succeeded ? "SWITCH_ROLLED_BACK" : "ROLLBACK_FAILED", cause: error },
          )
        : error;
      this.#emit("failed", {
        providerId,
        code: wrapped?.code ?? "SWITCH_FAILED",
        error: publicSwitchError(wrapped),
        rollback,
      });
      throw wrapped;
    }
  }

  async #rollback(providerId, mode) {
    try {
      await this.adapter.activate(providerId);
      const restored = await this.adapter.inspect();
      if (restored.currentProviderId !== providerId) return { attempted: true, succeeded: false };
      if (mode === "config") await this.gateway.reconnect();
      return { attempted: true, succeeded: true };
    } catch {
      return { attempted: true, succeeded: false };
    }
  }

  #drainPending() {
    if (!this.#pending || this.#operation || this.gateway.hasActiveTurns()) return;
    const pending = this.#pending;
    this.#pending = null;
    this.#performSwitch(pending.providerId, pending.idempotencyKey).catch(() => undefined);
  }

  #emit(phase, payload) {
    this.emit("event", { phase, at: new Date().toISOString(), ...payload });
  }
}

function ensureUsable(status) {
  if (!status.available) {
    throw new CcSwitchError(status.error ?? "未检测到 CC Switch CLI。", {
      code: "CC_SWITCH_NOT_FOUND",
      status: 503,
    });
  }
  if (!status.compatible) {
    throw new CcSwitchError(status.error ?? "CC Switch 版本不兼容。", {
      code: "CC_SWITCH_INCOMPATIBLE",
      status: 409,
    });
  }
}

function assertIdempotencyKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,200}$/.test(value)) {
    throw new CcSwitchError("无效的幂等请求标识。", { code: "INVALID_IDEMPOTENCY_KEY", status: 400 });
  }
  return value;
}

function publicSwitchError(error) {
  if (error instanceof CcSwitchError) return error.message;
  return "服务商切换失败，原服务商状态已保留。";
}
