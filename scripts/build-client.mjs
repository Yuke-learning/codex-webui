import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceDir = path.join(rootDir, "src", "public");
const outputDir = path.join(rootDir, "dist", "public");

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await copyFile(path.join(sourceDir, "index.html"), path.join(outputDir, "index.html"));

await build({
  entryPoints: {
    app: path.join(sourceDir, "app.js"),
    styles: path.join(sourceDir, "styles.entry.css"),
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome110", "safari16"],
  outdir: outputDir,
  entryNames: "[name]",
  assetNames: "assets/[name]-[hash]",
  minify: true,
  loader: {
    ".woff": "file",
    ".woff2": "file",
    ".ttf": "file",
  },
  legalComments: "none",
  logLevel: "info",
});
