import assert from "node:assert/strict";
import test from "node:test";
import { evaluateDoctorSnapshot } from "../agent-doctor.mjs";

const readySnapshot = {
  nodeVersion: "v24.18.0",
  envFilePresent: true,
  docker: { ok: true, detail: "28.0.0" },
  qualityService: "healthy",
  dirtyPathCount: 0,
  runs: [],
  deepSeekReviewerStatus: "eligible",
  now: Date.parse("2026-08-19T12:00:00.000Z")
};

test("doctor reports a healthy ready harness", () => {
  const report = evaluateDoctorSnapshot(readySnapshot);
  assert.equal(report.healthy, true);
  assert.ok(report.checks.every((entry) => entry.status === "pass"));
});

test("doctor distinguishes startup blockers from operational warnings", () => {
  const report = evaluateDoctorSnapshot({
    ...readySnapshot,
    nodeVersion: "v22.0.0",
    envFilePresent: false,
    docker: { ok: false, detail: "ENOENT" },
    qualityService: "unreachable",
    dirtyPathCount: 4,
    deepSeekReviewerStatus: "eval-required",
    runs: [
      {
        id: "run-stale",
        state: "reviewing",
        updatedAt: "2026-08-19T11:00:00.000Z"
      }
    ]
  });
  assert.equal(report.healthy, false);
  assert.equal(
    report.checks.find((entry) => entry.id === "node").status,
    "fail"
  );
  assert.equal(
    report.checks.find((entry) => entry.id === "quality-mcp").status,
    "warn"
  );
  assert.equal(
    report.checks.find((entry) => entry.id === "managed-runs").status,
    "warn"
  );
});
