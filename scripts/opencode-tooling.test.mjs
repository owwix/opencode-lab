import assert from "node:assert/strict";
import test from "node:test";
import {
  agentArgument,
  parseLauncherFlags,
  selectTooling,
  withToolingConfig
} from "./opencode-tooling.mjs";

test("launcher-only flags are stripped before OpenCode arguments", () => {
  assert.deepEqual(
    parseLauncherFlags([
      "run",
      "--with-research",
      "--agent",
      "research",
      "--full-tools",
      "--rebuild",
      "prompt"
    ]),
    {
      args: ["run", "--agent", "research", "prompt"],
      requested: { research: true, design: false, full: true },
      rebuild: true
    }
  );
});

test("agent lanes and explicit flags select only requested tool stacks", () => {
  const none = { research: false, design: false, full: false };
  const packSet = {
    managedRuns: {
      slides: {
        agent: "slides",
        tooling: ["research", "design"]
      }
    }
  };
  assert.deepEqual(selectTooling({ requested: none, agent: "lab" }), {
    research: false,
    design: false
  });
  assert.deepEqual(selectTooling({ requested: none, agent: "research" }), {
    research: true,
    design: false
  });
  assert.deepEqual(
    selectTooling({ requested: none, agent: "slides", packSet }),
    { research: true, design: true }
  );
  assert.deepEqual(
    selectTooling({
      requested: { research: false, design: false, full: true },
      agent: "lab"
    }),
    { research: true, design: true }
  );
  assert.deepEqual(
    selectTooling({
      requested: { research: false, design: true, full: false },
      agent: "lab"
    }),
    { research: false, design: true }
  );
});

test("agent option detection supports managed non-task runs", () => {
  assert.equal(agentArgument(["run", "--agent", "slides", "prompt"]), "slides");
  assert.equal(agentArgument(["run", "prompt"]), null);
});

test("runtime config disables optional MCPs by default", () => {
  const config = {
    mcp: {
      hound: { enabled: true, url: "http://hound-relay:8765/mcp" },
      "open-design": { enabled: true, type: "local" },
      quality: { enabled: true }
    }
  };
  const fast = withToolingConfig(config, { research: false, design: false });
  assert.equal(fast.mcp.hound.enabled, false);
  assert.equal(fast.mcp["open-design"].enabled, false);
  assert.equal(fast.mcp.quality.enabled, true);
  assert.equal(config.mcp.hound.enabled, true, "base config is not mutated");
});
