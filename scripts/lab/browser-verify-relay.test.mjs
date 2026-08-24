import assert from "node:assert/strict";
import test from "node:test";
import {
  verifyUrls,
  startBrowserVerifyRelay
} from "./browser-verify-relay.mjs";

test("browser relay denies non-loopback URLs", async () => {
  const results = await verifyUrls(["https://example.com/"]);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].mode, "denied");
});

test("browser relay health endpoint responds", async () => {
  const server = startBrowserVerifyRelay({
    host: "127.0.0.1",
    port: 0,
    token: "verify-relay-token",
    projectId: "project_verify_test",
    workspaceHash: "workspace_verify_test"
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.ok, true);
    assert.deepEqual(await health.json(), {
      ok: true,
      service: "lab-browser-verify",
      projectId: "project_verify_test",
      workspaceHash: "workspace_verify_test"
    });
    const unauthorized = await fetch(`http://127.0.0.1:${port}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls: ["http://127.0.0.1:3100"] })
    });
    assert.equal(unauthorized.status, 401);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("background-ship prints usage without workspace", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const ship = fileURLToPath(new URL("./background-ship.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [ship], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--workspace/u);
});
