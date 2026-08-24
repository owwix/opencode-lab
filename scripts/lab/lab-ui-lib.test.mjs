import assert from "node:assert/strict";
import test from "node:test";
import {
  agentStripLine,
  IMPLEMENTATION_LANES,
  loadedPacks,
  resolveMountName,
  startupMountHint
} from "../../.opencode/plugins/lab-ui-lib.mjs";

test("resolveMountName prefers OPENCODE_WORKSPACE_NAME", () => {
  assert.equal(
    resolveMountName({
      workspaceName: "sample-app",
      directory: "/tmp/other"
    }),
    "sample-app"
  );
  assert.equal(
    resolveMountName({ directory: "/Users/me/Projects/dnkoperator" }),
    "dnkoperator"
  );
});

test("agent strip and startup hint include only loaded pack agents", () => {
  const env = {
    OPENCODE_LAB_PACKS_JSON: JSON.stringify([
      {
        id: "example-pack",
        label: "Example",
        version: "0.1.0",
        agents: ["slides", "campaign"],
        commands: ["slides"]
      }
    ])
  };
  assert.equal(loadedPacks(env)[0].id, "example-pack");
  assert.match(
    agentStripLine({ workspaceName: "product", env }),
    /packs:slides\/campaign/u
  );
  assert.equal(
    agentStripLine({ workspaceName: "product", env: {} }).includes("packs:"),
    false
  );
  assert.match(
    startupMountHint({ workspaceName: "product", env }),
    /^Mount: product · Agents: fast\/lab\/deep\//u
  );
});

test("ordinary coding lanes expose their fixed Tab models", () => {
  assert.deepEqual(IMPLEMENTATION_LANES, [
    {
      agent: "fast",
      model: "GLM-4.7 Flash",
      use: "small, bounded, low-risk changes"
    },
    {
      agent: "lab",
      model: "GPT-OSS 120B",
      use: "everyday implementation"
    },
    {
      agent: "deep",
      model: "Kimi K2.7 Code",
      use: "complex or high-risk implementation"
    }
  ]);
});
