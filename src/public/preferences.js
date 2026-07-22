export const SHOW_CC_SWITCH_STORAGE_KEY = "codex-webui.show-cc-switch.v1";

export function loadCcSwitchVisibility(storage = globalThis.localStorage) {
  try {
    const stored = storage?.getItem(SHOW_CC_SWITCH_STORAGE_KEY);
    return stored === null || stored === undefined ? true : stored !== "false";
  } catch {
    return true;
  }
}

export function saveCcSwitchVisibility(visible, storage = globalThis.localStorage) {
  try {
    storage?.setItem(SHOW_CC_SWITCH_STORAGE_KEY, String(Boolean(visible)));
  } catch {
    // Keep the in-memory preference when browser storage is unavailable.
  }
}
