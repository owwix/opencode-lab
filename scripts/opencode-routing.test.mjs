import assert from "node:assert/strict";
import test from "node:test";
import { parseTaskInvocation, routeTask } from "./opencode-routing.mjs";

const policy = {
  defaultModel: "cloudflare-ai/default",
  models: {
    "cloudflare-ai/fast": {},
    "cloudflare-ai/vision": {},
    "cloudflare-ai/frontier": {}
  },
  lanes: {
    standard: { model: "cloudflare-ai/fast" },
    vision: { model: "cloudflare-ai/vision" },
    frontier: { model: "cloudflare-ai/frontier" }
  },
  rules: [
    {
      agent: "research",
      model: "cloudflare-ai/fast",
      priority: 70,
      reason: "research"
    },
    {
      taskPattern: "(?:image|screenshot)",
      model: "cloudflare-ai/vision",
      priority: 85,
      reason: "vision"
    },
    {
      taskPattern: "(?:security|deploy)",
      model: "cloudflare-ai/frontier",
      priority: 90,
      reason: "high risk"
    }
  ]
};
const packSet = {
  managedRuns: {
    slides: {
      agent: "slides",
      aliases: ["slides", "presentation"],
      capabilities: [],
      model: "cloudflare-ai/frontier",
      packId: "example-pack",
      qualityContract: "coding",
      taskPatterns: ["pitch|slides"],
      taskPrefix: "Slides: ",
      tooling: ["research", "design"]
    }
  }
};

test("parses a task and infers a specialist agent", () => {
  assert.deepEqual(parseTaskInvocation(["task", "research", "the", "market"]), {
    agent: "research",
    model: undefined,
    auto: false,
    task: "research the market"
  });
});

test("specialist agents route only when contributed by a loaded pack", () => {
  assert.equal(
    parseTaskInvocation(["task", "update", "the", "presentation"]).agent,
    "lab"
  );
  assert.equal(
    parseTaskInvocation(["task", "update", "the", "pitch"], { packSet }).agent,
    "slides"
  );
  const route = routeTask(
    parseTaskInvocation(["task", "update", "the", "slides"], { packSet }),
    policy,
    { packSet }
  );
  assert.equal(route.model, "cloudflare-ai/frontier");
  assert.match(route.reason, /example-pack/u);
});

test("routes once at the task boundary and exposes the selected lane", () => {
  const route = routeTask(
    parseTaskInvocation(["task", "create", "a", "screenshot"]),
    policy
  );
  assert.equal(route.agent, "lab");
  assert.equal(route.model, "cloudflare-ai/vision");
  assert.equal(route.lane, "vision");
  assert.match(route.reason, /vision/u);
});

test("explicit overrides are retained but must be registered", () => {
  const route = routeTask(
    parseTaskInvocation([
      "task",
      "--agent",
      "slides",
      "--model",
      "cloudflare-ai/frontier",
      "update",
      "slides"
    ]),
    policy
  );
  assert.equal(route.model, "cloudflare-ai/frontier");
  assert.equal(route.source, "explicit override");
  assert.throws(
    () =>
      routeTask(
        parseTaskInvocation([
          "task",
          "--model",
          "cloudflare-ai/unknown",
          "work"
        ]),
        policy
      ),
    /not in quality/u
  );
});
