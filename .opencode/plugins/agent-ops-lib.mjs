const SECRET_PATTERN =
  /(?:\.env|\.dev\.vars|credential|secret|token|password|\.pem|\.key|\.npmrc|\.netrc)/iu;

const SAFE_PERMISSIONS = new Set([
  "edit",
  "glob",
  "grep",
  "list",
  "lsp",
  "read",
  "todoread",
  "todowrite"
]);

const PROTECTED_PERMISSION_PATTERN =
  /(?:notion|publish|github_(?:push|open_pr)|deploy|external_directory|credential|secret|quality|browser|hound|research|network|fetch|download)/iu;

const VERIFY_PATTERN =
  /(?:\btest(?:s|ing)?\b|\btypecheck\b|\blint(?:ing)?\b|\bpreflight\b|\bverify|\bverification\b|\bcheck(?:s|ing)?\b)/iu;
const REVIEW_PATTERN = /(?:\breview(?:er|ing|ed)?\b|\baudit(?:ed|ing)?\b)/iu;
const FAILURE_PATTERN =
  /(?:\bfailed?\b|\bfailing\b|\berror\b|\bblocked\b|not verified|did not pass)/iu;
const PASS_PATTERN =
  /(?:\bpass(?:ed|es|ing)?\b|\bsuccess(?:ful|fully)?\b|\bgreen\b|\bverified\b|\bcomplete(?:d)?\b)/iu;

export const STATE_PRESENTATION = Object.freeze({
  researching: { label: "RESEARCHING", color: "info" },
  editing: { label: "EDITING", color: "warning" },
  reviewing: { label: "REVIEWING", color: "accent" },
  blocked: { label: "BLOCKED", color: "error" },
  complete: { label: "COMPLETE", color: "success" }
});

function normalized(value) {
  return String(value ?? "").trim();
}

export function latestAssistant(messages) {
  return [...messages]
    .reverse()
    .find((message) => message?.role === "assistant");
}

export function currentAgent(session, messages) {
  return (
    latestAssistant(messages)?.agent ??
    [...messages].reverse().find((message) => message?.role === "user")
      ?.agent ??
    session?.agent ??
    "lab"
  );
}

export function inferTaskType(agent) {
  const value = normalized(agent).toLowerCase();
  if (value.includes("research")) return "Research";
  if (value.includes("review")) return "Review";
  if (value.includes("dispatcher")) return "Dispatch";
  if (value.includes("plan")) return "Plan";
  if (["fast", "lab", "deep", "build"].includes(value)) return "Build";
  return value
    ? value.replace(
        /(^|-)([a-z])/gu,
        (_, prefix, letter) => `${prefix ? " " : ""}${letter.toUpperCase()}`
      )
    : "Build";
}

export function inferLayout(agent, override = "auto") {
  if (["build", "research"].includes(override)) return override;
  const task = inferTaskType(agent).toLowerCase();
  if (task === "research") return "research";
  return "build";
}

/**
 * @param {{status?: any, pendingPermissions?: readonly any[], agent?: unknown, messages?: readonly any[]}} input
 */
export function deriveSessionState({
  status,
  pendingPermissions = [],
  agent,
  messages = []
}) {
  if (pendingPermissions.length > 0) return "blocked";
  const latest = latestAssistant(messages);
  if (latest?.error || status?.type === "retry") return "blocked";
  if (status?.type === "busy") {
    const task = inferTaskType(agent);
    if (task === "Research") return "researching";
    if (task === "Review") return "reviewing";
    return "editing";
  }
  return "complete";
}

export function isSafePermission(request) {
  if (!request || !SAFE_PERMISSIONS.has(normalized(request.permission))) {
    return false;
  }
  return [...(request.patterns ?? []), JSON.stringify(request.metadata ?? {})]
    .map(normalized)
    .every((value) => !SECRET_PATTERN.test(value));
}

export function isAutoApprovable(request, approvalMode = "safe-auto") {
  if (approvalMode === "ask") return false;
  if (approvalMode === "safe-auto") return isSafePermission(request);
  if (approvalMode !== "broad-auto" || !request) return false;

  const permission = normalized(request.permission);
  const details = [...(request.patterns ?? []), request.metadata ?? {}]
    .map((value) =>
      typeof value === "string" ? value : JSON.stringify(value ?? {})
    )
    .join("\n");
  if (PROTECTED_PERMISSION_PATTERN.test(permission)) return false;
  if (SECRET_PATTERN.test(details)) return false;
  // Shell programs can hide network, publishing, or credential access behind
  // an otherwise harmless command name. Broad mode never answers shell
  // prompts; the explicit OpenCode allow/deny table remains authoritative.
  if (permission === "bash") return false;
  return true;
}

function toolText(part) {
  const state = part?.state ?? {};
  return [
    part?.tool,
    state?.title,
    JSON.stringify(state?.input ?? {}),
    state?.status === "completed" ? state.output : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function possibleRun(value, found = []) {
  if (!value || typeof value !== "object") return found;
  if (
    typeof value.state === "string" &&
    (value.verification || value.review || value.telemetry)
  ) {
    found.push(value);
  }
  for (const child of Object.values(value)) possibleRun(child, found);
  return found;
}

function structuredRuns(parts) {
  const found = [];
  for (const part of parts) {
    if (part?.type !== "tool" || part.state?.status !== "completed") continue;
    const output = normalized(part.state.output);
    if (!output.startsWith("{") && !output.startsWith("[")) continue;
    try {
      possibleRun(JSON.parse(output), found);
    } catch {
      // Non-JSON tool output is not quality evidence.
    }
  }
  return found;
}

/**
 * @param {{status?: any, pendingPermissions?: readonly any[], todos?: readonly any[], messages?: readonly any[], parts?: readonly any[]}} input
 */
export function qualitySnapshot({
  status,
  pendingPermissions = [],
  todos = [],
  messages = [],
  parts = []
}) {
  const tools = parts.filter((part) => part?.type === "tool");
  const completedTools = tools.filter(
    (part) => part.state?.status === "completed"
  );
  const toolErrors = tools.filter((part) => part.state?.status === "error");
  const runs = structuredRuns(parts);
  const run = runs.at(-1);
  const verificationSignals = completedTools.filter((part) => {
    const text = toolText(part);
    return VERIFY_PATTERN.test(text) && !FAILURE_PATTERN.test(text);
  }).length;
  const reviewSignals = completedTools.filter((part) => {
    const text = toolText(part);
    return (
      REVIEW_PATTERN.test(text) &&
      PASS_PATTERN.test(text) &&
      !FAILURE_PATTERN.test(text)
    );
  }).length;
  const todoComplete =
    todos.length > 0 &&
    todos.every((todo) => ["completed", "cancelled"].includes(todo.status));
  const assistantError = Boolean(latestAssistant(messages)?.error);
  const verificationPassed = Boolean(run?.verification?.passed);
  const reviewPassed = Boolean(run?.review?.passed);

  let score = 0;
  if (!assistantError && pendingPermissions.length === 0) score += 15;
  if (completedTools.length > 0 && toolErrors.length === 0) score += 20;
  if (todoComplete) score += 15;
  if (verificationPassed) score += 30;
  else if (verificationSignals > 0) score += 18;
  if (reviewPassed) score += 20;
  else if (reviewSignals > 0) score += 10;

  const verification = verificationPassed
    ? `passed${run?.verification?.sha ? ` @ ${String(run.verification.sha).slice(0, 7)}` : ""}`
    : verificationSignals > 0
      ? `${verificationSignals} successful check${verificationSignals === 1 ? "" : "s"}`
      : "no evidence yet";
  const review = reviewPassed
    ? `passed${run?.review?.sha ? ` @ ${String(run.review.sha).slice(0, 7)}` : ""}`
    : reviewSignals > 0
      ? `${reviewSignals} positive review signal${reviewSignals === 1 ? "" : "s"}`
      : "not recorded";

  return {
    score: Math.min(100, score),
    verification,
    review,
    toolErrors: toolErrors.length,
    completedTools: completedTools.length,
    managedState: run?.state,
    status: status?.type ?? "idle"
  };
}

export function layoutChecklist(layout) {
  if (layout === "research") {
    return [
      "source traceability",
      "decision synthesis",
      "uncertainty",
      "publish stage"
    ];
  }
  return [
    "scoped diff",
    "tests and checks",
    "independent review",
    "clean handoff"
  ];
}
