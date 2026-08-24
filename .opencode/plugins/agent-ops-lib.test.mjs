import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveSessionState,
  inferLayout,
  isAutoApprovable,
  isSafePermission,
  layoutChecklist,
  qualitySnapshot
} from "./agent-ops-lib.mjs";

test("session states are derived from real activity", () => {
  assert.equal(
    deriveSessionState({
      status: { type: "busy" },
      agent: "research",
      messages: []
    }),
    "researching"
  );
  assert.equal(
    deriveSessionState({
      status: { type: "busy" },
      pendingPermissions: [{ id: "permission" }],
      agent: "slides",
      messages: []
    }),
    "blocked"
  );
  assert.equal(
    deriveSessionState({ status: { type: "idle" }, messages: [] }),
    "complete"
  );
});

test("approval modes never auto-cross protected boundaries", () => {
  const edit = { permission: "edit", patterns: ["src/app.ts"] };
  assert.equal(isAutoApprovable(edit, "ask"), false);
  assert.equal(isAutoApprovable(edit, "safe-auto"), true);
  assert.equal(
    isAutoApprovable(
      { permission: "bash", patterns: ["npm run typecheck"] },
      "safe-auto"
    ),
    false
  );
  assert.equal(
    isAutoApprovable(
      { permission: "bash", patterns: ["npm run typecheck"] },
      "broad-auto"
    ),
    false
  );
  for (const request of [
    { permission: "notion_notion-update-page", patterns: [] },
    { permission: "github_github_push", patterns: [] },
    { permission: "hound_web_search", patterns: [] },
    { permission: "lab-browser_click", patterns: [] },
    { permission: "external_directory", patterns: ["/tmp/outside"] },
    { permission: "bash", patterns: ["git push origin main"] },
    { permission: "read", patterns: [".env"] }
  ]) {
    assert.equal(isAutoApprovable(request, "broad-auto"), false);
  }
});

test("approval shortcut is limited to low-risk non-secret requests", () => {
  assert.equal(
    isSafePermission({ permission: "edit", patterns: ["src/app.ts"] }),
    true
  );
  assert.equal(
    isSafePermission({ permission: "bash", patterns: ["npm test"] }),
    false
  );
  assert.equal(
    isSafePermission({ permission: "read", patterns: ["opencode.env"] }),
    false
  );
});

test("quality score requires evidence and distinguishes review", () => {
  const snapshot = qualitySnapshot({
    status: { type: "idle" },
    todos: [{ content: "verify", status: "completed" }],
    messages: [{ role: "assistant" }],
    parts: [
      {
        type: "tool",
        tool: "quality_get_run_status",
        state: {
          status: "completed",
          title: "Quality status",
          input: {},
          output: JSON.stringify({
            state: "passed",
            verification: { passed: true, sha: "1234567890" },
            review: { passed: true, sha: "1234567890" },
            telemetry: { cost: 0.25 }
          })
        }
      }
    ]
  });
  assert.equal(snapshot.score, 100);
  assert.equal(snapshot.verification, "passed @ 1234567");
  assert.equal(snapshot.review, "passed @ 1234567");
});

test("a passing test signal does not invent independent review", () => {
  const snapshot = qualitySnapshot({
    status: { type: "idle" },
    messages: [{ role: "assistant" }],
    parts: [
      {
        type: "tool",
        tool: "bash",
        state: {
          status: "completed",
          title: "npm test",
          input: { command: "npm test" },
          output: "12 tests passed"
        }
      }
    ]
  });
  assert.equal(snapshot.verification, "1 successful check");
  assert.equal(snapshot.review, "not recorded");
  assert.ok(snapshot.score < 100);
});

test("workspace layouts follow agent role and expose focused checklists", () => {
  assert.equal(inferLayout("slides"), "build");
  assert.equal(inferLayout("research"), "research");
  assert.equal(inferLayout("lab", "research"), "research");
  assert.deepEqual(layoutChecklist("research"), [
    "source traceability",
    "decision synthesis",
    "uncertainty",
    "publish stage"
  ]);
});
