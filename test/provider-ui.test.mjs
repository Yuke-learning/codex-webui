import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("places the global provider control in the sidebar above the new-thread button", async () => {
  const html = await readFile(path.join(root, "src/public/index.html"), "utf8");
  const sidebar = html.indexOf('id="sidebar"');
  const provider = html.indexOf('id="provider-switch"');
  const newThread = html.indexOf('id="new-thread"');
  const workspace = html.indexOf('<section class="workspace">');
  assert.ok(sidebar >= 0 && provider > sidebar && provider < newThread && newThread < workspace);
  assert.equal((html.match(/id="provider-switch"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /global-toolbar|global-provider-control/);
});

test("offers a settings preference for showing the CC Switch home control", async () => {
  const html = await readFile(path.join(root, "src/public/index.html"), "utf8");
  assert.match(html, /id="preference-setting-title">偏好设置</);
  assert.match(html, /id="show-cc-switch" type="checkbox"/);
  assert.match(html, /在主页显示 CC Switch 按钮/);
});

test("defines a full-width mobile provider sheet and 44px action targets", async () => {
  const css = await readFile(path.join(root, "src/public/styles.css"), "utf8");
  assert.match(css, /\.provider-dialog \{ position: fixed; inset: auto 0 0; width: 100%;/);
  assert.match(css, /\.provider-row button \{ min-width: 72px; min-height: 44px; \}/);
  assert.match(css, /\.provider-dialog \.dialog-heading \.icon-button \{[^}]*width: 44px; height: 44px;/);
});
