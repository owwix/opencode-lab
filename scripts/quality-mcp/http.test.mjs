import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  jsonRpcInternalError,
  toWebRequest,
  writeNodeResponse
} from "./http.mjs";

test("quality MCP server uses its retained HTTP adapter", () => {
  const server = readFileSync(
    fileURLToPath(new URL("./server.mjs", import.meta.url)),
    "utf8"
  );
  assert.match(server, /from "\.\/http\.mjs";/u);
});

test("HTTP adapter preserves method, headers, URL, and body", async () => {
  const request = Readable.from([Buffer.from("request body")]);
  request.method = "POST";
  request.url = "/mcp?session=one";
  request.headers = { "content-type": "text/plain", "x-test": ["a", "b"] };

  const webRequest = await toWebRequest(request, "127.0.0.1", 8793);
  assert.equal(webRequest.method, "POST");
  assert.equal(webRequest.url, "http://127.0.0.1:8793/mcp?session=one");
  assert.equal(webRequest.headers.get("x-test"), "a, b");
  assert.equal(await webRequest.text(), "request body");
});

test("HTTP adapter streams a web response back to Node", async () => {
  const chunks = [];
  const headers = new Map();
  let ended = false;
  const response = {
    statusCode: 0,
    setHeader(key, value) {
      headers.set(key, value);
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
    },
    end() {
      ended = true;
    },
    destroy(error) {
      throw error;
    }
  };

  await writeNodeResponse(
    response,
    new Response("response body", {
      status: 202,
      headers: { "x-quality": "ready" }
    })
  );

  assert.equal(response.statusCode, 202);
  assert.equal(headers.get("x-quality"), "ready");
  assert.equal(Buffer.concat(chunks).toString("utf8"), "response body");
  assert.equal(ended, true);
  assert.deepEqual(JSON.parse(jsonRpcInternalError()), {
    jsonrpc: "2.0",
    error: { code: -32603, message: "Internal server error" },
    id: null
  });
});
