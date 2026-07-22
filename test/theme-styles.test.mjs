import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const stylesheet = await readFile(new URL("../src/public/styles.css", import.meta.url), "utf8");

test("uses sidebar semantic colors for every project heading hover state", () => {
  assert.match(stylesheet, /--nav-project-hover-text:\s*var\(--nav-project-text\)/);
  assert.match(stylesheet, /\.project-heading:hover\s*\{[^}]*color:\s*var\(--nav-project-hover-text\)/s);
  assert.doesNotMatch(stylesheet, /\.project-heading:hover\s*\{[^}]*color:\s*var\(--text\)/s);
});

test("keeps ungrouped headings and chevrons readable while hovering", () => {
  assert.match(stylesheet, /--nav-ungrouped-hover-text:\s*var\(--nav-project-hover-text\)/);
  assert.match(stylesheet, /\.project-group\.is-ungrouped \.project-heading:hover\s*\{[^}]*color:\s*var\(--nav-ungrouped-hover-text\)/s);
  assert.match(stylesheet, /\.project-heading:hover \.project-chevron\s*\{[^}]*color:\s*var\(--nav-project-hover-text\)/s);
});

test("theme-specific project surfaces stay independent from the sidebar background", () => {
  assert.doesNotMatch(stylesheet, /html\[data-theme="[^"]+"\] \.project-heading\s*\{[^}]*background:\s*var\(--nav-sidebar-bg\)/s);
  assert.match(stylesheet, /html\[data-theme="data-dense-dashboard"\] \.project-heading,[\s\S]*?background:\s*var\(--nav-project-bg\)/);
});
