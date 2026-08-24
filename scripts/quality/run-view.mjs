import { basename, join } from "node:path";

const ACTIVE_STATES = new Set([
  "queued",
  "prepared",
  "implementing",
  "verifying",
  "reviewing",
  "needs_evidence",
  "running"
]);
const RETRYABLE_STATES = new Set(["failed", "cancelled", "abandoned"]);
const TERMINAL_STATES = new Set([
  "passed",
  "failed",
  "cancelled",
  "abandoned",
  "archived",
  "completed"
]);

function evidenceTarget(root, runId, file) {
  return file ? join(root, "runs", runId, file) : null;
}

function costView(telemetry) {
  const observed = Boolean(telemetry?.usageTelemetryObserved);
  return {
    available: observed,
    amount: observed ? Number(telemetry?.cost ?? 0) : null,
    tokens: observed ? Number(telemetry?.tokens ?? 0) : null,
    reason: observed ? null : "provider usage telemetry unavailable"
  };
}

export function runBelongsToRegistration(record, registration) {
  if (!record || !registration) return false;
  return (
    record.projectId === registration.projectId ||
    record.git?.source === registration.canonicalPath
  );
}

export function allowedRunActions(durable, controller = null) {
  const actions = [];
  const hasController = Boolean(durable.controllerRunId && controller);
  const pending = (controller?.approvals ?? []).filter(
    (approval) => approval.status === "pending"
  );
  if (hasController && ["prepared", "queued"].includes(durable.state)) {
    actions.push("resume");
  }
  if (
    hasController &&
    RETRYABLE_STATES.has(durable.state) &&
    durable.attempts.length < durable.maxAttempts
  ) {
    actions.push("retry");
  }
  if (hasController && ACTIVE_STATES.has(durable.state)) actions.push("cancel");
  if (pending.length) actions.push("approve", "reject");
  if (
    hasController &&
    durable.state === "passed" &&
    controller.releaseRequested
  ) {
    actions.push("adopt", "prepare-pr");
  }
  if (
    hasController &&
    TERMINAL_STATES.has(durable.state) &&
    durable.state !== "archived"
  ) {
    actions.push("archive");
  }
  if (
    hasController &&
    TERMINAL_STATES.has(durable.state) &&
    !durable.cleanedAt
  ) {
    actions.push("cleanup");
  }
  return [...new Set(actions)];
}

export function buildRunView({
  durable,
  controller = null,
  artifactIndex = null,
  notifications = [],
  root,
  now = Date.now()
}) {
  const controllerEvidence = controller
    ? evidenceTarget(root, durable.controllerRunId, "run.json")
    : null;
  const started = new Date(durable.createdAt).getTime();
  const ended = TERMINAL_STATES.has(durable.state)
    ? new Date(durable.updatedAt).getTime()
    : now;
  const verificationPath =
    controller?.verification?.log ??
    evidenceTarget(root, durable.id, "verification.json");
  const recordedReviewPaths =
    controller?.review?.logs?.filter(Boolean) ??
    (controller?.review?.log ? [controller.review.log] : []);
  const reviewPaths = recordedReviewPaths.length
    ? recordedReviewPaths
    : controller?.review && controllerEvidence
      ? [controllerEvidence]
      : [];
  const artifactEntries = artifactIndex?.entries?.length
    ? artifactIndex.entries.map((entry) => ({
        kind: entry.category,
        target: entry.target,
        location: entry.location,
        size: entry.size ?? null
      }))
    : [
        ...(controller?.artifacts?.visual ?? []),
        controller?.artifacts?.manifest,
        controller?.artifacts?.migrationPlan
      ]
        .filter(Boolean)
        .map((target) => ({ kind: "artifact", target }));
  const pendingApprovals = (controller?.approvals ?? []).filter(
    (approval) => approval.status === "pending"
  );
  const reviewerModels = [
    ...new Set(
      (controller?.review?.reviewers ?? [])
        .map((reviewer) => reviewer.model)
        .filter(Boolean)
    )
  ];
  const pr =
    controller?.publishing?.pr ??
    durable.externalActions?.preparePr?.receipt ??
    null;

  return {
    id: durable.id,
    kind: durable.kind,
    project: {
      id: durable.projectId,
      name: basename(durable.git?.source ?? "unknown"),
      source: durable.git?.source
    },
    task: durable.task ?? controller?.task ?? "Managed run",
    phase: durable.phase,
    state: durable.state,
    model: controller?.model ?? durable.model ?? null,
    reviewer: {
      models: reviewerModels,
      passed: controller?.review?.passed ?? null,
      evidence: reviewPaths.map((target) => ({ kind: "review", target }))
    },
    elapsed: {
      startedAt: durable.createdAt,
      updatedAt: durable.updatedAt,
      milliseconds: Math.max(0, ended - started)
    },
    cost: costView(controller?.telemetry),
    approvals: {
      pending: pendingApprovals,
      count: pendingApprovals.length
    },
    verification: {
      passed: controller?.verification?.passed ?? null,
      sha: controller?.verification?.sha ?? null,
      evidence: verificationPath
        ? [{ kind: "verification", target: verificationPath }]
        : []
    },
    review: {
      passed: controller?.review?.passed ?? null,
      sha: controller?.review?.sha ?? null,
      evidence: reviewPaths.map((target) => ({ kind: "review", target }))
    },
    worktree: {
      path: durable.git?.worktree,
      branch: durable.git?.branch,
      headSha: durable.git?.headSha,
      clean: durable.git?.clean,
      evidence: durable.git?.headSha
        ? [{ kind: "git", target: `git:${durable.git.headSha}` }]
        : []
    },
    artifacts: {
      count: artifactEntries.length,
      items: artifactEntries,
      index: artifactIndex
        ? evidenceTarget(root, durable.id, "artifacts.json")
        : null,
      categories: artifactIndex?.categories ?? {}
    },
    notifications: {
      unread: notifications.filter((record) => record.status === "unread")
        .length,
      records: notifications
    },
    preview: {
      url: controller?.preview?.url ?? controller?.artifacts?.preview ?? null,
      evidence: controller?.preview?.evidence ?? null
    },
    pullRequest: pr
      ? {
          url: pr.url ?? null,
          base: pr.base ?? null,
          branch: pr.branch ?? durable.git?.branch ?? null,
          headSha: pr.headSha ?? durable.git?.headSha ?? null,
          evidence: pr.url ?? `git:${pr.headSha}`
        }
      : null,
    attempts: {
      used: durable.attempts.length,
      maximum: durable.maxAttempts
    },
    actions: allowedRunActions(durable, controller),
    evidence: {
      service: evidenceTarget(root, durable.id, "service.json"),
      controller: controllerEvidence
    }
  };
}
