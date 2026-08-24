import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { synthesizeParallel } from "./parallel-synthesis.mjs";

test("parallel synthesis detects conflicts without merging", () => {
  const root = mkdtempSync(join(tmpdir(), "parallel-quality-"));
  try {
    for (const [id, files] of [
      ["run_a", ["src/a.ts"]],
      ["run_b", ["src/a.ts"]]
    ]) {
      mkdirSync(join(root, "runs", id), { recursive: true });
      writeFileSync(
        join(root, "runs", id, "run.json"),
        `${JSON.stringify({
          id,
          task: "parallel fixture",
          agent: "lab",
          model: "fixture",
          state: "passed",
          workspace: `/tmp/${id}`,
          headSha: "a".repeat(40),
          changedFiles: files,
          verification: { passed: true },
          review: { passed: true },
          artifacts: {}
        })}\n`
      );
    }
    const result = synthesizeParallel({
      root,
      groupId: "group_fixture",
      runIds: ["run_a", "run_b"]
    });
    assert.equal(result.status, "conflict");
    assert.equal(
      result.mergePolicy,
      "operator-approved-only; no automatic merge"
    );
    assert.equal(result.conflicts[0].file, "src/a.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed parallel members cannot produce a ready synthesis", () => {
  const root = mkdtempSync(join(tmpdir(), "parallel-quality-failed-"));
  try {
    for (const [id, state, files] of [
      ["run_passed", "passed", ["src/a.ts"]],
      ["run_failed", "failed", ["src/b.ts"]]
    ]) {
      mkdirSync(join(root, "runs", id), { recursive: true });
      writeFileSync(
        join(root, "runs", id, "run.json"),
        `${JSON.stringify({
          id,
          task: "parallel failure fixture",
          agent: "lab",
          model: "fixture",
          state,
          workspace: `/tmp/${id}`,
          headSha: "b".repeat(40),
          changedFiles: files,
          verification: { passed: state === "passed" },
          review: { passed: state === "passed" },
          artifacts: {}
        })}\n`
      );
    }
    const result = synthesizeParallel({
      root,
      groupId: "group_failed",
      runIds: ["run_passed", "run_failed"]
    });
    assert.equal(result.status, "failed");
    assert.deepEqual(result.failed, [{ id: "run_failed", state: "failed" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
