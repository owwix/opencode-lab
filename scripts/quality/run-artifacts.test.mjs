import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildRunArtifactIndex,
  pruneRunArtifactCache,
  readRunArtifactIndex
} from "./run-artifacts.mjs";

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "run-artifacts-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  git(workspace, ["init", "-q"]);
  git(workspace, ["config", "user.name", "Lab Test"]);
  git(workspace, ["config", "user.email", "lab@example.invalid"]);
  writeFileSync(join(workspace, "file.txt"), "before\n");
  git(workspace, ["add", "file.txt"]);
  git(workspace, ["commit", "-qm", "base"]);
  const baseSha = git(workspace, ["rev-parse", "HEAD"]);
  writeFileSync(join(workspace, "file.txt"), "after\n");
  git(workspace, ["commit", "-qam", "change"]);
  const headSha = git(workspace, ["rev-parse", "HEAD"]);
  return { root, workspace, baseSha, headSha };
}

test("one run index covers evidence, patches, research, images, browser captures, previews, and PR receipts", () => {
  const { root, workspace, baseSha, headSha } = fixture();
  const runId = "run_artifact_index";
  const directory = join(root, "runs", runId);
  mkdirSync(join(workspace, "artifacts", "research"), { recursive: true });
  mkdirSync(join(workspace, "artifacts", "marketing"), { recursive: true });
  mkdirSync(join(workspace, "artifacts", "lab-browser"), { recursive: true });
  mkdirSync(directory, { recursive: true });
  const research = join(workspace, "artifacts", "research", "brief.md");
  const image = join(workspace, "artifacts", "marketing", "hero.png");
  const browser = join(workspace, "artifacts", "lab-browser", "page.png");
  const verification = join(directory, "verification.log");
  const review = join(directory, "review-01.jsonl");
  writeFileSync(research, "# Brief\n");
  writeFileSync(image, "png");
  writeFileSync(browser, "png");
  writeFileSync(verification, "passed\n");
  writeFileSync(review, '{"passed":true}\n');

  const durable = {
    id: runId,
    projectId: "project_artifacts",
    state: "passed",
    git: {
      source: workspace,
      worktree: workspace,
      baseSha,
      headSha,
      changedFiles: ["file.txt"],
      branch: "agent/artifacts"
    },
    externalActions: {
      preparePr: { receipt: { headSha, url: "https://example.invalid/pr/1" } }
    }
  };
  const index = buildRunArtifactIndex({
    root,
    durable,
    controller: {
      verification: { log: verification },
      review: { logs: [review] },
      research: { stagedPath: research },
      preview: { url: "https://preview.example.invalid/run" },
      publishing: {
        pr: { url: "https://example.invalid/pr/1", headSha, base: "main" }
      }
    }
  });

  assert.equal(index.projectId, "project_artifacts");
  for (const category of [
    "patch",
    "research",
    "image",
    "browser-capture",
    "verification",
    "review",
    "preview",
    "pull-request",
    "pr-receipt"
  ]) {
    assert.ok(index.categories[category] >= 1, category);
  }
  assert.equal(readRunArtifactIndex({ root, runId }).runId, runId);
  assert.equal(index.retention.unpublishedWorkProtected, false);
  rmSync(root, { recursive: true, force: true });
});

test("retention deletes only an expired Lab cache and refuses unpublished work", () => {
  const { root, workspace, baseSha, headSha } = fixture();
  const runId = "run_retention";
  const cache = join(root, "runs", runId, "artifact-cache");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "copy.bin"), "cached");
  const old = new Date("2025-01-01T00:00:00.000Z");
  utimesSync(cache, old, old);
  const durable = {
    id: runId,
    projectId: "project_retention",
    state: "passed",
    git: {
      source: workspace,
      worktree: workspace,
      baseSha,
      headSha,
      changedFiles: ["file.txt"]
    },
    externalActions: {}
  };
  assert.throws(
    () =>
      pruneRunArtifactCache({
        root,
        durable,
        retentionDays: 1,
        now: Date.parse("2026-01-01T00:00:00.000Z")
      }),
    /unpublished work/u
  );
  assert.equal(existsSync(cache), true);
  const result = pruneRunArtifactCache({
    root,
    durable: {
      ...durable,
      externalActions: { preparePr: { receipt: { headSha } } }
    },
    retentionDays: 1,
    now: Date.parse("2026-01-01T00:00:00.000Z")
  });
  assert.equal(result.pruned, true);
  assert.equal(existsSync(cache), false);
  assert.equal(existsSync(workspace), true);
  rmSync(root, { recursive: true, force: true });
});
