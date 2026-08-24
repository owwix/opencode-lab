import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyAutoApproveArgs,
  readLabPreferences,
  writeLabPreferences
} from "./opencode-preferences.mjs";

test("sticky --auto selects broad-auto without forwarding raw auto", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-prefs-"));
  const path = join(dir, "preferences.json");
  try {
    assert.deepEqual(applyAutoApproveArgs(["--auto", "tui"], { path }), [
      "tui"
    ]);
    assert.equal(readLabPreferences(path).approvalMode, "broad-auto");
    assert.deepEqual(applyAutoApproveArgs(["tui"], { path }), ["tui"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--no-auto clears sticky auto-approve", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-prefs-"));
  const path = join(dir, "preferences.json");
  try {
    writeLabPreferences({ approvalMode: "broad-auto" }, path);
    assert.deepEqual(applyAutoApproveArgs(["--no-auto", "tui"], { path }), [
      "tui"
    ]);
    assert.equal(readLabPreferences(path).approvalMode, "ask");
    assert.equal(
      readFileSync(path, "utf8").includes('"approvalMode": "ask"'),
      true
    );
    assert.deepEqual(applyAutoApproveArgs(["tui"], { path }), ["tui"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("safe-auto is the public default and explicit mode is host-persisted", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-prefs-"));
  const path = join(dir, "preferences.json");
  try {
    assert.equal(readLabPreferences(path).approvalMode, "safe-auto");
    assert.deepEqual(
      applyAutoApproveArgs(["--approval-mode", "safe-auto", "tui"], { path }),
      ["tui"]
    );
    assert.equal(readLabPreferences(path).approvalMode, "safe-auto");
    assert.throws(
      () => applyAutoApproveArgs(["--approval-mode", "unbounded"], { path }),
      /must be one of/iu
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
