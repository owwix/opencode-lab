import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

export const RUN_STATES = Object.freeze([
  "prepared",
  "implementing",
  "verifying",
  "reviewing",
  "needs_evidence",
  "passed",
  "failed",
  "cancelled",
  "abandoned",
  "archived"
]);

const TRANSITIONS = Object.freeze({
  prepared: new Set([
    "implementing",
    "verifying",
    "failed",
    "cancelled",
    "abandoned"
  ]),
  implementing: new Set(["verifying", "failed", "cancelled", "abandoned"]),
  verifying: new Set(["reviewing", "failed", "cancelled", "abandoned"]),
  reviewing: new Set([
    "needs_evidence",
    "passed",
    "failed",
    "cancelled",
    "abandoned"
  ]),
  needs_evidence: new Set([
    "verifying",
    "reviewing",
    "passed",
    "failed",
    "cancelled",
    "abandoned"
  ]),
  passed: new Set(["verifying", "reviewing", "failed", "archived"]),
  failed: new Set([
    "implementing",
    "verifying",
    "reviewing",
    "cancelled",
    "abandoned",
    "archived"
  ]),
  cancelled: new Set(["implementing", "archived"]),
  abandoned: new Set(["implementing", "archived"]),
  archived: new Set([])
});

export const ACTIVE_RUN_STATES = Object.freeze([
  "prepared",
  "implementing",
  "verifying",
  "reviewing",
  "needs_evidence"
]);

export function slugify(value, fallback = "task") {
  const slug = String(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return slug || fallback;
}

export function createRunId({
  now = new Date(),
  random = randomBytes(3).toString("hex")
} = {}) {
  const stamp = now
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z");
  return `${stamp}-${random}`;
}

export function assertTransition(from, to) {
  if (!RUN_STATES.includes(from) || !RUN_STATES.includes(to)) {
    throw new Error(`Unknown quality-run transition: ${from} -> ${to}`);
  }
  if (!TRANSITIONS[from].has(to)) {
    throw new Error(`Invalid quality-run transition: ${from} -> ${to}`);
  }
}

export function inferRequirements(files, diffContext = "") {
  const normalized = files.map((file) => file.replaceAll("\\", "/"));
  const matches = (pattern) => normalized.some((file) => pattern.test(file));
  const context = String(diffContext).slice(0, 2_000_000);
  return {
    visual: matches(/\.(?:css|scss|sass|less|tsx|jsx|vue|svelte|html)$/u),
    security:
      matches(
        /(?:auth|security|permission|tenant|secret|credential|session)/iu
      ) ||
      /(?:authorization|authentication|bearer|oauth|jwt|csrf|cookie|api[_-]?key|access[_-]?token|password|process\.env)/iu.test(
        context
      ),
    migration: matches(/(?:^|\/)(?:migrations?|schema)(?:\/|\.|$)/iu),
    deployment:
      matches(/(?:railway|wrangler|docker|deploy|\.github\/workflows)/iu) ||
      /(?:wrangler|docker(?:file|\s+compose)?|github\/workflows|kubernetes|terraform|cloudflare[_-]?account|deploy(?:ment)?)/iu.test(
        context
      )
  };
}

export function selectPackageCommands(
  packageJson,
  requirements,
  { release = false } = {}
) {
  const scripts = packageJson?.scripts ?? {};
  const commands = [];
  const add = (name) => {
    if (scripts[name] && !commands.includes(`npm run ${name}`))
      commands.push(`npm run ${name}`);
  };

  if (release && scripts["check:release"]) {
    add("check:release");
    return commands;
  }
  if (scripts.check) {
    add("check");
    return commands;
  }
  add("format:check");
  add("lint");
  add("typecheck");
  add("test");
  return commands;
}

export function readPackageCommands(workspace, requirements, options) {
  try {
    const packageJson = JSON.parse(
      readFileSync(`${workspace}/package.json`, "utf8")
    );
    return selectPackageCommands(packageJson, requirements, options);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export function evidenceDigest(evidence) {
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

export function evaluateReleaseGate(run) {
  const blockers = [];
  if (run.state !== "passed")
    blockers.push(`run state is ${run.state}, not passed`);
  if (!run.changedFiles?.length)
    blockers.push("no changed files were recorded");
  if (!run.verification?.passed)
    blockers.push("deterministic verification is not green");
  if (!run.review?.passed) blockers.push("independent review is not green");
  if (!run.review?.distinctFromImplementation) {
    blockers.push("review model is not distinct from the implementation model");
  }
  if (!run.implementationCheckpoint?.passed) {
    blockers.push("controller-owned implementation checkpoint is not green");
  } else {
    if (run.implementationCheckpoint.headSha !== run.headSha) {
      blockers.push(
        "implementation checkpoint is not bound to the current HEAD"
      );
    }
    const checkpointFiles = [
      ...new Set(run.implementationCheckpoint.changedFiles ?? [])
    ].sort();
    const runFiles = [...new Set(run.changedFiles ?? [])].sort();
    if (JSON.stringify(checkpointFiles) !== JSON.stringify(runFiles)) {
      blockers.push(
        "declared changed files differ from the implementation checkpoint"
      );
    }
  }
  blockers.push(...evaluateRiskGate(run).blockers);
  if (!run.verification?.sha || run.verification.sha !== run.headSha) {
    blockers.push("verification is not bound to the current commit SHA");
  }
  if (!run.review?.sha || run.review.sha !== run.headSha) {
    blockers.push("review is not bound to the current commit SHA");
  }
  if (!run.clean) blockers.push("release worktree is not clean");
  if (run.requirements?.visual && !run.artifacts?.visual?.length) {
    blockers.push("visual changes require rendered evidence");
  }
  if (run.requirements?.migration && !run.artifacts?.migrationPlan) {
    blockers.push(
      "migration changes require a compatibility and recovery plan"
    );
  }
  if (
    run.contract?.name &&
    run.contract.name !== "coding" &&
    !run.artifacts?.contractEvidence?.passed
  ) {
    blockers.push(
      `${run.contract.name} quality-contract evidence is not green`
    );
  }
  if (
    run.artifacts?.contractEvidence?.passed &&
    (run.artifacts.contractEvidence.subjectSha !==
      (run.implementationCheckpoint?.contentSha ?? run.headSha) ||
      run.artifacts.contractEvidence.manifest?.commitSha !==
        (run.implementationCheckpoint?.contentSha ?? run.headSha))
  ) {
    blockers.push(
      "artifact evidence is not bound to the verified implementation"
    );
  }
  return { passed: blockers.length === 0, blockers };
}

export function evaluateRiskGate(run) {
  const blockers = [];
  for (const risk of ["security", "deployment"]) {
    if (!run.requirements?.[risk]) continue;
    const result = run.review?.riskEvidence?.[risk];
    if (result?.status !== "pass") {
      blockers.push(`${risk} risk review is not green`);
      continue;
    }
    if (!Array.isArray(result.evidence) || result.evidence.length === 0) {
      blockers.push(`${risk} risk review has no concrete evidence`);
    }
  }
  if (
    (run.requirements?.security || run.requirements?.deployment) &&
    !run.review?.distinctFromImplementation
  ) {
    blockers.push(
      "security or deployment changes require a reviewer model distinct from the implementation model"
    );
  }
  return { passed: blockers.length === 0, blockers };
}

export function selectModelRoute(agent, task, policy) {
  const normalizedAgent = slugify(agent, "lab");
  const normalizedTask = String(task).toLowerCase();
  const rules = policy?.rules ?? [];
  const matches = rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => {
      const agentMatches = !rule.agent || rule.agent === normalizedAgent;
      const taskMatches =
        !rule.taskPattern ||
        new RegExp(rule.taskPattern, "iu").test(normalizedTask);
      return agentMatches && taskMatches;
    })
    .sort((left, right) => {
      const priorityDifference =
        Number(right.rule.priority ?? 0) - Number(left.rule.priority ?? 0);
      return priorityDifference || left.index - right.index;
    });
  return matches[0]?.rule.model ?? policy?.defaultModel ?? null;
}

function reviewerCandidates(policy, task) {
  const reviewPolicyCandidates = Array.isArray(
    policy?.reviewPolicy?.reviewerCandidates
  )
    ? policy.reviewPolicy.reviewerCandidates
        .filter((entry) => entry?.status === "eligible")
        .map((entry) => ({ model: entry.model, family: entry.family ?? null }))
    : [];
  const configured = Array.isArray(policy?.reviewers) ? policy.reviewers : [];
  const legacyCandidates = configured
    .filter((entry) => entry?.enabled !== false)
    .filter((entry) => {
      if (typeof entry === "string" || !entry?.taskPattern) return true;
      return new RegExp(entry.taskPattern, "iu").test(String(task));
    })
    .map((entry) => ({
      model: typeof entry === "string" ? entry : entry.model,
      family: typeof entry === "string" ? null : (entry.family ?? null)
    }))
    .filter((entry) => entry.model);
  const legacy = selectModelRoute("reviewer", task, policy);
  if (legacy) legacyCandidates.push({ model: legacy, family: null });
  const candidates = reviewPolicyCandidates.length
    ? reviewPolicyCandidates
    : legacyCandidates;
  return candidates.filter(
    (entry, index) =>
      candidates.findIndex((candidate) => candidate.model === entry.model) ===
      index
  );
}

export function selectReviewerRoutes(
  task,
  requirements,
  policy,
  implementationModel
) {
  const highRisk = Boolean(
    requirements?.security ||
    requirements?.deployment ||
    requirements?.migration ||
    /(?:billing|payments?|tenant[-_ ]isolation|secret[-_ ]handling|agent[-_ ]permission)/iu.test(
      String(task)
    )
  );
  const legacyStrategy = policy?.reviewerStrategy ?? {};
  const level = policy?.reviewPolicy?.levels?.[highRisk ? "high" : "standard"];
  const minimum = Number(
    level?.minimumReviewers ??
      (highRisk
        ? (legacyStrategy.highRiskMinimumReviewers ?? 1)
        : (legacyStrategy.minimumReviewers ?? 1))
  );
  const minimumFamilies = Number(level?.minimumDistinctModelFamilies ?? 1);
  const candidates = reviewerCandidates(policy, task).filter(
    (candidate) => candidate.model !== implementationModel
  );
  if (!Number.isInteger(minimum) || minimum < 1) {
    throw new Error("Reviewer minimum must be a positive integer.");
  }
  if (!Number.isInteger(minimumFamilies) || minimumFamilies < 1) {
    throw new Error("Reviewer family minimum must be a positive integer.");
  }
  const selected = candidates.slice(0, minimum);
  const families = new Set(
    selected.map((candidate) => candidate.family ?? candidate.model)
  );
  if (selected.length < minimum || families.size < minimumFamilies) {
    const scope = highRisk ? "high-risk" : "managed";
    throw new Error(
      `Reviewer policy requires ${minimum} eligible ${scope} reviewer(s) distinct from the implementation model and ${minimumFamilies} distinct reviewer family/families; only ${selected.length} reviewer(s) across ${families.size} family/families are eligible after excluding the implementation model.`
    );
  }
  return selected.map(({ model, family }) => ({
    model,
    family,
    distinctFromImplementation: model !== implementationModel
  }));
}

export function summarizeRuns(
  runs,
  { now = new Date(), staleHours = 24 } = {}
) {
  const staleAfterMs = staleHours * 60 * 60 * 1000;
  const completed = runs.filter((run) =>
    ["passed", "failed", "cancelled", "abandoned", "archived"].includes(
      run.state
    )
  );
  const passed = completed.filter((run) => run.state === "passed").length;
  const totals = runs.reduce(
    (result, run) => {
      result.tokens += Number(run.telemetry?.tokens ?? 0);
      result.cost += Number(run.telemetry?.cost ?? 0);
      result.toolCalls += Number(run.telemetry?.toolCalls ?? 0);
      result.toolErrors += Number(run.telemetry?.toolErrors ?? 0);
      return result;
    },
    { tokens: 0, cost: 0, toolCalls: 0, toolErrors: 0 }
  );
  return {
    runs: runs.length,
    completed: completed.length,
    passed,
    passRate: completed.length ? passed / completed.length : null,
    stale: runs.filter(
      (run) =>
        ACTIVE_RUN_STATES.includes(run.state) &&
        now.getTime() - new Date(run.updatedAt ?? run.createdAt).getTime() >
          staleAfterMs
    ).length,
    ...totals
  };
}

export function buildBranchName(agent, task, runId) {
  return `agent/${slugify(agent, "agent")}/${slugify(task)}/${runId.slice(-6)}`;
}

export function workspaceLabel(workspace) {
  return slugify(basename(workspace), "workspace");
}
