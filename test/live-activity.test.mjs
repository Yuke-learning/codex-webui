import assert from "node:assert/strict";
import test from "node:test";

import { describeItemActivity, describeLiveActivity } from "../src/public/live-activity.js";

test("describes an active turn without exposing internal protocol data", () => {
  assert.deepEqual(describeLiveActivity({ method: "turn/started", params: { threadId: "thread-1" } }), {
    title: "Codex 正在思考",
    detail: "正在分析下一步操作。",
  });
});

test("describes command, file, and browser activity", () => {
  assert.deepEqual(describeItemActivity({ type: "commandExecution", status: "inProgress", command: "git status --short" }), {
    title: "正在运行命令",
    detail: "git status --short",
  });
  assert.deepEqual(describeItemActivity({ type: "fileChange", changes: [{ path: "src/app.js" }, { path: "src/ui.css" }] }), {
    title: "已编辑文件",
    detail: "src/app.js · src/ui.css",
  });
  assert.deepEqual(describeItemActivity({ type: "browserAction", url: "https://example.com" }), {
    title: "正在使用浏览器",
    detail: "https://example.com",
  });
});
