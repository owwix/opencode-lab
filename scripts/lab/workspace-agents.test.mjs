import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

const RESERVED = [
  "fast",
  "lab",
  "deep",
  "plan",
  "reviewer",
  "dispatcher",
  "research"
];

test("Lab leaves project config discovery enabled for workspace agents", () => {
  const compose = read("docker-compose.opencode.yml");
  assert.doesNotMatch(compose, /OPENCODE_DISABLE_PROJECT_CONFIG/u);
  assert.match(compose, /OPENCODE_CONFIG_DIR: \/opencode-config\/\.opencode/u);
  assert.match(
    compose,
    /working_dir: \$\{OPENCODE_WORKSPACE_CONTAINER:-\/workspace\}/u
  );
});

test("only generic agents are shipped in the Lab harness", () => {
  for (const name of RESERVED) {
    assert.equal(
      existsSync(resolve(root, `.opencode/agents/${name}.md`)),
      true,
      name
    );
  }
});

test("workspace-agents contract is documented", () => {
  const doc = read("docs/lab/workspace-agents.md");
  assert.match(doc, /OPENCODE_CONFIG_DIR/u);
  assert.match(doc, /Reserved harness names/u);
  for (const name of RESERVED) {
    assert.match(doc, new RegExp(`\`${name}\``, "u"));
  }
  assert.match(doc, /versioned packs/iu);
});
