import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

test("secret scan workflow covers all pushed branches and tags with pinned actions", () => {
  const workflow = readFileSync(
    path.join(root, ".github/workflows/secret-history.yml"),
    "utf8"
  );
  assert.match(workflow, /branches:\s*\["\*\*"\]/);
  assert.match(workflow, /tags:\s*\["\*\*"\]/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.doesNotMatch(workflow, /uses:\s*[^\s]+@(v\d+|main|master)\b/);
  assert.match(workflow, /gitleaks\/gitleaks-action@[0-9a-f]{40}/);
  assert.match(workflow, /trufflesecurity\/trufflehog@[0-9a-f]{40}/);
});

test("local history gate explicitly scans all refs", () => {
  const scanner = readFileSync(
    path.join(root, "scripts/release/scan-history.mjs"),
    "utf8"
  );
  assert.match(scanner, /--log-opts=--all/);
  assert.match(scanner, /--exit-code=1/);
  assert.match(scanner, /refs\/heads/);
  assert.match(scanner, /refs\/remotes/);
  assert.match(scanner, /refs\/tags/);
  assert.match(scanner, /--results=verified,unknown/);
});

test("Gitleaks allowlist is limited to one fixed unit-test value", () => {
  const config = readFileSync(path.join(root, ".gitleaks.toml"), "utf8");
  assert.match(config, /targetRules = \["generic-api-key"\]/);
  assert.match(config, /\^test-capability-signing-key-at-least-32-bytes\$/);
  assert.doesNotMatch(config, /paths\s*=/);
});

test("unverifiable copied theme and banner assets are absent", () => {
  const inventory = JSON.parse(
    readFileSync(path.join(root, "provenance/files.json"), "utf8")
  );
  const paths = new Set(inventory.files.map((entry) => entry.path));
  assert.equal(
    [...paths].some((file) => file.startsWith(".opencode/themes/")),
    false
  );
  assert.equal(paths.has("npm-agents-banner.svg"), false);
});
