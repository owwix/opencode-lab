#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";

const SENSITIVE =
  /(?:^|\/)(?:\.env(?:\..+)?|\.dev\.vars(?:\..+)?|docker\.env|opencode\.env|\.npmrc|\.netrc|[^/]+\.(?:pem|key|p12|pfx))$/iu;

export function parseArgs(argv) {
  const args = argv.slice(2);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith("--") || !args[index + 1])
      throw new Error(
        "Usage: publish.mjs --target TARGET --file RELATIVE_PATH [--title TITLE]"
      );
    values[args[index].slice(2)] = args[index + 1];
  }
  return values;
}

export function resolveFile(root, filePath) {
  const file = resolve(root, filePath ?? "");
  const rel = relative(root, file).replaceAll("\\", "/");
  if (!filePath || !rel || rel.startsWith("../") || SENSITIVE.test(rel)) {
    throw new Error(
      "Only a non-sensitive regular file inside the workspace may be published."
    );
  }
  if (lstatSync(file).isSymbolicLink()) {
    throw new Error(
      "Only a non-sensitive regular file inside the workspace may be published."
    );
  }
  return rel;
}

export function deriveTitle(values, rel) {
  return String(
    values.title ??
      rel
        .split("/")
        .at(-1)
        ?.replace(/\.[^.]+$/u, "") ??
      "Deliverable"
  ).slice(0, 200);
}

export function makeIdempotencyKey(target, rel, markdown) {
  return createHash("sha256")
    .update(`${target}\0${rel}\0${markdown}`)
    .digest("hex");
}

export async function publish({ target, filePath, titleOverride, env, root }) {
  const cwd = root ?? process.cwd();
  const rel = resolveFile(cwd, filePath);
  const markdown = readFileSync(resolve(cwd, rel), "utf8");
  const title = deriveTitle({ title: titleOverride }, rel);
  const idempotencyKey = makeIdempotencyKey(target, rel, markdown);
  const publishUrl =
    env?.NOTION_PUBLISH_URL ?? "http://agent-gateway:8787/notion/publish";
  const response = await fetch(publishUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env?.AGENT_GATEWAY_TOKEN ?? ""}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      target,
      title,
      markdown,
      idempotencyKey
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorMessage =
      typeof body?.error === "string"
        ? body.error
        : body?.error
          ? JSON.stringify(body.error)
          : `Publisher failed (${response.status}).`;
    throw new Error(errorMessage);
  }
  return body;
}

export function formatResult(body) {
  return `${JSON.stringify(
    {
      target: body.target,
      pageId: body.pageId,
      url: body.url,
      duplicate: Boolean(body.duplicate)
    },
    null,
    2
  )}\n`;
}

async function main() {
  const values = parseArgs(process.argv);
  const body = await publish({
    target: values.target,
    filePath: values.file,
    titleOverride: values.title,
    env: process.env
  });
  process.stdout.write(formatResult(body));
}

if (
  process.argv[1] &&
  new URL(import.meta.url).pathname === resolve(process.argv[1])
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
