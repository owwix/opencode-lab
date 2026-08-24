#!/usr/bin/env node
/**
 * Container-safe preview checker. Prints the host Mac URLs for whatever is
 * listening on 0.0.0.0/127.0.0.1 ports 3000 and 3001 inside this container.
 */
import http from "node:http";
import net from "node:net";

const map = [
  { container: 3000, host: 3100, label: "primary" },
  { container: 3001, host: 3101, label: "secondary" }
];

function probe(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.end();
      resolve(true);
    });
    socket.setTimeout(800, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

function httpCode(port, path = "/") {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path, timeout: 1200 },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }
    );
    req.on("error", () => resolve(0));
    req.on("timeout", () => {
      req.destroy();
      resolve(0);
    });
  });
}

const rows = [];
for (const entry of map) {
  const up = await probe(entry.container);
  const code = up ? await httpCode(entry.container) : 0;
  rows.push({ ...entry, up, code });
}

console.log("OpenCode local preview map");
console.log("App previews use host 3100/3101 only.");
console.log("");
for (const row of rows) {
  const status = row.up ? `up (http ${row.code || "n/a"})` : "not listening";
  console.log(
    `${row.label.padEnd(10)} container :${row.container} -> http://127.0.0.1:${row.host}  [${status}]`
  );
}

const anyUp = rows.some((row) => row.up);
if (!anyUp) {
  console.log("");
  console.log(
    "No app server is listening on :3000/:3001 yet. Start one bound to 0.0.0.0, or use docker compose with 127.0.0.1:3100/3101 publishes."
  );
  process.exitCode = 1;
} else {
  console.log("");
  console.log(
    "Tell the user to open the http://127.0.0.1:310x URLs above on their Mac."
  );
}
