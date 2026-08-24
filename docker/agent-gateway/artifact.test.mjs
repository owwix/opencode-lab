import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createAgentGateway } from "./gateway.mjs";
import { createCapabilityLease } from "./capability-lease.mjs";

const gatewaySigningKey = "test-capability-signing-key-at-least-32-bytes";
const capabilityContext = {
  workspaceHash: "workspace_hash_1234567890",
  projectId: "project_1234567890",
  sessionId: "session_1234567890",
  runId: "run_1234567890"
};

const baseConfig = {
  gatewaySigningKey,
  expectedWorkspaceHash: capabilityContext.workspaceHash,
  expectedProjectId: capabilityContext.projectId,
  expectedSessionId: capabilityContext.sessionId,
  expectedRunId: capabilityContext.runId,
  gatewayToken: createCapabilityLease({
    key: gatewaySigningKey,
    ...capabilityContext,
    routes: ["artifact"],
    actions: ["artifact:download"]
  }),
  cloudflareAccountId: "account-id",
  cloudflareApiToken: "real-cloudflare-token",
  artifactAllowlist: "example.com,allowed.org"
};

async function withGateway(fetchImpl, callback, options = {}) {
  const { config: configOverrides = {}, ...gatewayOptions } = options;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lab-artifact-"));
  const stagingRoot = path.join(tempRoot, ".artifact-staging");
  const server = createAgentGateway(
    { ...baseConfig, ...configOverrides },
    {
      fetchImpl,
      capabilities: ["artifact"],
      artifactStagingRoot: stagingRoot,
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
      ...gatewayOptions
    }
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

test("approved artifact download", async () => {
  const mockBody = Buffer.from("PDFDATA");
  await withGateway(
    async () =>
      new Response(mockBody, {
        status: 200,
        headers: { "content-type": "application/pdf" }
      }),
    async (origin) => {
      const payload = {
        url: "https://example.com/file.pdf",
        filename: "file.pdf"
      };
      const response = await fetch(`${origin}/artifact/download`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${baseConfig.gatewayToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.url, payload.url);
      assert.equal(result.mimeType, "application/pdf");
      assert.equal(result.size, mockBody.length);
      assert.ok(result.stagingPath.startsWith(".artifact-staging/"));
    }
  );
});

test("disallowed domain", async () => {
  await withGateway(
    async () => new Response("", { status: 200 }),
    async (origin) => {
      const payload = { url: "https://bad.com/malware.bin" };
      const response = await fetch(`${origin}/artifact/download`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${baseConfig.gatewayToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      assert.equal(response.status, 403);
    }
  );
});

test("http scheme rejected", async () => {
  await withGateway(
    async () => new Response("", { status: 200 }),
    async (origin) => {
      const payload = { url: "http://example.com/insecure.bin" };
      const response = await fetch(`${origin}/artifact/download`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${baseConfig.gatewayToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      assert.equal(response.status, 400);
    }
  );
});

test("private literal target is rejected before download", async () => {
  let called = false;
  await withGateway(
    async () => {
      called = true;
      return new Response("data", { status: 200 });
    },
    async (origin) => {
      const response = await fetch(`${origin}/artifact/download`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${baseConfig.gatewayToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ url: "https://127.0.0.1/file.bin" })
      });
      assert.equal(response.status, 403);
      assert.equal(called, false);
    },
    {
      config: { artifactAllowlist: "127.0.0.1" },
      dnsLookup: async () => [{ address: "127.0.0.1", family: 4 }]
    }
  );
});

test("private DNS result is rejected before download", async () => {
  let called = false;
  await withGateway(
    async () => {
      called = true;
      return new Response("data", { status: 200 });
    },
    async (origin) => {
      const response = await fetch(`${origin}/artifact/download`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${baseConfig.gatewayToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ url: "https://example.com/file.bin" })
      });
      assert.equal(response.status, 403);
      assert.equal(called, false);
    },
    {
      dnsLookup: async () => [{ address: "169.254.169.254", family: 4 }]
    }
  );
});

test("URL credentials and nonstandard ports are rejected", async () => {
  await withGateway(
    async () => new Response("data", { status: 200 }),
    async (origin) => {
      for (const url of [
        "https://user:secret@example.com/file.bin",
        "https://example.com:8443/file.bin"
      ]) {
        const response = await fetch(`${origin}/artifact/download`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${baseConfig.gatewayToken}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({ url })
        });
        assert.equal(response.status, 400);
      }
    }
  );
});

test("redirect to disallowed host", async () => {
  const redirectResp = new Response(null, {
    status: 302,
    headers: { location: "https://bad.com/evil.bin" }
  });
  await withGateway(
    async () => redirectResp,
    async (origin) => {
      const payload = { url: "https://example.com/start.bin" };
      const response = await fetch(`${origin}/artifact/download`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${baseConfig.gatewayToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      assert.equal(response.status, 403);
    }
  );
});

test("redirect targets are resolved and private results fail closed", async () => {
  let calls = 0;
  await withGateway(
    async () => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { location: "https://allowed.org/internal.bin" }
      });
    },
    async (origin) => {
      const response = await fetch(`${origin}/artifact/download`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${baseConfig.gatewayToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ url: "https://example.com/start.bin" })
      });
      assert.equal(response.status, 403);
      assert.equal(calls, 1);
    },
    {
      dnsLookup: async (hostname) => [
        {
          address: hostname === "allowed.org" ? "10.0.0.2" : "93.184.216.34",
          family: 4
        }
      ]
    }
  );
});

test("oversized file rejected", async () => {
  const large = Buffer.alloc(11 * 1024 * 1024, "a");
  await withGateway(
    async () =>
      new Response(large, {
        status: 200,
        headers: { "content-type": "application/pdf" }
      }),
    async (origin) => {
      const payload = { url: "https://example.com/large.pdf" };
      const response = await fetch(`${origin}/artifact/download`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${baseConfig.gatewayToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      assert.equal(response.status, 413);
    }
  );
});

test("invalid content type rejected", async () => {
  await withGateway(
    async () =>
      new Response("<html></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      }),
    async (origin) => {
      const payload = { url: "https://example.com/page.html" };
      const response = await fetch(`${origin}/artifact/download`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${baseConfig.gatewayToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      assert.equal(response.status, 415);
    }
  );
});

test("checksum mismatch rejected", async () => {
  const data = Buffer.from("data");
  await withGateway(
    async () =>
      new Response(data, {
        status: 200,
        headers: { "content-type": "application/pdf" }
      }),
    async (origin) => {
      const payload = {
        url: "https://example.com/file.pdf",
        checksum: "deadbeef"
      };
      const response = await fetch(`${origin}/artifact/download`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${baseConfig.gatewayToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      assert.equal(response.status, 400);
    }
  );
});

test("path traversal filename rejected", async () => {
  await withGateway(
    async () =>
      new Response("data", {
        status: 200,
        headers: { "content-type": "application/pdf" }
      }),
    async (origin) => {
      const payload = {
        url: "https://example.com/file.pdf",
        filename: "../evil.pdf"
      };
      const response = await fetch(`${origin}/artifact/download`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${baseConfig.gatewayToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      assert.equal(response.status, 400);
    }
  );
});
