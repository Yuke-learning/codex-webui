const GIT_DIRECTIVES = new Set([
  "git-stage",
  "git-commit",
  "git-push",
  "git-create-branch",
  "git-create-pr",
]);

export function parseCodexUiSegments(value) {
  const text = typeof value === "string" ? value : "";
  const segments = [];
  const markdownLines = [];
  let gitDirectives = [];
  let fence = null;

  const flushMarkdown = () => {
    const markdown = markdownLines.join("\n");
    markdownLines.length = 0;
    if (markdown.trim()) segments.push({ type: "markdown", text: markdown });
  };
  const flushGit = () => {
    if (!gitDirectives.length) return;
    segments.push({ type: "git", directives: gitDirectives });
    gitDirectives = [];
  };

  for (const line of text.split("\n")) {
    const fenceToken = markdownFence(line);
    if (fenceToken) {
      flushGit();
      markdownLines.push(line);
      if (!fence) fence = fenceToken;
      else if (fenceToken.character === fence.character && fenceToken.length >= fence.length) fence = null;
      continue;
    }

    const directive = fence ? null : parseDirectiveLine(line);
    if (directive && GIT_DIRECTIVES.has(directive.name)) {
      flushMarkdown();
      gitDirectives.push(directive);
      continue;
    }

    flushGit();
    markdownLines.push(line);
  }

  flushGit();
  flushMarkdown();
  return segments;
}

export function parseDirectiveLine(line) {
  if (typeof line !== "string") return null;
  const match = /^\s*::([a-z][a-z0-9-]*)\{([\s\S]*)\}\s*$/i.exec(line);
  if (!match) return null;
  const attributes = parseAttributes(match[2]);
  return attributes ? { name: match[1].toLowerCase(), attributes } : null;
}

function parseAttributes(source) {
  const attributes = {};
  let remaining = source.trim();

  while (remaining) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*"((?:\\.|[^"\\])*)"/.exec(remaining);
    if (!match) return null;
    attributes[match[1]] = unescapeAttribute(match[2]);
    remaining = remaining.slice(match[0].length).trimStart();
  }

  return attributes;
}

function unescapeAttribute(value) {
  return value.replace(/\\(["\\nrt])/g, (_, character) => ({
    "\"": "\"",
    "\\": "\\",
    n: "\n",
    r: "\r",
    t: "\t",
  })[character]);
}

function markdownFence(line) {
  const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
  return match ? { character: match[1][0], length: match[1].length } : null;
}
