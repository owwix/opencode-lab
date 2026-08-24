import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function markdownFiles(directory) {
  return readdirSync(join(root, directory), { recursive: true })
    .filter((path) => String(path).endsWith(".md"))
    .map((path) => join(directory, String(path)));
}

test("documentation index covers the core architecture and operations", () => {
  const index = read("docs/README.md");
  for (const target of [
    "architecture.md",
    "code-reference.md",
    "cli-reference.md",
    "managed-runs.md",
    "gateway-protocol.md",
    "tutorial.md",
    "project-contract.md",
    "packs.md",
    "strict-mode.md",
    "threat-model.md"
  ]) {
    assert.match(index, new RegExp(`\\(${target.replace(".", "\\.")}\\)`, "u"));
  }
});

test("every core slash command is discoverable in the CLI reference", () => {
  const reference = read("docs/cli-reference.md");
  const commands = readdirSync(join(root, ".opencode/commands"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => `/${name.slice(0, -3)}`);
  for (const command of commands) {
    assert.match(reference, new RegExp(`\\${command}\\b`, "u"), command);
  }
  for (const generated of ["/agents-help", "/workflow", "/runs"]) {
    assert.match(reference, new RegExp(`\\${generated}\\b`, "u"), generated);
  }
});

test("every operator environment setting is documented", () => {
  const reference = read("docs/cli-reference.md");
  const names = [
    ...read("opencode.env.example").matchAll(/^([A-Z][A-Z0-9_]+)=/gmu)
  ].map((match) => match[1]);
  assert.ok(names.length > 0);
  for (const name of names)
    assert.match(reference, new RegExp(`\\b${name}\\b`, "u"), name);
});

test("all repository-local Markdown links resolve", () => {
  const files = [
    "README.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "SUPPORT.md",
    "CHANGELOG.md",
    ...markdownFiles("docs")
  ];
  const missing = [];
  for (const file of files) {
    const source = read(file);
    for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
      const rawTarget = match[1].split("#", 1)[0];
      if (!rawTarget || /^(?:https?:|mailto:)/u.test(rawTarget)) continue;
      const target = resolve(
        root,
        dirname(file),
        decodeURIComponent(rawTarget)
      );
      if (!existsSync(target)) missing.push(`${file}: ${match[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("security-critical modules state their module contract", () => {
  for (const file of [
    "scripts/opencode-entry.mjs",
    "scripts/opencode.mjs",
    "scripts/quality-controller.mjs",
    "scripts/lab/project-contract.mjs",
    "scripts/lab/pack-loader.mjs",
    "scripts/lab/workspace-registry.mjs",
    "scripts/quality/run-service.mjs",
    "docker/agent-gateway/capability-lease.mjs",
    "docker/agent-gateway/gateway.mjs"
  ]) {
    const prefix = read(file).slice(0, 2_500);
    assert.match(prefix, /\/\*\*[\s\S]+?\*\//u, file);
  }
});
