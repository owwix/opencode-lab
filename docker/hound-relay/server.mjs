import { createHoundRelay } from "./relay.mjs";

function envPort(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a valid TCP port.`);
  }
  return value;
}

const host = process.env.HOUND_RELAY_HOST || "0.0.0.0";
const port = envPort("HOUND_RELAY_PORT", 8765);
const upstreamHost = process.env.HOUND_UPSTREAM_HOST || "hound-firewall";
const upstreamPort = envPort("HOUND_UPSTREAM_PORT", 8765);
const server = createHoundRelay({ upstreamHost, upstreamPort });

server.listen(port, host, () => {
  console.log(`Hound MCP relay listening on http://${host}:${port}/mcp`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
