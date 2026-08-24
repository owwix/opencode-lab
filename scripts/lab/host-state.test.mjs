import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  adoptLegacyHostFile,
  labConfigRoot,
  labHostPaths,
  labStateRoot,
  projectHostState
} from "./host-state.mjs";

test("host state stays outside projects and follows platform conventions", () => {
  assert.equal(
    labStateRoot({ env: {}, home: "/Users/alex", platform: "darwin" }),
    "/Users/alex/Library/Application Support/OpenCode Lab/state"
  );
  assert.equal(
    labConfigRoot({ env: {}, home: "/home/alex", platform: "linux" }),
    "/home/alex/.config/opencode-lab"
  );
  const paths = labHostPaths({
    env: {
      OPENCODE_LAB_STATE_ROOT: "/tmp/lab-state",
      OPENCODE_LAB_CONFIG_ROOT: "/tmp/lab-config"
    }
  });
  assert.equal(paths.registryPath, "/tmp/lab-state/host-registry.json");
  assert.equal(paths.preferencesPath, "/tmp/lab-config/preferences.json");
  assert.equal(
    projectHostState("project_0123456789abcdef01234567", {
      env: { OPENCODE_LAB_STATE_ROOT: "/tmp/lab-state" }
    }),
    "/tmp/lab-state/projects/project_0123456789abcdef01234567"
  );
});

test("legacy registry and preferences are copied once without following links", () => {
  const directory = mkdtempSync(join(tmpdir(), "lab-legacy-state-"));
  const source = join(directory, "preferences.json");
  const destination = join(directory, "host", "preferences.json");
  writeFileSync(source, '{"approvalMode":"broad-auto"}\n');
  assert.equal(adoptLegacyHostFile(source, destination), true);
  assert.equal(adoptLegacyHostFile(source, destination), false);
  assert.match(readFileSync(destination, "utf8"), /broad-auto/u);

  const link = join(directory, "preferences-link.json");
  symlinkSync(source, link);
  assert.throws(
    () => adoptLegacyHostFile(link, join(directory, "bad.json")),
    /unsafe legacy Lab state/u
  );
});

test("host state overrides must be absolute", () => {
  assert.throws(
    () => labStateRoot({ env: { OPENCODE_LAB_STATE_ROOT: ".quality" } }),
    /absolute host path/u
  );
  assert.throws(() => projectHostState("bad"), /valid stable project ID/u);
});
