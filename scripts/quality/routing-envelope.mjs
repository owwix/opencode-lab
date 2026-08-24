const MAX_TASK_LENGTH = 4_000;
const MAX_REASON_LENGTH = 600;

export const ROUTE_ENVELOPE_VERSION = "route-envelope/v1";

const AGENT_WORK_TYPES = Object.freeze({
  dispatcher: "dispatch",
  research: "research",
  fast: "coding",
  deep: "coding",
  plan: "coding",
  reviewer: "coding",
  lab: "coding"
});

function text(value) {
  return String(value ?? "").trim();
}

function match(value, pattern) {
  return pattern.test(value);
}

function bounded(value, max, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw new Error(
      `${label} must be a non-empty string of at most ${max} characters.`
    );
  }
  return value;
}

export function inferRouteEnvelope({
  agent = "lab",
  task = "",
  requirements = {},
  model = null
} = {}) {
  const normalizedAgent = text(agent).toLowerCase() || "lab";
  const normalizedTask = text(task).slice(0, MAX_TASK_LENGTH);
  const highRisk = Boolean(
    requirements.security ||
    requirements.deployment ||
    requirements.migration ||
    match(
      normalizedTask,
      /(?:security|authentication|authorization|secret|credential|permission|production|deploy|migration|billing|payment|tenant|incident)/iu
    )
  );
  const visual = Boolean(
    requirements.visual ||
    match(
      normalizedTask,
      /(?:image|visual|vision|screenshot|pdf|ocr|slide|presentation)/iu
    )
  );
  const complex = Boolean(
    highRisk ||
    match(
      normalizedTask,
      /(?:architecture|refactor|regression|debug|multi[- ]file|integration|schema|distributed|performance)/iu
    )
  );
  const workType = AGENT_WORK_TYPES[normalizedAgent] ?? normalizedAgent;
  const modality = visual ? "visual" : "text";
  const complexity = complex ? "frontier" : visual ? "visual" : "standard";
  const risk = highRisk ? "high" : "normal";
  const scope = match(
    normalizedTask,
    /(?:copy|typo|rename|status|summarize|explain)/iu
  )
    ? "small"
    : complex
      ? "multi-file"
      : "bounded";
  const reason = [
    `workType=${workType}`,
    `risk=${risk}`,
    `modality=${modality}`,
    `complexity=${complexity}`,
    `scope=${scope}`
  ].join(", ");
  return {
    protocol: ROUTE_ENVELOPE_VERSION,
    agent: normalizedAgent,
    task: normalizedTask,
    workType,
    complexity,
    risk,
    modality,
    scope,
    model: model ? text(model) : null,
    reason: reason.slice(0, MAX_REASON_LENGTH)
  };
}

export function validateRouteEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Route envelope must be an object.");
  }
  const expected = [
    "protocol",
    "agent",
    "task",
    "workType",
    "complexity",
    "risk",
    "modality",
    "scope",
    "model",
    "reason"
  ];
  const actual = Object.keys(value).sort();
  if (actual.join("\0") !== [...expected].sort().join("\0")) {
    throw new Error(
      `Route envelope must contain exactly: ${expected.join(", ")}.`
    );
  }
  if (value.protocol !== ROUTE_ENVELOPE_VERSION) {
    throw new Error(
      `Route envelope protocol must be ${ROUTE_ENVELOPE_VERSION}.`
    );
  }
  bounded(value.agent, 80, "agent");
  bounded(value.task, MAX_TASK_LENGTH, "task");
  bounded(value.reason, MAX_REASON_LENGTH, "reason");
  for (const [label, allowed] of [
    ["complexity", ["standard", "visual", "frontier"]],
    ["risk", ["normal", "high"]],
    ["modality", ["text", "visual"]],
    ["scope", ["small", "bounded", "multi-file"]]
  ]) {
    if (!allowed.includes(value[label]))
      throw new Error(`${label} is not supported.`);
  }
  if (!/^[a-z][a-z0-9-]{1,79}$/u.test(value.workType)) {
    throw new Error("workType is not supported.");
  }
  if (value.model !== null) bounded(value.model, 300, "model");
  return value;
}
