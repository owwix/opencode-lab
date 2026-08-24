import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createDeletionPlan,
  executeDeletionPlan
} from "../security/safe-remove.mjs";

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "safe-remove-workspace-"));
  const temporaryRoot = mkdtempSync(join(tmpdir(), "safe-remove-plans-"));
  return { workspace, temporaryRoot };
}

test("rejects ambiguous, absolute, root, and missing targets", () => {
  const context = fixture();
  for (const targets of [
    [],
    ["."],
    [context.workspace],
    ["../outside"],
    ["missing"]
  ]) {
    assert.throws(() => createDeletionPlan(targets, context));
  }
});

test("plans exact targets then moves them into a fresh recoverable directory", () => {
  const context = fixture();
  writeFileSync(join(context.workspace, "owned.txt"), "keep recoverable\n");
  const plan = createDeletionPlan(["owned.txt"], context);

  assert.equal(plan.targets[0].path, "owned.txt");
  assert.equal(plan.targets[0].kind, "file");
  assert.equal(existsSync(join(context.workspace, "owned.txt")), true);

  const result = executeDeletionPlan(plan.planPath, context);
  assert.equal(existsSync(join(context.workspace, "owned.txt")), false);
  assert.equal(
    readFileSync(join(result.recoveryRoot, "owned.txt"), "utf8"),
    "keep recoverable\n"
  );
  assert.equal(existsSync(result.manifestPath), true);
  assert.match(result.recoveryRoot, /\.agent-trash\/deletion-/u);
});

test("fails closed if a target changes after the plan", () => {
  const context = fixture();
  const target = join(context.workspace, "owned.txt");
  writeFileSync(target, "first\n");
  const plan = createDeletionPlan(["owned.txt"], context);
  writeFileSync(target, "changed after review\n");

  assert.throws(
    () => executeDeletionPlan(plan.planPath, context),
    /changed after approval/u
  );
  assert.equal(readFileSync(target, "utf8"), "changed after review\n");
});

test("rejects overlapping targets before writing a plan", () => {
  const context = fixture();
  const directory = join(context.workspace, "owned");
  mkdirSync(directory);
  writeFileSync(join(directory, "child.txt"), "x");
  assert.throws(
    () => createDeletionPlan(["owned", "owned/child.txt"], context),
    /overlap/u
  );
  assert.equal(existsSync(directory), true);
});

test("each execution receives a distinct fresh recovery directory", () => {
  const context = fixture();
  writeFileSync(join(context.workspace, "one.txt"), "one");
  writeFileSync(join(context.workspace, "two.txt"), "two");
  const first = executeDeletionPlan(
    createDeletionPlan(["one.txt"], context).planPath,
    context
  );
  const second = executeDeletionPlan(
    createDeletionPlan(["two.txt"], context).planPath,
    context
  );
  assert.notEqual(first.recoveryRoot, second.recoveryRoot);
});

test("moves a broken symlink itself without following its target", () => {
  const context = fixture();
  symlinkSync(
    "../outside-does-not-exist",
    join(context.workspace, "broken-link")
  );
  const result = executeDeletionPlan(
    createDeletionPlan(["broken-link"], context).planPath,
    context
  );
  assert.throws(() => lstatSync(join(context.workspace, "broken-link")), {
    code: "ENOENT"
  });
  assert.equal(existsSync(join(result.recoveryRoot, "broken-link")), false);
  assert.equal(
    lstatSync(join(result.recoveryRoot, "broken-link")).isSymbolicLink(),
    true
  );
});
