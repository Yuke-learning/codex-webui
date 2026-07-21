import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { CodexGateway, InputError } from "./src/codex-gateway.mjs";
import { shouldForwardCodexEvent } from "./src/public/refresh-policy.js";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(rootDir, "src", "public");
const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const gateway = new CodexGateway({ codexBin: process.env.CODEX_BIN ?? "codex" });
const eventClients = new Set();

const staticFiles = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/live-activity.js", { file: "live-activity.js", type: "text/javascript; charset=utf-8" }],
  ["/refresh-policy.js", { file: "refresh-policy.js", type: "text/javascript; charset=utf-8" }],
  ["/transcript.js", { file: "transcript.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
]);

gateway.on("notification", (event) => {
  if (shouldForwardCodexEvent(event)) broadcast("codex", event);
});
gateway.on("serverRequest", (event) => broadcast("approval", event));
gateway.on("transportError", (event) => broadcast("transport-error", event));

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
    const pathname = url.pathname;

    if (pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }

    await serveStatic(response, pathname);
  } catch (error) {
    respondError(response, error);
  }
});

server.listen(port, host, () => {
  console.log(`Codex WebUI listening on http://${host}:${port}`);
  console.log("The server is intentionally loopback-only. Publish it through an authenticated private network such as Tailscale.");
});

function writeSse(response, event, data) {
  if (response.writableEnded || response.destroyed) return false;
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  return true;
}

function broadcast(event, data) {
  for (const client of eventClients) {
    if (!writeSse(client, event, data)) eventClients.delete(client);
  }
}

async function handleApi(request, response, url) {
  response.setHeader("Cache-Control", "no-store");
  const { pathname } = url;

  if (request.method === "GET" && pathname === "/api/health") {
    respondJson(response, 200, await gateway.health());
    return;
  }

  if (request.method === "GET" && pathname === "/api/models") {
    respondJson(response, 200, { data: await gateway.listModels() });
    return;
  }

  if (request.method === "GET" && pathname === "/api/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write(": connected\n\n");
    eventClients.add(response);
    request.on("close", () => eventClients.delete(response));
    return;
  }

  enforceSameOrigin(request);

  if (request.method === "GET" && pathname === "/api/threads") {
    const threads = await gateway.listThreads({
      archived: url.searchParams.get("archived") === "true",
      searchTerm: url.searchParams.get("search") || undefined,
      cwd: url.searchParams.get("cwd") || undefined,
    });
    respondJson(response, 200, { data: threads });
    return;
  }

  if (request.method === "POST" && pathname === "/api/threads") {
    const body = await readJson(request);
    const thread = await gateway.createThread(body);
    respondJson(response, 201, { thread });
    return;
  }

  const match = /^\/api\/threads\/([^/]+)(?:\/(messages|interrupt|archive|settings))?$/.exec(pathname);
  if (!match) {
    respondJson(response, 404, { error: "Not found" });
    return;
  }

  const threadId = decodeURIComponent(match[1]);
  const action = match[2];

  if (request.method === "GET" && !action) {
    respondJson(response, 200, { thread: await gateway.readThread(threadId) });
    return;
  }

  if (request.method === "PATCH" && !action) {
    const body = await readJson(request);
    respondJson(response, 200, { thread: await gateway.renameThread(threadId, body.name) });
    return;
  }

  if (request.method === "PATCH" && action === "settings") {
    const body = await readJson(request);
    respondJson(response, 200, await gateway.updateThreadSettings(threadId, body));
    return;
  }

  if (request.method === "DELETE" && !action) {
    await gateway.deleteThread(threadId);
    respondJson(response, 204);
    return;
  }

  if (request.method === "POST" && action === "messages") {
    const body = await readJson(request);
    respondJson(response, 202, await gateway.sendMessage(threadId, body.text));
    return;
  }

  if (request.method === "POST" && action === "interrupt") {
    respondJson(response, 202, await gateway.interruptTurn(threadId));
    return;
  }

  if (request.method === "POST" && action === "archive") {
    await gateway.archiveThread(threadId);
    respondJson(response, 204);
    return;
  }

  respondJson(response, 405, { error: "Method not allowed" });
}

function enforceSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  const hostHeader = request.headers.host;
  const originUrl = new URL(origin);
  if (originUrl.host !== hostHeader) {
    throw new InputError("Cross-origin requests are not accepted.", 403);
  }
}

async function readJson(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > 128 * 1024) throw new InputError("Request body is too large.", 413);
    chunks.push(chunk);
  }

  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InputError("Request body must be valid JSON.");
  }
}

async function serveStatic(response, pathname) {
  const asset = staticFiles.get(pathname);
  if (!asset) {
    respondJson(response, 404, { error: "Not found" });
    return;
  }

  const filePath = path.join(publicDir, asset.file);
  const fileStats = await stat(filePath);
  response.writeHead(200, {
    "Content-Type": asset.type,
    "Content-Length": fileStats.size,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
  });
  createReadStream(filePath).pipe(response);
}

function respondJson(response, status, payload = undefined) {
  if (status === 204) {
    response.writeHead(204);
    response.end();
    return;
  }
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function respondError(response, error) {
  const status = error instanceof InputError ? error.status : 502;
  const message = error instanceof Error ? error.message : "Unexpected server error";
  console.error(error);
  respondJson(response, status, { error: message });
}

function shutdown() {
  for (const client of eventClients) client.end();
  eventClients.clear();
  gateway.close();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
