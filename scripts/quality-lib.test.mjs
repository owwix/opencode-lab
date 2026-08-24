import assert from "node:assert/strict";
import test from "node:test";
import {
  assertTransition,
  buildBranchName,
  evaluateRiskGate,
  evaluateReleaseGate,
  inferRequirements,
  selectPackageCommands,
  selectModelRoute,
  selectReviewerRoutes,
  slugify,
  summarizeRuns
} from "./quality-lib.mjs";

test("slugify and branch names remain bounded and shell-safe", () => {
  assert.equal(slugify(" Fix Layout / Spacing! "), "fix-layout-spacing");
  assert.match(
    buildBranchName("Visual Agent", "Fix spacing", "20260818T010101Z-abcdef"),
    /^agent\//u
  );
});

test("requirements derive deterministic trust and artifact gates from changed paths", () => {
  assert.deepEqual(
    inferRequirements([
      "app/presentation/Slides.tsx",
      "migrations/0042_auth_sessions.sql",
      ".github/workflows/deploy.yml"
    ]),
    {
      visual: true,
      security: true,
      migration: true,
      deployment: true
    }
  );
});

test("requirements also detect security and deployment semantics in diffs", () => {
  const requirements = inferRequirements(
    ["src/config.ts"],
    "+ const token = request.headers.get('authorization');\n+ wrangler deploy"
  );
  assert.equal(requirements.security, true);
  assert.equal(requirements.deployment, true);
});

test("package command selection prefers project and release checks", () => {
  const packageJson = {
    scripts: {
      check: "check",
      "check:release": "release",
      test: "test"
    }
  };
  assert.deepEqual(selectPackageCommands(packageJson, {}, {}), [
    "npm run check"
  ]);
  assert.deepEqual(selectPackageCommands(packageJson, {}, { release: true }), [
    "npm run check:release"
  ]);
});

test("release gate requires exact-SHA verification, review, cleanliness, and visual evidence", () => {
  const base = {
    state: "passed",
    headSha: "abc",
    clean: true,
    changedFiles: ["app/page.tsx"],
    implementationCheckpoint: {
      passed: true,
      contentSha: "abc",
      headSha: "abc",
      changedFiles: ["app/page.tsx"]
    },
    requirements: { visual: true, migration: false },
    artifacts: { visual: ["contact-sheet.png"] },
    verification: { passed: true, sha: "abc" },
    review: { passed: true, sha: "abc", distinctFromImplementation: true }
  };
  assert.deepEqual(evaluateReleaseGate(base), { passed: true, blockers: [] });
  assert.match(
    evaluateReleaseGate({ ...base, artifacts: { visual: [] } }).blockers[0],
    /rendered/u
  );
  assert.match(
    evaluateReleaseGate({
      ...base,
      requirements: { visual: false, migration: true },
      artifacts: { visual: [], migrationPlan: null }
    }).blockers[0],
    /migration/u
  );
  assert.match(
    evaluateReleaseGate({
      ...base,
      requirements: { visual: false, migration: false },
      artifacts: { visual: [], contractEvidence: null },
      contract: { name: "research" }
    }).blockers[0],
    /research quality-contract/u
  );
});

test("invalid lifecycle transitions are rejected", () => {
  assert.doesNotThrow(() => assertTransition("prepared", "implementing"));
  assert.doesNotThrow(() => assertTransition("failed", "implementing"));
  assert.doesNotThrow(() => assertTransition("implementing", "cancelled"));
  assert.doesNotThrow(() => assertTransition("cancelled", "archived"));
  assert.doesNotThrow(() => assertTransition("passed", "archived"));
  assert.throws(() => assertTransition("prepared", "passed"), /Invalid/u);
  assert.throws(() => assertTransition("archived", "passed"), /Invalid/u);
});

test("high-risk review fails closed without an eligible independent family", () => {
  const implementationModel = "provider/kimi";
  const policy = {
    defaultModel: implementationModel,
    rules: [{ agent: "reviewer", model: implementationModel }],
    reviewPolicy: {
      levels: {
        standard: { minimumReviewers: 1, minimumDistinctModelFamilies: 1 },
        high: { minimumReviewers: 2, minimumDistinctModelFamilies: 2 }
      },
      reviewerCandidates: [
        {
          model: implementationModel,
          family: "kimi",
          status: "eligible"
        },
        {
          model: "provider/independent",
          family: "independent",
          status: "eval-required"
        }
      ]
    }
  };
  assert.throws(
    () =>
      selectReviewerRoutes(
        "change auth",
        { security: true, deployment: false },
        policy,
        implementationModel
      ),
    /only 0 reviewer/u
  );
  policy.reviewPolicy.reviewerCandidates[1].status = "eligible";
  policy.reviewPolicy.reviewerCandidates.push({
    model: "provider/independent-2",
    family: "independent-2",
    status: "eligible"
  });
  const reviewers = selectReviewerRoutes(
    "change auth",
    { security: true, deployment: false },
    policy,
    implementationModel
  );
  assert.equal(reviewers.length, 2);
  assert.ok(reviewers.every((reviewer) => reviewer.distinctFromImplementation));
});

test("standard review also excludes the implementation model", () => {
  assert.throws(
    () =>
      selectReviewerRoutes(
        "change copy",
        { security: false, deployment: false },
        {
          defaultModel: "provider/builder",
          reviewPolicy: {
            levels: {
              standard: {
                minimumReviewers: 1,
                minimumDistinctModelFamilies: 1
              }
            },
            reviewerCandidates: [
              {
                model: "provider/builder",
                family: "builder",
                status: "eligible"
              }
            ]
          }
        },
        "provider/builder"
      ),
    /after excluding the implementation model/u
  );
});

test("security and deployment release gates require evidence and reviewer independence", () => {
  const run = {
    requirements: { security: true, deployment: false },
    review: {
      distinctFromImplementation: true,
      riskEvidence: {
        security: { status: "pass", evidence: ["security tests passed"] }
      }
    }
  };
  assert.deepEqual(evaluateRiskGate(run), { passed: true, blockers: [] });
  assert.match(
    evaluateRiskGate({
      ...run,
      review: { ...run.review, distinctFromImplementation: false }
    }).blockers[0],
    /distinct/u
  );
  assert.match(
    evaluateRiskGate({
      ...run,
      review: {
        ...run.review,
        riskEvidence: { security: { status: "pass", evidence: [] } }
      }
    }).blockers[0],
    /no concrete evidence/u
  );
});

test("model routing applies the first matching policy rule", () => {
  const policy = {
    defaultModel: "default",
    rules: [
      { agent: "research", model: "research-model" },
      { taskPattern: "security|auth", model: "review-model" }
    ]
  };
  assert.equal(
    selectModelRoute("Research", "compare papers", policy),
    "research-model"
  );
  assert.equal(selectModelRoute("lab", "fix auth", policy), "review-model");
  assert.equal(selectModelRoute("lab", "fix copy", policy), "default");
});

test("model routing uses explicit priorities for complexity escalation", () => {
  const policy = {
    defaultModel: "standard-model",
    rules: [
      { agent: "research", model: "standard-model", priority: 10 },
      { taskPattern: "vision|pdf", model: "long-context-model", priority: 20 },
      { taskPattern: "security|deploy", model: "frontier-model", priority: 30 }
    ]
  };
  assert.equal(
    selectModelRoute("research", "summarize a vision PDF", policy),
    "long-context-model"
  );
  assert.equal(
    selectModelRoute("research", "review a deployment change", policy),
    "frontier-model"
  );
  assert.equal(
    selectModelRoute("research", "summarize notes", policy),
    "standard-model"
  );
});

test("run telemetry summarizes pass rate, usage, and stale active runs", () => {
  const now = new Date("2026-08-19T12:00:00Z");
  const result = summarizeRuns(
    [
      {
        state: "passed",
        updatedAt: "2026-08-19T11:00:00Z",
        telemetry: { tokens: 100, cost: 0.1, toolCalls: 4, toolErrors: 0 }
      },
      {
        state: "failed",
        updatedAt: "2026-08-19T11:00:00Z",
        telemetry: { tokens: 50, cost: 0.05, toolCalls: 2, toolErrors: 1 }
      },
      { state: "implementing", updatedAt: "2026-08-17T11:00:00Z" }
    ],
    { now, staleHours: 24 }
  );
  assert.deepEqual(result, {
    runs: 3,
    completed: 2,
    passed: 1,
    passRate: 0.5,
    stale: 1,
    tokens: 150,
    cost: 0.15000000000000002,
    toolCalls: 6,
    toolErrors: 1
  });
});
