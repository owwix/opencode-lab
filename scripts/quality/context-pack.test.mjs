import assert from "node:assert/strict";
import test from "node:test";
import { buildContextPack } from "./context-pack.mjs";

test("context packs prioritize relevant paths and exclude credential files", () => {
  const pack = buildContextPack({
    task: "debug the gateway route",
    paths: [
      "README.md",
      "docker/agent-gateway/gateway.mjs",
      ".dev.vars",
      "opencode.env",
      "src/other.ts"
    ],
    changedFiles: ["docker/agent-gateway/gateway.test.mjs"]
  });
  assert.equal(pack.protocol, "context-pack/v1");
  assert.equal(pack.candidateFiles.includes(".dev.vars"), false);
  assert.equal(
    pack.candidateFiles.includes("docker/agent-gateway/gateway.mjs"),
    true
  );
  assert.equal(
    pack.changedFiles.includes("docker/agent-gateway/gateway.test.mjs"),
    true
  );
});
