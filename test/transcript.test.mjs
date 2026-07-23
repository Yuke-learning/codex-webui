import assert from "node:assert/strict";
import test from "node:test";

import { parseAutomationEnvelope, toTranscript } from "../src/public/transcript.js";

test("keeps native user, agent, and execution items in the transcript", () => {
  const transcript = toTranscript({
    turns: [{
      items: [
        { type: "userMessage", content: [{ type: "text", text: "检查状态" }] },
        { type: "agentMessage", text: "正在检查。" },
        { type: "commandExecution", command: "git status --short" },
      ],
    }],
  });

  assert.deepEqual(transcript.messages, [
    { role: "user", label: "你", text: "检查状态" },
    { role: "assistant", label: "Codex", text: "正在检查。" },
    {
      role: "activityGroup",
      id: "activity-group-0-2",
      label: "执行过程",
      count: 1,
      summary: "命令 1",
      latest: { label: "已运行命令", text: "git status --short" },
      hasProblem: false,
      items: [{ role: "activity", activityType: "command", label: "已运行命令", text: "git status --short", hasProblem: false }],
    },
  ]);
  assert.deepEqual(transcript.automationEvents, []);
});

test("uses turn timestamps for user and Codex conversation bubbles", () => {
  const transcript = toTranscript({
    turns: [{
      startedAt: 1_721_600_000,
      completedAt: 1_721_600_042,
      items: [
        { type: "userMessage", content: [{ type: "text", text: "现在几点？" }] },
        { type: "agentMessage", phase: "final", text: "这是本轮完成时间。" },
      ],
    }],
  });

  assert.deepEqual(transcript.messages, [
    { role: "user", label: "你", text: "现在几点？", timestamp: 1_721_600_000 },
    { role: "assistant", label: "Codex", text: "这是本轮完成时间。", timestamp: 1_721_600_042 },
  ]);
});

test("renders commentary progress without confusing it with the final answer", () => {
  const transcript = toTranscript({
    turns: [{
      items: [
        { type: "agentMessage", phase: "commentary", text: "正在读取文件。" },
        { type: "agentMessage", phase: "final", text: "读取完成。" },
      ],
    }],
  });

  assert.deepEqual(transcript.messages, [
    {
      role: "activityGroup",
      id: "activity-group-0-0",
      label: "执行过程",
      count: 1,
      summary: "进度 1",
      latest: { label: "Codex 正在执行", text: "正在读取文件。" },
      hasProblem: false,
      items: [{ role: "activity", activityType: "progress", label: "Codex 正在执行", text: "正在读取文件。" }],
    },
    { role: "assistant", label: "Codex", text: "读取完成。" },
  ]);
});

test("groups consecutive execution activity without crossing a final answer or turn", () => {
  const transcript = toTranscript({
    turns: [
      {
        items: [
          { type: "commandExecution", command: "npm test" },
          { type: "fileChange", changes: [{ path: "src/public/app.js" }] },
          { type: "browserAction", url: "http://127.0.0.1:8787" },
          { type: "agentMessage", phase: "final", text: "第一段完成。" },
          { type: "toolCall", toolName: "web.run" },
        ],
      },
      { items: [{ type: "commandExecution", command: "git status --short" }] },
    ],
  });

  assert.equal(transcript.messages.length, 4);
  assert.deepEqual(transcript.messages[0], {
    role: "activityGroup",
    id: "activity-group-0-0",
    label: "执行过程",
    count: 3,
    summary: "命令 1 · 文件 1 · 浏览器 1",
    latest: { label: "正在使用浏览器", text: "http://127.0.0.1:8787" },
    hasProblem: false,
    items: [
      { role: "activity", activityType: "command", label: "已运行命令", text: "npm test", hasProblem: false },
      { role: "activity", activityType: "file", label: "已编辑文件", text: "src/public/app.js", hasProblem: false },
      { role: "activity", activityType: "browser", label: "正在使用浏览器", text: "http://127.0.0.1:8787", hasProblem: false },
    ],
  });
  assert.deepEqual(transcript.messages[1], { role: "assistant", label: "Codex", text: "第一段完成。" });
  assert.equal(transcript.messages[2].id, "activity-group-0-4");
  assert.equal(transcript.messages[3].id, "activity-group-1-5");
});

test("marks failed execution groups so the UI can keep them expanded", () => {
  const transcript = toTranscript({
    turns: [{ items: [{ type: "commandExecution", status: "failed", command: "npm test" }] }],
  });

  assert.equal(transcript.messages[0].role, "activityGroup");
  assert.equal(transcript.messages[0].hasProblem, true);
  assert.equal(transcript.messages[0].items[0].hasProblem, true);
});

test("uses the stable turn id for activity expansion state across pagination", () => {
  const transcript = toTranscript({
    turns: [{ id: "turn-stable", items: [{ type: "commandExecution", command: "npm test" }] }],
  });

  assert.equal(transcript.messages[0].id, "activity-group-turn-stable-0");
});

test("moves exact heartbeat envelopes into the automation audit trail", () => {
  const heartbeat = `<heartbeat>\n  <automation_id>simgr</automation_id>\n  <decision>NOTIFY</decision>\n  <message>训练正常。</message>\n</heartbeat>`;
  const transcript = toTranscript({
    turns: [{
      items: [
        { type: "userMessage", content: [{ type: "text", text: heartbeat }] },
        { type: "agentMessage", text: heartbeat },
        { type: "agentMessage", text: "已记录。" },
      ],
    }],
  });

  assert.deepEqual(transcript.messages, [{ role: "assistant", label: "Codex", text: "已记录。" }]);
  assert.deepEqual(transcript.automationEvents, [{
    kind: "heartbeat",
    automationId: "simgr",
    decision: "NOTIFY",
    message: "训练正常。",
    key: "heartbeat\u0000simgr\u0000NOTIFY\u0000训练正常。",
    count: 2,
    lastRawIndex: 1,
  }]);
});

test("does not hide ordinary XML or incomplete heartbeat content", () => {
  const ordinaryXml = "<note><message>保留这段 XML</message></note>";
  const incompleteHeartbeat = "<heartbeat><message>没有自动化元数据</message></heartbeat>";

  assert.equal(parseAutomationEnvelope(ordinaryXml), null);
  assert.equal(parseAutomationEnvelope(incompleteHeartbeat), null);

  const transcript = toTranscript({
    turns: [{
      items: [
        { type: "userMessage", content: [{ type: "text", text: ordinaryXml }] },
        { type: "userMessage", content: [{ type: "text", text: incompleteHeartbeat }] },
      ],
    }],
  });

  assert.equal(transcript.messages.length, 2);
  assert.deepEqual(transcript.automationEvents, []);
});

test("does not stringify unknown protocol objects into the conversation", () => {
  const transcript = toTranscript({
    turns: [{
      items: [{ type: "internalMetadata", output: { secret: "not a chat message" } }],
    }],
  });

  assert.deepEqual(transcript, { messages: [], automationEvents: [] });
});
