import { createServer } from "node:http";
import { request as requestHttp } from "node:http";
import { connect } from "node:net";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
const SENSITIVE_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "forwarded",
  "proxy-authorization",
  "x-api-key",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto"
]);
const ALLOWED_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "POST"]);
const FORBIDDEN_FETCH_OPTIONS = new Set([
  "actions",
  "cookies",
  "extra_headers",
  "proxy",
  "solve_cloudflare",
  "useragent"
]);
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_FETCH_URLS = 10;
const MAX_CRAWL_PAGES = 25;

class RelayPolicyError extends Error {
  constructor(message, statusCode = 403) {
    super(message);
    this.statusCode = statusCode;
  }
}

function forwardedHeaders(headers, upstreamHost, upstreamPort, bodyLength) {
  const forwarded = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (
      value == null ||
      HOP_BY_HOP_HEADERS.has(normalized) ||
      SENSITIVE_REQUEST_HEADERS.has(normalized) ||
      normalized === "content-length"
    ) {
      continue;
    }
    forwarded[name] = value;
  }
  forwarded.host = `${upstreamHost}:${upstreamPort}`;
  if (bodyLength != null) forwarded["content-length"] = String(bodyLength);
  return forwarded;
}

function responseHeaders(headers) {
  const forwarded = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (
      value == null ||
      HOP_BY_HOP_HEADERS.has(normalized) ||
      normalized === "set-cookie"
    ) {
      continue;
    }
    forwarded[name] = value;
  }
  return forwarded;
}

function mcpPathAllowed(rawUrl) {
  if (!rawUrl?.startsWith("/")) return false;
  try {
    const pathname = new URL(rawUrl, "http://relay.invalid").pathname;
    return pathname === "/mcp" || pathname.startsWith("/mcp/");
  } catch {
    return false;
  }
}

function asRecord(value, label) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new RelayPolicyError(`${label} must be an object.`, 400);
  }
  return value;
}

function boundInteger(value, minimum, maximum, label) {
  if (value == null) return value;
  if (!Number.isInteger(value)) {
    throw new RelayPolicyError(`${label} must be an integer.`, 400);
  }
  return Math.min(Math.max(value, minimum), maximum);
}

function validateUrl(value, label) {
  if (typeof value !== "string") {
    throw new RelayPolicyError(`${label} must be a URL string.`, 400);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new RelayPolicyError(`${label} must be a valid URL.`, 400);
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new RelayPolicyError(`${label} must use HTTP or HTTPS.`);
  }
  if (parsed.username || parsed.password) {
    throw new RelayPolicyError(`${label} cannot contain credentials.`);
  }
}

function validateUrlList(values, label, maximum) {
  if (!Array.isArray(values)) {
    throw new RelayPolicyError(`${label} must be an array.`, 400);
  }
  if (values.length > maximum) {
    throw new RelayPolicyError(`${label} is limited to ${maximum} URLs.`);
  }
  for (const value of values) validateUrl(value, label);
}

function hardenToolCall(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  if (message.method !== "tools/call") return;

  const params = asRecord(message.params, "Tool-call parameters");
  const argumentsValue = asRecord(params.arguments, "Tool arguments");
  message.params = params;
  params.arguments = argumentsValue;

  if (params.name === "mcp_smart_search") {
    const options = asRecord(argumentsValue.options, "Search options");
    if (
      argumentsValue.mode === "find_similar" ||
      Object.hasOwn(argumentsValue, "url") ||
      options.mode === "find_similar" ||
      Object.hasOwn(options, "url")
    ) {
      throw new RelayPolicyError(
        "Hound search cannot fetch a source URL; use the guarded fetch tool."
      );
    }
    return;
  }

  if (params.name === "mcp_smart_fetch") {
    if (Object.hasOwn(argumentsValue, "actions")) {
      if (
        !Array.isArray(argumentsValue.actions) ||
        argumentsValue.actions.length
      ) {
        throw new RelayPolicyError("Hound browser actions are disabled.");
      }
      delete argumentsValue.actions;
    }
    if (argumentsValue.url != null)
      validateUrl(argumentsValue.url, "Fetch URL");
    if (argumentsValue.urls != null) {
      validateUrlList(argumentsValue.urls, "Bulk fetch URLs", MAX_FETCH_URLS);
    }
    const options = asRecord(argumentsValue.options, "Fetch options");
    for (const option of FORBIDDEN_FETCH_OPTIONS) {
      if (
        Object.hasOwn(argumentsValue, option) ||
        Object.hasOwn(options, option)
      ) {
        throw new RelayPolicyError(
          `Hound fetch option '${option}' is disabled.`
        );
      }
    }
    // Hound promotes selected top-level arguments and lets them override the
    // options object, so enforce robots in both locations.
    argumentsValue.respect_robots = true;
    argumentsValue.options = { ...options, respect_robots: true };
    return;
  }

  if (params.name === "mcp_smart_crawl") {
    if (argumentsValue.url != null)
      validateUrl(argumentsValue.url, "Crawl URL");
    if (argumentsValue.crawl_urls != null) {
      validateUrlList(
        argumentsValue.crawl_urls,
        "Selective crawl URLs",
        MAX_CRAWL_PAGES
      );
    }
    const options = asRecord(argumentsValue.options, "Crawl options");
    argumentsValue.concurrency = boundInteger(
      argumentsValue.concurrency,
      1,
      3,
      "Crawl concurrency"
    );
    argumentsValue.max_depth = boundInteger(
      argumentsValue.max_depth,
      0,
      3,
      "Crawl depth"
    );
    argumentsValue.max_pages = boundInteger(
      argumentsValue.max_pages,
      1,
      MAX_CRAWL_PAGES,
      "Crawl page count"
    );
    argumentsValue.respect_robots = true;
    argumentsValue.options = {
      ...options,
      concurrency: boundInteger(options.concurrency, 1, 3, "Crawl concurrency"),
      max_depth: boundInteger(options.max_depth, 0, 3, "Crawl depth"),
      max_pages: boundInteger(
        options.max_pages,
        1,
        MAX_CRAWL_PAGES,
        "Crawl page count"
      ),
      respect_robots: true
    };
    return;
  }

  if (params.name === "mcp_screenshot" && argumentsValue.url != null) {
    validateUrl(argumentsValue.url, "Screenshot URL");
  }
}

export function hardenMcpPayload(payload) {
  const messages = Array.isArray(payload) ? payload : [payload];
  if (messages.length === 0) {
    throw new RelayPolicyError("Empty JSON-RPC batches are not accepted.", 400);
  }
  for (const message of messages) hardenToolCall(message);
  return payload;
}

function requestId(payload) {
  if (!payload || Array.isArray(payload) || typeof payload !== "object")
    return null;
  return payload.id ?? null;
}

function sendPolicyError(response, error, id = null) {
  const statusCode = error instanceof RelayPolicyError ? error.statusCode : 400;
  const message =
    error instanceof RelayPolicyError
      ? error.message
      : "Invalid MCP request body.";
  const body = `${JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code: -32602, message }
  })}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_REQUEST_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(new RelayPolicyError("MCP request body is too large.", 413));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    request.on("aborted", () => reject(new Error("Request aborted.")));
    request.on("error", reject);
  });
}

function upstreamIsHealthy(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (healthy) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(healthy);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function forwardRequest(
  request,
  response,
  { upstreamHost, upstreamPort, method, body }
) {
  let upstreamResponse;
  const upstream = requestHttp(
    {
      hostname: upstreamHost,
      port: upstreamPort,
      method,
      path: request.url,
      headers: forwardedHeaders(
        request.headers,
        upstreamHost,
        upstreamPort,
        body?.length
      )
    },
    (incomingResponse) => {
      upstreamResponse = incomingResponse;
      const abortDownstream = () => {
        if (!response.destroyed) response.destroy();
      };
      incomingResponse.once("aborted", abortDownstream);
      incomingResponse.once("error", abortDownstream);
      response.writeHead(
        incomingResponse.statusCode || 502,
        responseHeaders(incomingResponse.headers)
      );
      incomingResponse.pipe(response);
    }
  );

  response.once("close", () => {
    if (response.writableEnded) return;
    upstreamResponse?.destroy();
    upstream.destroy();
  });

  upstream.on("error", () => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end("Hound is unavailable\n");
  });
  request.on("aborted", () => upstream.destroy());
  if (body) upstream.end(body);
  else request.pipe(upstream);
}

export function createHoundRelay({
  upstreamHost = "hound-firewall",
  upstreamPort = 8765
} = {}) {
  return createServer((request, response) => {
    if (request.url === "/health") {
      upstreamIsHealthy(upstreamHost, upstreamPort).then((healthy) => {
        if (response.destroyed) return;
        const body = `${JSON.stringify({ healthy })}\n`;
        response.writeHead(healthy ? 200 : 503, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body)
        });
        response.end(body);
      });
      return;
    }

    const method = request.method || "GET";
    if (!ALLOWED_METHODS.has(method) || !mcpPathAllowed(request.url)) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
      return;
    }

    if (method !== "POST") {
      forwardRequest(request, response, { upstreamHost, upstreamPort, method });
      return;
    }

    if (
      request.headers["content-encoding"] &&
      request.headers["content-encoding"] !== "identity"
    ) {
      sendPolicyError(
        response,
        new RelayPolicyError(
          "Encoded MCP request bodies are not accepted.",
          415
        )
      );
      return;
    }

    readRequestBody(request)
      .then((rawBody) => {
        let payload;
        try {
          payload = JSON.parse(rawBody.toString("utf8"));
          hardenMcpPayload(payload);
        } catch (error) {
          sendPolicyError(response, error, requestId(payload));
          return;
        }
        const body = Buffer.from(JSON.stringify(payload));
        forwardRequest(request, response, {
          upstreamHost,
          upstreamPort,
          method,
          body
        });
      })
      .catch((error) => sendPolicyError(response, error));
  });
}
