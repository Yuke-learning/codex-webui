import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const files = [path.join(rootDir, "server.mjs")];
for (const directory of ["scripts", "src", "test"]) collect(path.join(rootDir, directory), files);

for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`Syntax check passed for ${files.length} JavaScript modules.`);

function collect(entry, output) {
  const stat = statSync(entry);
  if (stat.isDirectory()) {
    for (const name of readdirSync(entry)) collect(path.join(entry, name), output);
    return;
  }
  if (/\.(?:js|mjs)$/.test(entry)) output.push(entry);
}
