import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const HOST = process.env.OPENPETS_RELAY_HOST || "127.0.0.1";
const PORT = Number(process.env.OPENPETS_RELAY_PORT || 8795);
const TOKEN = process.env.OPENPETS_RELAY_TOKEN?.trim();
const PROJECT_ID = process.env.OPENCODE_PROJECT_ID?.trim() ?? null;
const WORKSPACE_HASH = process.env.OPENCODE_WORKSPACE_HASH?.trim() ?? null;
const MAX_BODY_BYTES = 1024;
const REACTIONS = new Set([
  "thinking",
  "editing",
  "testing",
  "waiting",
  "success",
  "error"
]);
const cli = resolve("node_modules/.bin/openpets");

if (!TOKEN || TOKEN.length < 32) {
  throw new Error("OPENPETS_RELAY_TOKEN must be at least 32 characters.");
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("OPENPETS_RELAY_PORT must be a valid TCP port.");
}
if (!existsSync(cli))
  throw new Error("The pinned OpenPets CLI is not installed.");

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8"
  });
  response.end(body);
}

function authorized(request) {
  return request.headers.authorization === `Bearer ${TOKEN}`;
}

async function readJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function react(reaction) {
  // The CLI contacts OpenPets over local authenticated IPC. It receives only
  // a fixed reaction enum, never prompts, files, paths, or arbitrary text.
  const child = spawn(cli, ["react", reaction], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    json(response, 200, {
      ok: true,
      service: "openpets-relay",
      projectId: PROJECT_ID,
      workspaceHash: WORKSPACE_HASH
    });
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/react") {
    json(response, 404, { error: "Not found" });
    return;
  }
  if (!authorized(request)) {
    json(response, 401, { error: "Unauthorized" });
    return;
  }
  try {
    const { reaction } = await readJson(request);
    if (typeof reaction !== "string" || !REACTIONS.has(reaction)) {
      throw new Error("Reaction is not allowlisted.");
    }
    react(reaction);
    json(response, 202, { ok: true, reaction });
  } catch (error) {
    json(response, 400, {
      error: error instanceof Error ? error.message : "Invalid request."
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({ ok: true, host: HOST, port: PORT }));
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2_000).unref();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
