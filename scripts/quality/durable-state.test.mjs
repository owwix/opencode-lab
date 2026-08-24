import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkpointRun,
  claimJob,
  enqueueJob,
  finishJob,
  listApprovals,
  listCheckpoints,
  listJobs,
  putMemory,
  readTrace,
  recordTraceEvent,
  replayCheckpoint,
  requestApproval,
  retryJob,
  resolveApproval,
  searchMemory,
  workspacePolicy
} from "./durable-state.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "durable-quality-"));
  const workspace = join(root, "workspace");
  return { root, workspace };
}

test("checkpoints chain and replay validates integrity", () => {
  const { root, workspace } = fixture();
  try {
    const run = {
      id: "run_fixture",
      revision: 1,
      state: "implementing",
      task: "fixture",
      agent: "lab",
      model: "fixture-model",
      route: {},
      workspace,
      branch: "fixture",
      baseSha: "a".repeat(40),
      headSha: "a".repeat(40),
      changedFiles: ["README.md"],
      requirements: {},
      verification: null,
      implementationResult: null,
      review: null,
      telemetry: {},
      approvals: [],
      memory: []
    };
    checkpointRun({ root, run, reason: "first" });
    run.revision = 2;
    run.state = "verifying";
    checkpointRun({ root, run, reason: "second" });
    assert.equal(listCheckpoints({ root, runId: run.id }).length, 2);
    assert.equal(
      replayCheckpoint({ root, runId: run.id, sequence: 1 }).state,
      "implementing"
    );
    const path = join(root, "runs", run.id, "checkpoints", "000001.json");
    const tampered = JSON.parse(readFileSync(path, "utf8"));
    tampered.state = "passed";
    writeFileSync(path, `${JSON.stringify(tampered)}\n`);
    assert.throws(
      () => replayCheckpoint({ root, runId: run.id, sequence: 1 }),
      /integrity/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trace and approvals are redacted and restart-safe", () => {
  const { root } = fixture();
  try {
    const event = recordTraceEvent({
      root,
      runId: "run_trace",
      type: "tool.result",
      data: { authorization: "secret", value: "cf_12345678901234567890" }
    });
    assert.equal(event.data.authorization, "[REDACTED]");
    assert.equal(event.data.value, "[REDACTED_TOKEN]");
    assert.match(
      readFileSync(join(root, "traces", "events.jsonl"), "utf8"),
      /tool\.result/u
    );
    const approval = requestApproval({
      root,
      runId: "run_trace",
      phase: "implementation",
      action: "write staged file",
      reason: "fixture"
    });
    assert.equal(
      listApprovals({ root, runId: "run_trace", status: "pending" }).length,
      1
    );
    resolveApproval({
      root,
      approvalId: approval.id,
      decision: "approved",
      actor: "test"
    });
    assert.equal(
      listApprovals({ root, runId: "run_trace", status: "approved" }).length,
      1
    );
    assert.ok(readTrace({ root, runId: "run_trace" }).length >= 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("queue deduplicates active work and claims by priority", () => {
  const { root } = fixture();
  try {
    const first = enqueueJob({
      root,
      kind: "research",
      priority: 10,
      dedupeKey: "same"
    });
    const duplicate = enqueueJob({
      root,
      kind: "research",
      priority: 99,
      dedupeKey: "same"
    });
    assert.equal(duplicate.id, first.id);
    const second = enqueueJob({ root, kind: "verify", priority: 50 });
    assert.equal(claimJob({ root, workerId: "test" }).id, second.id);
    assert.equal(
      listJobs({ root }).find((job) => job.id === second.id).attempts,
      1
    );
    finishJob({ root, jobId: second.id, status: "completed" });
    assert.equal(listJobs({ root, status: "completed" }).length, 1);
    const retryable = enqueueJob({ root, kind: "retryable", maxAttempts: 2 });
    claimJob({ root, workerId: "test" });
    finishJob({
      root,
      jobId: retryable.id,
      status: "failed",
      error: "temporary"
    });
    assert.equal(retryJob({ root, jobId: retryable.id }).status, "queued");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("memory is searchable and workspace policy is bounded", () => {
  const { root, workspace } = fixture();
  try {
    const item = putMemory({
      root,
      workspace,
      text: "The project uses signed execution envelopes",
      tags: ["architecture"]
    });
    assert.equal(
      searchMemory({ root, workspace, query: "envelopes" })[0].id,
      item.id
    );
    assert.throws(
      () => putMemory({ root, workspace, text: "cf_12345678901234567890" }),
      /credential-shaped/u
    );
    assert.equal(
      workspacePolicy({ workspace, roots: [root] }).workspace,
      workspace
    );
    assert.throws(
      () =>
        workspacePolicy({ workspace: join(root, "../outside"), roots: [root] }),
      /outside/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
