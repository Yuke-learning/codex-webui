import assert from "node:assert/strict";
import test from "node:test";

import { messageTimeParts, timestampMilliseconds } from "../src/public/message-time.js";

test("normalizes Codex second timestamps and millisecond timestamps", () => {
  assert.equal(timestampMilliseconds(1_700_000_000), 1_700_000_000_000);
  assert.equal(timestampMilliseconds(1_700_000_000_123), 1_700_000_000_123);
});

test("formats a semantic time element payload and rejects invalid timestamps", () => {
  const time = messageTimeParts(1_700_000_000);
  assert.equal(time.dateTime, "2023-11-14T22:13:20.000Z");
  assert.ok(time.label.length > 0);
  assert.ok(time.title.length > 0);
  assert.equal(messageTimeParts(null), null);
  assert.equal(messageTimeParts("not-a-date"), null);
});
