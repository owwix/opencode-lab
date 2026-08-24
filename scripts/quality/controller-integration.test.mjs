import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const controller = join(harnessRoot, "scripts", "quality-controller.mjs");

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
    ...options
  });
  if (result.error) throw result.error;
  return result;
}

function controllerCommand(stateRoot, args) {
  return command(process.execPath, [controller, ...args], {
    cwd: harnessRoot,
    env: { ...process.env, QUALITY_STATE_ROOT: stateRoot }
  });
}

function parseControllerJson(output) {
  const start = output.indexOf("{");
  assert.notEqual(start, -1, `No JSON in controller output: ${output}`);
  return JSON.parse(output.slice(start));
}

test("prepare is idempotent and cancellation is safe to retry", () => {
  const fixture = mkdtempSync(join(tmpdir(), "quality-controller-"));
  const source = join(fixture, "source");
  const state = join(fixture, "state");
  const worktrees = join(fixture, "worktrees");
  mkdirSync(source);
  mkdirSync(state);
  try {
    assert.equal(command("git", ["init", "-q", source]).status, 0);
    writeFileSync(
      join(source, "package.json"),
      `${JSON.stringify({ scripts: { test: "node --test" } })}\n`
    );
    command("git", ["-C", source, "add", "package.json"]);
    assert.equal(
      command("git", [
        "-C",
        source,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "fixture"
      ]).status,
      0
    );
    const request = [
      "prepare",
      "--workspace",
      source,
      "--worktree-root",
      worktrees,
      "--task",
      "Change one bounded fixture",
      "--idempotency-key",
      "fixture-request-0001",
      "--max-tokens",
      "1000"
    ];
    const first = controllerCommand(state, request);
    assert.equal(first.status, 0, first.stderr);
    const prepared = parseControllerJson(first.stdout);
    assert.equal(prepared.idempotentReplay, false);
    const durable = JSON.parse(
      readFileSync(join(state, "runs", prepared.id, "service.json"), "utf8")
    );
    assert.equal(durable.kind, "individual");
    assert.equal(durable.controllerRunId, prepared.id);
    assert.equal(
      command("git", [
        "-C",
        source,
        "rev-parse",
        `refs/opencode-lab/runs/${prepared.id}`
      ]).stdout.trim(),
      command("git", ["-C", source, "rev-parse", "HEAD"]).stdout.trim()
    );

    const second = controllerCommand(state, request);
    assert.equal(second.status, 0, second.stderr);
    const replay = parseControllerJson(second.stdout);
    assert.equal(replay.id, prepared.id);
    assert.equal(replay.idempotentReplay, true);

    const mismatch = controllerCommand(state, [
      ...request.slice(0, request.indexOf("Change one bounded fixture")),
      "Different request",
      ...request.slice(request.indexOf("Change one bounded fixture") + 1)
    ]);
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /different managed-run request/u);

    const cancelled = controllerCommand(state, [
      "cancel",
      "--run",
      prepared.id,
      "--reason",
      "integration test"
    ]);
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.equal(parseControllerJson(cancelled.stdout).state, "cancelled");
    const cancelledAgain = controllerCommand(state, [
      "cancel",
      "--run",
      prepared.id
    ]);
    assert.equal(cancelledAgain.status, 0, cancelledAgain.stderr);
    assert.equal(parseControllerJson(cancelledAgain.stdout).state, "cancelled");

    const persisted = JSON.parse(
      readFileSync(join(state, "runs", prepared.id, "run.json"), "utf8")
    );
    assert.equal(persisted.state, "cancelled");
    assert.ok(persisted.revision >= 2);
    assert.equal(persisted.limits.maxTokens, 1000);
    assert.deepEqual(
      readdirSync(join(state, "runs", prepared.id)).filter(
        (name) => name.endsWith(".tmp") || name.endsWith(".lock")
      ),
      []
    );

    const cleanup = controllerCommand(state, ["cleanup", "--run", prepared.id]);
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.ok(
      JSON.parse(
        readFileSync(join(state, "runs", prepared.id, "service.json"), "utf8")
      ).cleanedAt
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("cleanup preserves a failed worktree with unpublished changes", () => {
  const fixture = mkdtempSync(join(tmpdir(), "quality-preserve-failed-"));
  const source = join(fixture, "source");
  const state = join(fixture, "state");
  const worktrees = join(fixture, "worktrees");
  mkdirSync(source);
  mkdirSync(state);
  try {
    assert.equal(command("git", ["init", "-q", source]).status, 0);
    writeFileSync(join(source, "README.md"), "seed\n");
    command("git", ["-C", source, "add", "README.md"]);
    assert.equal(
      command("git", [
        "-C",
        source,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "fixture"
      ]).status,
      0
    );
    const preparedResult = controllerCommand(state, [
      "prepare",
      "--workspace",
      source,
      "--worktree-root",
      worktrees,
      "--task",
      "Preserve a failed unpublished fixture"
    ]);
    assert.equal(preparedResult.status, 0, preparedResult.stderr);
    const prepared = parseControllerJson(preparedResult.stdout);
    writeFileSync(join(prepared.workspace, "unpublished.txt"), "preserve me\n");
    assert.equal(
      controllerCommand(state, ["cancel", "--run", prepared.id]).status,
      0
    );
    const cleanup = controllerCommand(state, ["cleanup", "--run", prepared.id]);
    assert.equal(cleanup.status, 1);
    assert.match(cleanup.stderr, /uncommitted changes|must be preserved/u);
    assert.equal(existsSync(prepared.workspace), true);
    assert.equal(
      readFileSync(join(prepared.workspace, "unpublished.txt"), "utf8"),
      "preserve me\n"
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("prepare fails before creating a worktree when review policy is unavailable", () => {
  const fixture = mkdtempSync(join(tmpdir(), "quality-review-preflight-"));
  const source = join(fixture, "source");
  const state = join(fixture, "state");
  const worktrees = join(fixture, "worktrees");
  mkdirSync(source);
  mkdirSync(state);
  try {
    assert.equal(command("git", ["init", "-q", source]).status, 0);
    writeFileSync(
      join(source, "package.json"),
      `${JSON.stringify({ scripts: { test: "node --test" } })}\n`
    );
    command("git", ["-C", source, "add", "package.json"]);
    assert.equal(
      command("git", [
        "-C",
        source,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "fixture"
      ]).status,
      0
    );

    const result = controllerCommand(state, [
      "prepare",
      "--workspace",
      source,
      "--worktree-root",
      worktrees,
      "--task",
      "Change authentication permission handling"
    ]);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /Review policy unavailable before implementation/u
    );
    assert.equal(existsSync(worktrees), false);
    assert.deepEqual(readdirSync(join(state, "runs")), []);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("finalize is idempotent and binds a clean controller commit", () => {
  const fixture = mkdtempSync(join(tmpdir(), "quality-finalize-"));
  const source = join(fixture, "source");
  const state = join(fixture, "state");
  const worktrees = join(fixture, "worktrees");
  mkdirSync(source);
  mkdirSync(state);
  try {
    assert.equal(command("git", ["init", "-q", source]).status, 0);
    writeFileSync(join(source, "README.md"), "seed\n");
    command("git", ["-C", source, "add", "README.md"]);
    assert.equal(
      command("git", [
        "-C",
        source,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "fixture"
      ]).status,
      0
    );
    const preparedResult = controllerCommand(state, [
      "prepare",
      "--workspace",
      source,
      "--worktree-root",
      worktrees,
      "--task",
      "Checkpoint one file",
      "--skip-review"
    ]);
    assert.equal(preparedResult.status, 0, preparedResult.stderr);
    const prepared = parseControllerJson(preparedResult.stdout);
    writeFileSync(join(prepared.workspace, "README.md"), "managed change\n");

    const first = controllerCommand(state, ["finalize", "--run", prepared.id]);
    assert.equal(first.status, 0, first.stderr);
    const checkpoint = parseControllerJson(first.stdout);
    assert.deepEqual(checkpoint.changedFiles, ["README.md"]);
    assert.notEqual(checkpoint.headSha, prepared.baseSha);
    assert.equal(
      command("git", [
        "-C",
        prepared.workspace,
        "status",
        "--porcelain=v1"
      ]).stdout.trim(),
      ""
    );

    const second = controllerCommand(state, ["finalize", "--run", prepared.id]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(
      parseControllerJson(second.stdout).headSha,
      checkpoint.headSha
    );

    const runPath = join(state, "runs", prepared.id, "run.json");
    const passed = JSON.parse(readFileSync(runPath, "utf8"));
    passed.state = "passed";
    passed.verification = { passed: true, sha: checkpoint.headSha };
    passed.review = {
      passed: true,
      sha: checkpoint.headSha,
      distinctFromImplementation: true
    };
    writeFileSync(runPath, `${JSON.stringify(passed, null, 2)}\n`);
    const adopted = controllerCommand(state, ["adopt", "--run", prepared.id]);
    assert.equal(adopted.status, 0, adopted.stderr);
    assert.equal(
      parseControllerJson(adopted.stdout).headSha,
      checkpoint.headSha
    );
    assert.equal(
      command("git", ["-C", source, "rev-parse", "HEAD"]).stdout.trim(),
      checkpoint.headSha
    );
    const adoptedAgain = controllerCommand(state, [
      "adopt",
      "--run",
      prepared.id
    ]);
    assert.equal(adoptedAgain.status, 0, adoptedAgain.stderr);
    assert.equal(
      parseControllerJson(adoptedAgain.stdout).headSha,
      checkpoint.headSha
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("failed managed runs return a nonzero process status", () => {
  const fixture = mkdtempSync(join(tmpdir(), "quality-failed-status-"));
  const source = join(fixture, "source");
  const state = join(fixture, "state");
  const worktrees = join(fixture, "worktrees");
  mkdirSync(source);
  mkdirSync(state);
  try {
    assert.equal(command("git", ["init", "-q", source]).status, 0);
    writeFileSync(join(source, "README.md"), "seed\n");
    command("git", ["-C", source, "add", "README.md"]);
    assert.equal(
      command("git", [
        "-C",
        source,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "fixture"
      ]).status,
      0
    );
    const result = controllerCommand(state, [
      "run",
      "--workspace",
      source,
      "--worktree-root",
      worktrees,
      "--task",
      "Produce no changes",
      "--skip-agent",
      "--skip-review",
      "--verify",
      "true"
    ]);
    assert.equal(result.status, 1, result.stdout || result.stderr);
    const prepared = parseControllerJson(result.stdout);
    const persisted = JSON.parse(
      readFileSync(join(state, "runs", prepared.id, "run.json"), "utf8")
    );
    assert.equal(persisted.state, "failed");
    assert.equal(persisted.implementationCheckpoint.passed, false);
    const durable = JSON.parse(
      readFileSync(join(state, "runs", prepared.id, "service.json"), "utf8")
    );
    assert.equal(durable.state, "failed");
    assert.equal(durable.attempts.length, 1);
    assert.equal(durable.attempts[0].status, "failed");
    assert.ok(durable.attempts[0].finishedAt);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("cancel terminates the persisted active process group", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "quality-cancel-"));
  const state = join(fixture, "state");
  const runId = "integration-cancel-0001";
  const runDirectory = join(state, "runs", runId);
  mkdirSync(runDirectory, { recursive: true });
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"
    ],
    { detached: true, stdio: "ignore" }
  );
  child.unref();
  const leaseId = "integration-lease-0001";
  const identity = {
    pid: child.pid,
    processGroupId: child.pid,
    startedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 60_000).toISOString()
  };
  writeFileSync(
    join(runDirectory, "run.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      revision: 0,
      id: runId,
      state: "implementing",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      limits: {
        implementationTimeoutMs: 60_000,
        verificationTimeoutMs: 60_000,
        reviewTimeoutMs: 60_000,
        maxOutputBytes: 10_000,
        maxTokens: 1_000,
        maxCost: 1,
        maxToolCalls: 10,
        heartbeatMs: 1_000,
        terminationGraceMs: 50
      },
      worker: {
        leaseId,
        ...identity,
        status: "running",
        operation: "test"
      },
      timeline: []
    })}\n`
  );
  writeFileSync(
    join(runDirectory, "heartbeat.json"),
    `${JSON.stringify({
      runId,
      leaseId,
      workerPid: child.pid,
      heartbeatAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      phase: { runId, leaseId, phase: "implementation", ...identity },
      status: "running"
    })}\n`
  );
  writeFileSync(
    join(runDirectory, "phase-process.json"),
    `${JSON.stringify({ runId, leaseId, phase: "implementation", ...identity })}\n`
  );
  try {
    const cancelled = controllerCommand(state, [
      "cancel",
      "--run",
      runId,
      "--reason",
      "stop integration child"
    ]);
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.equal(parseControllerJson(cancelled.stdout).state, "cancelled");
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    assert.throws(() => process.kill(child.pid, 0), /ESRCH/u);
  } finally {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The cancellation path should already have terminated it.
    }
    rmSync(fixture, { recursive: true, force: true });
  }
});
