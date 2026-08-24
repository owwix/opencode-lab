import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectProjectPreflight,
  ensureLocalGitExcludes,
  LAB_LOCAL_EXCLUDES
} from "./project-preflight.mjs";

function contract(overrides = {}) {
  return {
    schemaVersion: 1,
    install: [{ name: "npm", argv: ["npm", "ci"] }],
    verify: [{ name: "test", argv: ["npm", "test"] }],
    development: [],
    previewPorts: [],
    artifactRoots: [],
    riskLevel: "standard",
    enabledPacks: [],
    ...overrides
  };
}

test("local Lab artifacts use Git info/exclude without touching .gitignore", () => {
  const workspace = mkdtempSync(join(tmpdir(), "lab-preflight-git-"));
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  const first = ensureLocalGitExcludes(workspace);
  const second = ensureLocalGitExcludes(workspace);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  const contents = readFileSync(first.path, "utf8");
  for (const pattern of LAB_LOCAL_EXCLUDES)
    assert.match(contents, new RegExp(pattern.replaceAll("/", "\\/"), "u"));
  assert.equal(existsSync(join(workspace, ".gitignore")), false);
  assert.equal(
    execFileSync("git", ["status", "--porcelain=v1"], {
      cwd: workspace,
      encoding: "utf8"
    }),
    ""
  );
});

test("preflight reports unsupported runtimes and managed-run blockers", () => {
  const responses = new Map([
    ["git rev-parse --show-toplevel", { ok: true, output: "/project" }],
    ["git status --porcelain=v1", { ok: true, output: " M app.py" }],
    [
      "git rev-parse --git-path info/exclude",
      { ok: true, output: ".git/info/exclude" }
    ],
    ["git rev-parse --git-common-dir", { ok: true, output: ".git" }],
    ["lsof -nP -iTCP:3100 -sTCP:LISTEN -Fpc", { ok: false, output: "" }]
  ]);
  const execute = (command, args) =>
    responses.get(`${command} ${args.join(" ")}`) ?? {
      ok: false,
      output: "",
      error: "missing fixture"
    };
  const report = collectProjectPreflight({
    workspace: "/project",
    contract: contract({
      install: [{ name: "python", argv: ["python", "-m", "pip", "install"] }],
      previewPorts: [{ name: "app", container: 3000, host: 3100 }]
    }),
    contractSource: "declared",
    applyExcludes: false,
    execute
  });
  assert.equal(report.healthy, false);
  assert.equal(report.managedEligible, false);
  assert.match(
    report.checks.find((entry) => entry.id === "runtime").summary,
    /Unsupported executable/u
  );
});
