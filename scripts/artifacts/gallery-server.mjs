#!/usr/bin/env node
/**
 * Loopback-only gallery for image artifacts under artifacts/marketing.
 * Serves HTML index + image files; never leaves that directory.
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const GALLERY_PORT = Number(process.env.OPENCODE_GALLERY_PORT ?? "3110");
export const GALLERY_HOST = process.env.OPENCODE_GALLERY_HOST ?? "127.0.0.1";
const PROJECT_ID = process.env.OPENCODE_PROJECT_ID?.trim() ?? null;
const WORKSPACE_HASH = process.env.OPENCODE_WORKSPACE_HASH?.trim() ?? null;

const IMAGE_EXT = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".ico", "image/x-icon"]
]);

export function marketingRoot(workspaceRoot) {
  return resolve(workspaceRoot, "artifacts/marketing");
}

function walkImages(dir, root, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkImages(full, root, out);
      continue;
    }
    const ext = extname(entry.name).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;
    try {
      if (!statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    out.push(relative(root, full).split(sep).join("/"));
  }
  return out;
}

export function resolveSafeMarketingFile(workspaceRoot, requestPath) {
  const root = marketingRoot(workspaceRoot);
  const decoded = decodeURIComponent(requestPath.split("?")[0] ?? "");
  const cleaned = decoded.replace(/^\/+/u, "");
  if (!cleaned || cleaned.includes("\0")) return null;
  const full = resolve(root, cleaned);
  const rel = relative(root, full);
  if (
    rel.startsWith("..") ||
    rel.includes(`..${sep}`) ||
    normalize(rel) !== rel
  ) {
    return null;
  }
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  const ext = extname(full).toLowerCase();
  if (!IMAGE_EXT.has(ext)) return null;
  return {
    full,
    rel: rel.split(sep).join("/"),
    contentType: IMAGE_EXT.get(ext)
  };
}

function renderIndex(files, host, port) {
  const items = files
    .map(
      (file) =>
        `<li><a href="/file/${encodeURI(file)}" target="_blank" rel="noopener"><img src="/file/${encodeURI(file)}" alt="${file}" loading="lazy"/><span>${file}</span></a></li>`
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Lab gallery</title>
<style>
  :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; }
  body { margin: 1.5rem; background: #f4f4f1; color: #1a1a1a; }
  h1 { font-size: 1.25rem; margin: 0 0 0.25rem; }
  p { margin: 0 0 1.25rem; color: #555; }
  ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
  a { display: grid; gap: 0.5rem; color: inherit; text-decoration: none; }
  img { width: 100%; height: 160px; object-fit: cover; background: #ddd; border-radius: 6px; }
  span { font-size: 0.8rem; word-break: break-all; }
</style>
</head>
<body>
  <h1>Lab gallery</h1>
  <p>${files.length} image(s) from artifacts/marketing · http://${host}:${port}</p>
  <ul>
    ${items || "<li>No images yet.</li>"}
  </ul>
</body>
</html>`;
}

export function createGalleryServer(
  workspaceRoot,
  {
    port = GALLERY_PORT,
    host = GALLERY_HOST,
    projectId = PROJECT_ID,
    workspaceHash = WORKSPACE_HASH
  } = {}
) {
  const root = marketingRoot(workspaceRoot);
  const server = createServer((request, response) => {
    const address = server.address();
    const boundPort =
      address && typeof address === "object" ? address.port : port;
    const url = new URL(request.url ?? "/", `http://${host}:${boundPort}`);
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end("Method not allowed");
      return;
    }
    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        `${JSON.stringify({
          ok: true,
          service: "lab-gallery",
          projectId,
          workspaceHash
        })}\n`
      );
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const files = walkImages(root, root).sort();
      const body = renderIndex(files, host, boundPort);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      response.end(body);
      return;
    }
    if (url.pathname.startsWith("/file/")) {
      const safe = resolveSafeMarketingFile(
        workspaceRoot,
        url.pathname.slice("/file/".length)
      );
      if (!safe) {
        response.writeHead(404).end("Not found");
        return;
      }
      response.writeHead(200, { "content-type": safe.contentType });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      createReadStream(safe.full).pipe(response);
      return;
    }
    response.writeHead(404).end("Not found");
  });
  return {
    server,
    root,
    listen: () =>
      new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(port, host, () => {
          const address = server.address();
          resolveListen({
            host,
            port: address && typeof address === "object" ? address.port : port
          });
        });
      })
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const workspace = resolve(process.env.OPENCODE_WORKSPACE || process.cwd());
  const gallery = createGalleryServer(workspace);
  gallery.listen().then(({ host, port }) => {
    console.log(`Lab gallery on http://${host}:${port} (${gallery.root})`);
  });
}
