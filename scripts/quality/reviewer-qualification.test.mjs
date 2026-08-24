import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  promoteReviewer,
  qualifyReviewerReport
} from "./reviewer-qualification.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "reviewer-qualification-"));
  writeFileSync(join(root, "evidence.json"), "{}\n");
  const reportPath = join(root, "report.json");
  writeFileSync(
    reportPath,
    `${JSON.stringify({
      schemaVersion: 1,
      candidate: { model: "provider/reviewer", family: "independent" },
      results: { runs: 5, accuracy: 0.9, taskCompletion: 1 },
      evidenceFiles: ["evidence.json"]
    })}\n`
  );
  const policyPath = join(root, "policy.json");
  writeFileSync(
    policyPath,
    `${JSON.stringify({
      promotionPolicy: { minimumRuns: 3, minimumGoldenAccuracy: 0.8 },
      reviewPolicy: {
        reviewerCandidates: [
          {
            model: "provider/reviewer",
            family: "independent",
            status: "eval-required",
            evidence: null
          }
        ]
      }
    })}\n`
  );
  return { root, reportPath, policyPath };
}

test("qualification requires evidence-backed passing trials", () => {
  const { reportPath } = fixture();
  const result = qualifyReviewerReport(reportPath);
  assert.equal(result.passed, true);
  assert.equal(result.runs, 5);
  assert.match(result.digest, /^[a-f0-9]{64}$/u);
});

test("promotion is a manual, attributable operation", () => {
  const { reportPath, policyPath } = fixture();
  assert.throws(
    () => promoteReviewer({ reportPath, policyPath, actor: "operator" }),
    /explicit --approve/u
  );
  const promoted = promoteReviewer({
    reportPath,
    policyPath,
    approved: true,
    actor: "operator",
    now: new Date("2026-01-01T00:00:00.000Z")
  });
  assert.equal(promoted.status, "eligible");
  assert.equal(promoted.evidence.approvedBy, "operator");
  assert.equal(
    JSON.parse(readFileSync(policyPath, "utf8")).reviewPolicy
      .reviewerCandidates[0].status,
    "eligible"
  );
});
