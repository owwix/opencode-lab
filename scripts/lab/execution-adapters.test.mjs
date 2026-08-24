import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  adapterVerificationCommands,
  commandToShell,
  resolveExecutionAdapter
} from "./execution-adapters.mjs";
import { verifyProject } from "./verify.mjs";

function workspace() {
  return mkdtempSync(join(tmpdir(), "opencode-lab-adapter-"));
}

function contract(overrides = {}) {
  return {
    install: [],
    verify: [],
    development: [],
    ...overrides
  };
}

test("node adapter preserves the project contract verification plan", () => {
  const root = workspace();
  writeFileSync(join(root, "package.json"), "{}\n");
  const adapter = resolveExecutionAdapter({
    workspace: root,
    contract: contract({
      install: [{ name: "npm", argv: ["npm", "ci"] }],
      verify: [{ name: "test", argv: ["npm", "run", "test"] }]
    })
  });
  assert.equal(adapter.kind, "node");
  assert.equal(adapter.runtime, "node");
  assert.deepEqual(adapterVerificationCommands(adapter), [
    "'npm' 'run' 'test'"
  ]);
});

test("workspace manifests select the monorepo adapter", () => {
  const root = workspace();
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ workspaces: ["packages/*"] })}\n`
  );
  mkdirSync(join(root, "packages"));
  assert.equal(
    resolveExecutionAdapter({ workspace: root, contract: contract() }).kind,
    "monorepo"
  );
});

test("python projects use the pinned Python adapter", () => {
  const root = workspace();
  writeFileSync(join(root, "pyproject.toml"), "[project]\nname='sample'\n");
  const adapter = resolveExecutionAdapter({
    workspace: root,
    contract: contract({
      verify: [{ name: "test", argv: ["python", "-m", "pytest"], cwd: "tests" }]
    })
  });
  assert.equal(adapter.kind, "python");
  assert.match(adapter.image, /python:3\.12\.11-slim-bookworm@sha256:/u);
  assert.equal(adapter.verify[0].shell, "cd 'tests' && 'python' '-m' 'pytest'");
});

test("command rendering quotes environment and arguments", () => {
  assert.equal(
    commandToShell({
      argv: ["node", "a file.js"],
      env: { MODE: "it's-safe" }
    }),
    `MODE='it'"'"'s-safe' 'node' 'a file.js'`
  );
});

test("local verification consumes the same adapter plan", () => {
  const root = workspace();
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ scripts: { test: "node --test" } })}\n`
  );
  const calls = [];
  const result = verifyProject(root, {
    execute(command, argv, options) {
      calls.push({ command, argv, cwd: options.cwd });
      return { status: 0, stdout: "ok", stderr: "" };
    }
  });
  assert.equal(result.adapter, "node");
  assert.equal(result.passed, true);
  assert.deepEqual(calls[0], {
    command: "sh",
    argv: ["-lc", "'npm' 'run' 'test'"],
    cwd: root
  });
});
