import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createImplementationCheckpoint } from "./implementation-checkpoint.mjs";

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8"
  }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "implementation-checkpoint-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.com");
  writeFileSync(join(root, "README.md"), "seed\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "fixture");
  return { root, baseSha: git(root, "rev-parse", "HEAD") };
}

test("controller checkpoint commits exactly the declared implementation files", () => {
  const { root, baseSha } = fixture();
  try {
    writeFileSync(join(root, "README.md"), "verified change\n");
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "src", "feature.js"),
      "export const ready = true;\n"
    );
    const result = createImplementationCheckpoint({
      workspace: root,
      baseSha,
      runId: "run_fixture",
      task: "Implement verified fixture",
      checkpointNonce: "fixturecheckpoint0001",
      declaredFiles: ["README.md", "src/feature.js"]
    });

    assert.equal(result.clean, true);
    assert.notEqual(result.headSha, baseSha);
    assert.deepEqual(result.changedFiles, ["README.md", "src/feature.js"]);
    assert.equal(git(root, "status", "--porcelain=v1"), "");
    assert.deepEqual(
      git(root, "diff", "--name-only", `${baseSha}...${result.headSha}`).split(
        "\n"
      ),
      ["README.md", "src/feature.js"]
    );
    assert.equal(
      git(root, "show", `${result.headSha}:src/feature.js`),
      "export const ready = true;"
    );
    const recovered = createImplementationCheckpoint({
      workspace: root,
      baseSha,
      runId: "run_fixture",
      task: "Implement verified fixture",
      checkpointNonce: "fixturecheckpoint0001",
      declaredFiles: ["README.md", "src/feature.js"]
    });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.headSha, result.headSha);
    assert.throws(
      () =>
        createImplementationCheckpoint({
          workspace: root,
          baseSha,
          runId: "run_fixture",
          task: "Implement verified fixture",
          checkpointNonce: "differentcheckpoint1",
          declaredFiles: ["README.md", "src/feature.js"]
        }),
      /not the controller checkpoint/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evidence manifests bind to the content commit without dirtying HEAD", () => {
  const { root, baseSha } = fixture();
  try {
    mkdirSync(join(root, "artifacts", "quality"), { recursive: true });
    writeFileSync(join(root, "artifact.txt"), "evidence\n");
    writeFileSync(
      join(root, "artifacts", "quality", "evidence-manifest.json"),
      `${JSON.stringify({ schemaVersion: 1, commitSha: baseSha })}\n`
    );
    const result = createImplementationCheckpoint({
      workspace: root,
      baseSha,
      runId: "run_evidence",
      task: "Create evidence",
      checkpointNonce: "evidencecheckpoint01",
      declaredFiles: [
        "artifact.txt",
        "artifacts/quality/evidence-manifest.json"
      ]
    });

    assert.notEqual(result.contentSha, result.headSha);
    const manifest = JSON.parse(
      readFileSync(
        join(root, "artifacts", "quality", "evidence-manifest.json"),
        "utf8"
      )
    );
    assert.equal(manifest.commitSha, result.contentSha);
    assert.equal(git(root, "status", "--porcelain=v1"), "");
    assert.deepEqual(result.changedFiles, [
      "artifact.txt",
      "artifacts/quality/evidence-manifest.json"
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint fails closed on undeclared or credential-shaped changes", () => {
  const mismatch = fixture();
  try {
    writeFileSync(join(mismatch.root, "README.md"), "changed\n");
    assert.throws(
      () =>
        createImplementationCheckpoint({
          workspace: mismatch.root,
          baseSha: mismatch.baseSha,
          runId: "run_mismatch",
          task: "Mismatch",
          checkpointNonce: "mismatchcheckpoint01",
          declaredFiles: ["different.txt"]
        }),
      /Declared implementation files mismatch/u
    );
    assert.equal(git(mismatch.root, "rev-parse", "HEAD"), mismatch.baseSha);
  } finally {
    rmSync(mismatch.root, { recursive: true, force: true });
  }

  const sensitive = fixture();
  try {
    writeFileSync(join(sensitive.root, "token.txt"), `ghp_${"a".repeat(32)}\n`);
    assert.throws(
      () =>
        createImplementationCheckpoint({
          workspace: sensitive.root,
          baseSha: sensitive.baseSha,
          runId: "run_sensitive",
          task: "Sensitive",
          checkpointNonce: "sensitivecheckpoint1",
          declaredFiles: ["token.txt"]
        }),
      /credential-shaped content/u
    );
    assert.equal(git(sensitive.root, "rev-parse", "HEAD"), sensitive.baseSha);
  } finally {
    rmSync(sensitive.root, { recursive: true, force: true });
  }
});
