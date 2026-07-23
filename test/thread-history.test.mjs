import assert from "node:assert/strict";
import test from "node:test";

import { mergeRecentTurns, prependOlderTurns } from "../src/public/thread-history.js";

test("prepends an older page and removes its overlapping boundary", () => {
  const turns = prependOlderTurns(
    [{ id: "turn-2", revision: "current" }, { id: "turn-3" }],
    [{ id: "turn-1" }, { id: "turn-2", revision: "older" }],
  );

  assert.deepEqual(turns, [
    { id: "turn-1" },
    { id: "turn-2", revision: "current" },
    { id: "turn-3" },
  ]);
});

test("refreshes recent turns without discarding loaded history", () => {
  const turns = mergeRecentTurns(
    [{ id: "turn-1" }, { id: "turn-2", text: "old" }],
    [{ id: "turn-2", text: "updated" }, { id: "turn-3" }],
  );

  assert.deepEqual(turns, [
    { id: "turn-1" },
    { id: "turn-2", text: "updated" },
    { id: "turn-3" },
  ]);
});
