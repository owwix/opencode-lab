import assert from "node:assert/strict";
import test from "node:test";
import { prunePlan, runPrune } from "./prune.mjs";

test("prune only reports recognized legacy Lab volumes by default", () => {
  const plan = prunePlan({
    volumeNames: [
      "opencode-lab-opencode-state",
      "cf-coding-agent_opencode-state",
      "legacy-project_data",
      "postgres-data"
    ]
  });
  assert.deepEqual(plan.volumes, ["cf-coding-agent_opencode-state"]);
  assert.equal(plan.apply, false);
  assert.match(plan.message, /No volumes deleted/u);
});

test("prune deletes only exact revalidated names after --apply", () => {
  const calls = [];
  const runDocker = (args) => {
    calls.push(args);
    if (args[1] === "ls")
      return "cf-coding-agent_opencode-state\npostgres-data\n";
    assert.deepEqual(args, [
      "volume",
      "rm",
      "--",
      "cf-coding-agent_opencode-state"
    ]);
    return "cf-coding-agent_opencode-state\n";
  };
  const plan = runPrune({ apply: true, runDocker });
  assert.deepEqual(plan.volumes, ["cf-coding-agent_opencode-state"]);
  assert.equal(calls.length, 3);
});
