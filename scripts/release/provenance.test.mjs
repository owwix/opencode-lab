import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInventory,
  checkInventory,
  readPolicy,
  releaseFiles
} from "./provenance.mjs";

test("every release file receives an allowed provenance classification", () => {
  const policy = readPolicy();
  const inventory = buildInventory();
  assert.deepEqual(
    inventory.files.map((entry) => entry.path),
    releaseFiles()
  );
  assert.equal(
    inventory.files.some((entry) => entry.classification === "unknown"),
    false
  );
  for (const entry of inventory.files) {
    assert.ok(policy.sources[entry.source]);
    assert.ok(entry.license);
    if (entry.classification === "attributed-upstream") {
      assert.ok(entry.notice);
    }
  }
});

test("committed inventory exactly matches the release tree", () => {
  assert.doesNotThrow(() => checkInventory());
});
