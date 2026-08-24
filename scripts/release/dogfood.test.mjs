import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { dogfoodRepositories } from "./dogfood.mjs";

test("beta dogfood requires five distinct healthy repositories", () => {
  const root = mkdtempSync(join(tmpdir(), "lab-dogfood-"));
  const repositories = [];
  for (let index = 0; index < 5; index += 1) {
    const workspace = join(root, `project-${index}`);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(
      join(workspace, "package.json"),
      `${JSON.stringify({ scripts: { test: "node --test" } })}\n`
    );
    writeFileSync(
      join(workspace, "package-lock.json"),
      '{"lockfileVersion":3}\n'
    );
    const git = spawnSync("git", ["init", "-q", workspace]);
    assert.equal(git.status, 0);
    repositories.push(workspace);
  }
  const result = dogfoodRepositories(repositories);
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.repositories.length, 5);
  assert.throws(
    () => dogfoodRepositories(repositories.slice(0, 4)),
    /five distinct/u
  );
  rmSync(root, { recursive: true, force: true });
});
