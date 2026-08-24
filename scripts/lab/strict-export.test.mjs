import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { adoptStrictRun, exportStrictRun } from "./strict-export.mjs";
import { projectIdentity } from "./workspace-registry.mjs";

function command(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function fixture() {
  const source = mkdtempSync(join(tmpdir(), "strict-export-source-"));
  command("git", ["init", "-b", "main", source]);
  command("git", ["-C", source, "config", "user.name", "Test"]);
  command("git", [
    "-C",
    source,
    "config",
    "user.email",
    "test@example.invalid"
  ]);
  writeFileSync(join(source, "README.md"), "base\n");
  command("git", ["-C", source, "add", "README.md"]);
  command("git", ["-C", source, "commit", "-m", "base"]);
  const baseSha = command("git", ["-C", source, "rev-parse", "HEAD"]);
  const sandbox = mkdtempSync(join(tmpdir(), "strict-export-sandbox-"));
  command("git", ["clone", "--quiet", source, sandbox]);
  command("git", ["-C", sandbox, "config", "user.name", "Agent"]);
  command("git", [
    "-C",
    sandbox,
    "config",
    "user.email",
    "agent@example.invalid"
  ]);
  writeFileSync(join(sandbox, "README.md"), "base\nstrict change\n");
  mkdirSync(join(sandbox, "artifacts"));
  writeFileSync(join(sandbox, "artifacts", "result.txt"), "artifact\n");
  command("git", ["-C", sandbox, "add", "README.md"]);
  command("git", ["-C", sandbox, "commit", "-m", "implementation"]);

  const stateRoot = mkdtempSync(join(tmpdir(), "strict-export-state-"));
  const runId = "strict_aaaaaaaaaaaa";
  const directory = join(stateRoot, "strict", "runs", runId);
  mkdirSync(directory, { recursive: true });
  const identity = projectIdentity(source);
  writeFileSync(
    join(directory, "run.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      runId,
      sandboxName: "lab-project-aaaaaaaaaaaa",
      sandboxWorkspace: sandbox,
      source,
      projectId: identity.projectId,
      workspaceHash: identity.workspaceHash,
      baseSha
    })}\n`
  );
  const envDirectory = mkdtempSync(join(tmpdir(), "strict-export-env-"));
  const envFile = join(envDirectory, "opencode.env");
  writeFileSync(
    envFile,
    "STRICT_EXPORT_SIGNING_KEY=strict-export-test-key-with-32-bytes-minimum\n"
  );
  const runner = (program, args, options = {}) => {
    if (program === "sbx" && args[0] === "exec") {
      return command(args[2], args.slice(3), options);
    }
    if (program === "sbx" && args[0] === "cp") {
      const sourcePath = args[1].slice(args[1].indexOf(":") + 1);
      cpSync(sourcePath, args[2], { recursive: true });
      return "";
    }
    return command(program, args, options);
  };
  return { source, stateRoot, runId, envFile, runner, directory };
}

test("strict export signs a bounded bundle and adoption creates an exact clean commit", () => {
  const value = fixture();
  const exported = exportStrictRun(value);
  assert.deepEqual(exported.manifest.changedFiles, ["README.md"]);
  assert.ok(
    exported.manifest.files.some(({ path }) => path === "changes.patch")
  );
  assert.ok(
    exported.manifest.files.some(({ path }) => path === "artifacts/result.txt")
  );

  const receipt = adoptStrictRun({ ...value, approved: true });
  assert.match(receipt.commitSha, /^[a-f0-9]{40}$/u);
  assert.equal(
    readFileSync(join(value.source, "README.md"), "utf8"),
    "base\nstrict change\n"
  );
  assert.equal(
    command("git", ["-C", value.source, "status", "--porcelain=v1"]),
    ""
  );
  assert.deepEqual(adoptStrictRun({ ...value, approved: true }), receipt);
});

test("strict adoption rejects a tampered signed bundle", () => {
  const value = fixture();
  exportStrictRun(value);
  appendFileSync(
    join(value.directory, "export", "changes.patch"),
    "tampered\n"
  );
  assert.throws(
    () => adoptStrictRun({ ...value, approved: true }),
    /failed verification/u
  );
});

test("strict adoption requires explicit approval", () => {
  assert.throws(
    () => adoptStrictRun({ runId: "strict_aaaaaaaaaaaa" }),
    /--approve/u
  );
});
