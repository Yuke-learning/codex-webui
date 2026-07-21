import assert from "node:assert/strict";
import test from "node:test";

import { parseAutomationEnvelope, toTranscript } from "../src/public/transcript.js";

test("keeps native user, agent, and command execution items in the transcript", () => {
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
    { role: "tool", label: "终端命令", text: "git status --short" },
  ]);
  assert.deepEqual(transcript.automationEvents, []);
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
