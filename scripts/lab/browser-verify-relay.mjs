#!/usr/bin/env node
/**
 * Host-only Playwright (or HTTP) verify relay for Lab.
 * OpenCode containers call http://host.docker.internal:3111/verify so Chromium
 * runs on the Mac against loopback 3100/3101/3110.
 */
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { timingSafeEqual } from "node:crypto";

export const BROWSER_PORT = Number(process.env.LAB_BROWSER_PORT ?? "3111");
export const BROWSER_HOST = process.env.LAB_BROWSER_HOST ?? "127.0.0.1";
const PROJECT_ID = process.env.OPENCODE_PROJECT_ID?.trim() ?? null;
const WORKSPACE_HASH = process.env.OPENCODE_WORKSPACE_HASH?.trim() ?? null;

const workspace = resolve(
  process.env.OPENCODE_WORKSPACE || process.env.PWD || process.cwd()
);
const outDir = join(workspace, "artifacts/lab-browser");

function authorized(header, token) {
  if (!token) return false;
  const actual = Buffer.from(String(header ?? ""));
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function httpSmoke(url) {
  const started = Date.now();
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(10_000)
  });
  const text = await response.text();
  const title = text.match(/<title[^>]*>([^<]*)<\/title>/iu)?.[1]?.trim() || "";
  return {
    url,
    ok: response.ok,
    status: response.status,
    title,
    bytes: text.length,
    ms: Date.now() - started,
    mode: "http"
  };
}

async function playwrightSmoke(url) {
  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    return null;
  }
  mkdirSync(outDir, { recursive: true });
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const started = Date.now();
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 20_000
    });
    const title = await page.title();
    const safe = url.replace(/[^\w.-]+/gu, "_").slice(0, 80);
    const shot = join(outDir, `${safe}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    return {
      url,
      ok: Boolean(response?.ok()),
      status: response?.status() ?? 0,
      title,
      screenshot: shot,
      ms: Date.now() - started,
      mode: "playwright"
    };
  } finally {
    await browser.close();
  }
}

export async function verifyUrls(urls) {
  const results = [];
  for (const url of urls) {
    try {
      if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/iu.test(url)) {
        results.push({
          url,
          ok: false,
          error: "Only http://127.0.0.1 and http://localhost URLs are allowed.",
          mode: "denied"
        });
        continue;
      }
      const rich = await playwrightSmoke(url);
      results.push(rich ?? (await httpSmoke(url)));
    } catch (error) {
      results.push({
        url,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        mode: "error"
      });
    }
  }
  return results;
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function startBrowserVerifyRelay({
  host = BROWSER_HOST,
  port = BROWSER_PORT,
  token = process.env.LAB_BROWSER_VERIFY_RELAY_TOKEN?.trim(),
  projectId = PROJECT_ID,
  workspaceHash = WORKSPACE_HASH
} = {}) {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url?.startsWith("/health")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            service: "lab-browser-verify",
            projectId,
            workspaceHash
          })
        );
        return;
      }
      if (req.method === "POST" && req.url?.startsWith("/verify")) {
        if (!authorized(req.headers.authorization, token)) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Authorization required." }));
          return;
        }
        const raw = await readBody(req);
        let body;
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body." }));
          return;
        }
        const urls = Array.isArray(body.urls)
          ? body.urls.map(String)
          : body.url
            ? [String(body.url)]
            : [];
        if (urls.length === 0 || urls.length > 5) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Provide 1-5 urls." }));
          return;
        }
        const results = await verifyUrls(urls);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ results }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found." }));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error)
        })
      );
    }
  });
  server.listen(port, host);
  return server;
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  startBrowserVerifyRelay();
  console.log(
    `Lab browser verify relay on http://${BROWSER_HOST}:${BROWSER_PORT}`
  );
}
