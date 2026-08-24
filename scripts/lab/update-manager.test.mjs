import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  activateRelease,
  applyActiveImageEnvironment,
  backupLabState,
  candidateImagePlan,
  defaultReleaseImages,
  dispatchActiveRelease,
  readActiveRelease,
  rollbackRelease
} from "./update-manager.mjs";

function paths(root) {
  return {
    stateRoot: join(root, "state"),
    configRoot: join(root, "config"),
    registryPath: join(root, "state", "host-registry.json"),
    preferencesPath: join(root, "config", "preferences.json"),
    releasesRoot: join(root, "state", "releases"),
    updatesRoot: join(root, "state", "updates"),
    backupsRoot: join(root, "backups")
  };
}

function release(root, name, commit) {
  const path = join(root, name);
  mkdirSync(join(path, "scripts"), { recursive: true });
  writeFileSync(join(path, "scripts", "opencode-entry.mjs"), "// launcher\n");
  return { path, commit, images: defaultReleaseImages() };
}

test("candidate image staging uses commit-specific tags for every service", () => {
  const commit = "a".repeat(40);
  const plan = candidateImagePlan("/repo", commit);
  assert.equal(plan.builds.length, 7);
  assert.ok(
    Object.values(plan.images).every((image) =>
      image.endsWith(`candidate-${commit.slice(0, 12)}`)
    )
  );
});

test("activation and rollback are atomic pointers with separate state backups", () => {
  const root = mkdtempSync(join(tmpdir(), "lab-update-state-"));
  const hostPaths = paths(root);
  mkdirSync(hostPaths.stateRoot, { recursive: true });
  mkdirSync(hostPaths.configRoot, { recursive: true });
  writeFileSync(hostPaths.registryPath, '{"projects":{}}\n');
  writeFileSync(hostPaths.preferencesPath, '{"approvalMode":"safe-auto"}\n');
  const initial = release(root, "initial", "1".repeat(40));
  const first = release(root, "first", "2".repeat(40));
  const second = release(root, "second", "3".repeat(40));
  const backup = backupLabState({ paths: hostPaths, label: "before-first" });
  assert.equal(existsSync(join(backup, "state", "host-registry.json")), true);
  const activatedFirst = activateRelease({
    paths: hostPaths,
    release: { ...first, backup },
    previous: initial
  });
  activateRelease({
    paths: hostPaths,
    release: second,
    previous: activatedFirst
  });
  const rolledBack = rollbackRelease({
    packageRoot: initial.path,
    paths: hostPaths
  });
  assert.equal(rolledBack.commit, first.commit);
  assert.equal(readActiveRelease(hostPaths).path, first.path);
  assert.match(rolledBack.backup, /before-rollback/u);
  assert.equal(
    readFileSync(hostPaths.registryPath, "utf8"),
    '{"projects":{}}\n'
  );
  rmSync(root, { recursive: true, force: true });
});

test("active releases dispatch through their launcher and inject only image variables", () => {
  const root = mkdtempSync(join(tmpdir(), "lab-update-dispatch-"));
  const hostPaths = paths(root);
  const current = release(root, "current", "4".repeat(40));
  const active = release(root, "active", "5".repeat(40));
  active.images.OPENCODE_LAB_OPENCODE_IMAGE = "candidate/opencode:test";
  activateRelease({ paths: hostPaths, release: active, previous: current });
  const env = { KEEP: "yes" };
  let invocation = null;
  const status = dispatchActiveRelease({
    packageRoot: current.path,
    args: ["version"],
    paths: hostPaths,
    env,
    runner(command, args, options) {
      invocation = { command, args, options };
      return { status: 0 };
    }
  });
  assert.equal(status, 0);
  assert.equal(invocation.args.at(-1), "version");
  assert.equal(
    invocation.options.env.OPENCODE_LAB_OPENCODE_IMAGE,
    "candidate/opencode:test"
  );
  assert.equal(invocation.options.env.KEEP, "yes");
  const clean = {};
  applyActiveImageEnvironment(
    { images: { UNRELATED: "no", OPENCODE_LAB_PREVIEW_IMAGE: "preview:test" } },
    clean
  );
  assert.deepEqual(clean, { OPENCODE_LAB_PREVIEW_IMAGE: "preview:test" });
  rmSync(root, { recursive: true, force: true });
});
