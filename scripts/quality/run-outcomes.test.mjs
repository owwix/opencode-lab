import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  deriveRunOutcome,
  recordRunOutcome,
  summarizeOperationalMetrics
} from "./run-outcomes.mjs";

function run(overrides = {}) {
  return {
    id: "run-1",
    traceId: "trace-1",
    state: "passed",
    headSha: "abc",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:10.000Z",
    changedFiles: ["a.js", "b.js"],
    timeline: [
      { from: "verifying", to: "reviewing", at: "2026-01-01T00:00:05.000Z" }
    ],
    telemetry: { cost: 2, usageTelemetryObserved: true },
    verification: { passed: true, evidenceDigest: "verify" },
    review: { evidenceDigest: "review" },
    approvals: [],
    publishing: { pr: { url: "https://example.test/pr/1" } },
    ...overrides
  };
}

test("immutable outcomes bind operational metrics to a run", () => {
  const root = mkdtempSync(join(tmpdir(), "run-outcome-"));
  const first = recordRunOutcome({ root, run: run() });
  const second = recordRunOutcome({ root, run: run() });
  assert.deepEqual(second, first);
  assert.equal(first.timeToVerifiedMs, 5000);
  assert.equal(first.costPerVerifiedChange, 1);
  assert.equal(first.prConverted, true);
  const [receipt] = readdirSync(join(root, "runs/run-1/outcomes"));
  assert.equal(
    JSON.parse(readFileSync(join(root, "runs/run-1/outcomes", receipt), "utf8"))
      .receiptHash,
    first.receiptHash
  );
});

test("a resumed run records a new immutable terminal outcome", () => {
  const root = mkdtempSync(join(tmpdir(), "run-outcome-resume-"));
  recordRunOutcome({
    root,
    run: run({
      state: "failed",
      timeline: [
        {
          from: "verifying",
          to: "failed",
          at: "2026-01-01T00:00:06.000Z"
        }
      ]
    })
  });
  recordRunOutcome({ root, run: run() });
  assert.equal(readdirSync(join(root, "runs/run-1/outcomes")).length, 2);
});

test("operational summary tracks rework, infrastructure, approvals, and PR conversion", () => {
  const failed = run({
    id: "run-2",
    state: "failed",
    verification: { passed: false },
    publishing: null,
    timeline: [
      { from: "failed", to: "verifying", at: "2026-01-01T00:00:04.000Z" },
      {
        from: "verifying",
        to: "failed",
        at: "2026-01-01T00:00:06.000Z",
        detail: "Docker gateway timeout"
      }
    ],
    approvals: [
      {
        requestedAt: "2026-01-01T00:00:01.000Z",
        resolvedAt: "2026-01-01T00:00:03.000Z"
      }
    ]
  });
  const summary = summarizeOperationalMetrics([run(), failed]);
  assert.equal(summary.rework, 1);
  assert.equal(summary.infrastructureFailures, 1);
  assert.equal(summary.approvalWaitMs, 2000);
  assert.equal(summary.prConversions, 1);
});

test("outcome hashes are stable for the same run record", () => {
  assert.equal(
    deriveRunOutcome(run()).receiptHash,
    deriveRunOutcome(run()).receiptHash
  );
});
