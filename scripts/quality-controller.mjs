#!/usr/bin/env node

/**
 * Trusted managed-run controller and CLI.
 *
 * The controller owns run preparation, isolated Git worktrees, exact result
 * parsing, controller commits, deterministic verification, independent review,
 * evidence, approvals, adoption, and PR receipts. All downstream quality and
 * publishing claims bind to the controller-owned implementation SHA. State is
 * written atomically under the host Lab state root; external actions and final
 * operations are idempotent. Unknown options, unsafe paths, dirty/undeclared
 * changes, missing evidence, invalid transitions, and interrupted work fail
 * closed. See docs/managed-runs.md for the lifecycle contract.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertTransition,
  buildBranchName,
  createRunId,
  evaluateRiskGate,
  evaluateReleaseGate,
  evidenceDigest,
  inferRequirements,
  selectModelRoute,
  selectReviewerRoutes,
  summarizeRuns,
  workspaceLabel
} from "./quality-lib.mjs";
import {
  normalizeRunLimits,
  parseFinalAssistantResult,
  processIsAlive,
  runBounded,
  terminateProcessIdentity
} from "./quality/run-control.mjs";
import { buildContextPack } from "./quality/context-pack.mjs";
import {
  mergeTelemetry,
  recordPhaseTelemetry
} from "./quality/phase-telemetry.mjs";
import {
  inferRouteEnvelope,
  validateRouteEnvelope
} from "./quality/routing-envelope.mjs";
import { validateModelRegistry } from "./quality/model-registry.mjs";
import {
  configuredPackRoots,
  loadPackSet,
  packAgentConfig,
  qualityContractPath
} from "./lab/pack-loader.mjs";
import { loadProjectContract } from "./lab/project-contract.mjs";
import {
  adapterVerificationCommands,
  resolveExecutionAdapter
} from "./lab/execution-adapters.mjs";
import {
  checkpointRun,
  claimJob,
  enqueueJob,
  finishJob,
  listApprovals,
  listJobs,
  putMemory,
  readTrace,
  recordTraceEvent,
  replayCheckpoint,
  requestApproval,
  retryJob,
  resolveApproval,
  searchMemory,
  workspacePolicy
} from "./quality/durable-state.mjs";
import { synthesizeParallel } from "./quality/parallel-synthesis.mjs";
import {
  createImplementationCheckpoint,
  listImplementationChanges
} from "./quality/implementation-checkpoint.mjs";
import {
  archiveDurableRun,
  assertDurableCleanupSafe,
  beginDurableAttempt,
  DURABLE_RUN_KINDS,
  finishDurableAttempt,
  heartbeatDurableRun,
  linkDurableMembers,
  markDurableRunCleaned,
  readDurableRun,
  reconcileDurableRuns,
  recordExternalAction,
  syncControllerRun,
  updateDurableRun
} from "./quality/run-service.mjs";
import {
  buildRunArtifactIndex,
  pruneRunArtifactCache
} from "./quality/run-artifacts.mjs";
import { syncRunNotifications } from "./quality/run-notifications.mjs";
import {
  recordRunOutcome,
  summarizeOperationalMetrics
} from "./quality/run-outcomes.mjs";
import { preparePullRequest } from "./github/publish-boundary.mjs";
import { labStateRoot } from "./lab/host-state.mjs";

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const controllerPackSet = loadPackSet({
  roots: configuredPackRoots({ envFile: join(harnessRoot, "opencode.env") })
});
const qualityRoot = resolve(process.env.QUALITY_STATE_ROOT ?? labStateRoot());
const runsRoot = join(qualityRoot, "runs");
const researchStagingRoot = join(qualityRoot, "research-staging");
const idempotencyRoot = join(qualityRoot, "idempotency");
const routingPolicyPath = join(harnessRoot, "quality", "model-routing.json");
const shortCommandTimeoutMs = Number(
  process.env.QUALITY_COMMAND_TIMEOUT_MS ?? 2 * 60 * 1000
);
const shortCommandOutputBytes = Number(
  process.env.QUALITY_COMMAND_OUTPUT_BYTES ?? 8 * 1024 * 1024
);

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = { command, verify: [], artifact: [], member: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) fail(`Unexpected argument: ${token}`);
    const key = token.slice(2).replaceAll("-", "_");
    if (
      ["release", "allow_dirty_source", "skip_agent", "skip_review"].includes(
        key
      )
    ) {
      options[key] = true;
      continue;
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) fail(`Missing value for ${token}`);
    index += 1;
    if (["verify", "artifact", "member"].includes(key))
      options[key].push(value);
    else options[key] = value;
  }
  return options;
}

function exec(
  command,
  args,
  {
    cwd,
    env,
    capture = true,
    allowFailure = false,
    timeoutMs = shortCommandTimeoutMs,
    maxOutputBytes = shortCommandOutputBytes
  } = {}
) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    timeout: timeoutMs,
    maxBuffer: maxOutputBytes,
    killSignal: "SIGKILL"
  });
  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      throw new Error(`${command} exceeded its ${timeoutMs}ms deadline.`);
    }
    if (result.error.code === "ENOBUFS") {
      throw new Error(
        `${command} exceeded its ${maxOutputBytes}-byte output limit.`
      );
    }
    throw result.error;
  }
  if (result.status !== 0 && !allowFailure) {
    const detail = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`
    );
  }
  return result;
}

function git(workspace, args, options = {}) {
  return exec("git", ["-C", workspace, ...args], options).stdout.trim();
}

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function waitSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withFileLockSync(lockPath, action, { timeoutMs = 5_000 } = {}) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let descriptor;
  while (descriptor === undefined) {
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
      writeSync(
        descriptor,
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`
      );
      fsyncSync(descriptor);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let lock = {};
      try {
        lock = readJson(lockPath, {});
      } catch {
        // The owner may still be flushing the newly created lock record.
      }
      const ageMs = Date.now() - statSync(lockPath).mtimeMs;
      const knownOwner =
        Number.isInteger(Number(lock.pid)) && Number(lock.pid) > 1;
      if (ageMs > 30_000 || (knownOwner && !processIsAlive(lock.pid))) {
        try {
          unlinkSync(lockPath);
        } catch (unlinkError) {
          if (unlinkError?.code !== "ENOENT") throw unlinkError;
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for state lock: ${lockPath}`);
      }
      waitSync(20);
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
    unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT" && !cleanupError) cleanupError = error;
  }
  if (actionError) throw actionError;
  if (cleanupError) throw cleanupError;
  return result;
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${process.pid}-${randomUUID()}-${path.split(sep).at(-1)}.tmp`
  );
  const descriptor = openSync(temporary, "wx", 0o600);
  let writeError;
  try {
    writeSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
  } catch (error) {
    writeError = error;
  } finally {
    closeSync(descriptor);
  }
  if (writeError) {
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the original write failure.
    }
    throw writeError;
  }
  try {
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the original rename failure.
    }
    throw error;
  }
}

function runPath(runId, name) {
  return join(runsRoot, runId, name);
}

function contractName(agent) {
  if (agent === "research") return "research";
  const contributed = packAgentConfig(controllerPackSet, agent);
  if (contributed?.qualityContract) return contributed.qualityContract;
  if (controllerPackSet.qualityContracts[agent]) return agent;
  return "coding";
}

function loadContract(agent) {
  const name = contractName(agent);
  const path = qualityContractPath(
    controllerPackSet,
    name,
    join(harnessRoot, "quality", "contracts")
  );
  const contract = readJson(path);
  return contract ? { name, path, contract } : null;
}

function selectRunModel(agent, task, override) {
  if (override) return override;
  const contributed = packAgentConfig(controllerPackSet, agent);
  if (contributed?.model) return contributed.model;
  const policy = readJson(routingPolicyPath, {});
  return selectModelRoute(agent, task, policy);
}

function routeLane(model) {
  const policy = readJson(routingPolicyPath, {});
  return Object.values(policy?.lanes ?? {}).find(
    (lane) => lane?.model === model
  );
}

function limitsForLane(laneName, options = {}) {
  const policy = readJson(routingPolicyPath, {});
  const lane = policy?.lanes?.[laneName];
  return normalizeRunLimits({
    maxTokens: options.max_tokens ?? lane?.maxTokens,
    maxCost: options.max_cost ?? lane?.maxCost,
    maxToolCalls: options.max_tool_calls ?? lane?.maxToolCalls,
    reviewTimeoutMs: options.review_timeout_ms,
    implementationTimeoutMs: options.implementation_timeout_ms,
    verificationTimeoutMs: options.verification_timeout_ms
  });
}

function limitsFromOptions(options = {}, model = null) {
  const lane = routeLane(model ?? options.model);
  return normalizeRunLimits({
    implementationTimeoutMs:
      options.implementation_timeout_ms ??
      process.env.QUALITY_IMPLEMENTATION_TIMEOUT_MS,
    verificationTimeoutMs:
      options.verification_timeout_ms ??
      process.env.QUALITY_VERIFICATION_TIMEOUT_MS,
    reviewTimeoutMs:
      options.review_timeout_ms ?? process.env.QUALITY_REVIEW_TIMEOUT_MS,
    maxOutputBytes:
      options.max_output_bytes ?? process.env.QUALITY_MAX_OUTPUT_BYTES,
    maxTokens:
      options.max_tokens ?? process.env.QUALITY_MAX_TOKENS ?? lane?.maxTokens,
    maxCost: options.max_cost ?? process.env.QUALITY_MAX_COST ?? lane?.maxCost,
    maxToolCalls:
      options.max_tool_calls ??
      process.env.QUALITY_MAX_TOOL_CALLS ??
      lane?.maxToolCalls,
    heartbeatMs: process.env.QUALITY_HEARTBEAT_MS,
    terminationGraceMs: process.env.QUALITY_TERMINATION_GRACE_MS
  });
}

function remainingBudgets(run, { reviewer = false } = {}) {
  const limits = reviewer ? (run.reviewLimits ?? run.limits) : run.limits;
  const telemetry = reviewer
    ? run.reviewTelemetry
    : (run.implementationTelemetry ?? run.telemetry);
  return {
    maxTokens: Math.max(
      0,
      Number(limits.maxTokens) - Number(telemetry?.tokens ?? 0)
    ),
    maxCost: Math.max(0, Number(limits.maxCost) - Number(telemetry?.cost ?? 0)),
    maxToolCalls: Math.max(
      0,
      Number(limits.maxToolCalls) - Number(telemetry?.toolCalls ?? 0)
    )
  };
}

function budgetBlocker(run, { reviewer = false } = {}) {
  const remaining = remainingBudgets(run, { reviewer });
  const exhausted = Object.entries(remaining).find(([, value]) => value <= 0);
  return exhausted ? `${exhausted[0]} budget is exhausted` : null;
}

function phasePath(runId) {
  return runPath(runId, "phase-process.json");
}

function leaseDurationMs(run) {
  return Math.max(
    run.limits.heartbeatMs * 3,
    shortCommandTimeoutMs + run.limits.terminationGraceMs
  );
}

function writeHeartbeat(run, phase = null, status = "running") {
  if (!run.worker?.leaseId) return;
  const now = Date.now();
  const heartbeat = {
    runId: run.id,
    leaseId: run.worker.leaseId,
    workerPid: run.worker.pid,
    heartbeatAt: new Date(now).toISOString(),
    leaseExpiresAt: new Date(now + leaseDurationMs(run)).toISOString(),
    phase,
    status
  };
  atomicWriteJson(runPath(run.id, "heartbeat.json"), heartbeat);
  heartbeatDurableRun({
    root: qualityRoot,
    runId: run.id,
    leaseId: heartbeat.leaseId,
    workerPid: heartbeat.workerPid,
    phase: typeof phase === "string" ? phase : phase?.phase,
    leaseExpiresAt: heartbeat.leaseExpiresAt
  });
}

function currentPhase(runId) {
  const phase = readJson(phasePath(runId));
  return phase?.runId === runId ? phase : null;
}

function setPhaseProcess(run, phase, identity) {
  const record = {
    runId: run.id,
    leaseId: run.worker?.leaseId ?? null,
    phase,
    ...identity
  };
  atomicWriteJson(phasePath(run.id), record);
  writeHeartbeat(run, record);
}

function clearPhaseProcess(run) {
  const path = phasePath(run.id);
  const phase = readJson(path);
  if (phase && phase.leaseId === run.worker?.leaseId) {
    try {
      unlinkSync(path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  writeHeartbeat(run);
}

function beginWorkerLease(initialRun, operation) {
  const run = loadRun(initialRun.id);
  run.limits = normalizeRunLimits(run.limits ?? {});
  const priorHeartbeat = readJson(runPath(run.id, "heartbeat.json"));
  const priorIsFresh =
    Boolean(priorHeartbeat && run.worker) &&
    priorHeartbeat.leaseId === run.worker.leaseId &&
    Date.now() < new Date(priorHeartbeat.leaseExpiresAt ?? 0).getTime();
  if (
    run.worker?.status === "running" &&
    run.worker.pid !== process.pid &&
    processIsAlive(run.worker.pid)
  ) {
    throw new Error(
      `Run ${run.id} already has a ${priorIsFresh ? "live" : "stale-but-running"} worker (${run.worker.pid}); cancel it before starting another.`
    );
  }
  run.worker = {
    leaseId: process.env.QUALITY_WORKER_LEASE_ID?.trim() || randomUUID(),
    pid: process.pid,
    processGroupId:
      process.env.QUALITY_DETACHED_WORKER === "1" &&
      process.platform !== "win32"
        ? process.pid
        : null,
    operation,
    status: "running",
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    leaseExpiresAt: new Date(Date.now() + leaseDurationMs(run)).toISOString(),
    phase: null
  };
  beginDurableAttempt({
    root: qualityRoot,
    runId: run.id,
    leaseId: run.worker.leaseId,
    workerPid: run.worker.pid,
    operation,
    leaseExpiresAt: run.worker.leaseExpiresAt
  });
  saveRun(run);
  writeHeartbeat(run);
  const heartbeat = setInterval(() => {
    try {
      writeHeartbeat(run, currentPhase(run.id));
    } catch (error) {
      console.error(
        `Run ${run.id} heartbeat failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }, run.limits.heartbeatMs);
  heartbeat.unref();
  return {
    run,
    stop(status = "finished") {
      clearInterval(heartbeat);
      clearPhaseProcess(run);
      writeHeartbeat(run, null, status);
      const latest = loadRun(run.id);
      if (latest.worker?.leaseId === run.worker.leaseId) {
        latest.worker.status = status;
        latest.worker.endedAt = new Date().toISOString();
        latest.worker.phase = null;
        saveRun(latest);
      }
      finishDurableAttempt({
        root: qualityRoot,
        runId: run.id,
        leaseId: run.worker.leaseId,
        status,
        error: ["failed", "cancelled"].includes(latest.state)
          ? (latest.timeline?.at(-1)?.detail ?? latest.state)
          : null
      });
    }
  };
}

async function withWorkerLease(initialRun, operation, action) {
  const lease = beginWorkerLease(initialRun, operation);
  try {
    return await action(lease.run);
  } finally {
    const latest = loadRun(lease.run.id);
    lease.stop(
      ["failed", "cancelled", "abandoned"].includes(latest.state)
        ? latest.state
        : "completed"
    );
  }
}

function redactLog(value) {
  return String(value)
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/giu, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?token|access[_-]?token|secret|password|credential)\s*[:=]\s*)[^\s,"']+/giu,
      "$1[REDACTED]"
    )
    .replace(
      /\b(?:sk|cf|ntn|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/gu,
      "[REDACTED_TOKEN]"
    );
}

function loadRun(runId) {
  const path = runPath(runId, "run.json");
  if (!existsSync(path)) fail(`Unknown quality run: ${runId}`);
  const run = JSON.parse(readFileSync(path, "utf8"));
  const heartbeat = readJson(runPath(runId, "heartbeat.json"));
  if (heartbeat && run.worker?.leaseId === heartbeat.leaseId) {
    run.worker.heartbeatAt = heartbeat.heartbeatAt;
    run.worker.leaseExpiresAt = heartbeat.leaseExpiresAt;
    run.worker.phase = heartbeat.phase ?? null;
  }
  return run;
}

function saveRun(run) {
  const runDirectory = join(runsRoot, run.id);
  mkdirSync(runDirectory, { recursive: true });
  const path = join(runDirectory, "run.json");
  withFileLockSync(join(runDirectory, ".run.lock"), () => {
    const existing = readJson(path);
    const expectedRevision = Number(run.revision ?? 0);
    const actualRevision = Number(existing?.revision ?? 0);
    if (existing && actualRevision !== expectedRevision) {
      throw new Error(
        `Run ${run.id} changed concurrently (expected revision ${expectedRevision}, found ${actualRevision}). Reload it before writing.`
      );
    }
    run.updatedAt = new Date().toISOString();
    run.revision = actualRevision + 1;
    atomicWriteJson(path, run);
  });
  checkpointRun({
    root: qualityRoot,
    run,
    phase: run.worker?.phase ?? null,
    reason: "run state persisted"
  });
  recordTraceEvent({
    root: qualityRoot,
    runId: run.id,
    traceId: run.traceId,
    type: "run.state.persisted",
    phase: run.worker?.phase ?? null,
    data: { state: run.state, revision: run.revision }
  });
  const durable = syncControllerRun({ root: qualityRoot, run });
  const artifactIndex = buildRunArtifactIndex({
    root: qualityRoot,
    durable,
    controller: run
  });
  syncRunNotifications({
    root: qualityRoot,
    durable,
    controller: run,
    artifactIndex
  });
  recordRunOutcome({ root: qualityRoot, run });
  return run;
}

function transition(run, next, detail) {
  assertTransition(run.state, next);
  run.timeline.push({
    from: run.state,
    to: next,
    at: new Date().toISOString(),
    detail
  });
  run.state = next;
  return saveRun(run);
}

function preflightReviewPolicy({ task, requirements, model }) {
  try {
    return selectReviewerRoutes(
      task,
      requirements,
      readJson(routingPolicyPath, {}),
      model
    );
  } catch (error) {
    fail(
      `Review policy unavailable before implementation: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function prepareNew(options) {
  const registry = validateModelRegistry({
    routingPolicy: routingPolicyPath,
    openCodeConfig: join(harnessRoot, "opencode.json")
  });
  if (!registry.passed) {
    fail(`Model registry is invalid: ${registry.errors.join("; ")}`);
  }
  const source = resolve(options.workspace ?? process.cwd());
  if (!existsSync(join(source, ".git")))
    fail(`${source} is not a Git workspace.`);
  const operatorRoots = (process.env.QUALITY_WORKSPACE_ROOTS ?? "")
    .split(process.platform === "win32" ? ";" : ":")
    .map((value) => value.trim())
    .filter(Boolean);
  const policy = workspacePolicy({
    workspace: source,
    operator: process.env.USER ?? process.env.USERNAME ?? "operator",
    roots: operatorRoots
  });
  const runKind = options.run_kind?.trim() || "individual";
  if (!DURABLE_RUN_KINDS.includes(runKind)) {
    fail(`--run-kind must be one of: ${DURABLE_RUN_KINDS.join(", ")}.`);
  }
  const parentRunId = options.parent_run_id?.trim() || null;
  if (parentRunId) {
    const parent = readDurableRun({ root: qualityRoot, runId: parentRunId });
    if (!parent) fail(`Unknown parent durable run: ${parentRunId}`);
    if (parent.git?.source && resolve(parent.git.source) !== source) {
      fail("Parent and child durable runs must belong to the same workspace.");
    }
  }
  const sourceStatus = git(source, ["status", "--porcelain=v1"]);
  if (sourceStatus && !options.allow_dirty_source) {
    fail(
      "Source worktree is dirty. Commit/stash it, or pass --allow-dirty-source to isolate from HEAD and leave those changes behind."
    );
  }
  const task = options.task?.trim();
  if (!task) fail("--task is required.");
  const agent = options.agent?.trim() || "lab";
  const model = selectRunModel(agent, task, options.model);
  const initialRequirements = inferRequirements([], task);
  const routeEnvelope = validateRouteEnvelope(
    inferRouteEnvelope({
      agent,
      task,
      requirements: initialRequirements,
      model
    })
  );
  if (!options.skip_review) {
    preflightReviewPolicy({ task, requirements: initialRequirements, model });
  }
  const baseRef = options.base?.trim() || "HEAD";
  const baseSha = git(source, ["rev-parse", baseRef]);
  const id = createRunId();
  const branch = buildBranchName(agent, task, id);
  const worktreeParent = resolve(
    options.worktree_root ??
      join(dirname(source), ".opencode-worktrees", workspaceLabel(source))
  );
  const workspace = join(worktreeParent, id);
  mkdirSync(worktreeParent, { recursive: true });
  exec(
    "git",
    ["-C", source, "worktree", "add", "-b", branch, workspace, baseSha],
    { capture: false }
  );
  const contextPack = buildContextPack({
    agent,
    task,
    paths: git(source, ["ls-files"]).split("\n").filter(Boolean)
  });
  const memory = searchMemory({
    root: qualityRoot,
    workspace: source,
    query: task
  });
  const run = saveRun({
    schemaVersion: 2,
    revision: 0,
    id,
    createdAt: new Date().toISOString(),
    traceId: `trace_${randomUUID().replaceAll("-", "")}`,
    state: "prepared",
    runKind,
    parentRunId,
    memberRunIds: [],
    maxAttempts: Math.max(1, Math.min(10, Number(options.max_attempts) || 3)),
    task,
    agent,
    model,
    route: routeEnvelope,
    contract: loadContract(agent),
    source,
    workspacePolicy: policy,
    workspace,
    branch,
    baseRef,
    baseSha,
    headSha: baseSha,
    clean: true,
    idempotency: options.idempotency_key
      ? {
          keyHash: createHash("sha256")
            .update(options.idempotency_key)
            .digest("hex"),
          fingerprint: options.idempotency_fingerprint
        }
      : null,
    limits: limitsFromOptions(options, model),
    reviewLimits: limitsForLane("review", options),
    limitEnforcement: {
      timeAndOutput: "hard process boundary",
      tokenCostAndToolCalls:
        "live and terminal enforcement when OpenCode/provider JSONL reports usage; unavailable usage is recorded, never inferred as zero-cost proof"
    },
    worker: null,
    releaseRequested: Boolean(options.release),
    changedFiles: [],
    requirements: initialRequirements,
    contextPack,
    memory,
    commands: options.verify,
    artifacts: {
      visual: options.artifact,
      migrationPlan: null,
      manifest: null,
      contractEvidence: null
    },
    verification: null,
    implementationResult: null,
    implementationCheckpoint: null,
    review: null,
    adoption: null,
    publishing: null,
    telemetry: mergeTelemetry(),
    implementationTelemetry: mergeTelemetry(),
    reviewTelemetry: mergeTelemetry(),
    research: null,
    approvals: [],
    timeline: [
      {
        from: null,
        to: "prepared",
        at: new Date().toISOString(),
        detail: "isolated worktree created"
      }
    ]
  });
  atomicWriteJson(runPath(id, "context-pack.json"), contextPack);
  return run;
}

function prepare(options) {
  const key = options.idempotency_key?.trim();
  if (key && (key.length < 8 || key.length > 200)) {
    fail("--idempotency-key must contain between 8 and 200 characters.");
  }
  const normalized = {
    workspace: resolve(options.workspace ?? process.cwd()),
    task: options.task?.trim() ?? "",
    agent: options.agent?.trim() || "lab",
    base: options.base?.trim() || "HEAD",
    release: Boolean(options.release),
    runKind: options.run_kind?.trim() || "individual",
    parentRunId: options.parent_run_id?.trim() || null,
    maxAttempts: Math.max(1, Math.min(10, Number(options.max_attempts) || 3)),
    model: options.model?.trim() || null,
    verify: options.verify ?? [],
    artifact: options.artifact ?? [],
    limits: limitsFromOptions(
      options,
      selectRunModel(
        options.agent?.trim() || "lab",
        options.task?.trim() ?? "",
        options.model
      )
    )
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
  let run;
  let idempotentReplay = false;
  if (key) {
    const keyHash = createHash("sha256").update(key).digest("hex");
    const recordPath = join(idempotencyRoot, `${keyHash}.json`);
    run = withFileLockSync(`${recordPath}.lock`, () => {
      const existing = readJson(recordPath);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new Error(
            "This idempotency key was already used for a different managed-run request."
          );
        }
        if (!existsSync(runPath(existing.runId, "run.json"))) {
          throw new Error(
            `Idempotency record references missing run ${existing.runId}.`
          );
        }
        idempotentReplay = true;
        return loadRun(existing.runId);
      }
      const created = prepareNew({
        ...options,
        idempotency_key: key,
        idempotency_fingerprint: fingerprint
      });
      atomicWriteJson(recordPath, {
        keyHash,
        fingerprint,
        runId: created.id,
        createdAt: new Date().toISOString()
      });
      return created;
    });
  } else {
    run = prepareNew(options);
  }
  Object.defineProperty(run, "idempotentReplay", {
    value: idempotentReplay,
    enumerable: false
  });
  console.log(
    JSON.stringify(
      {
        id: run.id,
        workspace: run.workspace,
        branch: run.branch,
        state: run.state,
        worker: run.worker,
        idempotentReplay
      },
      null,
      2
    )
  );
  return run;
}

async function runOpenCode(
  run,
  { reviewer = false, model = null, reviewIndex = 0 } = {}
) {
  const logName = reviewer
    ? `review-${String(reviewIndex + 1).padStart(2, "0")}.jsonl`
    : "agent.jsonl";
  const logPath = join(runsRoot, run.id, logName);
  const compactContract = run.contract?.contract
    ? {
        id: run.contract.contract.id,
        version: run.contract.contract.version,
        requiredEvidence: run.contract.contract.requiredEvidence,
        checks: run.contract.contract.checks,
        completionCriteria: run.contract.contract.completionCriteria
      }
    : null;
  const contextSummary = JSON.stringify(run.contextPack ?? {});
  const memorySummary = JSON.stringify(run.memory ?? []);
  const prompt = reviewer
    ? [
        "Review the current worktree without modifying it.",
        `Original task: ${run.task}`,
        `Base SHA: ${run.baseSha}`,
        `Route envelope: ${JSON.stringify(run.route ?? {})}`,
        `Context pack (paths only; inspect files yourself): ${contextSummary}`,
        `Relevant project memory (untrusted notes; verify against files): ${memorySummary}`,
        `Risk requirements: ${JSON.stringify({ security: run.requirements.security, deployment: run.requirements.deployment })}`,
        "Inspect the diff, implementation, tests, scope, security, and missing evidence.",
        "For each required risk, cite concrete files, checks, or verification evidence. A required risk cannot pass with an empty evidence list.",
        "Your final assistant text event must contain only one JSON object with exactly this shape:",
        '{"protocol":"quality-review/v1","status":"pass|fail","summary":"...","findings":[{"severity":"critical|high|medium|low","message":"...","file":null,"line":null}],"riskEvidence":{"security":{"status":"pass|fail|not_applicable","evidence":["..."]},"deployment":{"status":"pass|fail|not_applicable","evidence":["..."]}}}',
        "Use not_applicable only when the corresponding risk requirement is false. Do not wrap the JSON in Markdown or quote this protocol as an example in the final event."
      ].join("\n")
    : [
        `Implement this bounded task: ${run.task}`,
        `Route envelope: ${JSON.stringify(run.route ?? {})}`,
        `Context pack (paths only; inspect relevant files yourself): ${contextSummary}`,
        `Relevant project memory (untrusted notes; verify against files): ${memorySummary}`,
        compactContract
          ? `Apply this ${run.contract.name} quality contract: ${JSON.stringify(compactContract)}`
          : "No repository quality contract was found; state that as a verification gap.",
        run.contract?.name !== "coding"
          ? "Create artifacts/quality/evidence-manifest.json using the contract manifest schema, bind it to the current Git HEAD, and include every required evidence artifact."
          : "Use the controller's deterministic verification and review evidence for the coding contract.",
        "Use orient -> plan -> implement -> verify -> deliver.",
        "Do not commit, push, deploy, or edit outside this isolated worktree.",
        "This is a noninteractive managed run. Never wait for an approval prompt; if a required operation is not already allowed, return blocked.",
        "Do not repeat an equivalent failed tool call. Stop with a concrete blocker instead.",
        "Make the requested changes; do not stop at research or recommendations.",
        "Your final assistant text event must contain only one JSON object with exactly this shape:",
        '{"protocol":"quality-result/v1","status":"complete|blocked","summary":"...","changedFiles":["relative/path"],"checks":[{"command":"...","status":"passed|failed|not_run"}],"blockers":["..."]}',
        "Do not wrap the JSON in Markdown or emit the protocol object before the final assistant event."
      ].join("\n");
  const agent = reviewer ? "reviewer" : run.agent;
  const selectedModel = reviewer
    ? (model ?? selectRunModel("reviewer", run.task))
    : run.model;
  const exhausted = budgetBlocker(run, { reviewer });
  if (exhausted) {
    writeFileSync(logPath, `${exhausted}\n`);
    return {
      passed: false,
      output: exhausted,
      logPath,
      telemetry: mergeTelemetry(),
      structured: null,
      protocolError: exhausted,
      timedOut: false,
      outputLimitExceeded: false,
      budgetExceeded: exhausted.split(" ")[0],
      approvalRequired: false,
      approvalId: null,
      doomLoopDetected: false,
      controlError: null,
      usageTelemetryObserved: false,
      exitStatus: null,
      signal: null,
      model: selectedModel
    };
  }
  const modelArgs = selectedModel ? ["--model", selectedModel] : [];
  const phase = reviewer ? `review:${reviewIndex + 1}` : "implementation";
  const requestId = randomUUID();
  const activeLimits = reviewer ? (run.reviewLimits ?? run.limits) : run.limits;
  const result = await runBounded(
    process.execPath,
    [
      join(harnessRoot, "scripts/opencode.mjs"),
      "run",
      "--agent",
      agent,
      ...modelArgs,
      "--format",
      "json",
      "--title",
      `quality:${run.id}`,
      prompt
    ],
    {
      cwd: harnessRoot,
      env: {
        OPENCODE_WORKSPACE: run.workspace,
        OPENCODE_NON_INTERACTIVE: "1",
        CI: "1",
        NO_COLOR: "1",
        LAB_REQUEST_ID: requestId,
        LAB_CORRELATION_ID: run.traceId,
        LAB_RUN_ID: run.id,
        LAB_PHASE: phase,
        LAB_MODEL: selectedModel ?? ""
      },
      timeoutMs: reviewer
        ? activeLimits.reviewTimeoutMs
        : activeLimits.implementationTimeoutMs,
      maxOutputBytes: activeLimits.maxOutputBytes,
      budgets: remainingBudgets(run, { reviewer }),
      terminationGraceMs: activeLimits.terminationGraceMs,
      heartbeatMs: activeLimits.heartbeatMs,
      onProcess: (identity) => setPhaseProcess(run, phase, identity),
      onHeartbeat: () => writeHeartbeat(run, currentPhase(run.id))
    }
  );
  clearPhaseProcess(run);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  writeFileSync(logPath, redactLog(output));
  for (const line of String(result.stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      recordTraceEvent({
        root: qualityRoot,
        runId: run.id,
        traceId: run.traceId,
        type: "opencode.event",
        phase,
        data: {
          eventType: event.type ?? null,
          role: event.role ?? null,
          tool: event.tool ?? event.name ?? null,
          callId: event.callId ?? event.call_id ?? null,
          status: event.status ?? null
        }
      });
    } catch {
      // Non-JSON process output remains in the redacted phase log only.
    }
  }
  let structured = null;
  let protocolError = null;
  try {
    structured = parseFinalAssistantResult(
      result.stdout ?? "",
      reviewer ? "review" : "implementation"
    );
  } catch (error) {
    protocolError = error instanceof Error ? error.message : String(error);
  }
  let approvalId = null;
  if (result.approvalRequired) {
    const approval = requestApproval({
      root: qualityRoot,
      runId: run.id,
      traceId: run.traceId,
      phase,
      action: `${phase} requested an interactive permission decision`,
      reason:
        "Noninteractive managed execution stopped before a permissioned action."
    });
    approvalId = approval.id;
    run.approvals = [
      ...(run.approvals ?? []),
      {
        id: approval.id,
        status: approval.status,
        phase,
        requestedAt: approval.requestedAt
      }
    ];
  }
  recordTraceEvent({
    root: qualityRoot,
    runId: run.id,
    traceId: run.traceId,
    type: reviewer ? "review.completed" : "implementation.completed",
    phase,
    data: {
      requestId,
      model: selectedModel,
      passed: result.passed && !protocolError,
      protocolError,
      durationMs: result.durationMs,
      approvalRequired: result.approvalRequired,
      approvalId,
      usageTelemetryObserved: result.usageTelemetryObserved
    }
  });
  return {
    passed: result.passed && !protocolError,
    output,
    logPath,
    telemetry: {
      ...result.telemetry,
      usageTelemetryObserved: result.usageTelemetryObserved,
      requests: [
        {
          requestId,
          correlationId: run.traceId,
          model: selectedModel,
          phase,
          durationMs: result.durationMs,
          tokens: result.telemetry.tokens,
          cost: result.telemetry.cost,
          toolCalls: result.telemetry.toolCalls,
          toolErrors: result.telemetry.toolErrors,
          usageObserved: result.usageTelemetryObserved
        }
      ],
      models: selectedModel ? [selectedModel] : []
    },
    requestId,
    structured,
    protocolError,
    timedOut: result.timedOut,
    outputLimitExceeded: result.outputLimitExceeded,
    budgetExceeded: result.budgetExceeded,
    approvalRequired: result.approvalRequired,
    approvalId,
    doomLoopDetected: result.doomLoopDetected,
    controlError: result.controlError,
    usageTelemetryObserved: result.usageTelemetryObserved,
    exitStatus: result.status,
    signal: result.signal,
    model: selectedModel
  };
}

async function runDagger(run, commands) {
  const evidencePath = join(runsRoot, run.id, "verification.json");
  const args = [
    join(harnessRoot, "scripts/dagger-quality.mjs"),
    "--workspace",
    run.workspace,
    "--output",
    evidencePath
  ];
  if (run.releaseRequested) args.push("--release");
  for (const command of commands) args.push("--command", command);
  const result = await runBounded(process.execPath, args, {
    cwd: harnessRoot,
    timeoutMs: run.limits.verificationTimeoutMs,
    maxOutputBytes: run.limits.maxOutputBytes,
    terminationGraceMs: run.limits.terminationGraceMs,
    heartbeatMs: run.limits.heartbeatMs,
    onProcess: (identity) => setPhaseProcess(run, "verification", identity),
    onHeartbeat: () => writeHeartbeat(run, currentPhase(run.id))
  });
  clearPhaseProcess(run);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const evidence = existsSync(evidencePath)
    ? JSON.parse(readFileSync(evidencePath, "utf8"))
    : {
        passed: false,
        commands: [],
        error: "verification did not produce evidence"
      };
  if (!result.passed) {
    evidence.passed = false;
    evidence.error = result.timedOut
      ? `verification exceeded its ${run.limits.verificationTimeoutMs}ms deadline`
      : result.outputLimitExceeded
        ? `verification exceeded its ${run.limits.maxOutputBytes}-byte output limit`
        : evidence.error ||
          `verification process exited with ${result.status ?? result.signal ?? "an error"}`;
  }
  evidence.process = {
    exitStatus: result.status,
    signal: result.signal,
    timedOut: result.timedOut,
    outputLimitExceeded: result.outputLimitExceeded,
    durationMs: result.durationMs
  };
  return evidence;
}

function refreshRun(run) {
  run.changedFiles = listImplementationChanges(run.workspace, run.baseSha);
  const riskContext = git(run.workspace, [
    "diff",
    "--no-ext-diff",
    "--unified=0",
    run.baseSha
  ]);
  run.requirements = inferRequirements(
    run.changedFiles,
    `${run.task}\n${riskContext}`
  );
  run.route = validateRouteEnvelope(
    inferRouteEnvelope({
      agent: run.agent,
      task: run.task,
      requirements: run.requirements,
      model: run.model
    })
  );
  run.contextPack = buildContextPack({
    agent: run.agent,
    task: run.task,
    paths: run.contextPack?.candidateFiles ?? [],
    changedFiles: run.changedFiles
  });
  atomicWriteJson(runPath(run.id, "context-pack.json"), run.contextPack);
  run.headSha = git(run.workspace, ["rev-parse", "HEAD"]);
  run.clean = git(run.workspace, ["status", "--porcelain=v1"]) === "";
  if (!run.commands.length) {
    const loaded = loadProjectContract(run.workspace);
    const adapter = resolveExecutionAdapter({
      workspace: run.workspace,
      contract: loaded.contract
    });
    run.executionAdapter = {
      schemaVersion: adapter.schemaVersion,
      kind: adapter.kind,
      runtime: adapter.runtime,
      image: adapter.image,
      install: adapter.install.map(({ shell }) => shell)
    };
    run.commands = adapterVerificationCommands(adapter);
  }
  return saveRun(run);
}

function samePaths(left, right) {
  const normalize = (values) => [...new Set(values ?? [])].sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function checkpointImplementation(run, { declaredFiles } = {}) {
  const currentHead = git(run.workspace, ["rev-parse", "HEAD"]);
  const currentClean = git(run.workspace, ["status", "--porcelain=v1"]) === "";
  const currentFiles = listImplementationChanges(run.workspace, run.baseSha);
  if (run.implementationCheckpoint?.passed) {
    if (
      currentClean &&
      currentHead === run.implementationCheckpoint.headSha &&
      samePaths(currentFiles, run.implementationCheckpoint.changedFiles)
    ) {
      run.headSha = currentHead;
      run.changedFiles = currentFiles;
      run.clean = true;
      return run;
    }
    fail(
      "Managed worktree changed after its controller checkpoint. Start a new run instead of publishing unreviewed follow-up changes."
    );
  }
  const intendedFiles = declaredFiles ?? currentFiles;
  const priorIntent = run.implementationCheckpoint;
  if (
    priorIntent?.declaredFiles &&
    !samePaths(priorIntent.declaredFiles, intendedFiles)
  ) {
    fail("Implementation declarations changed after checkpointing began.");
  }
  const checkpointNonce =
    priorIntent?.checkpointNonce ?? randomUUID().replaceAll("-", "");
  run.implementationCheckpoint = {
    passed: false,
    status: "committing",
    baseSha: run.baseSha,
    declaredFiles: intendedFiles,
    checkpointNonce,
    startedAt: priorIntent?.startedAt ?? new Date().toISOString()
  };
  saveRun(run);
  const checkpoint = createImplementationCheckpoint({
    workspace: run.workspace,
    baseSha: run.baseSha,
    runId: run.id,
    task: run.task,
    declaredFiles: intendedFiles,
    checkpointNonce
  });
  run.implementationCheckpoint = {
    ...checkpoint,
    passed: true,
    status: "complete"
  };
  run.changedFiles = checkpoint.changedFiles;
  run.headSha = checkpoint.headSha;
  run.clean = checkpoint.clean;
  saveRun(run);
  recordTraceEvent({
    root: qualityRoot,
    runId: run.id,
    traceId: run.traceId,
    type: "implementation.checkpointed",
    phase: "implementation",
    data: {
      contentSha: checkpoint.contentSha,
      headSha: checkpoint.headSha,
      changedFiles: checkpoint.changedFiles,
      evidenceManifests: checkpoint.evidenceManifests
    }
  });
  return run;
}

function checkpointFailure(run, error) {
  const message = error instanceof Error ? error.message : String(error);
  run.implementationCheckpoint = {
    ...run.implementationCheckpoint,
    passed: false,
    status: "failed",
    error: message,
    failedAt: new Date().toISOString()
  };
  run.verification = { passed: false, error: message };
  saveRun(run);
  if (run.state !== "failed") {
    transition(run, "failed", `implementation checkpoint failed: ${message}`);
  }
  return run;
}

async function verify(run) {
  if (
    ![
      "prepared",
      "implementing",
      "failed",
      "passed",
      "needs_evidence"
    ].includes(run.state)
  ) {
    fail(`Run ${run.id} cannot enter verification from ${run.state}.`);
  }
  const exhausted = budgetBlocker(run);
  if (exhausted) {
    run.verification = { passed: false, error: exhausted };
    return transition(run, "failed", exhausted);
  }
  try {
    checkpointImplementation(run, {
      declaredFiles: run.implementationResult?.result?.changedFiles
    });
  } catch (error) {
    return checkpointFailure(run, error);
  }
  transition(run, "verifying", "deterministic Dagger checks started");
  refreshRun(run);
  if (run.contract?.name !== "coding" && !run.artifacts?.contractEvidence) {
    for (const candidate of [
      "artifacts/quality/evidence-manifest.json",
      ".quality/evidence-manifest.json"
    ]) {
      if (existsSync(resolve(run.workspace, candidate))) {
        applyValidatedManifest(run, validateArtifactManifest(run, candidate));
        saveRun(run);
        break;
      }
    }
  }
  if (!run.changedFiles.length) {
    run.verification = {
      passed: false,
      error: "agent produced no file changes"
    };
    transition(run, "failed", "no changed files");
    return run;
  }
  if (!run.commands.length) {
    run.verification = {
      passed: false,
      error: "no verification command could be inferred; use --verify"
    };
    transition(run, "failed", "verification contract missing");
    return run;
  }
  run.verification = await runDagger(run, run.commands);
  recordTraceEvent({
    root: qualityRoot,
    runId: run.id,
    traceId: run.traceId,
    type: "verification.completed",
    phase: "verification",
    data: {
      passed: run.verification.passed,
      commands: run.commands,
      evidenceDigest: evidenceDigest(run.verification)
    }
  });
  const latest = loadRun(run.id);
  if (latest.state === "cancelled") return latest;
  run.verification.sha = git(run.workspace, ["rev-parse", "HEAD"]);
  run.verification.correlationId = run.traceId;
  run.verification.evidenceDigest = evidenceDigest(run.verification);
  saveRun(run);
  if (!run.verification.passed)
    transition(run, "failed", "deterministic verification failed");
  return run;
}

async function review(run) {
  if (run.state !== "verifying")
    fail(`Run ${run.id} must have green verification before review.`);
  let reviewerRoutes;
  try {
    reviewerRoutes = selectReviewerRoutes(
      run.task,
      run.requirements,
      readJson(routingPolicyPath, {}),
      run.model
    );
  } catch (error) {
    run.review = {
      passed: false,
      configurationError:
        error instanceof Error ? error.message : String(error),
      reviewers: []
    };
    saveRun(run);
    return transition(
      run,
      "failed",
      `review policy unavailable: ${run.review.configurationError}`
    );
  }
  transition(run, "reviewing", "read-only reviewer started");
  const results = [];
  for (const [index, route] of reviewerRoutes.entries()) {
    const result = await runOpenCode(run, {
      reviewer: true,
      model: route.model,
      reviewIndex: index
    });
    const latest = loadRun(run.id);
    if (latest.state === "cancelled") return latest;
    recordPhaseTelemetry(run, "review", result.telemetry);
    const structuredPassed =
      result.structured?.status === "pass" &&
      !result.structured.findings.some((finding) =>
        ["critical", "high"].includes(finding.severity)
      ) &&
      ["security", "deployment"].every((risk) =>
        run.requirements[risk]
          ? result.structured?.riskEvidence?.[risk]?.status === "pass"
          : result.structured?.riskEvidence?.[risk]?.status !== "fail"
      );
    results.push({
      passed: result.passed && structuredPassed,
      model: route.model,
      family: route.family,
      distinctFromImplementation: route.distinctFromImplementation,
      result: result.structured,
      protocolError: result.protocolError,
      log: result.logPath,
      process: {
        timedOut: result.timedOut,
        outputLimitExceeded: result.outputLimitExceeded,
        budgetExceeded: result.budgetExceeded,
        approvalRequired: result.approvalRequired,
        approvalId: result.approvalId,
        exitStatus: result.exitStatus,
        signal: result.signal
      }
    });
    saveRun(run);
    if (!result.passed || !structuredPassed) break;
  }
  const riskEvidence = Object.fromEntries(
    ["security", "deployment"].map((risk) => {
      const required = Boolean(run.requirements[risk]);
      const allPassed = results.every(
        (entry) => entry.result?.riskEvidence?.[risk]?.status === "pass"
      );
      return [
        risk,
        {
          status: required
            ? allPassed && results.length === reviewerRoutes.length
              ? "pass"
              : "fail"
            : "not_applicable",
          evidence: results.flatMap((entry) =>
            (entry.result?.riskEvidence?.[risk]?.evidence ?? []).map(
              (evidence) => `${entry.model}: ${evidence}`
            )
          )
        }
      ];
    })
  );
  run.review = {
    passed:
      results.length === reviewerRoutes.length &&
      results.every((result) => result.passed),
    sha: git(run.workspace, ["rev-parse", "HEAD"]),
    log: results[0]?.log ?? null,
    logs: results.map((result) => result.log),
    reviewers: results,
    correlationId: run.traceId,
    distinctFromImplementation:
      results.length > 0 &&
      results.every((result) => result.distinctFromImplementation),
    riskEvidence
  };
  const riskGate = evaluateRiskGate(run);
  run.review.passed &&= riskGate.passed;
  run.review.riskGate = riskGate;
  run.review.evidenceDigest = evidenceDigest(run.review);
  saveRun(run);
  if (!run.review.passed)
    return transition(run, "failed", "independent review failed");
  refreshRun(run);
  const missingVisual = run.requirements.visual && !run.artifacts.visual.length;
  const missingMigrationPlan =
    run.requirements.migration && !run.artifacts.migrationPlan;
  const missingContractEvidence =
    Boolean(run.contract) &&
    run.contract.name !== "coding" &&
    !run.artifacts.contractEvidence?.passed;
  if (missingVisual || missingMigrationPlan || missingContractEvidence) {
    const missing = [
      missingVisual && "rendered visual evidence",
      missingMigrationPlan && "a migration compatibility and recovery plan",
      missingContractEvidence && `${run.contract?.name} contract evidence`
    ].filter(Boolean);
    return transition(
      run,
      "needs_evidence",
      `${missing.join(" and ")} required`
    );
  }
  return transition(
    run,
    "passed",
    "verification and independent review passed"
  );
}

async function execute(options) {
  const prepared = prepare(options);
  if (prepared.idempotentReplay) return prepared;
  return withWorkerLease(prepared, "run", async (run) => {
    if (!options.skip_agent) {
      if (!options.skip_review) preflightReviewPolicy(run);
      transition(run, "implementing", "OpenCode implementation agent started");
      const result = await runOpenCode(run);
      const latest = loadRun(run.id);
      if (latest.state === "cancelled") return latest;
      recordPhaseTelemetry(run, "implementation", result.telemetry);
      run.implementationResult = {
        passed: result.passed && result.structured?.status === "complete",
        result: result.structured,
        protocolError: result.protocolError,
        log: result.logPath,
        process: {
          timedOut: result.timedOut,
          outputLimitExceeded: result.outputLimitExceeded,
          budgetExceeded: result.budgetExceeded,
          approvalRequired: result.approvalRequired,
          approvalId: result.approvalId,
          doomLoopDetected: result.doomLoopDetected,
          controlError: result.controlError,
          usageTelemetryObserved: result.usageTelemetryObserved,
          exitStatus: result.exitStatus,
          signal: result.signal
        }
      };
      saveRun(run);
      if (!run.implementationResult.passed) {
        const reason =
          result.protocolError ||
          (result.timedOut && "implementation deadline exceeded") ||
          (result.outputLimitExceeded &&
            "implementation output limit exceeded") ||
          (result.approvalRequired &&
            "implementation requested interactive approval") ||
          (result.doomLoopDetected &&
            "implementation triggered the doom-loop guard") ||
          result.controlError ||
          (result.budgetExceeded &&
            `implementation ${result.budgetExceeded} budget exceeded`) ||
          (result.structured?.status === "blocked" &&
            `implementation blocked: ${result.structured.blockers.join("; ")}`) ||
          "implementation process failed";
        return transition(run, "failed", reason);
      }
    }
    const verified = await verify(run);
    if (
      ["failed", "cancelled"].includes(verified.state) ||
      options.skip_review
    ) {
      return verified;
    }
    return review(verified);
  });
}

function validateArtifactManifest(run, manifestOption) {
  const manifestPath = resolve(run.workspace, manifestOption);
  const workspaceRoot = resolve(run.workspace);
  if (
    manifestPath !== workspaceRoot &&
    !manifestPath.startsWith(`${workspaceRoot}${sep}`)
  ) {
    fail("Artifact manifest must be inside the managed worktree.");
  }
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
    fail(`Artifact manifest not found: ${manifestPath}`);
  }
  const evidencePath = join(runsRoot, run.id, "artifact-evidence.json");
  const contract = run.contract?.name ?? contractName(run.agent);
  const result = exec(
    process.execPath,
    [
      join(harnessRoot, "scripts/quality/visual-evidence.mjs"),
      "--workspace",
      run.workspace,
      "--manifest",
      relative(workspaceRoot, manifestPath),
      "--contract",
      contract,
      "--expected-task",
      run.task,
      "--output",
      evidencePath
    ],
    { cwd: harnessRoot, allowFailure: true }
  );
  const evidence = readJson(evidencePath, {
    passed: false,
    fatal: true,
    error: { message: "artifact validator produced no evidence" }
  });
  const headSha = git(run.workspace, ["rev-parse", "HEAD"]);
  const subjectSha =
    run.implementationCheckpoint?.contentSha ?? run.headSha ?? headSha;
  const evidenceSha = evidence.manifest?.commitSha ?? "";
  if (!evidenceSha || subjectSha !== evidenceSha) {
    evidence.passed = false;
    evidence.errors = [
      ...(evidence.errors ?? []),
      "Artifact manifest commitSha does not match the controller implementation subject."
    ];
  }
  evidence.subjectSha = subjectSha;
  evidence.reviewedHeadSha = headSha;
  evidence.exitCode = result.status;
  return { manifestPath, evidence };
}

function applyValidatedManifest(run, validated) {
  run.artifacts ??= {};
  run.artifacts.visual ??= [];
  run.artifacts.manifest = validated.manifestPath;
  run.artifacts.contractEvidence = validated.evidence;
  if (validated.evidence.passed) {
    run.artifacts.visual.push(
      ...validated.evidence.artifacts
        .filter((artifact) =>
          ["render", "contact-sheet"].includes(artifact.kind)
        )
        .map((artifact) => resolve(run.workspace, artifact.path))
    );
    run.artifacts.visual = [...new Set(run.artifacts.visual)];
  }
  return run;
}

async function recordArtifacts(options) {
  const run = loadRun(options.run);
  run.artifacts ??= {};
  run.artifacts.visual ??= [];
  run.artifacts.migrationPlan ??= null;
  run.artifacts.manifest ??= null;
  run.artifacts.contractEvidence ??= null;
  if (options.manifest) {
    applyValidatedManifest(
      run,
      validateArtifactManifest(run, options.manifest)
    );
  }
  for (const artifact of options.artifact) {
    const path = isAbsolute(artifact)
      ? artifact
      : resolve(run.workspace, artifact);
    if (!existsSync(path) || !statSync(path).isFile())
      fail(`Visual artifact not found: ${path}`);
    run.artifacts.visual.push(path);
  }
  run.artifacts.visual = [...new Set(run.artifacts.visual)];
  if (options.migration_plan) {
    const path = isAbsolute(options.migration_plan)
      ? options.migration_plan
      : resolve(run.workspace, options.migration_plan);
    if (!existsSync(path)) fail(`Migration plan not found: ${path}`);
    run.artifacts.migrationPlan = path;
  }
  if (
    run.state === "needs_evidence" &&
    (!run.requirements.visual || run.artifacts.visual.length) &&
    (!run.requirements.migration || run.artifacts.migrationPlan) &&
    (!run.contract ||
      run.contract.name === "coding" ||
      run.artifacts.contractEvidence?.passed)
  ) {
    saveRun(run);
    await withWorkerLease(run, "artifacts", async (leasedRun) => {
      const verified = await verify(leasedRun);
      if (!["failed", "cancelled"].includes(verified.state)) {
        await review(verified);
      }
    });
  } else saveRun(run);
  console.log(JSON.stringify(run.artifacts, null, 2));
}

function listRuns() {
  if (!existsSync(runsRoot)) return [];
  return readdirSync(runsRoot)
    .filter((id) => existsSync(join(runsRoot, id, "run.json")))
    .map((id) => loadRun(id));
}

function status(options) {
  if (options.run) {
    console.log(JSON.stringify(loadRun(options.run), null, 2));
    return;
  }
  const runs = listRuns();
  if (!runs.length) return console.log("[]");
  const staleHours = Number(options.stale_hours ?? 24);
  const rows = runs.map(
    ({ id, state, agent, task, workspace, worker, updatedAt }) => ({
      id,
      state,
      agent,
      task,
      workspace,
      worker,
      stale:
        [
          "prepared",
          "implementing",
          "verifying",
          "reviewing",
          "needs_evidence"
        ].includes(state) &&
        Date.now() - new Date(worker?.heartbeatAt ?? updatedAt).getTime() >
          staleHours * 60 * 60 * 1000
    })
  );
  console.log(JSON.stringify(rows, null, 2));
}

function gate(options) {
  const run = refreshRun(loadRun(options.run));
  const result = evaluateReleaseGate(run);
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}

function finalize(options) {
  const run = loadRun(options.run);
  try {
    checkpointImplementation(run, {
      declaredFiles: run.implementationResult?.result?.changedFiles
    });
  } catch (error) {
    checkpointFailure(run, error);
    throw error;
  }
  console.log(JSON.stringify(run.implementationCheckpoint, null, 2));
  return run;
}

function requirePassedRelease(run) {
  const refreshed = refreshRun(run);
  const release = evaluateReleaseGate(refreshed);
  if (!release.passed) {
    fail(`Run ${run.id} is not releasable: ${release.blockers.join("; ")}`);
  }
  return refreshed;
}

function adopt(options) {
  const run = requirePassedRelease(loadRun(options.run));
  if (run.adoption?.headSha === run.headSha) {
    console.log(JSON.stringify(run.adoption, null, 2));
    return run;
  }
  const sourceStatus = git(run.source, ["status", "--porcelain=v1"]);
  if (sourceStatus) {
    fail("Source worktree must be clean before adopting a managed run.");
  }
  const previousSha = git(run.source, ["rev-parse", "HEAD"]);
  if (![run.baseSha, run.headSha].includes(previousSha)) {
    fail(
      `Source HEAD moved from ${run.baseSha} to ${previousSha}; refusing to overwrite newer work.`
    );
  }
  if (previousSha !== run.headSha) {
    git(run.source, ["merge", "--ff-only", run.headSha]);
  }
  const adoptedSha = git(run.source, ["rev-parse", "HEAD"]);
  if (adoptedSha !== run.headSha) {
    fail(`Adoption ended at ${adoptedSha}, expected ${run.headSha}.`);
  }
  run.adoption = {
    source: run.source,
    previousSha,
    headSha: run.headSha,
    adoptedAt: new Date().toISOString()
  };
  saveRun(run);
  recordExternalAction({
    root: qualityRoot,
    runId: run.id,
    action: "adopt",
    key: run.headSha,
    receipt: run.adoption
  });
  recordTraceEvent({
    root: qualityRoot,
    runId: run.id,
    traceId: run.traceId,
    type: "implementation.adopted",
    phase: "release",
    data: run.adoption
  });
  console.log(JSON.stringify(run.adoption, null, 2));
  return run;
}

function preparePr(options) {
  const run = requirePassedRelease(loadRun(options.run));
  const base = options.base?.trim() || "main";
  const prior = run.publishing?.pr;
  if (
    prior?.url &&
    prior.headSha === run.headSha &&
    prior.branch === run.branch &&
    prior.base === base
  ) {
    console.log(JSON.stringify(prior, null, 2));
    return run;
  }
  const title = (
    options.title?.trim() || `agent(${run.agent}): ${run.task}`
  ).slice(0, 200);
  const description =
    options.body?.trim() ||
    [
      "## Managed run",
      `- Run: \`${run.id}\``,
      `- Verified head: \`${run.headSha}\``,
      `- Verification: ${run.verification?.passed ? "passed" : "failed"}`,
      `- Independent review: ${run.review?.passed ? "passed" : "failed"}`,
      "",
      "The controller verified this exact commit before publication."
    ].join("\n");
  const prepared = preparePullRequest({
    workspace: run.workspace,
    title,
    body: description,
    base,
    expectedBranch: run.branch,
    expectedHeadSha: run.headSha
  });
  run.publishing ??= {};
  run.publishing.pr = {
    url: prepared.url,
    remote: prepared.remote,
    base,
    branch: run.branch,
    headSha: run.headSha,
    created: prepared.created,
    reused: prepared.reused,
    preparedAt: new Date().toISOString(),
    correlationId: run.traceId
  };
  saveRun(run);
  recordExternalAction({
    root: qualityRoot,
    runId: run.id,
    action: "preparePr",
    key: `${base}:${run.branch}:${run.headSha}`,
    receipt: run.publishing.pr
  });
  recordTraceEvent({
    root: qualityRoot,
    runId: run.id,
    traceId: run.traceId,
    type: "pull_request.prepared",
    phase: "release",
    data: run.publishing.pr
  });
  console.log(JSON.stringify(run.publishing.pr, null, 2));
  return run;
}

function setRunExitCode(run) {
  if (["failed", "cancelled", "abandoned"].includes(run?.state)) {
    process.exitCode = 1;
  }
  return run;
}

async function resume(options) {
  const initial = loadRun(options.run);
  if (initial.state === "archived") fail("Archived runs cannot be resumed.");
  if (initial.state === "passed") {
    console.log(JSON.stringify(initial, null, 2));
    return initial;
  }
  return withWorkerLease(initial, "resume", async (leasedRun) => {
    const run = refreshRun(leasedRun);
    const pendingApprovals = listApprovals({
      root: qualityRoot,
      runId: run.id,
      status: "pending"
    });
    const rejectedApprovals = listApprovals({
      root: qualityRoot,
      runId: run.id,
      status: "rejected"
    });
    if (pendingApprovals.length) {
      run.approvals = pendingApprovals.map((approval) => ({
        id: approval.id,
        status: approval.status,
        phase: approval.phase,
        requestedAt: approval.requestedAt
      }));
      saveRun(run);
      console.log(
        JSON.stringify(
          {
            id: run.id,
            state: run.state,
            blocked: "approval_pending",
            approvals: pendingApprovals
          },
          null,
          2
        )
      );
      return run;
    }
    if (rejectedApprovals.length) {
      console.log(
        JSON.stringify(
          {
            id: run.id,
            state: run.state,
            blocked: "approval_rejected",
            approvals: rejectedApprovals
          },
          null,
          2
        )
      );
      return run;
    }
    if (run.state === "archived") fail("Archived runs cannot be resumed.");
    if (run.state === "passed") {
      console.log(JSON.stringify(run, null, 2));
      return run;
    }
    if (run.state === "needs_evidence") {
      console.log(
        JSON.stringify(
          {
            id: run.id,
            state: run.state,
            next: "Record the required visual artifacts or migration plan with the artifacts command."
          },
          null,
          2
        )
      );
      return run;
    }
    if (["verifying", "reviewing"].includes(run.state)) {
      transition(run, "failed", `recovered interrupted ${run.state} phase`);
    }
    if (
      ["abandoned", "cancelled"].includes(run.state) &&
      run.changedFiles.length
    ) {
      transition(
        run,
        "implementing",
        `${run.state} work resumed from existing changes`
      );
    }
    if (!run.changedFiles.length) {
      if (!options.skip_review) preflightReviewPolicy(run);
      if (["failed", "abandoned", "cancelled"].includes(run.state)) {
        transition(run, "implementing", "implementation resumed");
      } else if (run.state === "prepared") {
        transition(run, "implementing", "implementation started from resume");
      }
      const result = await runOpenCode(run);
      const latest = loadRun(run.id);
      if (latest.state === "cancelled") return latest;
      recordPhaseTelemetry(run, "implementation", result.telemetry);
      run.implementationResult = {
        passed: result.passed && result.structured?.status === "complete",
        result: result.structured,
        protocolError: result.protocolError,
        log: result.logPath,
        process: {
          timedOut: result.timedOut,
          outputLimitExceeded: result.outputLimitExceeded,
          budgetExceeded: result.budgetExceeded,
          approvalRequired: result.approvalRequired,
          approvalId: result.approvalId,
          doomLoopDetected: result.doomLoopDetected,
          controlError: result.controlError,
          usageTelemetryObserved: result.usageTelemetryObserved,
          exitStatus: result.exitStatus,
          signal: result.signal
        }
      };
      saveRun(run);
      if (!run.implementationResult.passed) {
        return transition(
          run,
          "failed",
          result.protocolError ||
            (result.approvalRequired &&
              "resumed implementation requested interactive approval") ||
            (result.doomLoopDetected &&
              "resumed implementation triggered the doom-loop guard") ||
            result.controlError ||
            (result.budgetExceeded &&
              `resumed implementation ${result.budgetExceeded} budget exceeded`) ||
            "resumed implementation failed or blocked"
        );
      }
    }
    const verified = await verify(run);
    if (["failed", "cancelled"].includes(verified.state) || options.skip_review)
      return verified;
    return review(verified);
  });
}

async function stopRun(options, targetState) {
  const run = loadRun(options.run);
  if (run.state === targetState) {
    console.log(JSON.stringify({ id: run.id, state: run.state }, null, 2));
    return run;
  }
  if (["passed", "archived", "cancelled", "abandoned"].includes(run.state)) {
    fail(`Run ${run.id} cannot be ${targetState} from ${run.state}.`);
  }
  const phase = currentPhase(run.id);
  const heartbeat = readJson(runPath(run.id, "heartbeat.json"));
  const leaseIsFresh =
    Boolean(heartbeat && run.worker?.leaseId) &&
    heartbeat?.leaseId === run.worker?.leaseId &&
    Date.now() < new Date(heartbeat.leaseExpiresAt ?? 0).getTime();
  const identities = [];
  if (
    leaseIsFresh &&
    phase?.leaseId === run.worker?.leaseId &&
    processIsAlive(phase.pid)
  ) {
    identities.push(phase);
  }
  if (
    leaseIsFresh &&
    run.worker?.status === "running" &&
    processIsAlive(run.worker.pid) &&
    !identities.some(
      (identity) =>
        identity.processGroupId &&
        identity.processGroupId === run.worker.processGroupId
    )
  ) {
    identities.push(run.worker);
  }
  run.cancellation = {
    requestedAt: new Date().toISOString(),
    reason:
      options.reason ??
      (targetState === "cancelled"
        ? "cancelled by operator"
        : "abandoned by operator"),
    requestedByPid: process.pid,
    processes: identities.map(({ pid, processGroupId }) => ({
      pid,
      processGroupId
    }))
  };
  transition(run, targetState, run.cancellation.reason);
  const signalled = identities.map((identity) => ({
    pid: identity.pid,
    processGroupId: identity.processGroupId,
    sigterm: terminateProcessIdentity(identity, "SIGTERM")
  }));
  if (signalled.some((result) => result.sigterm)) {
    await new Promise((resolveWait) =>
      setTimeout(resolveWait, run.limits?.terminationGraceMs ?? 2_000)
    );
    for (const identity of identities) {
      if (processIsAlive(identity.pid)) {
        terminateProcessIdentity(identity, "SIGKILL");
      }
    }
  }
  console.log(
    JSON.stringify({ id: run.id, state: run.state, signalled }, null, 2)
  );
  return run;
}

function cancelRun(options) {
  return stopRun(options, "cancelled");
}

function abandon(options) {
  return stopRun(options, "abandoned");
}

function archive(options) {
  const run = loadRun(options.run);
  if (!["passed", "failed", "cancelled", "abandoned"].includes(run.state)) {
    fail("Only passed, failed, cancelled, or abandoned runs can be archived.");
  }
  transition(run, "archived", "run record archived");
  archiveDurableRun({ root: qualityRoot, runId: run.id });
  console.log(JSON.stringify({ id: run.id, state: run.state }, null, 2));
}

function cleanup(options) {
  const run = loadRun(options.run);
  if (
    !["passed", "failed", "cancelled", "abandoned", "archived"].includes(
      run.state
    )
  ) {
    fail("Only terminal runs can be cleaned up.");
  }
  if (!existsSync(run.workspace)) {
    assertDurableCleanupSafe(
      readDurableRun({ root: qualityRoot, runId: run.id })
    );
    run.cleanedAt = run.cleanedAt ?? new Date().toISOString();
    saveRun(run);
    markDurableRunCleaned({ root: qualityRoot, runId: run.id });
    console.log(
      JSON.stringify(
        { id: run.id, cleanedAt: run.cleanedAt, branchPreserved: run.branch },
        null,
        2
      )
    );
    return;
  }
  refreshRun(run);
  assertDurableCleanupSafe(
    readDurableRun({ root: qualityRoot, runId: run.id })
  );
  exec("git", ["-C", run.source, "worktree", "remove", run.workspace], {
    capture: false
  });
  run.cleanedAt = new Date().toISOString();
  saveRun(run);
  markDurableRunCleaned({ root: qualityRoot, runId: run.id });
  console.log(
    JSON.stringify(
      { id: run.id, cleanedAt: run.cleanedAt, branchPreserved: run.branch },
      null,
      2
    )
  );
}

function metrics(options) {
  const runs = listRuns();
  const result = summarizeRuns(runs, {
    staleHours: Number(options.stale_hours ?? 24)
  });
  console.log(
    JSON.stringify(
      { ...result, operational: summarizeOperationalMetrics(runs) },
      null,
      2
    )
  );
}

function retention(options) {
  if (!options.run) fail("retention requires --run ID.");
  const durable = readDurableRun({ root: qualityRoot, runId: options.run });
  if (!durable) fail(`Unknown quality run: ${options.run}`);
  const result = pruneRunArtifactCache({
    root: qualityRoot,
    durable,
    retentionDays:
      options.days ?? process.env.QUALITY_ARTIFACT_RETENTION_DAYS ?? 30
  });
  console.log(JSON.stringify(result, null, 2));
}

function parseJsonOption(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(
      `Invalid JSON value: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function checkpoint(options) {
  const run = loadRun(options.run);
  const record = checkpointRun({
    root: qualityRoot,
    run,
    phase: options.phase ?? run.worker?.phase ?? null,
    reason: options.reason ?? "operator checkpoint"
  });
  console.log(JSON.stringify(record, null, 2));
}

function replay(options) {
  if (!options.run || !options.sequence)
    fail("replay requires --run and --sequence.");
  console.log(
    JSON.stringify(
      replayCheckpoint({
        root: qualityRoot,
        runId: options.run,
        sequence: options.sequence
      }),
      null,
      2
    )
  );
}

function approvals(options) {
  console.log(
    JSON.stringify(
      listApprovals({
        root: qualityRoot,
        runId: options.run ?? null,
        status: options.status ?? null
      }),
      null,
      2
    )
  );
}

function approve(options) {
  if (!options.approval || !options.decision)
    fail("approve requires --approval ID and --decision approved|rejected.");
  const record = resolveApproval({
    root: qualityRoot,
    approvalId: options.approval,
    decision: options.decision,
    actor: options.actor ?? process.env.USER ?? "operator",
    note: options.note ?? ""
  });
  const runPathname = runPath(record.runId, "run.json");
  if (existsSync(runPathname)) {
    const run = loadRun(record.runId);
    run.approvals = listApprovals({
      root: qualityRoot,
      runId: record.runId
    }).map((approval) => ({
      id: approval.id,
      status: approval.status,
      phase: approval.phase,
      requestedAt: approval.requestedAt,
      resolvedAt: approval.resolvedAt
    }));
    saveRun(run);
  }
  console.log(JSON.stringify(record, null, 2));
}

function queueCommand(options) {
  const action = options.action ?? "list";
  let result;
  if (action === "enqueue") {
    result = enqueueJob({
      root: qualityRoot,
      kind: options.kind,
      payload: parseJsonOption(options.payload, {}),
      priority: options.priority,
      dedupeKey: options.dedupe_key ?? null,
      maxAttempts: options.max_attempts
    });
  } else if (action === "claim") {
    result = claimJob({
      root: qualityRoot,
      workerId: options.worker ?? `worker_${process.pid}`
    });
  } else if (action === "complete" || action === "fail") {
    if (!options.job) fail(`queue ${action} requires --job ID.`);
    result = finishJob({
      root: qualityRoot,
      jobId: options.job,
      status: action === "complete" ? "completed" : "failed",
      error: options.error ?? null
    });
  } else if (action === "retry") {
    if (!options.job) fail("queue retry requires --job ID.");
    result = retryJob({ root: qualityRoot, jobId: options.job });
  } else if (action === "list") {
    result = listJobs({ root: qualityRoot, status: options.status ?? null });
  } else {
    fail(`Unknown queue action: ${action}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

function memoryCommand(options) {
  const action = options.action ?? "search";
  const workspace = resolve(options.workspace ?? process.cwd());
  let result;
  if (action === "put") {
    result = putMemory({
      root: qualityRoot,
      workspace,
      text: options.text,
      source: options.source ?? "operator",
      tags: parseJsonOption(
        options.tags,
        String(options.tags ?? "")
          .split(",")
          .filter(Boolean)
      )
    });
  } else if (action === "search") {
    result = searchMemory({
      root: qualityRoot,
      workspace,
      query: options.query ?? "",
      limit: options.limit
    });
  } else {
    fail(`Unknown memory action: ${action}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

function trace(options) {
  if (!options.run) fail("trace requires --run ID.");
  console.log(
    JSON.stringify(
      readTrace({ root: qualityRoot, runId: options.run }),
      null,
      2
    )
  );
}

function parallel(options) {
  const result = synthesizeParallel({
    root: qualityRoot,
    groupId: options.group,
    runIds: options.member
  });
  if (readDurableRun({ root: qualityRoot, runId: options.group })) {
    linkDurableMembers({
      root: qualityRoot,
      runId: options.group,
      memberIds: result.runIds,
      payload: { synthesis: result }
    });
    updateDurableRun({
      root: qualityRoot,
      runId: options.group,
      update(record) {
        record.state =
          result.status === "ready"
            ? "passed"
            : result.status === "incomplete"
              ? "running"
              : "failed";
        record.phase =
          result.status === "incomplete" ? "coordination" : "terminal";
        return record;
      }
    });
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "ready") process.exitCode = 1;
}

function stageResearch(options) {
  const run = loadRun(options.run);
  const input = resolve(run.workspace, options.file ?? "");
  const workspacePrefix = `${resolve(run.workspace)}/`;
  if (
    !options.file ||
    (!input.startsWith(workspacePrefix) && input !== resolve(run.workspace))
  ) {
    fail("--file must identify a file inside the managed worktree.");
  }
  if (!existsSync(input) || !statSync(input).isFile()) {
    fail(`Research deliverable not found: ${input}`);
  }
  mkdirSync(researchStagingRoot, { recursive: true });
  const stagedPath = join(researchStagingRoot, `${run.id}.md`);
  const body = readFileSync(input, "utf8");
  writeFileSync(
    stagedPath,
    [
      "---",
      `run: ${run.id}`,
      `source: ${JSON.stringify(input)}`,
      `target: ${JSON.stringify(options.target ?? null)}`,
      `staged_at: ${new Date().toISOString()}`,
      "approved: false",
      "---",
      "",
      body
    ].join("\n")
  );
  run.research = {
    stagedPath,
    source: input,
    target: options.target ?? null,
    stagedAt: new Date().toISOString(),
    approvedAt: null,
    publishedAt: null
  };
  saveRun(run);
  console.log(JSON.stringify(run.research, null, 2));
}

function approveResearch(options) {
  const run = loadRun(options.run);
  if (!run.research?.stagedPath)
    fail("This run has no staged research deliverable.");
  run.research.approvedAt = new Date().toISOString();
  saveRun(run);
  console.log(
    JSON.stringify(
      {
        ...run.research,
        note: "Approval records readiness only; publishing to Notion remains a separate authorized action."
      },
      null,
      2
    )
  );
}

function route(options) {
  const agent = options.agent ?? "lab";
  const task = options.task ?? "";
  const model = selectRunModel(agent, task, options.model);
  const requirements = inferRequirements([], task);
  const routeEnvelope = validateRouteEnvelope(
    inferRouteEnvelope({ agent, task, requirements, model })
  );
  console.log(
    JSON.stringify(
      { agent, task, model, requirements, route: routeEnvelope },
      null,
      2
    )
  );
}

function help() {
  console.log(`OpenCode Lab quality controller

Commands:
  run       --workspace PATH --task TEXT [--agent NAME] [--verify COMMAND] [--release]
  prepare   --workspace PATH --task TEXT [--agent NAME]
  resume    --run ID
  finalize  --run ID
  verify    --run ID
  review    --run ID
  status    [--run ID]
  artifacts --run ID [--manifest PATH] [--artifact PATH] [--migration-plan PATH]
  gate      --run ID
  adopt     --run ID
  prepare-pr --run ID [--title TEXT] [--body TEXT] [--base main]
  cancel    --run ID [--reason TEXT]
  abandon   --run ID [--reason TEXT]
  archive   --run ID
  cleanup   --run ID
  metrics   [--stale-hours NUMBER]
  retention --run ID [--days NUMBER]
  checkpoint --run ID [--phase NAME] [--reason TEXT]
  replay    --run ID --sequence NUMBER
  approvals [--run ID] [--status pending|approved|rejected]
  approve   --approval ID --decision approved|rejected [--note TEXT]
  trace     --run ID
  queue     --action list|enqueue|claim|complete|fail|retry [queue options]
  memory    --action put|search --workspace PATH [memory options]
  parallel  --group ID --member RUN_ID --member RUN_ID [...]
  route     --agent NAME --task TEXT
  research-stage   --run ID --file PATH [--target NOTION_PAGE]
  research-approve --run ID

The source worktree must be clean unless --allow-dirty-source is supplied. Dirty
source changes are never copied into the isolated run. Cleanup never deletes a
branch or a dirty worktree. Managed runs accept --idempotency-key plus bounded
--implementation-timeout-ms, --verification-timeout-ms, --review-timeout-ms,
--max-output-bytes, --max-tokens, --max-cost, --max-tool-calls, and
--max-attempts values. Controller adapters may also supply --run-kind and
--parent-run-id to join detached, parallel, and fleet work to the same durable
run graph.
Time and output limits are hard process boundaries. Usage budgets are enforced
live and at completion when provider JSONL includes usage; missing telemetry is
recorded as unavailable and is never treated as proof of zero usage.`);
}

mkdirSync(runsRoot, { recursive: true });
mkdirSync(idempotencyRoot, { recursive: true });
try {
  const options = parseArgs(process.argv.slice(2));
  if (options.command !== "help") reconcileDurableRuns({ root: qualityRoot });
  if (options.command === "run") setRunExitCode(await execute(options));
  else if (options.command === "prepare") prepare(options);
  else if (options.command === "resume") setRunExitCode(await resume(options));
  else if (options.command === "finalize") finalize(options);
  else if (options.command === "verify") {
    const run = loadRun(options.run);
    setRunExitCode(
      await withWorkerLease(run, "verify", (leasedRun) => verify(leasedRun))
    );
  } else if (options.command === "review") {
    const run = loadRun(options.run);
    setRunExitCode(
      await withWorkerLease(run, "review", (leasedRun) => review(leasedRun))
    );
  } else if (options.command === "status") status(options);
  else if (options.command === "artifacts") await recordArtifacts(options);
  else if (options.command === "gate") gate(options);
  else if (options.command === "adopt") adopt(options);
  else if (options.command === "prepare-pr") preparePr(options);
  else if (options.command === "cancel") await cancelRun(options);
  else if (options.command === "abandon") await abandon(options);
  else if (options.command === "archive") archive(options);
  else if (options.command === "cleanup") cleanup(options);
  else if (options.command === "metrics") metrics(options);
  else if (options.command === "retention") retention(options);
  else if (options.command === "checkpoint") checkpoint(options);
  else if (options.command === "replay") replay(options);
  else if (options.command === "approvals") approvals(options);
  else if (options.command === "approve") approve(options);
  else if (options.command === "trace") trace(options);
  else if (options.command === "queue") queueCommand(options);
  else if (options.command === "memory") memoryCommand(options);
  else if (options.command === "parallel") parallel(options);
  else if (options.command === "route") route(options);
  else if (options.command === "research-stage") stageResearch(options);
  else if (options.command === "research-approve") approveResearch(options);
  else help();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
