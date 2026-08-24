import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const TERMINAL = new Set(["passed", "failed", "cancelled", "abandoned"]);

function milliseconds(start, end) {
  const value = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function approvalWait(run) {
  return (run.approvals ?? []).reduce((total, approval) => {
    if (!approval.requestedAt || !approval.resolvedAt) return total;
    return (
      total + (milliseconds(approval.requestedAt, approval.resolvedAt) ?? 0)
    );
  }, 0);
}

function reworkCount(run) {
  return (run.timeline ?? []).filter(
    ({ from, to }) =>
      from === "failed" &&
      ["implementing", "verifying", "reviewing"].includes(to)
  ).length;
}

function infrastructureFailure(run) {
  if (run.state !== "failed") return false;
  const reason = String(run.timeline?.at(-1)?.detail ?? "");
  return /(?:container|dagger|docker|gateway|network|timeout|deadline|connection|rate limit|infrastructure)/iu.test(
    reason
  );
}

function verifiedAt(run) {
  return (
    run.verification?.finishedAt ??
    run.timeline?.find(({ to }) => to === "reviewing")?.at ??
    null
  );
}

function terminalAt(run) {
  return (
    [...(run.timeline ?? [])].reverse().find(({ to }) => TERMINAL.has(to))
      ?.at ??
    run.updatedAt ??
    null
  );
}

export function deriveRunOutcome(run) {
  if (!TERMINAL.has(run.state))
    throw new Error(`Run is not terminal: ${run.state}`);
  const changed = new Set(run.changedFiles ?? []).size;
  const cost = Number(run.telemetry?.cost ?? 0);
  const receipt = {
    schemaVersion: 1,
    runId: run.id,
    traceId: run.traceId ?? null,
    state: run.state,
    subjectSha: run.headSha ?? null,
    createdAt: run.createdAt,
    terminalAt: terminalAt(run),
    timeToVerifiedMs: verifiedAt(run)
      ? milliseconds(run.createdAt, verifiedAt(run))
      : null,
    changedFiles: changed,
    observedCost: cost,
    costPerVerifiedChange:
      run.verification?.passed &&
      changed > 0 &&
      run.telemetry?.usageTelemetryObserved
        ? cost / changed
        : null,
    reworkCount: reworkCount(run),
    infrastructureFailure: infrastructureFailure(run),
    approvalWaitMs: approvalWait(run),
    prConverted: Boolean(run.publishing?.pr?.url),
    verificationDigest: run.verification?.evidenceDigest ?? null,
    reviewDigest: run.review?.evidenceDigest ?? null
  };
  return {
    ...receipt,
    receiptHash: createHash("sha256")
      .update(JSON.stringify(receipt))
      .digest("hex")
  };
}

export function recordRunOutcome({ root, run }) {
  if (!TERMINAL.has(run.state)) return null;
  const eventKey = createHash("sha256")
    .update(`${run.state}:${terminalAt(run)}`)
    .digest("hex")
    .slice(0, 20);
  const path = join(
    resolve(root),
    "runs",
    run.id,
    "outcomes",
    `${eventKey}.json`
  );
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, "utf8"));
    const { receiptHash, ...payload } = existing;
    const actual = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");
    if (actual !== receiptHash || existing.runId !== run.id) {
      throw new Error(`Immutable run outcome is invalid: ${path}`);
    }
    return existing;
  }
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(path, "wx", 0o600);
  try {
    const outcome = deriveRunOutcome(run);
    writeFileSync(descriptor, `${JSON.stringify(outcome, null, 2)}\n`);
    return outcome;
  } finally {
    closeSync(descriptor);
  }
}

export function summarizeOperationalMetrics(runs) {
  const terminal = runs.filter(({ state }) => TERMINAL.has(state));
  const outcomes = terminal.map(deriveRunOutcome);
  const verified = outcomes.filter(
    ({ timeToVerifiedMs }) => timeToVerifiedMs !== null
  );
  const priced = outcomes.filter(
    ({ costPerVerifiedChange }) => costPerVerifiedChange !== null
  );
  return {
    schemaVersion: 1,
    runs: runs.length,
    terminal: terminal.length,
    passed: outcomes.filter(({ state }) => state === "passed").length,
    meanTimeToVerifiedMs: verified.length
      ? verified.reduce((sum, item) => sum + item.timeToVerifiedMs, 0) /
        verified.length
      : null,
    meanCostPerVerifiedChange: priced.length
      ? priced.reduce((sum, item) => sum + item.costPerVerifiedChange, 0) /
        priced.length
      : null,
    rework: outcomes.reduce((sum, item) => sum + item.reworkCount, 0),
    infrastructureFailures: outcomes.filter(
      ({ infrastructureFailure }) => infrastructureFailure
    ).length,
    approvalWaitMs: outcomes.reduce(
      (sum, item) => sum + item.approvalWaitMs,
      0
    ),
    prConversions: runs.filter((run) => Boolean(run.publishing?.pr?.url)).length
  };
}
