import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function inside(root, candidate) {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function qualifyReviewerReport(
  reportPath,
  { minimumRuns = 3, minimumAccuracy = 0.8 } = {}
) {
  const path = resolve(reportPath);
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    throw new Error(`Reviewer qualification report is missing: ${path}`);
  }
  const root = dirname(path);
  const report = JSON.parse(readFileSync(path, "utf8"));
  if (report.schemaVersion !== 1) {
    throw new Error("Reviewer qualification report schemaVersion must be 1.");
  }
  const model = String(report.candidate?.model ?? "");
  const family = String(report.candidate?.family ?? "");
  if (!model || !family)
    throw new Error("Reviewer candidate needs model and family.");
  const runs = Number(report.results?.runs);
  const accuracy = Number(report.results?.accuracy);
  const completion = Number(report.results?.taskCompletion);
  if (!Number.isInteger(runs) || runs < minimumRuns) {
    throw new Error(`Reviewer needs at least ${minimumRuns} evaluation runs.`);
  }
  if (
    !Number.isFinite(accuracy) ||
    accuracy < minimumAccuracy ||
    accuracy > 1
  ) {
    throw new Error(`Reviewer accuracy must be at least ${minimumAccuracy}.`);
  }
  if (
    !Number.isFinite(completion) ||
    completion < minimumAccuracy ||
    completion > 1
  ) {
    throw new Error(
      `Reviewer task completion must be at least ${minimumAccuracy}.`
    );
  }
  const evidence = report.evidenceFiles ?? [];
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new Error("Reviewer qualification needs evidence files.");
  }
  for (const item of evidence) {
    const candidate = resolve(root, item);
    if (
      !inside(root, candidate) ||
      !existsSync(candidate) ||
      !lstatSync(candidate).isFile()
    ) {
      throw new Error(
        `Reviewer evidence is missing or escapes its report: ${item}`
      );
    }
  }
  return {
    passed: true,
    model,
    family,
    runs,
    accuracy,
    taskCompletion: completion,
    reportPath: path,
    digest: digest(report)
  };
}

export function promoteReviewer({
  reportPath,
  policyPath,
  approved = false,
  actor,
  now = new Date()
}) {
  if (!approved)
    throw new Error("Reviewer promotion requires explicit --approve.");
  if (!String(actor ?? "").trim())
    throw new Error("Reviewer promotion requires --actor.");
  const policyFile = resolve(policyPath);
  const policy = JSON.parse(readFileSync(policyFile, "utf8"));
  const qualified = qualifyReviewerReport(reportPath, {
    minimumRuns: policy.promotionPolicy?.minimumRuns ?? 3,
    minimumAccuracy: policy.promotionPolicy?.minimumGoldenAccuracy ?? 0.8
  });
  const candidate = policy.reviewPolicy?.reviewerCandidates?.find(
    ({ model }) => model === qualified.model
  );
  if (!candidate)
    throw new Error(`Reviewer is not registered: ${qualified.model}`);
  if (candidate.family !== qualified.family) {
    throw new Error(
      "Qualification family does not match the registered reviewer family."
    );
  }
  candidate.status = "eligible";
  candidate.evidence = {
    kind: "qualification-report",
    report: relative(dirname(policyFile), qualified.reportPath),
    digest: qualified.digest,
    runs: qualified.runs,
    accuracy: qualified.accuracy,
    taskCompletion: qualified.taskCompletion,
    approvedBy: String(actor).trim(),
    approvedAt: now.toISOString()
  };
  const temporary = `${policyFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(policy, null, 2)}\n`, {
    mode: 0o600
  });
  renameSync(temporary, policyFile);
  return candidate;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== "promote") {
      throw new Error(
        "Usage: reviewer-qualification.mjs promote --report FILE --policy FILE --approve --actor NAME"
      );
    }
    const result = promoteReviewer({
      reportPath: option("--report"),
      policyPath: option("--policy") ?? "quality/model-routing.json",
      approved: process.argv.includes("--approve"),
      actor: option("--actor")
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
