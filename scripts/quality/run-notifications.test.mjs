import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  listProjectNotifications,
  syncRunNotifications
} from "./run-notifications.mjs";

test("run notifications deduplicate events and remain project scoped", () => {
  const root = mkdtempSync(join(tmpdir(), "run-notifications-"));
  const durable = {
    id: "run_notify",
    projectId: "project_one",
    state: "passed",
    task: "Ship the feature",
    updatedAt: "2026-01-01T00:00:00.000Z",
    git: { headSha: "a".repeat(40) },
    externalActions: {}
  };
  const controller = {
    approvals: [{ id: "approval_one", status: "pending", phase: "publishing" }],
    publishing: {
      pr: { url: "https://example.invalid/pull/1", headSha: "a".repeat(40) }
    }
  };
  const artifactIndex = {
    entries: [{ id: "artifact_one", category: "image" }]
  };
  const first = syncRunNotifications({
    root,
    durable,
    controller,
    artifactIndex
  });
  const second = syncRunNotifications({
    root,
    durable,
    controller,
    artifactIndex
  });
  assert.deepEqual(
    first.map((record) => record.type).sort(),
    ["approval-required", "artifact-ready", "passed", "pr-ready"].sort()
  );
  assert.equal(second.length, 0);
  assert.equal(
    listProjectNotifications({ root, projectId: "project_one" }).length,
    4
  );
  assert.equal(
    listProjectNotifications({ root, projectId: "project_two" }).length,
    0
  );
  rmSync(root, { recursive: true, force: true });
});
