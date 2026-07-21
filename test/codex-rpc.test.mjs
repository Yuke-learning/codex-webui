import assert from "node:assert/strict";
import test from "node:test";

import { JsonRpcStreamParser } from "../src/codex-rpc.mjs";

test("parses newline-delimited JSON-RPC messages across chunks", () => {
  const parser = new JsonRpcStreamParser();
  assert.deepEqual(parser.push('{"id":1,"res'), []);
  assert.deepEqual(parser.push('ult":{"ok":true}}\n{"method":"turn/started","params":{}}\n'), [
    { id: 1, result: { ok: true } },
    { method: "turn/started", params: {} },
  ]);
});

test("parses Content-Length framed JSON-RPC messages", () => {
  const parser = new JsonRpcStreamParser();
  const message = JSON.stringify({ id: 2, result: { value: "中文" } });
  const frame = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
  assert.deepEqual(parser.push(frame), [{ id: 2, result: { value: "中文" } }]);
});
