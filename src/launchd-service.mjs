import path from "node:path";

export const LAUNCHD_LABEL = "com.yuke.codex-webui";

export function createLaunchAgentPlist({
  label = LAUNCHD_LABEL,
  nodeBinary,
  runnerPath,
  workingDirectory,
  stdoutPath,
  stderrPath,
  homeDirectory,
  pathValue,
  codexBinary,
  tailscaleBinary,
  port = 8787,
}) {
  const absolutePaths = {
    nodeBinary,
    runnerPath,
    workingDirectory,
    stdoutPath,
    stderrPath,
    homeDirectory,
    codexBinary,
    tailscaleBinary,
  };
  for (const [name, value] of Object.entries(absolutePaths)) {
    if (!path.isAbsolute(value ?? "")) throw new TypeError(`${name} must be an absolute path.`);
  }
  if (!label || !pathValue) throw new TypeError("label and pathValue are required.");

  const environment = {
    HOME: homeDirectory,
    PATH: pathValue,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(port),
    CODEX_BIN: codexBinary,
    TAILSCALE_BIN: tailscaleBinary,
  };

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodeBinary)}</string>
    <string>${escapeXml(runnerPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(environment).map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`).join("\n")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>
</dict>
</plist>
`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
