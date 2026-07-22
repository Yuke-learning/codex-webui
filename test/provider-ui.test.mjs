import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("keeps the global provider control outside the task-only header", async () => {
  const html = await readFile(path.join(root, "src/public/index.html"), "utf8");
  const toolbarStart = html.indexOf('<div class="global-toolbar">');
  const provider = html.indexOf('id="provider-switch"');
  const threadHeader = html.indexOf('id="thread-header"');
  assert.ok(toolbarStart >= 0 && provider > toolbarStart && provider < threadHeader);
  assert.equal((html.match(/id="provider-switch"/g) ?? []).length, 1);
});

test("defines a full-width mobile provider sheet and 44px action targets", async () => {
  const css = await readFile(path.join(root, "src/public/styles.css"), "utf8");
  assert.match(css, /\.provider-dialog \{ position: fixed; inset: auto 0 0; width: 100%;/);
  assert.match(css, /\.provider-row button \{ min-width: 72px; min-height: 44px; \}/);
  assert.match(css, /\.provider-dialog \.dialog-heading \.icon-button \{[^}]*width: 44px; height: 44px;/);
});
