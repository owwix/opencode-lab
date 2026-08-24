import { spawn } from "node:child_process";

const IMPLEMENTATION_KEYS = Object.freeze([
  "protocol",
  "status",
  "summary",
  "changedFiles",
  "checks",
  "blockers"
]);
const REVIEW_KEYS = Object.freeze([
  "protocol",
  "status",
  "summary",
  "findings",
  "riskEvidence"
]);

export const DEFAULT_RUN_LIMITS = Object.freeze({
  implementationTimeoutMs: 30 * 60 * 1000,
  verificationTimeoutMs: 20 * 60 * 1000,
  reviewTimeoutMs: 10 * 60 * 1000,
  maxOutputBytes: 8 * 1024 * 1024,
  maxTokens: 250_000,
  maxCost: 25,
  maxToolCalls: 200,
  heartbeatMs: 5_000,
  terminationGraceMs: 2_000
});

function finitePositive(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive finite number.`);
  }
  return parsed;
}

export function normalizeRunLimits(input = {}) {
  return {
    implementationTimeoutMs: finitePositive(
      input.implementationTimeoutMs,
      DEFAULT_RUN_LIMITS.implementationTimeoutMs,
      "implementationTimeoutMs"
    ),
    verificationTimeoutMs: finitePositive(
      input.verificationTimeoutMs,
      DEFAULT_RUN_LIMITS.verificationTimeoutMs,
      "verificationTimeoutMs"
    ),
    reviewTimeoutMs: finitePositive(
      input.reviewTimeoutMs,
      DEFAULT_RUN_LIMITS.reviewTimeoutMs,
      "reviewTimeoutMs"
    ),
    maxOutputBytes: finitePositive(
      input.maxOutputBytes,
      DEFAULT_RUN_LIMITS.maxOutputBytes,
      "maxOutputBytes"
    ),
    maxTokens: finitePositive(
      input.maxTokens,
      DEFAULT_RUN_LIMITS.maxTokens,
      "maxTokens"
    ),
    maxCost: finitePositive(
      input.maxCost,
      DEFAULT_RUN_LIMITS.maxCost,
      "maxCost"
    ),
    maxToolCalls: finitePositive(
      input.maxToolCalls,
      DEFAULT_RUN_LIMITS.maxToolCalls,
      "maxToolCalls"
    ),
    heartbeatMs: finitePositive(
      input.heartbeatMs,
      DEFAULT_RUN_LIMITS.heartbeatMs,
      "heartbeatMs"
    ),
    terminationGraceMs: finitePositive(
      input.terminationGraceMs,
      DEFAULT_RUN_LIMITS.terminationGraceMs,
      "terminationGraceMs"
    )
  };
}

export function emptyTelemetry(durationMs = 0) {
  return {
    tokens: 0,
    cost: 0,
    toolCalls: 0,
    toolErrors: 0,
    modelCalls: 0,
    durationMs
  };
}

export function accumulateTelemetryEvent(result, event) {
  const serialized = JSON.stringify(event).toLowerCase();
  if (/"type":"tool(?:_use|-use|call)?"/u.test(serialized)) {
    result.toolCalls += 1;
    if (/"(?:error|status)":"?(?:error|failed)/u.test(serialized)) {
      result.toolErrors += 1;
    }
  }
  const usage = event.usage ?? event.part?.usage ?? event.message?.usage;
  if (usage && typeof usage === "object") {
    result.modelCalls += 1;
    result.tokens += [
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
      usage.input_tokens,
      usage.output_tokens,
      usage.cache_read_tokens,
      usage.cache_write_tokens
    ].reduce((sum, value) => sum + Number(value ?? 0), 0);
    result.cost += Number(usage.cost ?? event.cost ?? 0);
  }
  return result;
}

export function telemetryFromJsonl(output, durationMs = 0) {
  const telemetry = emptyTelemetry(durationMs);
  for (const line of String(output).split("\n").filter(Boolean)) {
    try {
      accumulateTelemetryEvent(telemetry, JSON.parse(line));
    } catch {
      // Non-JSON diagnostics are deliberately excluded from usage accounting.
    }
  }
  return telemetry;
}

function isApprovalEvent(event) {
  const type = String(event?.type ?? "").toLowerCase();
  return (
    [
      "approval_required",
      "approval.requested",
      "permission.asked",
      "permission.requested",
      "permission_request",
      "question",
      "question.asked"
    ].includes(type) ||
    (type.startsWith("permission") &&
      ["pending", "requested"].includes(
        String(event?.status ?? event?.permission?.status ?? "").toLowerCase()
      ))
  );
}

function isDoomLoopEvent(event) {
  const type = String(event?.type ?? "").toLowerCase();
  const permission = String(
    event?.permission?.type ?? event?.permission ?? ""
  ).toLowerCase();
  return (
    [
      "doom_loop",
      "doom-loop",
      "doom_loop.detected",
      "doom_loop_detected"
    ].includes(type) || permission === "doom_loop"
  );
}

function assistantText(event) {
  if (
    event?.type === "text" &&
    event.part?.type === "text" &&
    typeof event.part.text === "string"
  ) {
    return event.part.text;
  }
  if (
    ["message", "message.completed", "assistant.message"].includes(
      event?.type
    ) &&
    event.message?.role === "assistant"
  ) {
    if (typeof event.message.content === "string") {
      return event.message.content;
    }
    if (Array.isArray(event.message.content)) {
      return event.message.content
        .filter(
          (part) => part?.type === "text" && typeof part.text === "string"
        )
        .map((part) => part.text)
        .join("");
    }
  }
  if (
    event?.role === "assistant" &&
    event.final === true &&
    typeof event.content === "string"
  ) {
    return event.content;
  }
  return null;
}

function plainObject(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(value, allowed, label) {
  const keys = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} must contain exactly: ${allowed.join(", ")}.`);
  }
}

function boundedString(value, label, { min = 1, max = 8_000 } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new Error(
      `${label} must be a string between ${min} and ${max} characters.`
    );
  }
  return value;
}

function boundedArray(value, label, max = 500) {
  if (!Array.isArray(value) || value.length > max) {
    throw new Error(`${label} must be an array with at most ${max} entries.`);
  }
  return value;
}

function validateImplementation(value) {
  if (!plainObject(value))
    throw new Error("Implementation result must be an object.");
  exactKeys(value, IMPLEMENTATION_KEYS, "Implementation result");
  if (value.protocol !== "quality-result/v1") {
    throw new Error("Implementation protocol must be quality-result/v1.");
  }
  if (!["complete", "blocked"].includes(value.status)) {
    throw new Error("Implementation status must be complete or blocked.");
  }
  boundedString(value.summary, "Implementation summary");
  boundedArray(value.changedFiles, "changedFiles").forEach((file, index) => {
    boundedString(file, `changedFiles[${index}]`, { max: 1_000 });
    if (file.startsWith("/") || file.split(/[\\/]/u).includes("..")) {
      throw new Error(`changedFiles[${index}] must be workspace-relative.`);
    }
  });
  boundedArray(value.checks, "checks", 200).forEach((check, index) => {
    if (!plainObject(check))
      throw new Error(`checks[${index}] must be an object.`);
    exactKeys(check, ["command", "status"], `checks[${index}]`);
    boundedString(check.command, `checks[${index}].command`, { max: 2_000 });
    if (!["passed", "failed", "not_run"].includes(check.status)) {
      throw new Error(`checks[${index}].status is invalid.`);
    }
  });
  boundedArray(value.blockers, "blockers", 100).forEach((blocker, index) =>
    boundedString(blocker, `blockers[${index}]`, { max: 2_000 })
  );
  if (value.status === "blocked" && value.blockers.length === 0) {
    throw new Error(
      "A blocked implementation must identify at least one blocker."
    );
  }
  if (value.status === "complete" && value.blockers.length > 0) {
    throw new Error("A complete implementation cannot include blockers.");
  }
  if (
    value.status === "complete" &&
    value.checks.some((check) => check.status === "failed")
  ) {
    throw new Error("A complete implementation cannot report a failed check.");
  }
  return value;
}

function validateRiskEvidence(value, label) {
  if (!plainObject(value)) throw new Error(`${label} must be an object.`);
  exactKeys(value, ["status", "evidence"], label);
  if (!["pass", "fail", "not_applicable"].includes(value.status)) {
    throw new Error(`${label}.status is invalid.`);
  }
  boundedArray(value.evidence, `${label}.evidence`, 100).forEach(
    (entry, index) =>
      boundedString(entry, `${label}.evidence[${index}]`, { max: 2_000 })
  );
  if (value.status === "pass" && value.evidence.length === 0) {
    throw new Error(`${label} cannot pass without concrete evidence.`);
  }
}

function validateReview(value) {
  if (!plainObject(value)) throw new Error("Review result must be an object.");
  exactKeys(value, REVIEW_KEYS, "Review result");
  if (value.protocol !== "quality-review/v1") {
    throw new Error("Review protocol must be quality-review/v1.");
  }
  if (!["pass", "fail"].includes(value.status)) {
    throw new Error("Review status must be pass or fail.");
  }
  boundedString(value.summary, "Review summary");
  boundedArray(value.findings, "findings", 200).forEach((finding, index) => {
    if (!plainObject(finding)) {
      throw new Error(`findings[${index}] must be an object.`);
    }
    exactKeys(
      finding,
      ["severity", "message", "file", "line"],
      `findings[${index}]`
    );
    if (!["critical", "high", "medium", "low"].includes(finding.severity)) {
      throw new Error(`findings[${index}].severity is invalid.`);
    }
    boundedString(finding.message, `findings[${index}].message`, {
      max: 4_000
    });
    if (finding.file !== null) {
      boundedString(finding.file, `findings[${index}].file`, { max: 1_000 });
    }
    if (
      finding.line !== null &&
      (!Number.isInteger(finding.line) || finding.line < 1)
    ) {
      throw new Error(
        `findings[${index}].line must be null or a positive integer.`
      );
    }
  });
  if (!plainObject(value.riskEvidence)) {
    throw new Error("riskEvidence must be an object.");
  }
  exactKeys(value.riskEvidence, ["security", "deployment"], "riskEvidence");
  validateRiskEvidence(value.riskEvidence.security, "riskEvidence.security");
  validateRiskEvidence(
    value.riskEvidence.deployment,
    "riskEvidence.deployment"
  );
  if (
    value.status === "pass" &&
    value.findings.some((finding) =>
      ["critical", "high", "medium"].includes(finding.severity)
    )
  ) {
    throw new Error("A passing review cannot contain a material finding.");
  }
  if (value.status === "fail" && value.findings.length === 0) {
    throw new Error("A failing review must identify at least one finding.");
  }
  return value;
}

export function parseFinalAssistantResult(output, kind) {
  const assistantEvents = [];
  for (const line of String(output).split("\n").filter(Boolean)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const text = assistantText(event);
    if (text !== null) assistantEvents.push(text);
  }
  if (assistantEvents.length === 0) {
    throw new Error(
      "No final assistant text event was found in OpenCode JSONL."
    );
  }
  const finalText = assistantEvents.at(-1).trim();
  let value;
  try {
    value = JSON.parse(finalText);
  } catch {
    throw new Error(
      "The final assistant event must contain only one JSON object."
    );
  }
  return kind === "review"
    ? validateReview(value)
    : validateImplementation(value);
}

function signalProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") process.kill(child.pid, signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export function terminateProcessIdentity(identity, signal = "SIGTERM") {
  const pid = Number(identity?.pid);
  const processGroupId = Number(identity?.processGroupId);
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    if (
      process.platform !== "win32" &&
      Number.isInteger(processGroupId) &&
      processGroupId > 1
    ) {
      process.kill(-processGroupId, signal);
    } else {
      process.kill(pid, signal);
    }
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (
      error?.code === "EPERM" &&
      process.platform !== "win32" &&
      processGroupId === pid
    ) {
      try {
        process.kill(pid, signal);
        return true;
      } catch (fallbackError) {
        if (fallbackError?.code === "ESRCH") return false;
        throw fallbackError;
      }
    }
    throw error;
  }
}

export function processIsAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 1) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

export function runBounded(
  command,
  args,
  {
    cwd,
    env,
    timeoutMs,
    maxOutputBytes,
    budgets = {},
    inheritEnv = true,
    abortSignal,
    terminationGraceMs = DEFAULT_RUN_LIMITS.terminationGraceMs,
    onProcess,
    onHeartbeat,
    heartbeatMs = DEFAULT_RUN_LIMITS.heartbeatMs
  } = {}
) {
  const startedAt = Date.now();
  const telemetry = emptyTelemetry();
  const outputLimit = finitePositive(
    maxOutputBytes,
    DEFAULT_RUN_LIMITS.maxOutputBytes,
    "maxOutputBytes"
  );
  const deadline = finitePositive(
    timeoutMs,
    DEFAULT_RUN_LIMITS.implementationTimeoutMs,
    "timeoutMs"
  );
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env: inheritEnv ? { ...process.env, ...env } : { ...env },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const identity = {
      pid: child.pid,
      processGroupId: process.platform === "win32" ? null : child.pid,
      startedAt: new Date(startedAt).toISOString(),
      deadlineAt: new Date(startedAt + deadline).toISOString()
    };
    try {
      onProcess?.(identity);
    } catch (error) {
      signalProcessGroup(child, "SIGKILL");
      child.stdout.resume();
      child.stderr.resume();
      rejectRun(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let budgetExceeded = null;
    let approvalRequired = false;
    let doomLoopDetected = false;
    let aborted = false;
    let controlError = null;
    let terminating = false;
    let stdoutRemainder = "";
    let stderrRemainder = "";

    const stop = (reason) => {
      if (terminating) return;
      terminating = true;
      if (reason === "timeout") timedOut = true;
      else if (reason === "output") outputLimitExceeded = true;
      else if (reason === "approval") approvalRequired = true;
      else if (reason === "doomLoop") doomLoopDetected = true;
      else if (reason === "abort") aborted = true;
      else if (reason === "control")
        controlError = "heartbeat persistence failed";
      else budgetExceeded = reason;
      signalProcessGroup(child, "SIGTERM");
      setTimeout(
        () => signalProcessGroup(child, "SIGKILL"),
        terminationGraceMs
      ).unref();
    };

    const abortRun = () => stop("abort");
    if (abortSignal?.aborted) abortRun();
    else abortSignal?.addEventListener("abort", abortRun, { once: true });

    const checkBudgets = () => {
      if (
        Number.isFinite(Number(budgets.maxTokens)) &&
        telemetry.tokens > Number(budgets.maxTokens)
      ) {
        stop("tokens");
      } else if (
        Number.isFinite(Number(budgets.maxCost)) &&
        telemetry.cost > Number(budgets.maxCost)
      ) {
        stop("cost");
      } else if (
        Number.isFinite(Number(budgets.maxToolCalls)) &&
        telemetry.toolCalls > Number(budgets.maxToolCalls)
      ) {
        stop("toolCalls");
      }
    };

    const accountLines = (chunk, stream) => {
      const prior = stream === "stdout" ? stdoutRemainder : stderrRemainder;
      const combined = prior + chunk;
      const lines = combined.split("\n");
      const remainder = lines.pop() ?? "";
      if (stream === "stdout") stdoutRemainder = remainder;
      else stderrRemainder = remainder;
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          accumulateTelemetryEvent(telemetry, event);
          if (isDoomLoopEvent(event)) stop("doomLoop");
          else if (isApprovalEvent(event)) stop("approval");
          checkBudgets();
        } catch {
          // Diagnostic lines do not contribute to model usage.
        }
      }
    };

    const capture = (chunk, stream) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, outputLimit - capturedBytes);
      const accepted = buffer.subarray(0, remaining);
      capturedBytes += accepted.length;
      const text = accepted.toString("utf8");
      if (stream === "stdout") stdout += text;
      else stderr += text;
      accountLines(text, stream);
      if (buffer.length > remaining) stop("output");
    };

    child.stdout.on("data", (chunk) => capture(chunk, "stdout"));
    child.stderr.on("data", (chunk) => capture(chunk, "stderr"));
    child.once("error", rejectRun);
    const timeout = setTimeout(() => stop("timeout"), deadline);
    const heartbeat = setInterval(() => {
      try {
        onHeartbeat?.({
          ...identity,
          heartbeatAt: new Date().toISOString()
        });
      } catch {
        stop("control");
      }
    }, heartbeatMs);
    heartbeat.unref();

    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      abortSignal?.removeEventListener("abort", abortRun);
      for (const remainder of [stdoutRemainder, stderrRemainder]) {
        if (!remainder) continue;
        try {
          const event = JSON.parse(remainder);
          accumulateTelemetryEvent(telemetry, event);
          if (isDoomLoopEvent(event)) stop("doomLoop");
          else if (isApprovalEvent(event)) stop("approval");
          checkBudgets();
        } catch {
          // Ignore incomplete/non-JSON final diagnostics.
        }
      }
      telemetry.durationMs = Date.now() - startedAt;
      resolveRun({
        status,
        signal,
        stdout,
        stderr,
        timedOut,
        outputLimitExceeded,
        budgetExceeded,
        approvalRequired,
        doomLoopDetected,
        aborted,
        controlError,
        usageTelemetryObserved: telemetry.modelCalls > 0,
        telemetry,
        durationMs: telemetry.durationMs,
        identity,
        passed:
          status === 0 &&
          !timedOut &&
          !outputLimitExceeded &&
          !approvalRequired &&
          !doomLoopDetected &&
          !aborted &&
          !controlError &&
          !budgetExceeded
      });
    });
  });
}
