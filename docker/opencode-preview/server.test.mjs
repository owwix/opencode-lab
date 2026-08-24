import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import test from "node:test";

import { listenPreviewRoutes, proxyConnection } from "./server.mjs";

function unusedPort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test("preview relay forwards TCP bytes to the upstream app port", async () => {
  const upstreamPort = await unusedPort();
  const listenPort = await unusedPort();
  const received = [];
  const upstream = net.createServer((socket) => {
    socket.on("data", (chunk) => received.push(chunk.toString("utf8")));
    socket.end("pong");
  });
  upstream.listen(upstreamPort, "127.0.0.1");
  await once(upstream, "listening");

  const relays = listenPreviewRoutes([
    { listen: listenPort, upstreamHost: "127.0.0.1", upstreamPort }
  ]);
  await Promise.all(relays.map((server) => once(server, "listening")));

  const client = net.connect(listenPort, "127.0.0.1");
  const chunks = [];
  client.on("data", (chunk) => chunks.push(chunk.toString("utf8")));
  client.write("ping");
  await once(client, "end");

  assert.equal(received.join(""), "ping");
  assert.equal(chunks.join(""), "pong");

  for (const server of relays) server.close();
  upstream.close();
  await Promise.all(
    [...relays, upstream].map((server) => once(server, "close"))
  );
  assert.equal(typeof proxyConnection, "function");
});
