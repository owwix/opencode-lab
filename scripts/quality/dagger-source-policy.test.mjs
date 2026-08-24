import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  unlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  isSensitiveSnapshotPath,
  listDependencySnapshotFiles,
  listTrackedSensitiveFiles,
  listVerificationSnapshotFiles
} from "./dagger-source-policy.mjs";

test("classifies credential files but retains documented examples", () => {
  for (const path of [
    ".dev.vars",
    ".env.production",
    "docker.env",
    "nested/opencode.env",
    ".agent-trash/deletion-123/recovery-manifest.json",
    ".npmrc",
    "credentials.json",
    "keys/signing.pem",
    "id_ed25519"
  ]) {
    assert.equal(isSensitiveSnapshotPath(path), true, path);
  }
  for (const path of [
    ".dev.vars.example",
    ".env.example",
    "opencode.env.example",
    "credentials.example.json",
    "env.d.ts",
    "scripts/sync-worker-secrets.mjs"
  ]) {
    assert.equal(isSensitiveSnapshotPath(path), false, path);
  }
});

test(
  "repository does not track credential-class files",
  {
    skip: !existsSync(resolve(process.cwd(), ".git"))
      ? "source-only verification snapshots intentionally omit Git metadata"
      : false
  },
  () => {
    assert.deepEqual(
      listTrackedSensitiveFiles(process.cwd()),
      [],
      "Remove listed files from the Git index without deleting the local copies, then rotate any exposed credentials."
    );
  }
);

test("snapshot includes changed source while excluding ignored and tracked canaries", () => {
  const workspace = mkdtempSync(join(tmpdir(), "dagger-source-policy-"));
  try {
    execFileSync("git", ["init", "--quiet", workspace]);
    writeFileSync(join(workspace, ".gitignore"), "ignored.txt\n.dev.vars\n");
    writeFileSync(join(workspace, "safe.js"), "export default true;\n");
    writeFileSync(join(workspace, ".dev.vars"), "CANARY=must-not-cross\n");
    execFileSync("git", [
      "-C",
      workspace,
      "add",
      "-f",
      ".gitignore",
      "safe.js",
      ".dev.vars"
    ]);
    writeFileSync(join(workspace, "deleted.js"), "removed\n");
    execFileSync("git", ["-C", workspace, "add", "deleted.js"]);
    unlinkSync(join(workspace, "deleted.js"));
    writeFileSync(join(workspace, "new-safe.js"), "export default 2;\n");
    writeFileSync(join(workspace, "ignored.txt"), "must-not-cross\n");

    assert.deepEqual(listTrackedSensitiveFiles(workspace), [".dev.vars"]);
    assert.deepEqual(listVerificationSnapshotFiles(workspace), [
      ".gitignore",
      "new-safe.js",
      "safe.js"
    ]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("snapshot rejects symlinks instead of following them", () => {
  const workspace = mkdtempSync(join(tmpdir(), "dagger-source-link-"));
  try {
    execFileSync("git", ["init", "--quiet", workspace]);
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "real.js"), "safe\n");
    symlinkSync("real.js", join(workspace, "src", "linked.js"));
    execFileSync("git", ["-C", workspace, "add", "src"]);
    assert.throws(
      () => listVerificationSnapshotFiles(workspace),
      /reject symbolic links/u
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("dependency snapshot ignores ordinary source edits when install is manifest-only", () => {
  const workspace = mkdtempSync(join(tmpdir(), "dagger-dependencies-"));
  try {
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } })
    );
    writeFileSync(join(workspace, "package-lock.json"), "{}\n");
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "app.js"), "export default true;\n");
    assert.deepEqual(
      listDependencySnapshotFiles(workspace, [
        "package-lock.json",
        "package.json",
        "src/app.js"
      ]),
      ["package-lock.json", "package.json"]
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("dependency snapshot stays conservative for install hooks", () => {
  const workspace = mkdtempSync(join(tmpdir(), "dagger-install-hook-"));
  try {
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ scripts: { postinstall: "node scripts/setup.mjs" } })
    );
    const files = ["package.json", "scripts/setup.mjs", "src/app.js"];
    assert.deepEqual(listDependencySnapshotFiles(workspace, files), files);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
