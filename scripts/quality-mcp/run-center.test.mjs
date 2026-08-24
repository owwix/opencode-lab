import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  projectIdentity,
  registerForegroundLaunch
} from "../lab/workspace-registry.mjs";
import { createDurableRun } from "../quality/run-service.mjs";

test("run-center HTTP reads are registration-scoped and evidence-backed", async () => {
  const root = mkdtempSync(join(tmpdir(), "quality-run-center-"));
  const workspace = join(root, "workspace");
  const otherWorkspace = join(root, "other");
  const registryPath = join(root, "host-registry.json");
  const registrationToken = "run-center-registration-token-1234567890";
  mkdirSync(join(workspace, ".git"), { recursive: true });
  mkdirSync(join(otherWorkspace, ".git"), { recursive: true });
  const identity = projectIdentity(workspace);
  const otherIdentity = projectIdentity(otherWorkspace);
  process.env.QUALITY_STATE_ROOT = root;
  process.env.OPENCODE_LAB_STATE_ROOT = root;
  process.env.OPENCODE_LAB_REGISTRY_PATH = registryPath;
  process.env.QUALITY_WORKSPACE_ROOTS = `${workspace},${otherWorkspace}`;
  registerForegroundLaunch({
    registryPath,
    identity,
    launchId: "launch_run_center_123456",
    sessionId: "session_run_center_123456",
    runId: "run_launch_123456",
    profile: "fast",
    pid: process.pid,
    registrationToken
  });

  for (const [id, source, projectId] of [
    ["run_visible_123456", identity.canonicalPath, identity.projectId],
    ["run_hidden_123456", otherIdentity.canonicalPath, otherIdentity.projectId]
  ]) {
    const runDirectory = join(root, "runs", id);
    mkdirSync(runDirectory, { recursive: true });
    createDurableRun({
      root,
      id,
      kind: "background",
      state: "passed",
      task: `Task for ${id}`,
      projectId,
      controllerRunId: id,
      source,
      workspace: join(root, "worktrees", id),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z"
    });
    writeFileSync(
      join(runDirectory, "run.json"),
      `${JSON.stringify(
        {
          id,
          task: `Task for ${id}`,
          state: "passed",
          model: "builder",
          source,
          workspace: join(root, "worktrees", id),
          branch: `agent/${id}`,
          baseSha: null,
          headSha: null,
          clean: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z",
          releaseRequested: false,
          verification: {
            passed: true,
            sha: "b".repeat(40),
            log: join(runDirectory, "verification.log")
          },
          review: {
            passed: true,
            sha: "b".repeat(40),
            logs: [join(runDirectory, "review-01.jsonl")],
            reviewers: [{ model: "reviewer" }]
          },
          telemetry: { usageTelemetryObserved: false },
          approvals: [],
          artifacts: { visual: [] }
        },
        null,
        2
      )}\n`
    );
  }

  try {
    const { handleQualityMcp } = await import(
      `./handler.mjs?run-center-test=${Date.now()}`
    );
    const response = await handleQualityMcp(
      new Request("http://127.0.0.1:8793/runs", {
        headers: {
          authorization: "Bearer quality-token",
          "x-lab-registration-token": registrationToken
        }
      }),
      "quality-token"
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.runs.length, 1, JSON.stringify(payload));
    assert.equal(payload.runs[0].id, "run_visible_123456");
    assert.equal(payload.runs[0].verification.passed, true);
    assert.match(
      payload.runs[0].verification.evidence[0].target,
      /verification\.log$/u
    );
    assert.equal(payload.runs[0].review.passed, true);
    assert.match(
      payload.runs[0].review.evidence[0].target,
      /review-01\.jsonl$/u
    );
    assert.equal(payload.runs[0].cost.available, false);
    assert.match(payload.runs[0].artifacts.index, /artifacts\.json$/u);
    assert.equal(payload.runs[0].notifications.unread, 1);
    const notificationResponse = await handleQualityMcp(
      new Request("http://127.0.0.1:8793/notifications", {
        headers: {
          authorization: "Bearer quality-token",
          "x-lab-registration-token": registrationToken
        }
      }),
      "quality-token"
    );
    assert.equal(notificationResponse.status, 200);
    const notifications = await notificationResponse.json();
    assert.equal(notifications.notifications.length, 1);
    assert.equal(notifications.notifications[0].runId, "run_visible_123456");
  } finally {
    delete process.env.QUALITY_STATE_ROOT;
    delete process.env.OPENCODE_LAB_STATE_ROOT;
    delete process.env.OPENCODE_LAB_REGISTRY_PATH;
    delete process.env.QUALITY_WORKSPACE_ROOTS;
    rmSync(root, { recursive: true, force: true });
  }
});
