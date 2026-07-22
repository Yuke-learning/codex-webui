import assert from "node:assert/strict";
import test from "node:test";

import {
  SHOW_CC_SWITCH_STORAGE_KEY,
  loadCcSwitchVisibility,
  saveCcSwitchVisibility,
} from "../src/public/preferences.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

test("shows the CC Switch home control by default", () => {
  assert.equal(loadCcSwitchVisibility(memoryStorage()), true);
});

test("persists and restores the CC Switch home-control preference", () => {
  const storage = memoryStorage();
  saveCcSwitchVisibility(false, storage);
  assert.equal(storage.getItem(SHOW_CC_SWITCH_STORAGE_KEY), "false");
  assert.equal(loadCcSwitchVisibility(storage), false);
  saveCcSwitchVisibility(true, storage);
  assert.equal(loadCcSwitchVisibility(storage), true);
});

test("falls back to visible when browser storage is unavailable", () => {
  const storage = {
    getItem() {
      throw new Error("blocked");
    },
  };
  assert.equal(loadCcSwitchVisibility(storage), true);
  assert.doesNotThrow(() => saveCcSwitchVisibility(false, storage));
});
