import assert from "node:assert/strict";
import test from "node:test";

import { collectPaginatedThreadData, normalizeTurnsPage } from "../src/codex-gateway.mjs";

test("collects every thread/list page and removes overlapping thread ids", async () => {
  const cursors = [];
  const threads = await collectPaginatedThreadData(async (cursor) => {
    cursors.push(cursor ?? null);
    if (!cursor) {
      return {
        data: [{ id: "thread-a" }, { id: "thread-b" }],
        nextCursor: "page-2",
      };
    }
    return {
      data: [{ id: "thread-b" }, { id: "thread-c" }],
      nextCursor: null,
    };
  });

  assert.deepEqual(cursors, [null, "page-2"]);
  assert.deepEqual(threads.map((thread) => thread.id), ["thread-a", "thread-b", "thread-c"]);
});

test("rejects a repeated thread/list pagination cursor", async () => {
  await assert.rejects(
    collectPaginatedThreadData(async () => ({ data: [], nextCursor: "same-page" })),
    /repeated pagination cursor/i,
  );
});

test("normalizes descending turn pages into chronological order", () => {
  const page = normalizeTurnsPage({
    data: [{ id: "newest" }, { id: "older" }],
    nextCursor: "older-page",
  });

  assert.deepEqual(page, {
    data: [{ id: "older" }, { id: "newest" }],
    nextCursor: "older-page",
  });
});
