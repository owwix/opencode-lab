import assert from "node:assert/strict";
import test from "node:test";
import { validateModelRegistry } from "./model-registry.mjs";

test("routing registry matches the OpenCode provider and gateway", () => {
  const result = validateModelRegistry({
    routingPolicy: "quality/model-routing.json",
    openCodeConfig: "opencode.json"
  });
  assert.deepEqual(result, { passed: true, errors: [] });
});
