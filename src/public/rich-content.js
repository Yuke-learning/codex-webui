import createDOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdownLanguage from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import renderMathInElement from "katex/contrib/auto-render";
import markdownit from "markdown-it";

const MAX_CACHE_ENTRIES = 300;
const htmlCache = new Map();
const purifier = createDOMPurify(globalThis.window);

for (const [name, language] of [
  ["bash", bash],
  ["shell", bash],
  ["sh", bash],
  ["css", css],
  ["diff", diff],
  ["javascript", javascript],
  ["js", javascript],
  ["json", json],
  ["markdown", markdownLanguage],
  ["md", markdownLanguage],
  ["python", python],
  ["py", python],
  ["typescript", typescript],
  ["ts", typescript],
  ["html", xml],
  ["xml", xml],
]) {
  hljs.registerLanguage(name, language);
}

const markdown = markdownit({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
  highlight(code, languageName) {
    const language = languageName?.trim().split(/\s+/)[0];
    if (!language || !hljs.getLanguage(language)) return "";
    try {
      const highlighted = hljs.highlight(code, { language, ignoreIllegals: true }).value;
      return `<pre class="code-block"><code class="hljs language-${language}">${highlighted}</code></pre>`;
    } catch {
      return "";
    }
  },
});

markdown.renderer.rules.image = (tokens, index) => {
  const alt = markdown.utils.escapeHtml(tokens[index].content || "图片");
  return `<span class="markdown-image-placeholder">[图片：${alt}]</span>`;
};

const defaultLinkOpen = markdown.renderer.rules.link_open
  ?? ((tokens, index, options, environment, renderer) => renderer.renderToken(tokens, index, options));

markdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, index, options, environment, renderer);
};

const sanitizeOptions = {
  ADD_ATTR: ["target"],
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: [
    "audio",
    "button",
    "embed",
    "form",
    "iframe",
    "img",
    "input",
    "link",
    "meta",
    "object",
    "option",
    "picture",
    "select",
    "source",
    "style",
    "textarea",
    "video",
  ],
};

const mathOptions = {
  delimiters: [
    { left: "$$", right: "$$", display: true },
    { left: "\\[", right: "\\]", display: true },
    { left: "\\(", right: "\\)", display: false },
    { left: "$", right: "$", display: false },
  ],
  ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option"],
  throwOnError: false,
  trust: false,
  strict: "warn",
  maxExpand: 1000,
  maxSize: 20,
};

export function appendRichContent(container, text) {
  const template = document.createElement("template");
  template.innerHTML = renderRichContentHtml(text);
  container.append(template.content.cloneNode(true));
}

export function renderRichContentHtml(value) {
  const text = typeof value === "string" ? value : "";
  const cached = htmlCache.get(text);
  if (cached !== undefined) {
    htmlCache.delete(text);
    htmlCache.set(text, cached);
    return cached;
  }

  const wrapper = document.createElement("div");
  wrapper.innerHTML = purifier.sanitize(markdown.render(text), sanitizeOptions);
  try {
    renderMathInElement(wrapper, mathOptions);
  } catch {
    // Invalid TeX must not prevent the surrounding Markdown from rendering.
  }
  const html = purifier.sanitize(wrapper.innerHTML, sanitizeOptions);
  remember(text, html);
  return html;
}

export function clearRichContentCache() {
  htmlCache.clear();
}

function remember(key, html) {
  htmlCache.set(key, html);
  if (htmlCache.size <= MAX_CACHE_ENTRIES) return;
  htmlCache.delete(htmlCache.keys().next().value);
}
