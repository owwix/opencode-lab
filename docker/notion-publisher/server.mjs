import { timingSafeEqual, createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertCapabilityScope,
  verifyCapabilityLease
} from "../agent-gateway/capability-lease.mjs";

const MAX_BODY_BYTES = 512 * 1024;
const NOTION_VERSION = "2026-03-11";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parseTargets(value) {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("NOTION_PUBLISH_TARGETS_JSON must be an object.");
  }
  const entries = Object.entries(parsed).filter(
    ([target, pageId]) =>
      /^[a-z][a-z0-9_-]{0,31}$/iu.test(target) &&
      /^[0-9a-f-]{32,36}$/iu.test(String(pageId))
  );
  if (entries.length === 0 || entries.length !== Object.keys(parsed).length) {
    throw new Error("Notion publish targets must be named fixed page IDs.");
  }
  return Object.fromEntries(entries);
}

const config = {
  token: required("NOTION_PUBLISHER_TOKEN"),
  notionToken: required("NOTION_API_TOKEN"),
  targets: parseTargets(required("NOTION_PUBLISH_TARGETS_JSON")),
  stateDir: process.env.NOTION_PUBLISH_STATE_DIR || "/state",
  capabilityKey: required("AGENT_GATEWAY_SIGNING_KEY"),
  workspaceHash: required("OPENCODE_WORKSPACE_HASH"),
  projectId: required("OPENCODE_PROJECT_ID"),
  sessionId: required("OPENCODE_LAUNCH_SESSION_ID"),
  runId: required("OPENCODE_RUN_ID")
};
mkdirSync(config.stateDir, { recursive: true });

function authorized(header) {
  const actual = Buffer.from(header ?? "", "utf8");
  const expected = Buffer.from(`Bearer ${config.token}`, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function authorizedCapability(header) {
  const claims = verifyCapabilityLease(String(header ?? ""), {
    key: config.capabilityKey,
    workspaceHash: config.workspaceHash,
    projectId: config.projectId,
    sessionId: config.sessionId,
    runId: config.runId
  });
  return assertCapabilityScope(claims, {
    route: "notion-publish",
    action: "publish"
  });
}

function response(res, status, body) {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text)
  });
  res.end(text);
}

function readRequest(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > MAX_BODY_BYTES)
        return reject(new Error("Payload exceeds 512 KiB."));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function validate(input) {
  const target = String(input?.target ?? "");
  const title = String(input?.title ?? "").trim();
  const markdown = String(input?.markdown ?? "");
  const idempotencyKey = String(input?.idempotencyKey ?? "");
  if (!config.targets[target])
    throw new Error("Publish target is not allowlisted.");
  if (!title || title.length > 200)
    throw new Error("Title must be 1-200 characters.");
  if (!markdown.trim() || Buffer.byteLength(markdown) > MAX_BODY_BYTES) {
    throw new Error("Markdown must be non-empty and no larger than 512 KiB.");
  }
  if (!/^[a-zA-Z0-9._:-]{16,160}$/.test(idempotencyKey)) {
    throw new Error("Idempotency key is invalid.");
  }
  return { target, title, markdown, idempotencyKey };
}

function statePath(key) {
  return join(
    config.stateDir,
    `${createHash("sha256").update(key).digest("hex")}.json`
  );
}

function readState(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeState(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

async function publish(input) {
  const path = statePath(input.idempotencyKey);
  const existing = readState(path);
  if (existing?.status === "completed") return { duplicate: true, ...existing };
  if (existing?.status === "unknown") {
    const error = new Error(
      "Prior external write outcome is unknown; inspect Notion before retrying."
    );
    error.status = 409;
    throw error;
  }
  writeState(path, {
    status: "pending",
    target: input.target,
    createdAt: new Date().toISOString()
  });
  let upstream;
  try {
    upstream = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.notionToken}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        parent: { page_id: config.targets[input.target] },
        properties: { title: { title: [{ text: { content: input.title } }] } },
        markdown: input.markdown
      }),
      signal: AbortSignal.timeout(30_000)
    });
  } catch {
    writeState(path, {
      status: "unknown",
      target: input.target,
      createdAt: new Date().toISOString()
    });
    const error = new Error(
      "Notion write outcome is unknown; do not retry automatically."
    );
    error.status = 409;
    throw error;
  }
  if (!upstream.ok) {
    writeState(path, {
      status: "failed",
      target: input.target,
      statusCode: upstream.status,
      createdAt: new Date().toISOString()
    });
    const error = new Error(
      `Notion rejected the fixed publish request (${upstream.status}).`
    );
    error.status = 502;
    throw error;
  }
  const page = await upstream.json();
  const completed = {
    status: "completed",
    target: input.target,
    pageId: page.id,
    url: page.url,
    publishedAt: new Date().toISOString()
  };
  writeState(path, completed);
  return completed;
}

createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health")
    return response(res, 200, { ok: true, service: "notion-publisher" });
  if (!authorized(req.headers.authorization))
    return response(res, 401, { error: "Authorization required." });
  if (req.method !== "POST" || req.url !== "/publish")
    return response(res, 404, { error: "Route is not allowlisted." });
  try {
    authorizedCapability(req.headers["x-opencode-capability-lease"]);
    const result = await publish(validate(await readRequest(req)));
    return response(res, 200, result);
  } catch (error) {
    const capabilityFailure = /Capability lease/iu.test(
      error instanceof Error ? error.message : String(error)
    );
    return response(
      res,
      capabilityFailure ? 403 : Number(error?.status) || 400,
      {
        error: error instanceof Error ? error.message : "Publish failed."
      }
    );
  }
}).listen(Number(process.env.NOTION_PUBLISHER_PORT || 8796), "0.0.0.0", () => {
  console.log("Restricted Notion publisher listening on port 8796");
});
