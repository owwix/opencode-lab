import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const checkpoint = fileURLToPath(new URL("./checkpoint.mjs", import.meta.url));

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function runCheckpoint(cwd, args) {
  return execFileSync(process.execPath, [checkpoint, ...args], {
    encoding: "utf8",
    env: { ...process.env, OPENCODE_WORKSPACE: cwd }
  }).trim();
}

test("lab checkpoint create and rewind restores WIP file", () => {
  const root = mkdtempSync(join(tmpdir(), "lab-cp-"));
  try {
    git(root, ["init"]);
    git(root, ["config", "user.email", "lab@example.com"]);
    git(root, ["config", "user.name", "Lab"]);
    writeFileSync(join(root, "a.txt"), "base\n");
    git(root, ["add", "a.txt"]);
    git(root, ["commit", "-m", "base"]);

    writeFileSync(join(root, "a.txt"), "wip\n");
    const created = JSON.parse(runCheckpoint(root, ["create", "before-bad"]));
    assert.equal(created.dirty, true);
    assert.ok(created.stashSha);

    writeFileSync(join(root, "a.txt"), "oops\n");
    runCheckpoint(root, ["rewind", created.id.slice(0, 12)]);
    const restored = execFileSync("cat", [join(root, "a.txt")], {
      encoding: "utf8"
    });
    assert.equal(restored, "wip\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lab browser-verify reports JSON for unreachable URL", async () => {
  const browser = fileURLToPath(
    new URL("./browser-verify.mjs", import.meta.url)
  );
  let code = 0;
  let out = "";
  try {
    out = execFileSync(process.execPath, [browser, "http://127.0.0.1:9"], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCODE_WORKSPACE: tmpdir(),
        LAB_BROWSER_HTTP_ONLY: "1",
        LAB_BROWSER_RELAY_URL: "http://127.0.0.1:1"
      }
    });
  } catch (error) {
    code = error.status ?? 1;
    out = error.stdout?.toString?.() || "";
  }
  assert.equal(code, 1);
  const parsed = JSON.parse(out);
  assert.equal(parsed.results[0].ok, false);
});
