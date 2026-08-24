import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { safeGitOutput } from "../security/safe-git.mjs";

test("safe diff omits credential-class history and staged deletions", () => {
  const workspace = mkdtempSync(join(tmpdir(), "safe-git-"));
  const previous = process.cwd();
  try {
    execFileSync("git", ["init", "--quiet", workspace]);
    execFileSync("git", ["-C", workspace, "config", "user.name", "Test"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "test@example.com"
    ]);
    writeFileSync(join(workspace, ".dev.vars"), "LIVE_TOKEN=must-not-cross\n");
    writeFileSync(join(workspace, "safe.js"), "export const value = 1;\n");
    execFileSync("git", ["-C", workspace, "add", ".dev.vars", "safe.js"]);
    execFileSync("git", ["-C", workspace, "commit", "--quiet", "-m", "base"]);
    unlinkSync(join(workspace, ".dev.vars"));
    writeFileSync(join(workspace, "safe.js"), "export const value = 2;\n");
    writeFileSync(
      join(workspace, "new-safe.js"),
      "export const added = true;\n"
    );
    process.chdir(workspace);

    const output = safeGitOutput("diff");
    assert.match(output, /value = 2/u);
    assert.match(output, /added = true/u);
    assert.doesNotMatch(output, /LIVE_TOKEN|must-not-cross|\.dev\.vars/u);
    const status = safeGitOutput("status");
    assert.match(status, /safe\.js|new-safe\.js/u);
    assert.doesNotMatch(status, /\.dev\.vars/u);
  } finally {
    process.chdir(previous);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("safe file listing removes credential-class paths", () => {
  const workspace = mkdtempSync(join(tmpdir(), "safe-git-files-"));
  const previous = process.cwd();
  try {
    execFileSync("git", ["init", "--quiet", workspace]);
    writeFileSync(join(workspace, ".env"), "SECRET=value\n");
    writeFileSync(join(workspace, "source.ts"), "export {};\n");
    execFileSync("git", ["-C", workspace, "add", "-f", ".env", "source.ts"]);
    process.chdir(workspace);
    assert.equal(safeGitOutput("files"), "source.ts\n");
  } finally {
    process.chdir(previous);
    rmSync(workspace, { recursive: true, force: true });
  }
});
