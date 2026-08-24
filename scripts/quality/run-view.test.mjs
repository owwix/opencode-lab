import assert from "node:assert/strict";
import test from "node:test";
import {
  allowedRunActions,
  buildRunView,
  runBelongsToRegistration
} from "./run-view.mjs";

function durable(overrides = {}) {
  return {
    id: "run_12345678",
    kind: "background",
    state: "passed",
    phase: "terminal",
    projectId: "project_alpha",
    controllerRunId: "run_12345678",
    task: "Ship the bounded change",
    model: "builder",
    attempts: [{ status: "completed" }],
    maxAttempts: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:02:00.000Z",
    cleanedAt: null,
    externalActions: {},
    git: {
      source: "/projects/alpha",
      worktree: "/state/worktrees/run_12345678",
      branch: "agent/run_12345678",
      headSha: "abcdef1234567890",
      clean: true
    },
    ...overrides
  };
}

function controller(overrides = {}) {
  return {
    task: "Ship the bounded change",
    model: "builder",
    releaseRequested: true,
    telemetry: {
      usageTelemetryObserved: true,
      cost: 0.125,
      tokens: 900
    },
    approvals: [],
    verification: {
      passed: true,
      sha: "abcdef1234567890",
      log: "/state/runs/run_12345678/verification.log"
    },
    review: {
      passed: true,
      sha: "abcdef1234567890",
      logs: ["/state/runs/run_12345678/review-01.jsonl"],
      reviewers: [{ model: "reviewer-a" }]
    },
    artifacts: {
      visual: ["/state/runs/run_12345678/preview.png"],
      manifest: "/state/runs/run_12345678/evidence.json"
    },
    preview: {
      url: "http://127.0.0.1:3100/run_12345678",
      evidence: "/state/runs/run_12345678/preview.json"
    },
    publishing: {
      pr: {
        url: "https://github.com/example/repo/pull/1",
        headSha: "abcdef1234567890",
        base: "main",
        branch: "agent/run_12345678"
      }
    },
    ...overrides
  };
}

test("run view exposes every operator field and binds quality claims to evidence", () => {
  const view = buildRunView({
    durable: durable(),
    controller: controller(),
    artifactIndex: {
      categories: { image: 1, patch: 1 },
      entries: [
        { category: "image", target: "/state/preview.png", location: "file" },
        { category: "patch", target: "/state/change.patch", location: "file" }
      ]
    },
    notifications: [
      { id: "notification_1", status: "unread", type: "artifact-ready" }
    ],
    root: "/state",
    now: Date.parse("2026-01-01T00:10:00.000Z")
  });

  assert.equal(view.project.name, "alpha");
  assert.equal(view.task, "Ship the bounded change");
  assert.equal(view.state, "passed");
  assert.equal(view.phase, "terminal");
  assert.equal(view.model, "builder");
  assert.deepEqual(view.reviewer.models, ["reviewer-a"]);
  assert.equal(view.elapsed.milliseconds, 120_000);
  assert.deepEqual(view.cost, {
    available: true,
    amount: 0.125,
    tokens: 900,
    reason: null
  });
  assert.equal(view.verification.passed, true);
  assert.equal(view.verification.evidence.length, 1);
  assert.equal(view.review.passed, true);
  assert.equal(view.review.evidence.length, 1);
  assert.equal(view.artifacts.count, 2);
  assert.equal(view.artifacts.categories.patch, 1);
  assert.equal(view.notifications.unread, 1);
  assert.equal(view.preview.url, "http://127.0.0.1:3100/run_12345678");
  assert.equal(view.pullRequest.url, "https://github.com/example/repo/pull/1");
  assert.ok(view.actions.includes("adopt"));
  assert.ok(view.actions.includes("prepare-pr"));
});

test("unobserved cost is unavailable rather than reported as free", () => {
  const view = buildRunView({
    durable: durable(),
    controller: controller({ telemetry: { cost: 0 } }),
    root: "/state"
  });
  assert.equal(view.cost.available, false);
  assert.equal(view.cost.amount, null);
  assert.match(view.cost.reason, /unavailable/u);
});

test("a recorded review claim always links to review or controller evidence", () => {
  const view = buildRunView({
    durable: durable({ state: "failed" }),
    controller: controller({
      review: { passed: false, sha: null, reviewers: [], logs: [] }
    }),
    root: "/state"
  });
  assert.equal(view.review.passed, false);
  assert.equal(
    view.review.evidence[0].target,
    "/state/runs/run_12345678/run.json"
  );
});

test("actions are state-aware, bounded, and approval-specific", () => {
  assert.deepEqual(
    allowedRunActions(
      durable({ state: "prepared", phase: "queued", attempts: [] }),
      controller({ releaseRequested: false })
    ),
    ["resume", "cancel"]
  );
  assert.deepEqual(
    allowedRunActions(
      durable({ state: "failed", attempts: [{}, {}, {}] }),
      controller({ releaseRequested: false })
    ),
    ["archive", "cleanup"]
  );
  const actions = allowedRunActions(
    durable({ state: "implementing" }),
    controller({
      releaseRequested: false,
      approvals: [{ id: "approval_1", status: "pending" }]
    })
  );
  assert.deepEqual(actions, ["cancel", "approve", "reject"]);
});

test("project scoping accepts only the registered project identity", () => {
  const registration = {
    projectId: "project_alpha",
    canonicalPath: "/projects/alpha"
  };
  assert.equal(runBelongsToRegistration(durable(), registration), true);
  assert.equal(
    runBelongsToRegistration(
      durable({
        projectId: "project_beta",
        git: { ...durable().git, source: "/projects/beta" }
      }),
      registration
    ),
    false
  );
});
