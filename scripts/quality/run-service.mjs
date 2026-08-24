/**
 * Durable run service shared by individual, background, parallel, and fleet
 * execution.
 *
 * Records are schema-migrated, project-scoped, path-validated, lock-protected,
 * and atomically written. Attempts, heartbeats, recovery refs, parent/member
 * relationships, and idempotent external-action receipts survive restarts.
 * Reconciliation records interrupted workers and bounds retries; cleanup must
 * preserve dirty or unpublished work. Reference: docs/managed-runs.md.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export const DURABLE_RUN_SCHEMA_VERSION = 1;
export const DURABLE_RUN_KINDS = Object.freeze([
  "individual",
  "background",
  "parallel",
  "fleet"
]);

const TERMINAL_STATES = new Set([
  "passed",
  "failed",
  "cancelled",
  "abandoned",
  "archived",
  "completed"
]);
const ACTIVE_STATES = new Set([
  "queued",
  "prepared",
  "implementing",
  "verifying",
  "reviewing",
  "needs_evidence",
  "running"
]);

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600
  });
  renameSync(temporary, path);
}

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function readLegacyJson(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) {
    throw new Error(`Unsafe legacy durable-run record: ${path}`);
  }
  return readJson(path);
}

function waitSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withLock(path, action, timeoutMs = 5_000) {
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let descriptor;
  while (descriptor === undefined) {
    try {
      descriptor = openSync(path, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() >= deadline)
        throw new Error(`Timed out waiting for durable-run lock: ${path}`);
      try {
        if (Date.now() - statSync(path).mtimeMs > 30_000) unlinkSync(path);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") throw cleanupError;
      }
      waitSync(10);
    }
  }
  let result;
  let actionError;
  try {
    result = action();
  } catch (error) {
    actionError = error;
  }
  let cleanupError;
  try {
    closeSync(descriptor);
  } catch (error) {
    cleanupError = error;
  }
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT" && !cleanupError) cleanupError = error;
  }
  if (actionError) throw actionError;
  if (cleanupError) throw cleanupError;
  return result;
}

function recordPath(root, runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/u.test(String(runId ?? ""))) {
    throw new Error(`Unsafe durable run id: ${runId}`);
  }
  return join(resolve(root), "runs", runId, "service.json");
}

function controllerPath(root, runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/u.test(String(runId ?? ""))) {
    throw new Error(`Unsafe durable run id: ${runId}`);
  }
  return join(resolve(root), "runs", runId, "run.json");
}

function projectHash(source) {
  if (!source) return null;
  const workspaceHash = createHash("sha256")
    .update(resolve(source))
    .digest("hex");
  return `project_${workspaceHash.slice(0, 24)}`;
}

function phaseForState(state) {
  if (state === "prepared" || state === "queued") return "queued";
  if (state === "implementing" || state === "running") return "implementation";
  if (state === "verifying") return "verification";
  if (state === "reviewing") return "review";
  if (state === "needs_evidence") return "evidence";
  if (TERMINAL_STATES.has(state)) return "terminal";
  return "unknown";
}

function normalizeAttempt(attempt, index) {
  return {
    number: Number(attempt?.number ?? index + 1),
    leaseId: attempt?.leaseId ?? null,
    workerPid: attempt?.workerPid ?? null,
    operation: attempt?.operation ?? "run",
    status: attempt?.status ?? "unknown",
    startedAt: attempt?.startedAt ?? null,
    heartbeatAt: attempt?.heartbeatAt ?? null,
    leaseExpiresAt: attempt?.leaseExpiresAt ?? null,
    finishedAt: attempt?.finishedAt ?? null,
    error: attempt?.error ?? null
  };
}

export function migrateDurableRun(record) {
  if (!record || typeof record !== "object")
    throw new Error("Durable run record must be an object.");
  const migrated = {
    ...record,
    schemaVersion: DURABLE_RUN_SCHEMA_VERSION,
    kind: DURABLE_RUN_KINDS.includes(record.kind) ? record.kind : "individual",
    state: record.state ?? "queued",
    phase: record.phase ?? phaseForState(record.state ?? "queued"),
    projectId: record.projectId ?? projectHash(record.source),
    controllerRunId: record.controllerRunId ?? record.id ?? null,
    parentId: record.parentId ?? null,
    memberIds: [...new Set(record.memberIds ?? [])],
    maxAttempts: Math.max(1, Math.min(10, Number(record.maxAttempts) || 3)),
    attempts: (record.attempts ?? []).map(normalizeAttempt),
    heartbeat: record.heartbeat ?? null,
    git: {
      source: record.git?.source ?? record.source ?? null,
      worktree: record.git?.worktree ?? record.workspace ?? null,
      branch: record.git?.branch ?? record.branch ?? null,
      baseSha: record.git?.baseSha ?? record.baseSha ?? null,
      headSha: record.git?.headSha ?? record.headSha ?? null,
      changedFiles: record.git?.changedFiles ?? record.changedFiles ?? [],
      clean: record.git?.clean ?? record.clean ?? null,
      recoveryRef: record.git?.recoveryRef ?? null
    },
    externalActions: record.externalActions ?? {},
    payload: record.payload ?? {},
    createdAt: record.createdAt ?? nowIso(),
    updatedAt: record.updatedAt ?? record.createdAt ?? nowIso(),
    archivedAt: record.archivedAt ?? null,
    cleanedAt: record.cleanedAt ?? null
  };
  delete migrated.workspace;
  delete migrated.branch;
  delete migrated.baseSha;
  delete migrated.headSha;
  delete migrated.changedFiles;
  delete migrated.clean;
  return migrated;
}

function fromControllerRun(run, kind = null) {
  const pr = run.publishing?.pr;
  const adoption = run.adoption;
  const actions = {};
  if (pr?.headSha) {
    actions.preparePr = {
      key: `${pr.base}:${pr.branch}:${pr.headSha}`,
      receipt: pr,
      completedAt: pr.preparedAt ?? run.updatedAt ?? nowIso()
    };
  }
  if (adoption?.headSha) {
    actions.adopt = {
      key: adoption.headSha,
      receipt: adoption,
      completedAt: adoption.adoptedAt ?? run.updatedAt ?? nowIso()
    };
  }
  return migrateDurableRun({
    id: run.id,
    kind: kind ?? run.runKind ?? "individual",
    state: run.state,
    phase: run.worker?.phase ?? phaseForState(run.state),
    task: run.task,
    agent: run.agent,
    model: run.model,
    source: run.source,
    workspace: run.workspace,
    projectId: run.workspacePolicy?.projectId ?? projectHash(run.source),
    controllerRunId: run.id,
    parentId: run.parentRunId ?? null,
    memberIds: run.memberRunIds ?? [],
    maxAttempts: run.maxAttempts ?? 3,
    heartbeat: run.worker
      ? {
          leaseId: run.worker.leaseId ?? null,
          workerPid: run.worker.pid ?? null,
          status: run.worker.status ?? null,
          heartbeatAt: run.worker.heartbeatAt ?? null,
          leaseExpiresAt: run.worker.leaseExpiresAt ?? null
        }
      : null,
    git: {
      source: run.source,
      worktree: run.workspace,
      branch: run.branch,
      baseSha: run.baseSha,
      headSha: run.headSha,
      changedFiles: run.changedFiles ?? [],
      clean: run.clean,
      recoveryRef: run.id ? `refs/opencode-lab/runs/${run.id}` : null
    },
    externalActions: actions,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    archivedAt: run.state === "archived" ? run.updatedAt : null,
    cleanedAt: run.cleanedAt ?? null
  });
}

function persistRecoveryRef(record) {
  const { source, headSha, recoveryRef } = record.git ?? {};
  if (
    !source ||
    !headSha ||
    !recoveryRef ||
    !existsSync(source) ||
    !existsSync(join(source, ".git"))
  )
    return;
  const result = spawnSync(
    "git",
    ["-C", source, "update-ref", recoveryRef, headSha],
    { encoding: "utf8", timeout: 30_000 }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      String(result.stderr || result.stdout || "git update-ref failed").trim()
    );
  }
}

export function createDurableRun({ root, ...input }) {
  if (!input.id) throw new Error("Durable run id is required.");
  if (input.kind && !DURABLE_RUN_KINDS.includes(input.kind))
    throw new Error(`Unsupported durable run kind: ${input.kind}`);
  const path = recordPath(root, input.id);
  return withLock(`${path}.lock`, () => {
    const existing = readJson(path);
    if (existing) return migrateDurableRun(existing);
    const record = migrateDurableRun(input);
    atomicJson(path, record);
    persistRecoveryRef(record);
    return record;
  });
}

export function readDurableRun({ root, runId, migrate = true }) {
  const path = recordPath(root, runId);
  const current = readJson(path);
  if (current) {
    const record = migrateDurableRun(current);
    if (migrate && JSON.stringify(record) !== JSON.stringify(current))
      atomicJson(path, record);
    return record;
  }
  const controller = readJson(controllerPath(root, runId));
  if (!controller) return null;
  const record = fromControllerRun(controller);
  if (migrate) atomicJson(path, record);
  return record;
}

export function updateDurableRun({ root, runId, update }) {
  const path = recordPath(root, runId);
  return withLock(`${path}.lock`, () => {
    const current = readJson(path) ?? readDurableRun({ root, runId });
    if (!current) throw new Error(`Unknown durable run: ${runId}`);
    const next = migrateDurableRun(
      typeof update === "function"
        ? update(structuredClone(current))
        : { ...current, ...update }
    );
    next.id = runId;
    next.updatedAt = nowIso();
    atomicJson(path, next);
    persistRecoveryRef(next);
    return next;
  });
}

export function syncControllerRun({ root, run, kind = null }) {
  const incoming = fromControllerRun(run, kind);
  const path = recordPath(root, run.id);
  return withLock(`${path}.lock`, () => {
    const previous = readJson(path);
    const preserveReconciledLease = Boolean(
      incoming.heartbeat?.leaseId &&
      previous?.payload?.reconciledLeases?.includes(
        incoming.heartbeat.leaseId
      ) &&
      ACTIVE_STATES.has(incoming.state)
    );
    const record = migrateDurableRun({
      ...previous,
      ...incoming,
      state: preserveReconciledLease ? previous.state : incoming.state,
      phase: preserveReconciledLease ? previous.phase : incoming.phase,
      heartbeat: preserveReconciledLease
        ? previous.heartbeat
        : incoming.heartbeat,
      kind: kind ?? previous?.kind ?? incoming.kind,
      attempts: previous?.attempts ?? incoming.attempts,
      parentId: run.parentRunId ?? previous?.parentId ?? null,
      memberIds: run.memberRunIds ?? previous?.memberIds ?? [],
      externalActions: {
        ...(previous?.externalActions ?? {}),
        ...(incoming.externalActions ?? {})
      },
      payload: previous?.payload ?? incoming.payload
    });
    atomicJson(path, record);
    persistRecoveryRef(record);
    return record;
  });
}

export function beginDurableAttempt({
  root,
  runId,
  leaseId,
  workerPid = process.pid,
  operation = "run",
  leaseExpiresAt
}) {
  return updateDurableRun({
    root,
    runId,
    update(record) {
      const attempts = record.attempts ?? [];
      const active = attempts.find(
        (attempt) => attempt.status === "running" && attempt.leaseId === leaseId
      );
      if (active) return record;
      if (attempts.length >= record.maxAttempts) {
        throw new Error(
          `Run ${runId} exhausted its ${record.maxAttempts} attempts.`
        );
      }
      const timestamp = nowIso();
      attempts.push({
        number: attempts.length + 1,
        leaseId,
        workerPid,
        operation,
        status: "running",
        startedAt: timestamp,
        heartbeatAt: timestamp,
        leaseExpiresAt: leaseExpiresAt ?? null,
        finishedAt: null,
        error: null
      });
      record.attempts = attempts;
      record.heartbeat = {
        leaseId,
        workerPid,
        status: "running",
        heartbeatAt: timestamp,
        leaseExpiresAt: leaseExpiresAt ?? null
      };
      return record;
    }
  });
}

export function heartbeatDurableRun({
  root,
  runId,
  leaseId,
  workerPid,
  phase,
  leaseExpiresAt
}) {
  return updateDurableRun({
    root,
    runId,
    update(record) {
      const timestamp = nowIso();
      const attempt = [...record.attempts]
        .reverse()
        .find((item) => item.leaseId === leaseId && item.status === "running");
      if (!attempt) return record;
      attempt.heartbeatAt = timestamp;
      attempt.leaseExpiresAt = leaseExpiresAt ?? attempt.leaseExpiresAt;
      record.heartbeat = {
        leaseId,
        workerPid: workerPid ?? attempt.workerPid,
        status: "running",
        heartbeatAt: timestamp,
        leaseExpiresAt: attempt.leaseExpiresAt
      };
      if (phase) record.phase = phase;
      return record;
    }
  });
}

export function finishDurableAttempt({
  root,
  runId,
  leaseId,
  status = "completed",
  error = null
}) {
  return updateDurableRun({
    root,
    runId,
    update(record) {
      const attempt = [...record.attempts]
        .reverse()
        .find((item) => item.leaseId === leaseId && item.status === "running");
      if (attempt) {
        attempt.status = status;
        attempt.finishedAt = nowIso();
        attempt.error = error;
      }
      if (record.heartbeat?.leaseId === leaseId) {
        record.heartbeat = { ...record.heartbeat, status };
      }
      return record;
    }
  });
}

export function linkDurableMembers({ root, runId, memberIds, payload }) {
  return updateDurableRun({
    root,
    runId,
    update(record) {
      record.memberIds = [...new Set(memberIds ?? [])];
      if (payload) record.payload = { ...record.payload, ...payload };
      return record;
    }
  });
}

export function recordExternalAction({ root, runId, action, key, receipt }) {
  if (!action || !key) throw new Error("External action and key are required.");
  return updateDurableRun({
    root,
    runId,
    update(record) {
      const existing = record.externalActions[action];
      if (existing) {
        if (existing.key !== key) {
          throw new Error(
            `External action ${action} already completed with another key.`
          );
        }
        return record;
      }
      record.externalActions[action] = {
        key,
        receipt,
        completedAt: nowIso()
      };
      return record;
    }
  });
}

export function listDurableRuns({ root, kind = null } = {}) {
  const runs = join(resolve(root), "runs");
  if (!existsSync(runs)) return [];
  return readdirSync(runs)
    .map((runId) => readDurableRun({ root, runId }))
    .filter(Boolean)
    .filter((record) => !kind || record.kind === kind)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function terminalStateFromLegacy(record) {
  if (record.state) return record.state;
  if (typeof record.exitCode === "number")
    return record.exitCode === 0 ? "completed" : "failed";
  return record.finishedAt ? "completed" : "running";
}

function fleetStateFromLegacy(record) {
  const jobs = record.jobs ?? [];
  if (!jobs.length) return record.finishedAt ? "passed" : "queued";
  const failed = jobs.some(
    (job) =>
      ["failed", "cancelled", "abandoned"].includes(job.state) ||
      (typeof job.exitCode === "number" && job.exitCode !== 0)
  );
  if (record.finishedAt) return failed ? "failed" : "passed";
  return jobs.some((job) => job.state === "running") ? "running" : "queued";
}

export function migrateLegacyRunState({ root }) {
  const stateRoot = resolve(root);
  const migrated = [];
  const backgroundRoot = join(stateRoot, "background");
  if (existsSync(backgroundRoot)) {
    for (const name of readdirSync(backgroundRoot).filter((entry) =>
      entry.endsWith(".json")
    )) {
      const sourcePath = join(backgroundRoot, name);
      const legacy = readLegacyJson(sourcePath);
      if (!legacy?.id) continue;
      const id = legacy.runId ?? `background_${legacy.id}`;
      const current = readDurableRun({ root: stateRoot, runId: id });
      if (
        current?.kind === "background" &&
        current.payload?.migratedFrom === sourcePath
      ) {
        migrated.push({ kind: "background", id, sourcePath });
        continue;
      }
      if (!current) {
        createDurableRun({
          root: stateRoot,
          id,
          kind: "background",
          state: terminalStateFromLegacy(legacy),
          task: legacy.prompt ?? "Migrated background task",
          agent: legacy.agent ?? null,
          source: legacy.workspace ?? null,
          controllerRunId: legacy.runId ?? null,
          payload: { background: legacy, migratedFrom: sourcePath },
          createdAt: legacy.createdAt,
          updatedAt: legacy.updatedAt ?? legacy.finishedAt
        });
      } else {
        updateDurableRun({
          root: stateRoot,
          runId: id,
          update(record) {
            record.kind = "background";
            record.payload = {
              ...record.payload,
              background: {
                ...(record.payload?.background ?? {}),
                ...legacy
              },
              migratedFrom: record.payload?.migratedFrom ?? sourcePath
            };
            return record;
          }
        });
      }
      migrated.push({ kind: "background", id, sourcePath });
    }
  }
  const fleetRoot = join(stateRoot, "fleet");
  if (existsSync(fleetRoot)) {
    for (const name of readdirSync(fleetRoot).filter((entry) =>
      entry.endsWith(".json")
    )) {
      const sourcePath = join(fleetRoot, name);
      const legacy = readLegacyJson(sourcePath);
      const id = legacy?.id ?? name.slice(0, -5);
      if (!legacy || !id) continue;
      const current = readDurableRun({ root: stateRoot, runId: id });
      const memberIds = (legacy.jobs ?? [])
        .map((job) => job.runId)
        .filter(Boolean);
      if (
        current?.kind === "fleet" &&
        current.payload?.migratedFrom === sourcePath
      ) {
        migrated.push({ kind: "fleet", id, sourcePath });
        continue;
      }
      if (!current) {
        createDurableRun({
          root: stateRoot,
          id,
          kind: "fleet",
          state: fleetStateFromLegacy(legacy),
          task: `Migrated fleet with ${(legacy.jobs ?? []).length} jobs`,
          source: legacy.workspace ?? null,
          controllerRunId: null,
          memberIds,
          payload: { fleet: legacy, migratedFrom: sourcePath },
          createdAt: legacy.createdAt,
          updatedAt: legacy.updatedAt ?? legacy.finishedAt
        });
      } else {
        updateDurableRun({
          root: stateRoot,
          runId: id,
          update(record) {
            record.kind = "fleet";
            record.memberIds = [
              ...new Set([...record.memberIds, ...memberIds])
            ];
            record.payload = {
              ...record.payload,
              fleet: record.payload?.fleet ?? legacy,
              migratedFrom: record.payload?.migratedFrom ?? sourcePath
            };
            return record;
          }
        });
      }
      migrated.push({ kind: "fleet", id, sourcePath });
    }
  }
  return migrated;
}

export function reconcileDurableRuns({
  root,
  now = Date.now(),
  isAlive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  }
} = {}) {
  migrateLegacyRunState({ root });
  const rows = listDurableRuns({ root });
  return rows.map((existing) => {
    let record = existing;
    const controller = record.controllerRunId
      ? readJson(controllerPath(root, record.controllerRunId))
      : null;
    if (controller) record = syncControllerRun({ root, run: controller });
    const heartbeat = record.heartbeat;
    const expired =
      heartbeat?.leaseExpiresAt &&
      new Date(heartbeat.leaseExpiresAt).getTime() <= now;
    if (
      ACTIVE_STATES.has(record.state) &&
      heartbeat?.status === "running" &&
      expired &&
      !isAlive(heartbeat.workerPid)
    ) {
      return updateDurableRun({
        root,
        runId: record.id,
        update(current) {
          const attempt = [...current.attempts]
            .reverse()
            .find(
              (item) =>
                item.leaseId === heartbeat.leaseId && item.status === "running"
            );
          if (attempt) {
            attempt.status = "interrupted";
            attempt.finishedAt = nowIso(now);
            attempt.error =
              "Worker heartbeat expired during startup reconciliation.";
          } else {
            current.attempts.push({
              number: current.attempts.length + 1,
              leaseId: heartbeat.leaseId,
              workerPid: heartbeat.workerPid ?? null,
              operation: "recovered-worker",
              status: "interrupted",
              startedAt: heartbeat.heartbeatAt ?? null,
              heartbeatAt: heartbeat.heartbeatAt ?? null,
              leaseExpiresAt: heartbeat.leaseExpiresAt ?? null,
              finishedAt: nowIso(now),
              error: "Worker heartbeat expired during startup reconciliation."
            });
          }
          current.heartbeat = { ...heartbeat, status: "stale" };
          current.payload.reconciledLeases = [
            ...new Set([
              ...(current.payload.reconciledLeases ?? []),
              heartbeat.leaseId
            ])
          ];
          current.state =
            current.attempts.length < current.maxAttempts ? "queued" : "failed";
          current.phase = phaseForState(current.state);
          return current;
        }
      });
    }
    const background = record.payload?.background;
    const launchIsStale =
      background?.launchedAt &&
      now - new Date(background.launchedAt).getTime() > 30_000;
    if (
      record.kind === "background" &&
      ACTIVE_STATES.has(record.state) &&
      !heartbeat &&
      launchIsStale &&
      !background.reconciledAt &&
      !isAlive(background.pid)
    ) {
      return updateDurableRun({
        root,
        runId: record.id,
        update(current) {
          current.attempts.push({
            number: current.attempts.length + 1,
            leaseId: null,
            workerPid: background.pid ?? null,
            operation: "background-launch",
            status: "interrupted",
            startedAt: background.launchedAt,
            heartbeatAt: null,
            leaseExpiresAt: null,
            finishedAt: nowIso(now),
            error: "Detached worker exited before establishing a heartbeat."
          });
          current.payload.background.reconciledAt = nowIso(now);
          current.state =
            current.attempts.length < current.maxAttempts ? "queued" : "failed";
          current.phase = phaseForState(current.state);
          return current;
        }
      });
    }
    return record;
  });
}

export function hasUnpublishedChanges(record) {
  const git = record.git ?? {};
  const changed =
    Boolean(git.changedFiles?.length) ||
    Boolean(git.baseSha && git.headSha && git.baseSha !== git.headSha);
  if (!changed) return false;
  const publishedHead = record.externalActions?.preparePr?.receipt?.headSha;
  const adoptedHead = record.externalActions?.adopt?.receipt?.headSha;
  return ![publishedHead, adoptedHead].includes(git.headSha);
}

export function assertDurableCleanupSafe(record) {
  if (!TERMINAL_STATES.has(record.state)) {
    throw new Error("Only terminal durable runs can be cleaned up.");
  }
  if (record.git?.clean === false) {
    throw new Error(
      "Run has uncommitted changes; recovery worktree must be preserved."
    );
  }
  if (hasUnpublishedChanges(record)) {
    throw new Error(
      "Run has unpublished commits; adopt or prepare a PR before cleanup."
    );
  }
  return true;
}

export function archiveDurableRun({ root, runId }) {
  return updateDurableRun({
    root,
    runId,
    update(record) {
      if (!TERMINAL_STATES.has(record.state))
        throw new Error("Only terminal durable runs can be archived.");
      record.state = "archived";
      record.phase = "terminal";
      record.archivedAt = record.archivedAt ?? nowIso();
      return record;
    }
  });
}

export function markDurableRunCleaned({ root, runId }) {
  return updateDurableRun({
    root,
    runId,
    update(record) {
      assertDurableCleanupSafe(record);
      record.cleanedAt = record.cleanedAt ?? nowIso();
      return record;
    }
  });
}
