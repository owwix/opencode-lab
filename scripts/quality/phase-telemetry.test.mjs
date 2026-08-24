import assert from "node:assert/strict";
import test from "node:test";
import { mergeTelemetry, recordPhaseTelemetry } from "./phase-telemetry.mjs";

function emptyRun() {
  return {
    telemetry: mergeTelemetry(),
    implementationTelemetry: mergeTelemetry(),
    reviewTelemetry: mergeTelemetry()
  };
}

test("phase telemetry keeps implementation and review budgets independent", () => {
  const run = emptyRun();
  recordPhaseTelemetry(run, "implementation", {
    tokens: 100,
    cost: 0.1,
    toolCalls: 3,
    models: ["builder"]
  });
  recordPhaseTelemetry(run, "review", {
    tokens: 25,
    cost: 0.02,
    toolCalls: 1,
    models: ["reviewer"]
  });

  assert.equal(run.implementationTelemetry.tokens, 100);
  assert.equal(run.reviewTelemetry.tokens, 25);
  assert.equal(run.telemetry.tokens, 125);
  assert.deepEqual(run.implementationTelemetry.models, ["builder"]);
  assert.deepEqual(run.reviewTelemetry.models, ["reviewer"]);
});

test("phase telemetry retains only the newest one hundred requests", () => {
  const current = {
    requests: Array.from({ length: 99 }, (_, index) => ({ index }))
  };
  const merged = mergeTelemetry(current, {
    requests: [{ index: 99 }, { index: 100 }]
  });

  assert.equal(merged.requests.length, 100);
  assert.equal(merged.requests[0].index, 1);
  assert.equal(merged.requests.at(-1).index, 100);
});

test("phase telemetry rejects unknown phases", () => {
  assert.throws(
    () => recordPhaseTelemetry(emptyRun(), "verification", {}),
    /Unsupported telemetry phase/u
  );
});
