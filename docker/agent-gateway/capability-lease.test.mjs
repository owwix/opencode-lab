import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCapabilityScope,
  createCapabilityLease,
  verifyCapabilityLease
} from "./capability-lease.mjs";

const key = "test-capability-signing-key-at-least-32-bytes"; // gitleaks:allow
const context = {
  workspaceHash: "workspace_hash_1234567890",
  projectId: "project_1234567890",
  sessionId: "session_1234567890",
  runId: "run_1234567890"
};

function lease(overrides = {}) {
  return createCapabilityLease({
    key,
    ...context,
    routes: ["chat"],
    actions: ["chat:invoke"],
    now: 1_000_000,
    ttlSeconds: 60,
    ...overrides
  });
}

test("accepts an intact lease only for its declared scope", () => {
  const claims = verifyCapabilityLease(lease(), {
    key,
    ...context,
    now: 1_010_000
  });
  assert.equal(
    assertCapabilityScope(claims, { route: "chat", action: "invoke" }),
    claims
  );
  assert.throws(
    () =>
      assertCapabilityScope(claims, {
        route: "github-publish",
        action: "push"
      }),
    /does not allow route/iu
  );
});

test("rejects altered and expired leases", () => {
  const token = lease();
  const parts = token.split(".");
  parts[2] = `${parts[2].slice(0, -1)}${parts[2].endsWith("a") ? "b" : "a"}`;
  assert.throws(
    () => verifyCapabilityLease(parts.join("."), { key, ...context }),
    /signature|payload/iu
  );
  assert.throws(
    () => verifyCapabilityLease(token, { key, ...context, now: 1_091_000 }),
    /expired/iu
  );
});

test("rejects cross-workspace and cross-session reuse", () => {
  assert.throws(
    () =>
      verifyCapabilityLease(lease(), {
        key,
        ...context,
        workspaceHash: "workspace_hash_other_123",
        now: 1_010_000
      }),
    /workspaceHash does not match/iu
  );
  assert.throws(
    () =>
      verifyCapabilityLease(lease(), {
        key,
        ...context,
        sessionId: "session_other_1234567890",
        now: 1_010_000
      }),
    /sessionId does not match/iu
  );
  assert.throws(
    () =>
      verifyCapabilityLease(lease(), {
        key,
        ...context,
        runId: "run_other_1234567890",
        now: 1_010_000
      }),
    /runId does not match/iu
  );
});
