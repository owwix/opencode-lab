import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { createCapabilityLease } from "../agent-gateway/capability-lease.mjs";

async function waitForHealth(url) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // The child may still be binding its loopback port.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("Notion publisher did not become healthy.");
}

test("Notion publisher requires a matching publish capability", async () => {
  const port = 19400 + (process.pid % 500);
  const token = "n".repeat(64);
  const key = "test-capability-signing-key-at-least-32-bytes"; // gitleaks:allow
  const context = {
    workspaceHash: "workspace_hash_1234567890",
    projectId: "project_1234567890",
    sessionId: "session_1234567890",
    runId: "run_1234567890"
  };
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    ["docker/notion-publisher/server.mjs"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NOTION_PUBLISHER_PORT: String(port),
        NOTION_PUBLISHER_TOKEN: token,
        NOTION_API_TOKEN: "test-notion-token",
        NOTION_PUBLISH_TARGETS_JSON:
          '{"docs":"01234567-89ab-cdef-0123-456789abcdef"}',
        NOTION_PUBLISH_STATE_DIR: process.env.TMPDIR ?? "/tmp",
        AGENT_GATEWAY_SIGNING_KEY: key,
        OPENCODE_WORKSPACE_HASH: context.workspaceHash,
        OPENCODE_PROJECT_ID: context.projectId,
        OPENCODE_LAUNCH_SESSION_ID: context.sessionId,
        OPENCODE_RUN_ID: context.runId
      },
      stdio: "ignore"
    }
  );
  const internalHeaders = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json"
  };
  try {
    await waitForHealth(url);
    assert.equal(
      (await fetch(`${url}/publish`, { method: "POST" })).status,
      401
    );
    assert.equal(
      (
        await fetch(`${url}/publish`, {
          method: "POST",
          headers: internalHeaders,
          body: "{}"
        })
      ).status,
      403
    );
    const chatLease = createCapabilityLease({
      key,
      ...context,
      routes: ["chat"],
      actions: ["chat:invoke"]
    });
    assert.equal(
      (
        await fetch(`${url}/publish`, {
          method: "POST",
          headers: {
            ...internalHeaders,
            "x-opencode-capability-lease": chatLease
          },
          body: "{}"
        })
      ).status,
      403
    );
    const publishLease = createCapabilityLease({
      key,
      ...context,
      routes: ["notion-publish"],
      actions: ["notion-publish:publish"]
    });
    assert.equal(
      (
        await fetch(`${url}/publish`, {
          method: "POST",
          headers: {
            ...internalHeaders,
            "x-opencode-capability-lease": publishLease
          },
          body: "{}"
        })
      ).status,
      400
    );
  } finally {
    child.kill("SIGTERM");
  }
});
