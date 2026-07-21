import assert from "node:assert/strict";
import test from "node:test";

import { classifyCodexEvent, shouldForwardCodexEvent } from "../src/public/refresh-policy.js";

test("ignores goal updates that do not affect the current interface", () => {
  const event = { method: "thread/goal/cleared", params: { threadId: "thread-1" } };
  assert.deepEqual(classifyCodexEvent(event, "thread-1"), {
    threadId: "thread-1",
    isSelectedThread: true,
    refreshList: false,
    refreshDetail: false,
    clearSelection: false,
    markRunning: false,
  });
  assert.equal(shouldForwardCodexEvent(event), false);
});

test("refreshes only the selected thread when its turn completes", () => {
  const event = { method: "turn/completed", params: { threadId: "thread-1" } };
  assert.deepEqual(classifyCodexEvent(event, "thread-1"), {
    threadId: "thread-1",
    isSelectedThread: true,
    refreshList: true,
    refreshDetail: true,
    clearSelection: false,
    markRunning: false,
  });
});

test("does not reload the open thread for another thread's completion", () => {
  const event = { method: "turn/completed", params: { threadId: "thread-2" } };
  const policy = classifyCodexEvent(event, "thread-1");
  assert.equal(policy.refreshList, true);
  assert.equal(policy.refreshDetail, false);
});
