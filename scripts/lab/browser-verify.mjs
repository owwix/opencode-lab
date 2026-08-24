#!/usr/bin/env node
/**
 * Verify Lab preview URLs. Prefers:
 * 1) Scoped agent-gateway browser relay
 * 2) Local Playwright when installed
 * 3) HTTP + HTML smoke
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_TARGETS = [
  process.env.LAB_PREVIEW_URL || "http://127.0.0.1:3100",
  process.env.LAB_PREVIEW_URL_ALT || "http://127.0.0.1:3101"
].filter(Boolean);

const targets = (
  process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TARGETS
).filter(Boolean);

function relayCandidates() {
  const configured = process.env.LAB_BROWSER_RELAY_URL?.trim();
  const list = [];
  if (configured) list.push(configured.replace(/\/$/u, ""));
  const gateway = process.env.WORKERS_AI_GATEWAY_URL?.trim();
  if (gateway) list.push(`${gateway.replace(/\/$/u, "")}/browser`);
  return [...new Set(list)];
}

async function viaRelay(urls) {
  for (const base of relayCandidates()) {
    try {
      const response = await fetch(`${base}/verify`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.AGENT_GATEWAY_TOKEN ?? ""}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ urls }),
        signal: AbortSignal.timeout(60_000)
      });
      if (!response.ok) continue;
      const payload = await response.json();
      if (Array.isArray(payload.results)) {
        return payload.results.map((row) => ({ ...row, relay: base }));
      }
    } catch {
      // try next candidate
    }
  }
  return null;
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

async function playwrightSmoke(url, outDir) {
  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    return null;
  }
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

const outDir = resolve(
  process.env.OPENCODE_WORKSPACE_CONTAINER ||
    process.env.OPENCODE_WORKSPACE ||
    process.cwd(),
  "artifacts/lab-browser"
);
mkdirSync(outDir, { recursive: true });

// Map container-facing preview names to Mac loopback for the host relay.
const relayUrls = targets.map((url) => {
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname === "host.docker.internal" ||
      parsed.hostname === "opencode-preview"
    ) {
      parsed.hostname = "127.0.0.1";
      return parsed.toString().replace(/\/$/u, "") || parsed.origin;
    }
  } catch {
    // keep original
  }
  return url;
});

let results = await viaRelay(relayUrls);
const forceHttp = process.env.LAB_BROWSER_HTTP_ONLY === "1";
if (!results) {
  results = [];
  for (const url of targets) {
    try {
      if (forceHttp) {
        results.push(await httpSmoke(url));
        continue;
      }
      const rich = await playwrightSmoke(url, outDir);
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
}

console.log(JSON.stringify({ results }, null, 2));
process.exitCode = results.some((row) => !row.ok) ? 1 : 0;
