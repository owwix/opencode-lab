import assert from "node:assert/strict";
import { createServer } from "node:http";
import { request as requestHttp } from "node:http";
import { test } from "node:test";
import {
  createHoundRelay,
  hardenMcpPayload
} from "../docker/hound-relay/relay.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected a TCP listener."));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("relay forwards only MCP traffic to the fixed Hound upstream", async (t) => {
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.writeHead(201, {
      "content-type": "application/json",
      "x-upstream-path": request.url || ""
    });
    response.end(
      JSON.stringify({
        authorization: request.headers.authorization ?? null,
        body: Buffer.concat(chunks).toString("utf8"),
        cookie: request.headers.cookie ?? null,
        host: request.headers.host
      })
    );
  });
  const upstreamPort = await listen(upstream);
  const relay = createHoundRelay({
    upstreamHost: "127.0.0.1",
    upstreamPort
  });
  const relayPort = await listen(relay);
  t.after(async () => {
    await close(relay);
    await close(upstream);
  });

  const response = await fetch(
    `http://127.0.0.1:${relayPort}/mcp?session=one`,
    {
      method: "POST",
      body: '{"jsonrpc":"2.0"}',
      headers: {
        authorization: "Bearer must-not-forward",
        cookie: "must-not-forward=true",
        "content-type": "application/json"
      }
    }
  );

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-upstream-path"), "/mcp?session=one");
  assert.deepEqual(await response.json(), {
    authorization: null,
    body: '{"jsonrpc":"2.0"}',
    cookie: null,
    host: `127.0.0.1:${upstreamPort}`
  });

  const health = await fetch(`http://127.0.0.1:${relayPort}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { healthy: true });
});

test("relay health tracks Hound and rejects non-MCP paths", async (t) => {
  const relay = createHoundRelay({
    upstreamHost: "127.0.0.1",
    upstreamPort: 1
  });
  const relayPort = await listen(relay);
  t.after(() => close(relay));

  const health = await fetch(`http://127.0.0.1:${relayPort}/health`);
  assert.equal(health.status, 503);
  assert.deepEqual(await health.json(), { healthy: false });

  const rejected = await fetch(`http://127.0.0.1:${relayPort}/anything-else`);
  assert.equal(rejected.status, 404);

  const denied = await fetch(`http://127.0.0.1:${relayPort}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "mcp_smart_search",
        arguments: {
          query: "similar",
          options: { mode: "find_similar", url: "http://private.example" }
        }
      }
    })
  });
  assert.equal(denied.status, 403);
  assert.match(
    (await denied.json()).error.message,
    /cannot fetch a source URL/
  );

  const absoluteTargetStatus = await new Promise((resolve, reject) => {
    const request = requestHttp(
      {
        host: "127.0.0.1",
        port: relayPort,
        path: "http://attacker.invalid/mcp"
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      }
    );
    request.on("error", reject);
    request.end();
  });
  assert.equal(absoluteTargetStatus, 404);
});

test("relay makes autonomous web tools passive and bounded", () => {
  const fetchPayload = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "mcp_smart_fetch",
      arguments: {
        actions: [],
        url: "https://example.com",
        options: { respect_robots: false, wait: 50 }
      }
    }
  };
  hardenMcpPayload(fetchPayload);
  assert.deepEqual(fetchPayload.params.arguments.options, {
    respect_robots: true,
    wait: 50
  });
  assert.equal(fetchPayload.params.arguments.respect_robots, true);
  assert.equal(Object.hasOwn(fetchPayload.params.arguments, "actions"), false);

  const crawlPayload = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "mcp_smart_crawl",
      arguments: {
        url: "https://example.com",
        concurrency: 8,
        max_depth: 9,
        max_pages: 250,
        respect_robots: false,
        options: {
          concurrency: 5,
          max_depth: 5,
          max_pages: 100,
          respect_robots: false
        }
      }
    }
  };
  hardenMcpPayload(crawlPayload);
  assert.equal(crawlPayload.params.arguments.concurrency, 3);
  assert.equal(crawlPayload.params.arguments.max_depth, 3);
  assert.equal(crawlPayload.params.arguments.max_pages, 25);
  assert.equal(crawlPayload.params.arguments.respect_robots, true);
  assert.deepEqual(crawlPayload.params.arguments.options, {
    concurrency: 3,
    max_depth: 3,
    max_pages: 25,
    respect_robots: true
  });

  assert.throws(
    () =>
      hardenMcpPayload({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "mcp_smart_crawl",
          arguments: {
            url: "https://example.com",
            max_pages: "100"
          }
        }
      }),
    /Crawl page count must be an integer/
  );
});

test("relay blocks search-as-fetch and active browser inputs", () => {
  assert.throws(
    () =>
      hardenMcpPayload({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "mcp_smart_search",
          arguments: {
            query: "similar",
            options: {
              mode: "find_similar",
              url: "http://private.example"
            }
          }
        }
      }),
    /cannot fetch a source URL/
  );
  assert.throws(
    () =>
      hardenMcpPayload({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "mcp_smart_search",
          arguments: {
            query: "similar",
            mode: "find_similar",
            url: "http://private.example"
          }
        }
      }),
    /cannot fetch a source URL/
  );
  assert.throws(
    () =>
      hardenMcpPayload({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "mcp_smart_fetch",
          arguments: {
            url: "https://example.com",
            actions: [{ click: "button" }]
          }
        }
      }),
    /browser actions are disabled/
  );
  assert.throws(
    () =>
      hardenMcpPayload({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "mcp_smart_fetch",
          arguments: {
            url: "https://example.com",
            options: { cookies: [{ name: "session", value: "secret" }] }
          }
        }
      }),
    /option 'cookies' is disabled/
  );
  for (const option of [
    "cookies",
    "extra_headers",
    "proxy",
    "solve_cloudflare",
    "useragent"
  ]) {
    assert.throws(
      () =>
        hardenMcpPayload({
          jsonrpc: "2.0",
          id: 30,
          method: "tools/call",
          params: {
            name: "mcp_smart_fetch",
            arguments: {
              url: "https://example.com",
              [option]: "promoted-top-level-value"
            }
          }
        }),
      new RegExp(`option '${option}' is disabled`)
    );
  }
  const credentialUrl = new URL("https://example.com");
  credentialUrl.username = "fixture-user";
  credentialUrl.password = "fixture-password";

  assert.throws(
    () =>
      hardenMcpPayload({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "mcp_screenshot",
          arguments: { url: credentialUrl.href }
        }
      }),
    /cannot contain credentials/
  );
});

test("relay returns a bounded error when Hound is unavailable", async (t) => {
  const relay = createHoundRelay({
    upstreamHost: "127.0.0.1",
    upstreamPort: 1
  });
  const relayPort = await listen(relay);
  t.after(() => close(relay));

  const response = await fetch(`http://127.0.0.1:${relayPort}/mcp`, {
    method: "POST",
    body: "{}"
  });
  assert.equal(response.status, 502);
  assert.equal(await response.text(), "Hound is unavailable\n");
});

test("relay closes upstream event streams when the MCP client disconnects", async (t) => {
  let markUpstreamClosed;
  let activeUpstreamResponse;
  const upstreamClosed = new Promise((resolve) => {
    markUpstreamClosed = resolve;
  });
  const upstream = createServer((_request, response) => {
    activeUpstreamResponse = response;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: connected\n\n");
    response.once("close", () => markUpstreamClosed(true));
  });
  const upstreamPort = await listen(upstream);
  const relay = createHoundRelay({
    upstreamHost: "127.0.0.1",
    upstreamPort
  });
  const relayPort = await listen(relay);
  t.after(async () => {
    activeUpstreamResponse?.destroy();
    await close(relay);
    await close(upstream);
  });

  await new Promise((resolve, reject) => {
    const client = requestHttp(
      {
        host: "127.0.0.1",
        port: relayPort,
        path: "/mcp",
        headers: { accept: "text/event-stream" }
      },
      (response) => {
        response.once("data", () => {
          client.destroy();
          response.destroy();
          resolve();
        });
      }
    );
    client.once("error", (error) => {
      if (error.code === "ECONNRESET") resolve();
      else reject(error);
    });
    client.end();
  });

  assert.equal(
    await Promise.race([
      upstreamClosed,
      new Promise((resolve) => setTimeout(() => resolve(false), 500))
    ]),
    true
  );
});

test("relay closes the downstream response when Hound aborts a stream", async (t) => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: partial\n\n");
    setImmediate(() => response.destroy());
  });
  const upstreamPort = await listen(upstream);
  const relay = createHoundRelay({
    upstreamHost: "127.0.0.1",
    upstreamPort
  });
  const relayPort = await listen(relay);
  t.after(async () => {
    await close(relay);
    await close(upstream);
  });

  const downstreamClosed = await new Promise((resolve, reject) => {
    const client = requestHttp(
      {
        host: "127.0.0.1",
        port: relayPort,
        path: "/mcp",
        headers: { accept: "text/event-stream" }
      },
      (response) => {
        response.once("aborted", () => resolve(true));
        response.once("error", () => resolve(true));
        response.once("end", () => resolve(false));
        response.resume();
      }
    );
    client.once("error", reject);
    client.end();
  });

  assert.equal(downstreamClosed, true);
});
