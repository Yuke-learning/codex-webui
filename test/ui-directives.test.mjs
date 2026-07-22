import assert from "node:assert/strict";
import test from "node:test";

import { parseCodexUiSegments, parseDirectiveLine } from "../src/public/ui-directives.js";

test("extracts consecutive Git directives from an assistant response", () => {
  const segments = parseCodexUiSegments(`已完成并推送。

::git-stage{cwd="/Users/example/Code/codex-webui"}
::git-commit{cwd="/Users/example/Code/codex-webui"}
::git-push{cwd="/Users/example/Code/codex-webui" branch="main"}`);

  assert.deepEqual(segments, [
    { type: "markdown", text: "已完成并推送。\n" },
    {
      type: "git",
      directives: [
        { name: "git-stage", attributes: { cwd: "/Users/example/Code/codex-webui" } },
        { name: "git-commit", attributes: { cwd: "/Users/example/Code/codex-webui" } },
        { name: "git-push", attributes: { cwd: "/Users/example/Code/codex-webui", branch: "main" } },
      ],
    },
  ]);
});

test("leaves directives inside fenced code and unknown directives as Markdown", () => {
  const text = `\`\`\`text
::git-push{cwd="/tmp/project" branch="main"}
\`\`\`

::unknown-directive{value="keep me"}`;

  assert.deepEqual(parseCodexUiSegments(text), [{ type: "markdown", text }]);
});

test("rejects malformed attributes and decodes safe quoted values", () => {
  assert.equal(parseDirectiveLine('::git-push{cwd="/tmp/project" broken}'), null);
  assert.deepEqual(parseDirectiveLine('::git-create-pr{cwd="/tmp/My Project" url="https://example.com/a\\\"b" isDraft="false"}'), {
    name: "git-create-pr",
    attributes: {
      cwd: "/tmp/My Project",
      url: 'https://example.com/a"b',
      isDraft: "false",
    },
  });
});
