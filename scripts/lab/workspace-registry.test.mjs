import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  lookupRegistration,
  projectIdentity,
  readHostRegistry,
  recordProjectHelper,
  registerBackgroundLaunch,
  registerForegroundLaunch,
  unregisterBackgroundLaunch,
  unregisterForegroundLaunch
} from "./workspace-registry.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lab-registry-"));
  const one = join(root, "one");
  const two = join(root, "two");
  mkdirSync(one);
  mkdirSync(two);
  return { root, one, two, registryPath: join(root, "registry.json") };
}

function launch(registryPath, identity, overrides = {}) {
  return registerForegroundLaunch(
    {
      registryPath,
      identity,
      launchId: overrides.launchId ?? "launch_one_12345678",
      sessionId: overrides.sessionId ?? "session_one_12345678",
      runId: overrides.runId ?? "run_one_12345678",
      profile: overrides.profile ?? "fast",
      pid: overrides.pid ?? 111,
      registrationToken: overrides.token ?? "a".repeat(32),
      conflictAction: overrides.conflictAction ?? "reject",
      now: () => overrides.now ?? "2026-08-24T10:00:00.000Z"
    },
    {
      alive: overrides.alive ?? (() => true),
      stop: overrides.stop ?? (() => {})
    }
  );
}

test("two projects receive stable isolated identities and one foreground", () => {
  const state = fixture();
  try {
    const first = projectIdentity(state.one);
    const second = projectIdentity(state.two);
    assert.notEqual(first.projectId, second.projectId);
    assert.equal(launch(state.registryPath, first).registered, true);
    const conflict = launch(state.registryPath, second, {
      launchId: "launch_two_12345678",
      token: "b".repeat(32)
    });
    assert.equal(conflict.registered, false);
    assert.equal(conflict.action, "conflict");
    assert.equal(conflict.existing.projectId, first.projectId);
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test("explicit stop replaces foreground while resume preserves it", () => {
  const state = fixture();
  try {
    const first = projectIdentity(state.one);
    const second = projectIdentity(state.two);
    launch(state.registryPath, first);
    const resumed = launch(state.registryPath, second, {
      launchId: "launch_two_resume",
      token: "b".repeat(32),
      conflictAction: "resume"
    });
    assert.equal(resumed.action, "resume");
    const stopped = [];
    const replaced = launch(state.registryPath, second, {
      launchId: "launch_two_stop",
      sessionId: "session_two_12345678",
      token: "c".repeat(32),
      conflictAction: "stop",
      stop: (pid) => stopped.push(pid)
    });
    assert.equal(replaced.registered, true);
    assert.deepEqual(stopped, [111]);
    assert.equal(
      readHostRegistry(state.registryPath).foreground.projectId,
      second.projectId
    );
    assert.equal(
      readHostRegistry(state.registryPath).projects[first.projectId].sessions
        .session_one_12345678,
      undefined
    );
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test("registration token binds helper identity and unregisters exact launch", () => {
  const state = fixture();
  try {
    const identity = projectIdentity(state.one);
    launch(state.registryPath, identity, { pid: process.pid });
    const registration = lookupRegistration(state.registryPath, "a".repeat(32));
    assert.equal(registration.canonicalPath, identity.canonicalPath);
    assert.equal(lookupRegistration(state.registryPath, "z".repeat(32)), null);
    assert.equal(
      recordProjectHelper({
        registryPath: state.registryPath,
        projectId: identity.projectId,
        launchId: "launch_one_12345678",
        helper: "gallery",
        pid: 222,
        port: 3110,
        workspaceHash: identity.workspaceHash
      }),
      true
    );
    assert.equal(
      readHostRegistry(state.registryPath).projects[identity.projectId].helpers
        .gallery.pid,
      222
    );
    assert.equal(
      unregisterForegroundLaunch({
        registryPath: state.registryPath,
        launchId: "launch_one_12345678",
        registrationToken: "a".repeat(32)
      }),
      true
    );
    assert.equal(readHostRegistry(state.registryPath).foreground, null);
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test("background runs coexist without taking foreground ownership", () => {
  const state = fixture();
  try {
    const foreground = projectIdentity(state.one);
    const background = projectIdentity(state.two);
    launch(state.registryPath, foreground, { pid: process.pid });
    registerBackgroundLaunch({
      registryPath: state.registryPath,
      identity: background,
      launchId: "launch_background_123456",
      sessionId: "session_background_123456",
      runId: "run_background_123456",
      profile: "research",
      pid: process.pid,
      registrationToken: "d".repeat(32)
    });
    assert.equal(
      readHostRegistry(state.registryPath).foreground.projectId,
      foreground.projectId
    );
    assert.equal(
      lookupRegistration(state.registryPath, "d".repeat(32)).projectId,
      background.projectId
    );
    assert.equal(
      unregisterBackgroundLaunch({
        registryPath: state.registryPath,
        projectId: background.projectId,
        sessionId: "session_background_123456",
        registrationToken: "d".repeat(32)
      }),
      true
    );
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test("sequential project launches never reuse another project's helper identity", () => {
  const state = fixture();
  try {
    const first = projectIdentity(state.one);
    const second = projectIdentity(state.two);
    launch(state.registryPath, first, { pid: process.pid });
    recordProjectHelper({
      registryPath: state.registryPath,
      projectId: first.projectId,
      launchId: "launch_one_12345678",
      helper: "gallery",
      pid: 221,
      port: 3110,
      workspaceHash: first.workspaceHash
    });
    unregisterForegroundLaunch({
      registryPath: state.registryPath,
      launchId: "launch_one_12345678",
      registrationToken: "a".repeat(32)
    });

    launch(state.registryPath, second, {
      launchId: "launch_two_12345678",
      sessionId: "session_two_12345678",
      runId: "run_two_12345678",
      pid: process.pid,
      token: "b".repeat(32)
    });
    recordProjectHelper({
      registryPath: state.registryPath,
      projectId: second.projectId,
      launchId: "launch_two_12345678",
      helper: "gallery",
      pid: 222,
      port: 3110,
      workspaceHash: second.workspaceHash
    });

    const registry = readHostRegistry(state.registryPath);
    assert.equal(registry.foreground.projectId, second.projectId);
    assert.equal(
      registry.projects[first.projectId].helpers.gallery.workspaceHash,
      first.workspaceHash
    );
    assert.equal(
      registry.projects[second.projectId].helpers.gallery.workspaceHash,
      second.workspaceHash
    );
    assert.notEqual(
      registry.projects[first.projectId].helpers.gallery.workspaceHash,
      registry.projects[second.projectId].helpers.gallery.workspaceHash
    );
    assert.equal(lookupRegistration(state.registryPath, "a".repeat(32)), null);
    assert.equal(
      lookupRegistration(state.registryPath, "b".repeat(32)).projectId,
      second.projectId
    );
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});
