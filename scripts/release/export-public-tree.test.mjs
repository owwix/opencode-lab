import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { exportPublicTree } from "./export-public-tree.mjs";
import { checkInventory } from "./provenance.mjs";

test("public export copies only classified files into one clean root commit", () => {
  const parent = mkdtempSync(
    path.join(os.tmpdir(), "opencode-lab-export-test-")
  );
  const destination = path.join(parent, "public");
  const inventory = checkInventory();
  const result = exportPublicTree(destination, { initialize: true });
  assert.equal(result.files, inventory.files.length);

  const commitCount = spawnSync("git", ["rev-list", "--count", "--all"], {
    cwd: destination,
    encoding: "utf8"
  });
  assert.equal(commitCount.status, 0);
  assert.equal(commitCount.stdout.trim(), "1");

  const provenanceCheck = spawnSync(
    "node",
    ["scripts/release/provenance.mjs", "check"],
    { cwd: destination, encoding: "utf8" }
  );
  assert.equal(provenanceCheck.status, 0, provenanceCheck.stderr);

  const tracked = spawnSync("git", ["ls-files"], {
    cwd: destination,
    encoding: "utf8"
  });
  assert.deepEqual(
    tracked.stdout.trim().split("\n").sort(),
    inventory.files.map((entry) => entry.path).sort()
  );
  assert.match(
    readFileSync(path.join(destination, "LICENSE"), "utf8"),
    /Apache License/
  );
  assert.match(
    readFileSync(path.join(destination, "README.md"), "utf8"),
    /not affiliated with, endorsed by/
  );
});

test("public export rejects broad and populated destinations", () => {
  assert.throws(() => exportPublicTree(os.homedir()), /unsafe/);
  assert.throws(() => exportPublicTree(process.cwd()), /(unsafe|inside|empty)/);
});
