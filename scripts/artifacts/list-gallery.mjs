#!/usr/bin/env node
/**
 * List safe image artifacts under artifacts/marketing for Lab /gallery.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(process.env.OPENCODE_WORKSPACE_CONTAINER || "/workspace");
const marketing = join(root, "artifacts/marketing");
const galleryBase =
  process.env.OPENCODE_GALLERY_URL?.replace(/\/$/u, "") ||
  "http://127.0.0.1:3110";
const IMAGE_EXT = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".svg",
  ".avif",
  ".bmp",
  ".ico"
]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    const lower = entry.name.toLowerCase();
    const dot = lower.lastIndexOf(".");
    if (dot === -1) continue;
    if (!IMAGE_EXT.has(lower.slice(dot))) continue;
    try {
      if (!statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    out.push(relative(root, full).split(/[/\\]/u).join("/"));
  }
  return out;
}

const files = walk(marketing).sort();
if (files.length === 0) {
  console.log("No safe images under artifacts/marketing/ yet.");
  console.log(`Gallery: ${galleryBase}`);
  process.exit(0);
}

console.log(`${files.length} image(s) under artifacts/marketing/`);
console.log(`Gallery: ${galleryBase}`);
for (const file of files.slice(0, 50)) {
  const underMarketing = file.replace(/^artifacts\/marketing\//u, "");
  console.log(`- ${galleryBase}/file/${underMarketing}`);
}
if (files.length > 50) {
  console.log(`… and ${files.length - 50} more`);
}
