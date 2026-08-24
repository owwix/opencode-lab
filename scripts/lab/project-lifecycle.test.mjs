import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  formatLifecycleStatus,
  formatRecentProjects,
  lifecycleSnapshot,
  prepareNewWorkspace,
  resolveRecentProject,
  stopForegroundWorkspace
} from "./project-lifecycle.mjs";
import {
  projectIdentity,
  readHostRegistry,
  registerBackgroundLaunch,
  registerForegroundLaunch
} from "./workspace-registry.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lab-lifecycle-"));
  const one = join(root, "one");
  const two = join(root, "two");
  mkdirSync(one);
  mkdirSync(two);
  return { root, one, two, registryPath: join(root, "registry.json") };
}

function registerForeground(state, overrides = {}) {
  return registerForegroundLaunch(
    {
      registryPath: state.registryPath,
      identity: projectIdentity(overrides.path ?? state.one),
      launchId: overrides.launchId ?? "launch_one_12345678",
      sessionId: overrides.sessionId ?? "session_one_12345678",
      runId: overrides.runId ?? "run_one_12345678",
      profile: overrides.profile ?? "fast",
      pid: overrides.pid ?? 101,
      registrationToken: overrides.token ?? "a".repeat(32),
      now: () => overrides.openedAt ?? "2026-08-24T10:00:00.000Z"
    },
    { alive: overrides.alive ?? (() => true) }
  );
}

test("snapshot reconciles stale sessions and orders recent projects", () => {
  const state = fixture();
  try {
    registerForeground(state, { pid: 101 });
    registerBackgroundLaunch({
      registryPath: state.registryPath,
      identity: projectIdentity(state.two),
      launchId: "launch_two_12345678",
      sessionId: "session_two_12345678",
      runId: "run_two_12345678",
      profile: "research",
      pid: 202,
      registrationToken: "b".repeat(32),
      now: () => "2026-08-24T11:00:00.000Z"
    });

    const snapshot = lifecycleSnapshot(state.registryPath, {
      alive: (pid) => pid === 202
    });
    assert.equal(snapshot.foreground, null);
    assert.equal(snapshot.backgroundSessions.length, 1);
    assert.equal(snapshot.backgroundSessions[0].pid, 202);
    assert.deepEqual(
      snapshot.projects.map((project) => project.name),
      ["two", "one"]
    );
    assert.equal(snapshot.projects[0].sessionCount, 1);
    assert.equal(snapshot.projects[1].sessionCount, 0);
    assert.equal(readHostRegistry(state.registryPath).foreground, null);
    assert.match(formatRecentProjects(snapshot), /^1\. two/mu);
    assert.match(formatLifecycleStatus(snapshot), /Background sessions: 1/u);
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test("recent project selectors support index, ID, name, and path", () => {
  const projects = [
    {
      projectId: "project_one",
      name: "one",
      canonicalPath: "/tmp/one",
      exists: true
    },
    {
      projectId: "project_two",
      name: "two",
      canonicalPath: "/tmp/two",
      exists: true
    },
    {
      projectId: "project_missing",
      name: "missing",
      canonicalPath: "/tmp/missing",
      exists: false
    }
  ];
  const snapshot = { projects };
  assert.equal(resolveRecentProject(snapshot).projectId, "project_one");
  assert.equal(resolveRecentProject(snapshot, "2").projectId, "project_two");
  assert.equal(
    resolveRecentProject(snapshot, "project_one").canonicalPath,
    "/tmp/one"
  );
  assert.equal(resolveRecentProject(snapshot, "two").projectId, "project_two");
  assert.equal(
    resolveRecentProject(snapshot, "/tmp/two").projectId,
    "project_two"
  );
  assert.throws(
    () => resolveRecentProject(snapshot, "3"),
    /path no longer exists/u
  );
  assert.throws(
    () => resolveRecentProject(snapshot, "4"),
    /index is out of range/u
  );
  assert.throws(
    () => resolveRecentProject(snapshot, "missing"),
    /path no longer exists/u
  );
});

test("new workspace creation is exact and rejects unsafe targets", () => {
  const state = fixture();
  try {
    const created = prepareNewWorkspace("fresh", { cwd: state.root });
    assert.deepEqual(created, {
      path: resolve(state.root, "fresh"),
      created: true
    });
    assert.equal(existsSync(created.path), true);
    assert.deepEqual(prepareNewWorkspace(created.path), {
      path: created.path,
      created: false
    });
    writeFileSync(join(created.path, "README.md"), "occupied\n");
    assert.throws(
      () => prepareNewWorkspace(created.path),
      /target is not empty/u
    );
    assert.throws(
      () => prepareNewWorkspace(join(state.root, "absent", "nested")),
      /Parent directory does not exist/u
    );
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test("stop terminates only the verified registered launcher", () => {
  const state = fixture();
  try {
    let running = true;
    const pid = 303;
    const expectedLauncher = "/opt/opencode-lab/scripts/opencode.mjs";
    registerForeground(state, { pid, alive: () => true });
    const signals = [];
    const result = stopForegroundWorkspace(
      { registryPath: state.registryPath, expectedLauncher, timeoutMs: 200 },
      {
        alive: () => running,
        readCommand: () => `/usr/bin/node ${expectedLauncher}`,
        signal: (signaledPid, name) => {
          signals.push([signaledPid, name]);
          running = false;
        },
        wait: () => {}
      }
    );
    assert.equal(result.stopped, true);
    assert.deepEqual(signals, [[pid, "SIGTERM"]]);
    assert.equal(readHostRegistry(state.registryPath).foreground, null);
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test("stop refuses a PID whose command does not match the launcher", () => {
  const state = fixture();
  try {
    registerForeground(state, { pid: 404, alive: () => true });
    let signaled = false;
    assert.throws(
      () =>
        stopForegroundWorkspace(
          {
            registryPath: state.registryPath,
            expectedLauncher: "/opt/opencode-lab/scripts/opencode.mjs"
          },
          {
            alive: () => true,
            readCommand: () => "/usr/bin/node unrelated.mjs",
            signal: () => {
              signaled = true;
            },
            wait: () => {}
          }
        ),
      /Refusing to stop PID 404/u
    );
    assert.equal(signaled, false);
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});
