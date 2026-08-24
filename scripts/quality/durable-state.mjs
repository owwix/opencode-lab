import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
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

const TOKEN_RE = /(?:sk|cf|ntn|ghp|github_pat)_[A-Za-z0-9_-]{12,}/iu;
const SECRET_KEY_RE =
  /(authorization|api[_-]?key|api[_-]?token|password|secret|credential)/iu;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])])
    );
  }
  return value;
}

export function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

function redact(value) {
  if (typeof value === "string")
    return value.replace(TOKEN_RE, "[REDACTED_TOKEN]");
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        SECRET_KEY_RE.test(name) ? "[REDACTED]" : redact(item, name)
      ])
    );
  }
  return value;
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

function waitSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withStateLock(path, action, timeoutMs = 5_000) {
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let descriptor;
  while (descriptor === undefined) {
    try {
      descriptor = openSync(path, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() >= deadline)
        throw new Error(`Timed out waiting for state lock: ${path}`);
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

function runRoot(root, runId) {
  return join(resolve(root), "runs", runId);
}

export function recordTraceEvent({
  root,
  runId,
  traceId,
  type,
  phase,
  data = {}
}) {
  const event = {
    schemaVersion: 1,
    traceId: traceId ?? `trace_${runId}`,
    spanId: `span_${randomUUID().replaceAll("-", "")}`,
    runId,
    type,
    phase: phase ?? null,
    at: new Date().toISOString(),
    data: redact(data)
  };
  const line = `${JSON.stringify(event)}\n`;
  return withStateLock(join(resolve(root), "traces", ".trace.lock"), () => {
    const path = join(runRoot(root, runId), "trace.jsonl");
    const globalPath = join(resolve(root), "traces", "events.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    mkdirSync(dirname(globalPath), { recursive: true });
    appendFileSync(path, line, { mode: 0o600 });
    appendFileSync(globalPath, line, { mode: 0o600 });
    return event;
  });
}

export function readTrace({ root, runId }) {
  const path = join(runRoot(root, runId), "trace.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function checkpointRun({
  root,
  run,
  phase = null,
  reason = "state saved"
}) {
  const checkpointRoot = join(runRoot(root, run.id), "checkpoints");
  return withStateLock(join(checkpointRoot, ".checkpoint.lock"), () => {
    mkdirSync(checkpointRoot, { recursive: true });
    const existing = readdirSync(checkpointRoot)
      .filter((name) => /^\d{6}\.json$/u.test(name))
      .sort();
    const sequence = existing.length + 1;
    const previous = existing.at(-1)
      ? readJson(join(checkpointRoot, existing.at(-1)))
      : null;
    const snapshot = redact({
      schemaVersion: 1,
      runId: run.id,
      revision: run.revision,
      state: run.state,
      task: run.task,
      agent: run.agent,
      model: run.model,
      route: run.route,
      workspace: run.workspace,
      branch: run.branch,
      baseSha: run.baseSha,
      headSha: run.headSha,
      changedFiles: run.changedFiles,
      requirements: run.requirements,
      verification: run.verification,
      implementationResult: run.implementationResult,
      review: run.review,
      telemetry: run.telemetry,
      approvals: run.approvals,
      memory: run.memory,
      reason
    });
    const envelope = {
      ...snapshot,
      sequence,
      phase,
      previousHash: previous?.hash ?? null,
      createdAt: new Date().toISOString()
    };
    const record = { ...envelope, hash: digest(envelope) };
    atomicJson(
      join(checkpointRoot, `${String(sequence).padStart(6, "0")}.json`),
      record
    );
    atomicJson(join(checkpointRoot, "latest.json"), {
      sequence,
      hash: record.hash,
      file: `${String(sequence).padStart(6, "0")}.json`
    });
    return record;
  });
}

export function listCheckpoints({ root, runId }) {
  const checkpointRoot = join(runRoot(root, runId), "checkpoints");
  if (!existsSync(checkpointRoot)) return [];
  return readdirSync(checkpointRoot)
    .filter((name) => /^\d{6}\.json$/u.test(name))
    .sort()
    .map((name) => readJson(join(checkpointRoot, name)));
}

export function replayCheckpoint({ root, runId, sequence }) {
  const checkpoints = listCheckpoints({ root, runId });
  const recordIndex = checkpoints.findIndex(
    (item) => item.sequence === Number(sequence)
  );
  const record = recordIndex >= 0 ? checkpoints[recordIndex] : null;
  if (!record)
    throw new Error(`Checkpoint ${sequence} does not exist for run ${runId}.`);
  if (
    recordIndex > 0 &&
    record.previousHash !== checkpoints[recordIndex - 1].hash
  )
    throw new Error(
      `Checkpoint ${sequence} failed its chain-link integrity check.`
    );
  if (
    record.hash !==
    digest({
      schemaVersion: record.schemaVersion,
      runId: record.runId,
      revision: record.revision,
      state: record.state,
      task: record.task,
      agent: record.agent,
      model: record.model,
      route: record.route,
      workspace: record.workspace,
      branch: record.branch,
      baseSha: record.baseSha,
      headSha: record.headSha,
      changedFiles: record.changedFiles,
      requirements: record.requirements,
      verification: record.verification,
      implementationResult: record.implementationResult,
      review: record.review,
      telemetry: record.telemetry,
      approvals: record.approvals,
      memory: record.memory,
      reason: record.reason,
      sequence: record.sequence,
      phase: record.phase,
      previousHash: record.previousHash,
      createdAt: record.createdAt
    })
  )
    throw new Error(`Checkpoint ${sequence} failed its integrity check.`);
  return record;
}

export function requestApproval({
  root,
  runId,
  traceId,
  phase,
  action,
  reason
}) {
  if (!action || typeof action !== "string")
    throw new Error("Approval action is required.");
  const approvalRoot = join(resolve(root), "approvals");
  const id = `approval_${randomUUID()}`;
  const record = {
    schemaVersion: 1,
    id,
    runId,
    traceId: traceId ?? `trace_${runId}`,
    phase: phase ?? null,
    action,
    actionHash: digest({ action, runId, phase }),
    reason: reason ?? "agent requested approval",
    status: "pending",
    requestedAt: new Date().toISOString(),
    resolvedAt: null,
    resolvedBy: null,
    resolution: null
  };
  atomicJson(join(approvalRoot, `${id}.json`), record);
  recordTraceEvent({
    root,
    runId,
    traceId: record.traceId,
    type: "approval.requested",
    phase,
    data: { approvalId: id, action, reason }
  });
  return record;
}

export function listApprovals({ root, runId = null, status = null }) {
  const approvalRoot = join(resolve(root), "approvals");
  if (!existsSync(approvalRoot)) return [];
  return readdirSync(approvalRoot)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson(join(approvalRoot, name)))
    .filter(
      (item) =>
        (!runId || item.runId === runId) && (!status || item.status === status)
    )
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

export function resolveApproval({
  root,
  approvalId,
  decision,
  actor = "operator",
  note = ""
}) {
  if (!["approved", "rejected"].includes(decision))
    throw new Error("Approval decision must be approved or rejected.");
  const approvalRoot = join(resolve(root), "approvals");
  const path = join(approvalRoot, `${approvalId}.json`);
  const record = readJson(path);
  if (!record) throw new Error(`Unknown approval: ${approvalId}`);
  if (record.status !== "pending")
    throw new Error(`Approval ${approvalId} is already ${record.status}.`);
  record.status = decision;
  record.resolvedAt = new Date().toISOString();
  record.resolvedBy = actor;
  record.resolution = note;
  atomicJson(path, record);
  recordTraceEvent({
    root,
    runId: record.runId,
    traceId: record.traceId,
    type: `approval.${decision}`,
    phase: record.phase,
    data: { approvalId, actor, note }
  });
  return record;
}

function queueRoot(root) {
  return join(resolve(root), "queue");
}

export function enqueueJob({
  root,
  kind,
  payload = {},
  priority = 50,
  dedupeKey = null,
  maxAttempts = 3
}) {
  if (!kind || typeof kind !== "string")
    throw new Error("Queue job kind is required.");
  const jobsRoot = join(queueRoot(root), "jobs");
  mkdirSync(jobsRoot, { recursive: true });
  return withStateLock(join(queueRoot(root), ".queue.lock"), () => {
    const existing = listJobs({ root }).find(
      (job) =>
        dedupeKey &&
        job.dedupeKey === dedupeKey &&
        ["queued", "claimed"].includes(job.status)
    );
    if (existing) return existing;
    const job = {
      schemaVersion: 1,
      id: `job_${randomUUID()}`,
      kind,
      payload: redact(payload),
      priority: Number.isFinite(Number(priority)) ? Number(priority) : 50,
      dedupeKey,
      attempts: 0,
      maxAttempts: Math.max(1, Math.min(10, Number(maxAttempts) || 3)),
      status: "queued",
      createdAt: new Date().toISOString(),
      claimedAt: null,
      claimedBy: null,
      finishedAt: null,
      error: null
    };
    atomicJson(join(jobsRoot, `${job.id}.json`), job);
    return job;
  });
}

export function listJobs({ root, status = null }) {
  const jobsRoot = join(queueRoot(root), "jobs");
  if (!existsSync(jobsRoot)) return [];
  return readdirSync(jobsRoot)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson(join(jobsRoot, name)))
    .filter((job) => !status || job.status === status)
    .sort(
      (a, b) =>
        b.priority - a.priority || a.createdAt.localeCompare(b.createdAt)
    );
}

export function claimJob({ root, workerId }) {
  return withStateLock(join(queueRoot(root), ".queue.lock"), () => {
    const job = listJobs({ root, status: "queued" })[0];
    if (!job) return null;
    job.status = "claimed";
    job.attempts = Number(job.attempts ?? 0) + 1;
    job.claimedAt = new Date().toISOString();
    job.claimedBy = workerId ?? `worker_${process.pid}`;
    atomicJson(join(queueRoot(root), "jobs", `${job.id}.json`), job);
    return job;
  });
}

export function finishJob({ root, jobId, status, error = null }) {
  if (!["completed", "failed"].includes(status))
    throw new Error("Queue terminal status must be completed or failed.");
  return withStateLock(join(queueRoot(root), ".queue.lock"), () => {
    const path = join(queueRoot(root), "jobs", `${jobId}.json`);
    const job = readJson(path);
    if (!job) throw new Error(`Unknown queue job: ${jobId}`);
    const exhausted =
      status === "failed" &&
      Number(job.attempts ?? 0) >= Number(job.maxAttempts ?? 3);
    job.status = exhausted ? "dead_letter" : status;
    job.finishedAt = new Date().toISOString();
    job.error = error ? redact(error) : null;
    job.deadLetteredAt = exhausted ? new Date().toISOString() : null;
    atomicJson(path, job);
    return job;
  });
}

export function retryJob({ root, jobId }) {
  return withStateLock(join(queueRoot(root), ".queue.lock"), () => {
    const path = join(queueRoot(root), "jobs", `${jobId}.json`);
    const job = readJson(path);
    if (!job) throw new Error(`Unknown queue job: ${jobId}`);
    if (job.status !== "failed")
      throw new Error(
        `Only failed queue jobs can be retried; current status is ${job.status}.`
      );
    if (Number(job.attempts ?? 0) >= Number(job.maxAttempts ?? 3)) {
      job.status = "dead_letter";
      job.deadLetteredAt = new Date().toISOString();
    } else {
      job.status = "queued";
      job.claimedAt = null;
      job.claimedBy = null;
      job.finishedAt = null;
    }
    atomicJson(path, job);
    return job;
  });
}

function memoryPath(root, workspace) {
  return join(
    resolve(root),
    "memory",
    `${digest(resolve(workspace)).slice(0, 24)}.jsonl`
  );
}

export function putMemory({
  root,
  workspace,
  text,
  source = "operator",
  tags = []
}) {
  if (!workspace || !text || text.length > 20_000)
    throw new Error(
      "Memory requires a workspace and <=20,000 characters of text."
    );
  if (TOKEN_RE.test(text))
    throw new Error("Memory cannot contain credential-shaped tokens.");
  const path = memoryPath(root, workspace);
  mkdirSync(dirname(path), { recursive: true });
  const item = {
    schemaVersion: 1,
    id: `memory_${randomUUID()}`,
    workspace: resolve(workspace),
    text,
    source,
    tags: Array.isArray(tags) ? tags.slice(0, 20) : [],
    createdAt: new Date().toISOString()
  };
  appendFileSync(path, `${JSON.stringify(item)}\n`, { mode: 0o600 });
  return item;
}

export function searchMemory({ root, workspace, query, limit = 5 }) {
  const path = memoryPath(root, workspace);
  if (!existsSync(path) || !query) return [];
  const terms = String(query).toLowerCase().split(/\s+/u).filter(Boolean);
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((item) => ({
      item,
      score: terms.reduce(
        (score, term) =>
          score + (item.text.toLowerCase().includes(term) ? 1 : 0),
        0
      )
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 5)))
    .map(({ item }) => item);
}

export function workspacePolicy({
  workspace,
  operator = process.env.USER ?? "operator",
  roots = []
}) {
  const target = resolve(workspace);
  const allowedRoots = roots.filter(Boolean).map((root) => resolve(root));
  if (
    allowedRoots.length &&
    !allowedRoots.some(
      (root) => target === root || target.startsWith(`${root}/`)
    )
  ) {
    throw new Error(
      `Workspace is outside the configured operator roots: ${target}`
    );
  }
  return {
    operator,
    workspace: target,
    roots: allowedRoots,
    policyVersion: 1,
    operations: ["read", "write", "verify", "review"],
    checkedAt: new Date().toISOString()
  };
}
