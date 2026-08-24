import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  readCompatibilityManifest,
  runCompatibilityChecks,
  runtimeProbeCommands,
  validateCompatibilityManifest,
  verifyPinnedSources
} from "./compatibility.mjs";
import { validateProjectContract } from "./project-contract.mjs";

test("versions.lock binds every required component, schema, and adapter", () => {
  const manifest = readCompatibilityManifest();
  assert.deepEqual(validateCompatibilityManifest(manifest), {
    passed: true,
    errors: []
  });
  const source = verifyPinnedSources(process.cwd(), manifest);
  assert.equal(source.passed, true, JSON.stringify(source));
  assert.ok(Object.keys(manifest.schemas).length >= 7);
  assert.deepEqual(Object.keys(manifest.configAdapters).sort(), [
    "opencodeJson",
    "projectJson",
    "tuiJson"
  ]);
  assert.equal(
    validateProjectContract(
      JSON.parse(
        readFileSync(
          join(process.cwd(), manifest.configAdapters.projectJson.fixture),
          "utf8"
        )
      )
    ).schemaVersion,
    1
  );
});

test("runtime checks exercise the real digest-pinned OpenCode binary and config", () => {
  const manifest = readCompatibilityManifest();
  const commands = runtimeProbeCommands(process.cwd(), manifest);
  assert.equal(commands.length, 2);
  assert.ok(
    commands.every((probe) =>
      probe.args.includes(manifest.components.opencode.image)
    )
  );
  const outputs = [
    {
      status: 0,
      stdout: `opencode ${manifest.components.opencode.version}\n`,
      stderr: ""
    },
    { status: 0, stdout: '{"provider":{"cloudflare":{}}}\n', stderr: "" }
  ];
  const result = runCompatibilityChecks({
    runtime: true,
    runner() {
      return outputs.shift();
    }
  });
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.probes.length, 2);
});
