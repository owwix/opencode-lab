/**
 * Fixed-purpose credential and relay gateway.
 *
 * This privileged process holds provider/relay credentials. Every non-health
 * request must present a capability lease matching the configured launch and
 * route/action, and every upstream is selected from compiled allowlists.
 * OpenCode/project input cannot supply an arbitrary upstream, credential,
 * method, model, private-network target, or publishing operation. Artifact
 * fetches additionally revalidate DNS and redirects and enforce bounded HTTPS
 * staging. Keep new routes synchronized with docs/gateway-protocol.md and the
 * threat model, with positive and malicious boundary tests.
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import dns from "node:dns/promises";
import https from "node:https";
import { Readable } from "node:stream";
import {
  assertCapabilityScope,
  bearerCapability,
  verifyCapabilityLease
} from "./capability-lease.mjs";

const nonPublicNetworks = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3]
]) {
  nonPublicNetworks.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8]
]) {
  nonPublicNetworks.addSubnet(address, prefix, "ipv6");
}

export const CHAT_MODELS = new Set([
  "@cf/deepseek-ai/deepseek-v4-flash-0731",
  "@cf/deepseek-ai/deepseek-v4-pro-0813",
  "@cf/moonshotai/kimi-k2.6",
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/openai/gpt-oss-120b",
  "@cf/zai-org/glm-4.7-flash",
  "@cf/zai-org/glm-5.2"
]);
export const OPENAI_CHAT_MODELS = new Set([
  "gpt-5",
  "gpt-5-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "o4-mini"
]);
export const VERTEX_CHAT_MODELS = new Set([
  "gemini-3.7-flash",
  "gemini-3.1-pro-preview"
]);
export const IMAGE_MODELS = new Set([
  "@cf/black-forest-labs/flux-2-klein-4b",
  "@cf/black-forest-labs/flux-2-klein-9b",
  "@cf/black-forest-labs/flux-2-dev"
]);
// Workers AI's GPT-OSS chat schema currently rejects the OpenAI-standard
// multi-turn representation used by tool loops (content-part arrays and
// assistant messages with null content). Keep this compatibility shim scoped
// to the text-only model; never flatten content for vision-capable models.
const TEXT_ONLY_CHAT_COMPAT_MODELS = new Set(["@cf/openai/gpt-oss-120b"]);
/** When GPT-OSS rejects an oversized session, retry once on the long-context lane. */
export const LONG_CONTEXT_FALLBACK_MODEL = "@cf/moonshotai/kimi-k2.6";
export const PAYLOAD_FALLBACK_SOURCE_MODELS = new Set([
  "@cf/openai/gpt-oss-120b"
]);
export const GATEWAY_CAPABILITIES = Object.freeze([
  "chat",
  "openai-chat",
  "vertex-chat",
  "image",
  "quality",
  "open-design",
  "notion-publish",
  "github-publish",
  "openpets",
  "browser-verify",
  "browser-session",
  "artifact"
]);

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
  "x-lab-request-id",
  "x-lab-correlation-id"
]);
const RESPONSE_HEADERS = new Set([
  "cache-control",
  "cf-aig-log-id",
  "cf-ray",
  "content-language",
  "content-type",
  "last-modified",
  "mcp-session-id",
  "retry-after",
  "x-accel-buffering",
  "x-request-id",
  "x-lab-request-id",
  "x-lab-correlation-id",
  "x-lab-model",
  "x-lab-fallback-from",
  "x-lab-concurrency-retry",
  "x-lab-duration-ms"
]);

class GatewayPolicyError extends Error {
  constructor(message, statusCode = 403) {
    super(message);
    this.statusCode = statusCode;
  }
}

function filteredRequestHeaders(
  headers,
  upstreamToken,
  bodyLength,
  capabilityLease,
  additionalHeaders = {}
) {
  const result = {
    authorization: `Bearer ${upstreamToken}`,
    "content-length": String(bodyLength),
    "x-opencode-capability-lease": capabilityLease,
    ...additionalHeaders
  };
  for (const [name, value] of headers.entries()) {
    if (REQUEST_HEADERS.has(name.toLowerCase())) result[name] = value;
  }
  return result;
}

function filteredResponseHeaders(headers) {
  const result = {};
  for (const [name, value] of headers.entries()) {
    if (RESPONSE_HEADERS.has(name.toLowerCase())) result[name] = value;
  }
  return result;
}

function createLimiter(limit) {
  let active = 0;
  const waiters = [];
  return {
    async acquire(timeoutMs = 1_000) {
      if (active < limit) {
        active += 1;
        return true;
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((entry) => entry.resolve === resolve);
          if (index >= 0) waiters.splice(index, 1);
          resolve(false);
        }, timeoutMs);
        waiters.push({ resolve, timer });
      });
    },
    release() {
      const next = waiters.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(true);
      } else {
        active = Math.max(0, active - 1);
      }
    }
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let exceeded = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        exceeded = true;
        chunks.length = 0;
      } else if (!exceeded) {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      if (exceeded) {
        reject(new GatewayPolicyError("Request body is too large.", 413));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    request.on("aborted", () => reject(new Error("Request was aborted.")));
    request.on("error", reject);
  });
}

function parseJson(body) {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new GatewayPolicyError("Request body must be valid JSON.", 400);
  }
}

function normalizeChatBody(body, model) {
  if (!TEXT_ONLY_CHAT_COMPAT_MODELS.has(model)) return body;
  const payload = parseJson(body);
  if (!Array.isArray(payload.messages)) return body;
  const messages = payload.messages.map((message) => {
    const normalized = { ...message };
    if (Array.isArray(normalized.content)) {
      normalized.content = normalized.content
        .map((part) =>
          typeof part === "string"
            ? part
            : typeof part?.text === "string"
              ? part.text
              : ""
        )
        .filter(Boolean)
        .join("\n");
    } else if (normalized.content == null) {
      normalized.content = "";
    }
    return normalized;
  });
  return Buffer.from(JSON.stringify({ ...payload, messages }));
}

export function rewriteChatModel(body, model) {
  const payload = parseJson(body);
  return Buffer.from(JSON.stringify({ ...payload, model }), "utf8");
}

export function shouldFallbackPayloadTooLarge(
  status,
  model,
  allowlistedModels
) {
  return (
    status === 413 &&
    PAYLOAD_FALLBACK_SOURCE_MODELS.has(model) &&
    allowlistedModels.has(LONG_CONTEXT_FALLBACK_MODEL)
  );
}

const OVERFLOW_BODY_PATTERN =
  /payload too large|context.?length|maximum context|too many tokens|request.?too.?large|prompt.?too.?long/iu;

const GPT_OSS_SCHEMA_BODY_PATTERN =
  /schema|tool[_ -]?call|content.?part|messages(?:\.|\[)|null content|expected (?:a )?string|type.?error/iu;

const VERTEX_THOUGHT_BODY_PATTERN =
  /thought_signature|functioncall|function.?call.*signat/iu;

export function isContextOverflowStatus(status, bodyText = "") {
  if (status === 413) return true;
  if (status !== 400) return false;
  return OVERFLOW_BODY_PATTERN.test(String(bodyText));
}

export function isGptOssSchemaError(status, bodyText = "") {
  return status === 400 && GPT_OSS_SCHEMA_BODY_PATTERN.test(String(bodyText));
}

export function isVertexThoughtSignatureError(status, bodyText = "") {
  return status === 400 && VERTEX_THOUGHT_BODY_PATTERN.test(String(bodyText));
}

export function isGptOssAuthError(bodyText = "") {
  return /unauthorized|forbidden|invalid.?api.?key|authentication|permission denied/iu.test(
    String(bodyText)
  );
}

export function shouldFallbackGptOssToLongContext(
  status,
  model,
  bodyText = ""
) {
  if (!PAYLOAD_FALLBACK_SOURCE_MODELS.has(model)) return false;
  if (isGptOssAuthError(bodyText)) return false;
  return (
    isContextOverflowStatus(status, bodyText) ||
    isGptOssSchemaError(status, bodyText)
  );
}

/** Brief pause before a second attempt when a model slot is busy. */
export const CONCURRENCY_RETRY_DELAY_MS = 750;

export function shouldRetryConcurrency(status) {
  return status === 429;
}

async function acquireLimiterSlot(
  limiter,
  { delay, delayMs = CONCURRENCY_RETRY_DELAY_MS, timeoutMs = 5_000 } = {}
) {
  let acquired = await limiter.acquire(timeoutMs);
  if (acquired) return { acquired: true, retried: false };
  await delay(delayMs);
  acquired = await limiter.acquire(timeoutMs);
  return { acquired, retried: true };
}

function vertexOpenAiUrl(project) {
  return `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/global/endpoints/openapi/chat/completions`;
}

export function vertexOpenAiModelId(model) {
  if (typeof model !== "string" || !model.includes("/")) {
    return `google/${model}`;
  }
  return model;
}

function thoughtSignatureOf(call) {
  const fromExtra = call?.extra_content?.google?.thought_signature;
  if (typeof fromExtra === "string" && fromExtra) return fromExtra;
  const fromFunction = call?.function?.thought_signature;
  if (typeof fromFunction === "string" && fromFunction) return fromFunction;
  return "";
}

export function attachVertexThoughtSignatures(
  messages,
  { forceAll = false } = {}
) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => {
    if (
      !Array.isArray(message?.tool_calls) ||
      message.tool_calls.length === 0
    ) {
      return message;
    }
    return {
      ...message,
      tool_calls: message.tool_calls.map((call, index) => {
        if (thoughtSignatureOf(call) && !forceAll) return call;
        // Gemini 3 requires a signature on functionCall steps. OpenCode's
        // OpenAI-compatible client strips extra_content, so inject Google's
        // documented skip token when the original signature is gone.
        if (!forceAll && index > 0) return call;
        return {
          ...call,
          extra_content: {
            ...(call.extra_content ?? {}),
            google: {
              ...(call.extra_content?.google ?? {}),
              thought_signature: "skip_thought_signature_validator"
            }
          }
        };
      })
    };
  });
}

export function rewriteVertexChatBody(body, options = {}) {
  const payload = parseJson(body);
  return Buffer.from(
    JSON.stringify({
      ...payload,
      model: vertexOpenAiModelId(payload.model),
      messages: attachVertexThoughtSignatures(payload.messages, options)
    })
  );
}

const vertexTokenCache = { token: "", expiresAt: 0 };

async function resolveVertexAccessToken(config, fetchImpl) {
  const configured = String(config.googleAccessToken ?? "").trim();
  if (configured) return configured;
  if (vertexTokenCache.token && Date.now() < vertexTokenCache.expiresAt) {
    return vertexTokenCache.token;
  }
  const credentialPath = String(
    config.googleApplicationCredentials ?? ""
  ).trim();
  if (!credentialPath) {
    throw new GatewayPolicyError("Vertex credentials are not configured.");
  }
  const raw = await fs.readFile(credentialPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GatewayPolicyError("Vertex credentials are invalid.", 500);
  }
  if (parsed.type !== "authorized_user" || !parsed.refresh_token) {
    throw new GatewayPolicyError("Vertex credentials are invalid.", 500);
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: parsed.refresh_token,
    client_id: parsed.client_id,
    client_secret: parsed.client_secret
  });
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) {
    throw new GatewayPolicyError("Vertex authentication failed.", 502);
  }
  const payload = await response.json();
  const token = String(payload.access_token ?? "").trim();
  if (!token)
    throw new GatewayPolicyError("Vertex authentication failed.", 502);
  const expiresIn = Number(payload.expires_in) || 3600;
  vertexTokenCache.token = token;
  vertexTokenCache.expiresAt = Date.now() + Math.max(30, expiresIn - 60) * 1000;
  return token;
}

function fixedTarget(requestUrl, method, body, config, policy) {
  const url = new URL(requestUrl, "http://gateway.invalid");
  if (url.pathname === "/openai/v1/chat/completions") {
    if (!policy.capabilities.has("openai-chat")) {
      throw new GatewayPolicyError("Route is not allowlisted.", 404);
    }
    if (method !== "POST")
      throw new GatewayPolicyError("Method not allowed.", 405);
    const payload = parseJson(body);
    if (!policy.openaiChatModels.has(payload?.model)) {
      throw new GatewayPolicyError("OpenAI model is not allowlisted.");
    }
    return {
      model: payload.model,
      token: config.openaiApiKey,
      url: "https://api.openai.com/v1/chat/completions"
    };
  }
  if (url.pathname === "/vertex/v1/chat/completions") {
    if (!policy.capabilities.has("vertex-chat")) {
      throw new GatewayPolicyError("Route is not allowlisted.", 404);
    }
    if (method !== "POST")
      throw new GatewayPolicyError("Method not allowed.", 405);
    const payload = parseJson(body);
    if (!policy.vertexChatModels.has(payload?.model)) {
      throw new GatewayPolicyError("Vertex model is not allowlisted.");
    }
    const project = String(config.googleCloudProject ?? "").trim();
    if (!project)
      throw new GatewayPolicyError("Vertex project is not configured.");
    return {
      model: payload.model,
      token: "",
      auth: "vertex",
      url: vertexOpenAiUrl(project)
    };
  }
  if (url.pathname === "/v1/chat/completions") {
    if (!policy.capabilities.has("chat")) {
      throw new GatewayPolicyError("Route is not allowlisted.", 404);
    }
    if (method !== "POST")
      throw new GatewayPolicyError("Method not allowed.", 405);
    const payload = parseJson(body);
    if (!policy.chatModels.has(payload?.model)) {
      throw new GatewayPolicyError("Workers AI model is not allowlisted.");
    }
    return {
      model: payload.model,
      token: config.cloudflareApiToken,
      url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.cloudflareAccountId)}/ai/v1/chat/completions`
    };
  }

  if (url.pathname.startsWith("/run/")) {
    if (!policy.capabilities.has("image")) {
      throw new GatewayPolicyError("Route is not allowlisted.", 404);
    }
    if (method !== "POST")
      throw new GatewayPolicyError("Method not allowed.", 405);
    const model = decodeURIComponent(url.pathname.slice("/run/".length));
    if (!policy.imageModels.has(model)) {
      throw new GatewayPolicyError(
        "Workers AI image model is not allowlisted."
      );
    }
    return {
      model,
      token: config.cloudflareApiToken,
      url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.cloudflareAccountId)}/ai/run/${model}`
    };
  }

  if (url.pathname === "/quality/mcp") {
    if (!policy.capabilities.has("quality")) {
      throw new GatewayPolicyError("Route is not allowlisted.", 404);
    }
    if (!new Set(["DELETE", "POST"]).has(method)) {
      throw new GatewayPolicyError("Method not allowed.", 405);
    }
    return {
      model: "quality",
      token: config.qualityMcpToken,
      headers: {
        "x-lab-registration-token": config.qualityRegistrationToken
      },
      url: `http://host.docker.internal:8793/mcp${url.search}`
    };
  }

  if (
    url.pathname === "/quality/notifications" ||
    url.pathname === "/quality/runs" ||
    url.pathname.startsWith("/quality/runs/")
  ) {
    if (!policy.capabilities.has("quality")) {
      throw new GatewayPolicyError("Route is not allowlisted.", 404);
    }
    if (!new Set(["GET", "POST"]).has(method)) {
      throw new GatewayPolicyError("Method not allowed.", 405);
    }
    const upstreamPath = url.pathname.slice("/quality".length);
    return {
      model: "quality",
      token: config.qualityMcpToken,
      headers: {
        "x-lab-registration-token": config.qualityRegistrationToken
      },
      url: `http://host.docker.internal:8793${upstreamPath}${url.search}`
    };
  }

  if (url.pathname.startsWith("/open-design/")) {
    if (!policy.capabilities.has("open-design")) {
      throw new GatewayPolicyError("Route is not allowlisted.", 404);
    }
    if (!new Set(["DELETE", "GET", "HEAD", "POST", "PUT"]).has(method)) {
      throw new GatewayPolicyError("Method not allowed.", 405);
    }
    const upstreamPath = url.pathname.slice("/open-design".length);
    if (
      !new Set(["/api", "/artifacts", "/frames"]).has(upstreamPath) &&
      !["/api/", "/artifacts/", "/frames/"].some((prefix) =>
        upstreamPath.startsWith(prefix)
      )
    ) {
      throw new GatewayPolicyError("OpenDesign route is not allowlisted.");
    }
    return {
      model: "open-design",
      token: config.openDesignToken,
      url: `http://open-design:7456${upstreamPath}${url.search}`
    };
  }

  if (url.pathname === "/notion/publish") {
    if (!policy.capabilities.has("notion-publish")) {
      throw new GatewayPolicyError("Route is not allowlisted.", 404);
    }
    if (method !== "POST")
      throw new GatewayPolicyError("Method not allowed.", 405);
    return {
      model: "notion-publish",
      token: config.notionPublisherToken,
      url: `${config.notionPublisherUrl}/publish`
    };
  }

  if (url.pathname.startsWith("/github/")) {
    if (!policy.capabilities.has("github-publish")) {
      throw new GatewayPolicyError("Route is not allowlisted.", 404);
    }
    if (method !== "POST") {
      throw new GatewayPolicyError("Method not allowed.", 405);
    }
    const operation = url.pathname.slice("/github/".length);
    if (!new Set(["status", "push", "pr"]).has(operation)) {
      throw new GatewayPolicyError("GitHub route is not allowlisted.");
    }
    return {
      model: "github-publish",
      token: config.githubRelayToken,
      url: `${config.githubRelayUrl}/v1/${operation}`
    };
  }

  if (url.pathname === "/openpets/react") {
    if (!policy.capabilities.has("openpets")) {
      throw new GatewayPolicyError("Route is not allowlisted.", 404);
    }
    if (method !== "POST") {
      throw new GatewayPolicyError("Method not allowed.", 405);
    }
    const payload = parseJson(body);
    if (
      typeof payload?.reaction !== "string" ||
      !new Set([
        "thinking",
        "editing",
        "testing",
        "waiting",
        "success",
        "error"
      ]).has(payload.reaction)
    ) {
      throw new GatewayPolicyError("OpenPets reaction is not allowlisted.");
    }
    return {
      model: "openpets",
      token: config.openPetsRelayToken,
      url: `${config.openPetsRelayUrl}/v1/react`
    };
  }

  if (url.pathname === "/browser/verify") {
    if (!policy.capabilities.has("browser-verify")) {
      throw new GatewayPolicyError("Route is not allowlisted.", 404);
    }
    if (method !== "POST") {
      throw new GatewayPolicyError("Method not allowed.", 405);
    }
    return {
      model: "browser-verify",
      token: config.browserVerifyRelayToken,
      url: `${config.browserVerifyRelayUrl}/verify`
    };
  }

  if (url.pathname === "/browser/session") {
    if (!policy.capabilities.has("browser-session")) {
      throw new GatewayPolicyError("Route is not allowlisted.", 404);
    }
    if (method !== "POST") {
      throw new GatewayPolicyError("Method not allowed.", 405);
    }
    return {
      model: "browser-session",
      token: config.browserSessionRelayToken,
      url: `${config.browserSessionRelayUrl}/action`
    };
  }

  throw new GatewayPolicyError("Route is not allowlisted.", 404);
}

function capabilityScopeForTarget(requestUrl, target) {
  const pathname = new URL(requestUrl, "http://gateway.invalid").pathname;
  if (pathname === "/openai/v1/chat/completions") {
    return { route: "openai-chat", action: "invoke" };
  }
  if (pathname === "/vertex/v1/chat/completions") {
    return { route: "vertex-chat", action: "invoke" };
  }
  if (pathname === "/v1/chat/completions") {
    return { route: "chat", action: "invoke" };
  }
  if (pathname.startsWith("/run/")) {
    return { route: "image", action: "generate" };
  }
  if (pathname === "/quality/mcp") {
    return { route: "quality", action: "mcp" };
  }
  if (pathname === "/quality/runs") {
    return { route: "quality", action: "read" };
  }
  if (pathname === "/quality/notifications") {
    return { route: "quality", action: "read" };
  }
  if (pathname.startsWith("/quality/runs/")) {
    return {
      route: "quality",
      action: pathname.includes("/actions/") ? "operate" : "read"
    };
  }
  if (pathname.startsWith("/open-design/")) {
    return { route: "open-design", action: "mcp" };
  }
  if (pathname === "/notion/publish") {
    return { route: "notion-publish", action: "publish" };
  }
  if (pathname.startsWith("/github/")) {
    return {
      route: "github-publish",
      action: pathname.slice("/github/".length)
    };
  }
  if (pathname === "/openpets/react") {
    return { route: "openpets", action: "react" };
  }
  if (pathname === "/browser/verify") {
    return { route: "browser-verify", action: "verify" };
  }
  if (pathname === "/browser/session") {
    return { route: "browser-session", action: "control" };
  }
  throw new GatewayPolicyError(
    `No capability scope is defined for ${target.model}.`,
    404
  );
}

function requireCapabilityScope(claims, scope) {
  try {
    return assertCapabilityScope(claims, scope);
  } catch (error) {
    throw new GatewayPolicyError(
      error instanceof Error ? error.message : "Capability scope rejected.",
      403
    );
  }
}

async function streamResponse(upstream, response, metadata = {}) {
  const headers = filteredResponseHeaders(upstream.headers);
  if (metadata.requestId) headers["x-lab-request-id"] = metadata.requestId;
  if (metadata.correlationId) {
    headers["x-lab-correlation-id"] = metadata.correlationId;
  }
  if (metadata.model) headers["x-lab-model"] = metadata.model;
  if (metadata.fallbackFrom) {
    headers["x-lab-fallback-from"] = metadata.fallbackFrom;
  }
  if (metadata.concurrencyRetried) {
    headers["x-lab-concurrency-retry"] = "1";
  }
  if (metadata.durationMs !== undefined) {
    headers["x-lab-duration-ms"] = String(metadata.durationMs);
  }
  response.writeHead(upstream.status, headers);
  if (!upstream.body) {
    response.end();
    return;
  }
  for await (const chunk of Readable.fromWeb(upstream.body)) {
    if (!response.write(chunk)) await once(response, "drain");
  }
  response.end();
}

function policyResponse(response, error) {
  const statusCode =
    error instanceof GatewayPolicyError ? error.statusCode : 502;
  const message =
    error instanceof GatewayPolicyError
      ? error.message
      : "The credential gateway could not reach its fixed upstream.";
  const body = `${JSON.stringify({ error: { message } })}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function privateAddress(address) {
  const normalized = String(address).toLowerCase();
  const family = net.isIPv4(normalized)
    ? "ipv4"
    : net.isIPv6(normalized)
      ? "ipv6"
      : null;
  return family === null || nonPublicNetworks.check(normalized, family);
}

async function resolveArtifactTarget(url, allowlist, dnsLookup) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new GatewayPolicyError("Only HTTPS URLs are allowed.", 400);
  }
  if (
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== "443")
  ) {
    throw new GatewayPolicyError("Artifact URL authority is not allowed.", 400);
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  if (!allowlist.includes(host)) {
    throw new GatewayPolicyError("Domain is not allowlisted.", 403);
  }
  const addresses = net.isIP(host)
    ? [{ address: host, family: net.isIPv4(host) ? 4 : 6 }]
    : await dnsLookup(host, { all: true, verbatim: true }).catch(() => []);
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => privateAddress(address))
  ) {
    throw new GatewayPolicyError("Target resolves to a non-public IP.", 403);
  }
  return { parsed, host, addresses };
}

function pinnedArtifactRequest(url, { address, family, timeoutMs, maxBytes }) {
  return new Promise((resolveRequest, rejectRequest) => {
    const parsed = new URL(url);
    const request = https.request(
      parsed,
      {
        method: "GET",
        servername: parsed.hostname,
        lookup(_hostname, _options, callback) {
          callback(null, address, family);
        }
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy(
              new GatewayPolicyError("Artifact size exceeds limit.", 413)
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", rejectRequest);
        response.on("end", () => {
          const buffer = Buffer.concat(chunks);
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) {
              for (const entry of value) headers.append(name, entry);
            } else if (value !== undefined) {
              headers.set(name, value);
            }
          }
          const status = response.statusCode ?? 502;
          resolveRequest({
            status,
            ok: status >= 200 && status < 300,
            headers,
            async arrayBuffer() {
              return buffer;
            }
          });
        });
      }
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(
        new GatewayPolicyError("Artifact request timed out.", 504)
      );
    });
    request.on("error", rejectRequest);
    request.end();
  });
}

export function createAgentGateway(
  config,
  {
    fetchImpl = fetch,
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    capabilities = GATEWAY_CAPABILITIES.filter(
      (capability) =>
        !new Set([
          "openai-chat",
          "vertex-chat",
          "notion-publish",
          "github-publish",
          "openpets",
          "browser-verify",
          "browser-session",
          "artifact"
        ]).has(capability)
    ),
    chatModels = CHAT_MODELS,
    openaiChatModels = OPENAI_CHAT_MODELS,
    vertexChatModels = VERTEX_CHAT_MODELS,
    imageModels = IMAGE_MODELS,
    artifactStagingRoot = "/workspace/.artifact-staging",
    dnsLookup = dns.lookup
  } = {}
) {
  const capabilitySet = new Set(capabilities);
  const unknownCapabilities = [...capabilitySet].filter(
    (capability) => !GATEWAY_CAPABILITIES.includes(capability)
  );
  if (unknownCapabilities.length) {
    throw new Error(
      `Unknown gateway capabilities: ${unknownCapabilities.join(", ")}.`
    );
  }
  const requiredConfig = [
    "gatewaySigningKey",
    "expectedWorkspaceHash",
    "expectedProjectId",
    "expectedSessionId",
    "expectedRunId"
  ];
  if (capabilitySet.has("chat") || capabilitySet.has("image")) {
    requiredConfig.push("cloudflareAccountId", "cloudflareApiToken");
  }
  if (capabilitySet.has("openai-chat")) requiredConfig.push("openaiApiKey");
  if (capabilitySet.has("vertex-chat"))
    requiredConfig.push("googleCloudProject");
  if (capabilitySet.has("quality")) {
    requiredConfig.push("qualityMcpToken", "qualityRegistrationToken");
  }
  if (capabilitySet.has("open-design")) requiredConfig.push("openDesignToken");
  if (capabilitySet.has("notion-publish")) {
    requiredConfig.push("notionPublisherToken", "notionPublisherUrl");
  }
  if (capabilitySet.has("github-publish")) {
    requiredConfig.push("githubRelayToken", "githubRelayUrl");
  }
  if (capabilitySet.has("openpets")) {
    requiredConfig.push("openPetsRelayToken", "openPetsRelayUrl");
  }
  if (capabilitySet.has("browser-verify")) {
    requiredConfig.push("browserVerifyRelayToken", "browserVerifyRelayUrl");
  }
  if (capabilitySet.has("browser-session")) {
    requiredConfig.push("browserSessionRelayToken", "browserSessionRelayUrl");
  }
  if (capabilitySet.has("artifact")) {
    requiredConfig.push("artifactAllowlist");
  }
  for (const name of requiredConfig) {
    if (!String(config[name] ?? "").trim())
      throw new Error(`${name} is required.`);
  }
  const policy = Object.freeze({
    capabilities: capabilitySet,
    chatModels: new Set(chatModels),
    openaiChatModels: new Set(openaiChatModels),
    vertexChatModels: new Set(vertexChatModels),
    imageModels: new Set(imageModels)
  });
  const concurrency = new Map([
    ["@cf/moonshotai/kimi-k2.6", createLimiter(2)],
    ["@cf/moonshotai/kimi-k2.7-code", createLimiter(2)],
    ["@cf/zai-org/glm-5.2", createLimiter(1)],
    ["@cf/zai-org/glm-4.7-flash", createLimiter(8)],
    ["@cf/openai/gpt-oss-120b", createLimiter(4)],
    ["gpt-5", createLimiter(2)],
    ["gpt-5-mini", createLimiter(4)],
    ["gpt-4.1", createLimiter(2)],
    ["gpt-4.1-mini", createLimiter(4)],
    ["o4-mini", createLimiter(2)],
    ["gemini-3.7-flash", createLimiter(4)],
    ["gemini-3.1-pro-preview", createLimiter(3)],
    ["quality", createLimiter(4)],
    ["open-design", createLimiter(2)],
    ["notion-publish", createLimiter(2)],
    ["github-publish", createLimiter(2)],
    ["openpets", createLimiter(4)],
    ["browser-verify", createLimiter(2)],
    ["browser-session", createLimiter(2)],
    ["artifact", createLimiter(4)]
  ]);

  const MAX_ARTIFACT_SIZE = 10 * 1024 * 1024; // 10 MiB
  const MAX_ARTIFACT_REDIRECTS = 5;
  const DEFAULT_ARTIFACT_TIMEOUT_MS = 30 * 1000; // 30 s

  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true,"service":"agent-gateway"}\n');
      return;
    }
    let capabilityLease;
    let capabilityClaims;
    try {
      capabilityLease = bearerCapability(request.headers.authorization);
      capabilityClaims = verifyCapabilityLease(capabilityLease, {
        key: config.gatewaySigningKey,
        workspaceHash: config.expectedWorkspaceHash,
        projectId: config.expectedProjectId,
        sessionId: config.expectedSessionId,
        runId: config.expectedRunId
      });
    } catch (error) {
      policyResponse(
        response,
        new GatewayPolicyError(
          error instanceof Error ? error.message : "Capability lease rejected.",
          401
        )
      );
      return;
    }
    let limiter = null;
    let acquired = false;
    try {
      const body = await readBody(request);

      // Artifact download route (HTTPS only, allow‑list enforced)
      if (request.method === "POST" && request.url === "/artifact/download") {
        requireCapabilityScope(capabilityClaims, {
          route: "artifact",
          action: "download"
        });
        if (!policy.capabilities.has("artifact")) {
          throw new GatewayPolicyError("Route is not allowlisted.", 404);
        }
        const payload = parseJson(body);
        const { url, checksum, filename, maxSize, allowedContentTypes } =
          payload;
        const allowlist = (config.artifactAllowlist ?? "")
          .split(",")
          .map((entry) => entry.trim().toLowerCase().replace(/\.$/u, ""))
          .filter(Boolean);
        if (typeof url !== "string") {
          throw new GatewayPolicyError("Artifact URL is required.", 400);
        }
        const initialTarget = await resolveArtifactTarget(
          url,
          allowlist,
          dnsLookup
        );
        const parsedUrl = initialTarget.parsed;
        if (
          maxSize !== undefined &&
          (!Number.isSafeInteger(maxSize) ||
            maxSize <= 0 ||
            maxSize > MAX_ARTIFACT_SIZE)
        ) {
          throw new GatewayPolicyError("Invalid artifact size limit.", 400);
        }
        const limitSize = maxSize ?? MAX_ARTIFACT_SIZE;
        // Follow redirects manually
        let currentUrl = url;
        let redirectCount = 0;
        let responseObj;
        const fetchOptsBase = {
          method: "GET",
          headers: {},
          redirect: "manual",
          signal: AbortSignal.timeout(DEFAULT_ARTIFACT_TIMEOUT_MS)
        };
        while (true) {
          const target = await resolveArtifactTarget(
            currentUrl,
            allowlist,
            dnsLookup
          );
          responseObj =
            fetchImpl === fetch
              ? await pinnedArtifactRequest(currentUrl, {
                  ...target.addresses[0],
                  timeoutMs: DEFAULT_ARTIFACT_TIMEOUT_MS,
                  maxBytes: limitSize
                })
              : await fetchImpl(currentUrl, fetchOptsBase);
          if (
            responseObj.status >= 300 &&
            responseObj.status < 400 &&
            responseObj.headers.get("location")
          ) {
            if (redirectCount >= MAX_ARTIFACT_REDIRECTS) {
              throw new GatewayPolicyError("Too many redirects.", 400);
            }
            const location = responseObj.headers.get("location");
            const nextUrl = new URL(location, currentUrl).toString();
            currentUrl = nextUrl;
            redirectCount++;
            continue;
          }
          break;
        }
        if (!responseObj.ok) {
          throw new GatewayPolicyError(
            `Failed to download artifact (status ${responseObj.status}).`,
            responseObj.status
          );
        }
        const contentType =
          responseObj.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
        const allowedTypes = allowedContentTypes?.length
          ? allowedContentTypes
          : [
              "application/octet-stream",
              "application/pdf",
              "image/png",
              "image/jpeg",
              "image/webp",
              "text/plain"
            ];
        if (!allowedTypes.includes(contentType)) {
          throw new GatewayPolicyError("Disallowed content type.", 415);
        }
        const buffer = Buffer.from(await responseObj.arrayBuffer());
        if (buffer.length > limitSize) {
          throw new GatewayPolicyError("Artifact size exceeds limit.", 413);
        }
        if (checksum) {
          const computed = crypto
            .createHash("sha256")
            .update(buffer)
            .digest("hex");
          if (computed !== checksum.toLowerCase()) {
            throw new GatewayPolicyError("Checksum mismatch.", 400);
          }
        }
        // Determine safe filename
        let safeName = filename ?? path.basename(parsedUrl.pathname);
        if (
          !safeName ||
          safeName.includes("..") ||
          safeName.includes("/") ||
          safeName.includes("\\")
        ) {
          throw new GatewayPolicyError("Invalid filename.", 400);
        }
        const stagingRoot = path.resolve(artifactStagingRoot);
        await fs.mkdir(stagingRoot, { recursive: true });
        const tmpDir = await fs.mkdtemp(path.join(stagingRoot, "tmp-"));
        const destPath = path.join(tmpDir, safeName);
        await fs.writeFile(destPath, buffer);
        const result = {
          url,
          finalUrl: currentUrl,
          size: buffer.length,
          mimeType: contentType,
          checksum:
            checksum ??
            crypto.createHash("sha256").update(buffer).digest("hex"),
          stagingPath: path.relative(path.dirname(stagingRoot), destPath)
        };
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8"
        });
        response.end(JSON.stringify(result));
        return;
      }

      // Normal route handling
      const target = fixedTarget(
        request.url,
        request.method ?? "GET",
        body,
        config,
        policy
      );
      requireCapabilityScope(
        capabilityClaims,
        capabilityScopeForTarget(request.url, target)
      );
      if (target.auth === "vertex") {
        target.token = await resolveVertexAccessToken(config, fetchImpl);
      }
      const upstreamBody = request.url?.startsWith(
        "/vertex/v1/chat/completions"
      )
        ? rewriteVertexChatBody(body)
        : request.url?.startsWith("/v1/chat/completions")
          ? normalizeChatBody(body, target.model)
          : body;
      const requestId =
        request.headers["x-lab-request-id"]?.toString().trim() || randomUUID();
      const correlationId =
        request.headers["x-lab-correlation-id"]?.toString().trim() || requestId;
      limiter = concurrency.get(target.model) ?? createLimiter(2);
      let concurrencyRetried = false;
      {
        const slot = await acquireLimiterSlot(limiter, { delay });
        acquired = slot.acquired;
        concurrencyRetried = slot.retried && slot.acquired;
        if (!slot.acquired) {
          response.writeHead(429, {
            "content-type": "application/json; charset=utf-8",
            "retry-after": "1",
            "x-lab-request-id": requestId,
            "x-lab-concurrency-retry": "1"
          });
          response.end(
            '{"error":{"message":"Model concurrency limit reached."}}\n'
          );
          return;
        }
      }
      const startedAt = Date.now();
      let activeModel = target.model;
      let activeBody = upstreamBody;
      let activeUrl = target.url;
      let activeToken = target.token;
      const fetchUpstream = () =>
        fetchImpl(activeUrl, {
          method: request.method,
          headers: filteredRequestHeaders(
            new Headers(request.headers),
            activeToken,
            activeBody.length,
            capabilityLease,
            {
              ...target.headers,
              "x-lab-correlation-id": correlationId
            }
          ),
          body: new Set(["GET", "HEAD"]).has(request.method)
            ? undefined
            : activeBody,
          redirect: "manual",
          signal: AbortSignal.timeout(10 * 60 * 1000)
        });
      let upstream = await fetchUpstream();
      let fallbackFrom = null;
      if (
        request.url?.startsWith("/v1/chat/completions") &&
        PAYLOAD_FALLBACK_SOURCE_MODELS.has(activeModel) &&
        policy.chatModels.has(LONG_CONTEXT_FALLBACK_MODEL) &&
        (upstream.status === 413 || upstream.status === 400)
      ) {
        const errorBody = upstream.body
          ? Buffer.from(
              await upstream.arrayBuffer().catch(() => new ArrayBuffer(0))
            ).toString("utf8")
          : "";
        if (
          shouldFallbackGptOssToLongContext(
            upstream.status,
            activeModel,
            errorBody
          )
        ) {
          const previousModel = activeModel;
          activeModel = LONG_CONTEXT_FALLBACK_MODEL;
          activeBody = rewriteChatModel(body, activeModel);
          activeUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.cloudflareAccountId)}/ai/v1/chat/completions`;
          if (acquired) {
            limiter.release();
            acquired = false;
          }
          limiter = concurrency.get(activeModel) ?? createLimiter(2);
          const slot = await acquireLimiterSlot(limiter, { delay });
          acquired = slot.acquired;
          if (slot.retried && slot.acquired) concurrencyRetried = true;
          if (!slot.acquired) {
            response.writeHead(429, {
              "content-type": "application/json; charset=utf-8",
              "retry-after": "1",
              "x-lab-request-id": requestId,
              "x-lab-fallback-from": previousModel,
              "x-lab-concurrency-retry": "1"
            });
            response.end(
              '{"error":{"message":"Model concurrency limit reached during payload fallback."}}\n'
            );
            return;
          }
          fallbackFrom = previousModel;
          upstream = await fetchUpstream();
        } else {
          response.writeHead(upstream.status, {
            "content-type": "application/json; charset=utf-8",
            "x-lab-request-id": requestId,
            "x-lab-model": activeModel
          });
          response.end(errorBody || '{"error":{"message":"Bad Request"}}\n');
          return;
        }
      }
      if (
        request.url?.startsWith("/vertex/v1/chat/completions") &&
        upstream.status === 400
      ) {
        const errorBody = upstream.body
          ? Buffer.from(
              await upstream.arrayBuffer().catch(() => new ArrayBuffer(0))
            ).toString("utf8")
          : "";
        if (isVertexThoughtSignatureError(upstream.status, errorBody)) {
          activeBody = rewriteVertexChatBody(body, { forceAll: true });
          upstream = await fetchUpstream();
        } else {
          response.writeHead(upstream.status, {
            "content-type": "application/json; charset=utf-8",
            "x-lab-request-id": requestId,
            "x-lab-model": activeModel
          });
          response.end(errorBody || '{"error":{"message":"Bad Request"}}\n');
          return;
        }
      }
      if (
        shouldRetryConcurrency(upstream.status) &&
        (request.url?.startsWith("/v1/chat/completions") ||
          request.url?.startsWith("/openai/v1/chat/completions") ||
          request.url?.startsWith("/vertex/v1/chat/completions"))
      ) {
        if (upstream.body) {
          await upstream.arrayBuffer().catch(() => undefined);
        }
        await delay(CONCURRENCY_RETRY_DELAY_MS);
        concurrencyRetried = true;
        upstream = await fetchUpstream();
      }
      await streamResponse(upstream, response, {
        requestId,
        correlationId,
        model: activeModel,
        fallbackFrom,
        concurrencyRetried,
        durationMs: Date.now() - startedAt
      });
      process.stderr.write(
        `${JSON.stringify({
          requestId,
          correlationId,
          model: activeModel,
          fallbackFrom,
          concurrencyRetried,
          status: upstream.status,
          durationMs: Date.now() - startedAt
        })}\n`
      );
    } catch (error) {
      if (!response.headersSent) policyResponse(response, error);
      else response.destroy();
    } finally {
      if (acquired) limiter.release();
    }
  });
}
