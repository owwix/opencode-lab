import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveTitle,
  makeIdempotencyKey,
  parseArgs,
  publish,
  resolveFile
} from "./publish.mjs";

function withTempDir(callback) {
  const dir = mkdtempSync(join(tmpdir(), "notion-publish-"));
  return callback(dir);
}

async function withServer(handler, callback) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("parseArgs extracts flags", () => {
  const values = parseArgs([
    "node",
    "publish.mjs",
    "--target",
    "docs",
    "--file",
    "note.md",
    "--title",
    "Hello"
  ]);
  assert.equal(values.target, "docs");
  assert.equal(values.file, "note.md");
  assert.equal(values.title, "Hello");
});

test("parseArgs rejects invalid invocation", () => {
  assert.throws(() => parseArgs(["node", "publish.mjs", "--target"]));
  assert.throws(() => parseArgs(["node", "publish.mjs", "bad"]));
});

test("resolveFile rejects sensitive and escaping paths", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "ok.md"), "ok");
    assert.doesNotThrow(() => resolveFile(dir, "ok.md"));

    for (const bad of [".env", "docker.env", "opencode.env", "key.pem"]) {
      assert.throws(() => resolveFile(dir, bad), bad);
    }
    assert.throws(() => resolveFile(dir, "../outside.md"));
  });
});

test("resolved file path is workspace-relative", () => {
  withTempDir((dir) => {
    const nested = join(dir, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, "file.md"), "content");
    assert.equal(resolveFile(dir, "nested/file.md"), "nested/file.md");
  });
});

test("deriveTitle falls back to filename", () => {
  assert.equal(deriveTitle({ title: "Custom" }, "path/file.md"), "Custom");
  assert.equal(deriveTitle({}, "path/file.md"), "file");
});

test("makeIdempotencyKey is deterministic", () => {
  const one = makeIdempotencyKey("docs", "file.md", "# Hello");
  const two = makeIdempotencyKey("docs", "file.md", "# Hello");
  assert.equal(one, two);
  assert.notEqual(one, makeIdempotencyKey("docs", "file.md", "# Hi"));
});

test("publish forwards markdown and idempotency key to fixed upstream", async () => {
  await withServer(
    async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(request.headers.authorization, "Bearer gw-token");
      assert.equal(body.target, "docs");
      assert.equal(body.title, "Test page");
      assert.equal(body.markdown, "# Hello Notion");
      assert.ok(body.idempotencyKey);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          target: body.target,
          pageId: "page-123",
          url: "https://notion.so/page-123",
          duplicate: false
        })
      );
    },
    async (origin) => {
      await withTempDir(async (dir) => {
        writeFileSync(join(dir, "post.md"), "# Hello Notion");
        const result = await publish({
          target: "docs",
          filePath: "post.md",
          titleOverride: "Test page",
          env: {
            AGENT_GATEWAY_TOKEN: "gw-token",
            NOTION_PUBLISH_URL: `${origin}/notion/publish`
          },
          root: dir
        });
        assert.equal(result.pageId, "page-123");
        assert.equal(result.url, "https://notion.so/page-123");
      });
    }
  );
});

test("publish surfaces upstream errors", async () => {
  await withServer(
    async (request, response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Notion rejected the page" }));
    },
    async (origin) => {
      await withTempDir(async (dir) => {
        writeFileSync(join(dir, "bad.md"), "# Bad");
        await assert.rejects(
          publish({
            target: "docs",
            filePath: "bad.md",
            env: {
              AGENT_GATEWAY_TOKEN: "gw-token",
              NOTION_PUBLISH_URL: `${origin}/notion/publish`
            },
            root: dir
          }),
          /Notion rejected the page/u
        );
      });
    }
  );
});
