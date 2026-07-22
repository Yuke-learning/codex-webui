import { access, mkdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createLaunchAgentPlist, LAUNCHD_LABEL } from "../src/launchd-service.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const homeDirectory = os.homedir();
const uid = process.getuid?.();
const action = process.argv[2] ?? "status";
const launchDomain = `gui/${uid}`;
const serviceTarget = `${launchDomain}/${LAUNCHD_LABEL}`;
const launchAgentsDirectory = path.join(homeDirectory, "Library", "LaunchAgents");
const plistPath = path.join(launchAgentsDirectory, `${LAUNCHD_LABEL}.plist`);
const logsDirectory = path.join(rootDir, "logs");

if (!Number.isInteger(uid)) throw new Error("A macOS user session is required.");

if (action === "install") await install();
else if (action === "restart") restart();
else if (action === "status") status();
else if (action === "uninstall") await uninstallService();
else throw new Error("Usage: node scripts/launchd-service.mjs <install|restart|status|uninstall>");

async function install() {
  const nodeBinary = await realpath(process.execPath);
  const codexBinary = await resolveExecutable(process.env.CODEX_BIN ?? "codex");
  const tailscaleBinary = await resolveExecutable(process.env.TAILSCALE_BIN ?? "tailscale");
  const pathValue = uniquePaths([
    path.dirname(nodeBinary),
    path.dirname(codexBinary),
    path.dirname(tailscaleBinary),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]).join(":");

  await mkdir(launchAgentsDirectory, { recursive: true, mode: 0o700 });
  await mkdir(logsDirectory, { recursive: true, mode: 0o700 });

  const plist = createLaunchAgentPlist({
    nodeBinary,
    runnerPath: path.join(rootDir, "scripts", "run-service.mjs"),
    workingDirectory: rootDir,
    stdoutPath: path.join(logsDirectory, "launchd.stdout.log"),
    stderrPath: path.join(logsDirectory, "launchd.stderr.log"),
    homeDirectory,
    pathValue,
    codexBinary,
    tailscaleBinary,
    port: Number.parseInt(process.env.PORT ?? "8787", 10),
  });

  const temporaryPath = `${plistPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, plist, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, plistPath);
  run("/usr/bin/plutil", ["-lint", plistPath]);
  run("/bin/launchctl", ["bootout", launchDomain, plistPath], { ignoreFailure: true });
  run("/bin/launchctl", ["enable", serviceTarget]);
  run("/bin/launchctl", ["bootstrap", launchDomain, plistPath]);
  console.log(`Installed and started ${LAUNCHD_LABEL}.`);
  console.log(`LaunchAgent: ${plistPath}`);
  console.log(`Logs: ${logsDirectory}`);
}

function restart() {
  run("/bin/launchctl", ["kickstart", "-k", serviceTarget]);
  console.log(`Restarted ${LAUNCHD_LABEL}.`);
}

function status() {
  run("/bin/launchctl", ["print", serviceTarget], { inherit: true });
}

async function uninstallService() {
  run("/bin/launchctl", ["bootout", launchDomain, plistPath], { ignoreFailure: true });
  await unlink(plistPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  console.log(`Uninstalled ${LAUNCHD_LABEL}. Logs were kept at ${logsDirectory}.`);
}

async function resolveExecutable(value) {
  const candidate = path.isAbsolute(value)
    ? value
    : run("/usr/bin/which", [value]).stdout.trim();
  const resolved = await realpath(candidate);
  await access(resolved, fsConstants.X_OK);
  return resolved;
}

function uniquePaths(values) {
  return [...new Set(values.filter(Boolean))];
}

function run(file, args, { ignoreFailure = false, inherit = false } = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !ignoreFailure) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
    throw new Error(`${file} ${args.join(" ")} failed: ${detail}`);
  }
  return result;
}
