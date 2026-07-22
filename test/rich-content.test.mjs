import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;

const { clearRichContentCache, renderRichContentHtml } = await import("../src/public/rich-content.js");

test.beforeEach(() => clearRichContentCache());

test("renders Markdown, highlighted code, and inline and display math", () => {
  const html = renderRichContentHtml(`# 标题

**粗体**与行内公式 $E = mc^2$。

$$
\\int_0^1 x^2 \\, dx
$$

\`\`\`javascript
const answer = 42;
\`\`\``);

  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<strong>粗体<\/strong>/);
  assert.match(html, /class="katex"/);
  assert.match(html, /class="katex-display"/);
  assert.match(html, /class="hljs-keyword">const<\/span>/);
});

test("keeps code contents out of math rendering", () => {
  const html = renderRichContentHtml(`\`\`\`bash
echo '$HOME is not math'
\`\`\``);

  assert.doesNotMatch(html, /class="katex"/);
  assert.match(html, /\$HOME is not math/);
});

test("removes executable HTML, dangerous links, and remote images", () => {
  const html = renderRichContentHtml(`<script>alert(1)</script>

<img src=x onerror="alert(1)">

[危险链接](javascript:alert(1))

![跟踪图片](https://tracker.example/pixel.png)`);

  const wrapper = document.createElement("div");
  wrapper.innerHTML = html;

  assert.equal(wrapper.querySelector("script"), null);
  assert.equal(wrapper.querySelector("img"), null);
  assert.equal(wrapper.querySelector("[onerror]"), null);
  assert.equal(wrapper.querySelector('a[href^="javascript:"]'), null);
  assert.doesNotMatch(html, /tracker\.example/i);
  assert.match(html, /\[图片：跟踪图片\]/);
});

test("opens ordinary links safely in a new tab", () => {
  const html = renderRichContentHtml("[OpenAI](https://openai.com/)");

  assert.match(html, /href="https:\/\/openai\.com\/"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
});
