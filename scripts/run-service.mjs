import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildScript = path.join(rootDir, "scripts", "build-client.mjs");
const serverEntry = path.join(rootDir, "server.mjs");

const build = spawnSync(process.execPath, [buildScript], {
  cwd: rootDir,
  env: process.env,
  stdio: "inherit",
});

if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

await import(pathToFileURL(serverEntry).href);
