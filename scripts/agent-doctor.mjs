#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  collectLaunchSnapshot,
  snapshotLines
} from "./lab/launch-snapshot.mjs";
import { labHostPaths } from "./lab/host-state.mjs";
import { loadProjectContract } from "./lab/project-contract.mjs";
import {
  collectProjectPreflight,
  preflightLines
} from "./lab/project-preflight.mjs";

const root = resolve(import.meta.dirname, "..");
const stateRoot = labHostPaths().stateRoot;
const activeStates = new Set([
  "preparing",
  "implementing",
  "verifying",
  "reviewing"
]);
const STALE_RUN_MS = 30 * 60 * 1000;

function check(id, status, summary, details = undefined) {
  return { id, status, summary, ...(details ? { details } : {}) };
}

function commandAvailable(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error)
    return { ok: false, detail: result.error.code ?? "unavailable" };
  return {
    ok: result.status === 0,
    detail: (result.stdout || result.stderr || "").trim().split("\n")[0]
  };
}

function readRuns(directory = join(stateRoot, "runs")) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .map((id) => {
      try {
        return JSON.parse(
          readFileSync(join(directory, id, "run.json"), "utf8")
        );
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function modelReviewStatus(path = resolve(root, "quality/model-routing.json")) {
  try {
    const policy = JSON.parse(readFileSync(path, "utf8"));
    const candidates = policy.reviewPolicy?.reviewerCandidates ?? [];
    const deepSeek = candidates.find((candidate) =>
      String(candidate.model).toLowerCase().includes("deepseek")
    );
    return deepSeek?.status ?? "missing";
  } catch {
    return "unreadable";
  }
}

export function evaluateDoctorSnapshot({
  nodeVersion,
  envFilePresent,
  docker,
  qualityService,
  dirtyPathCount,
  runs,
  deepSeekReviewerStatus,
  launchSnapshot,
  now = Date.now()
}) {
  const checks = [];
  const nodeMajor = Number(
    String(nodeVersion).replace(/^v/u, "").split(".")[0]
  );
  checks.push(
    Number.isInteger(nodeMajor) && nodeMajor >= 24
      ? check("node", "pass", `Node ${nodeVersion} is supported.`)
      : check(
          "node",
          "fail",
          `Node ${nodeVersion || "missing"} is unsupported; Node 24+ is required.`
        )
  );
  checks.push(
    envFilePresent
      ? check("opencode-env", "pass", "OpenCode environment file is present.")
      : check(
          "opencode-env",
          "fail",
          "opencode.env is missing; OpenCode cannot start."
        )
  );
  checks.push(
    docker.ok
      ? check("docker", "pass", "Docker is available.")
      : check("docker", "fail", "Docker is unavailable.", docker.detail)
  );
  checks.push(
    qualityService === "healthy"
      ? check("quality-mcp", "pass", "Quality MCP is healthy.")
      : qualityService === "unreachable"
        ? check(
            "quality-mcp",
            "warn",
            "Quality MCP is not running; it starts with the launcher."
          )
        : check(
            "quality-mcp",
            "warn",
            "Quality MCP health could not be checked."
          )
  );
  const staleRuns = runs.filter((run) => {
    const updatedAt = Date.parse(run.updatedAt ?? run.createdAt ?? "");
    return (
      activeStates.has(run.state) &&
      Number.isFinite(updatedAt) &&
      now - updatedAt > STALE_RUN_MS
    );
  });
  checks.push(
    staleRuns.length === 0
      ? check("managed-runs", "pass", "No stale managed runs found.")
      : check(
          "managed-runs",
          "warn",
          `${staleRuns.length} managed run(s) appear stale; inspect or cancel them.`,
          staleRuns.map((run) => run.id).filter(Boolean)
        )
  );
  checks.push(
    dirtyPathCount === 0
      ? check("worktree", "pass", "Worktree is clean.")
      : check(
          "worktree",
          "warn",
          `${dirtyPathCount} changed path(s) are uncommitted; create a clean baseline before release.`
        )
  );
  checks.push(
    deepSeekReviewerStatus === "eligible"
      ? check(
          "independent-review",
          "pass",
          "DeepSeek is eligible for independent review."
        )
      : check(
          "independent-review",
          "warn",
          `DeepSeek reviewer is ${deepSeekReviewerStatus}; K2.7 runs may stop at review until it qualifies.`
        )
  );
  if (launchSnapshot) {
    checks.push(
      launchSnapshot.defaultProfile.ok
        ? check(
            "default-profile",
            "pass",
            "Default launch needs only the coding stack; Hound and OpenDesign remain optional."
          )
        : check(
            "default-profile",
            "fail",
            "Default launch unexpectedly depends on an optional research or design service."
          )
    );
    checks.push(
      launchSnapshot.runtimeConfig.writable
        ? check(
            "runtime-config",
            "pass",
            "Runtime config directory is writable."
          )
        : check(
            "runtime-config",
            "fail",
            "Runtime config directory is not writable; OpenCode cannot create its per-session config."
          )
    );
    checks.push(
      launchSnapshot.image.matchesDockerfile
        ? check(
            "opencode-image",
            "pass",
            "Local OpenCode image matches Dockerfile.opencode and the pinned OpenDesign runtime."
          )
        : check(
            "opencode-image",
            "warn",
            "Local OpenCode image is stale or unlabelled for Dockerfile.opencode; run lab --rebuild."
          )
    );
    checks.push(
      launchSnapshot.image.openDesignPinMatchesCompose
        ? check(
            "open-design-pin",
            "pass",
            "OpenDesign is pinned consistently in Dockerfile and Compose."
          )
        : check(
            "open-design-pin",
            "fail",
            "OpenDesign pin differs between Dockerfile.opencode and docker-compose.opencode.yml."
          )
    );
  }
  return {
    healthy: checks.every((entry) => entry.status !== "fail"),
    checks
  };
}

async function qualityHealth() {
  try {
    const response = await fetch("http://127.0.0.1:8793/health", {
      signal: AbortSignal.timeout(1_000)
    });
    return response.ok ? "healthy" : "unreachable";
  } catch {
    return "unreachable";
  }
}

function dirtyPathCount() {
  const result = spawnSync("git", ["status", "--porcelain=v1"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0) return 0;
  return result.stdout.split("\n").filter(Boolean).length;
}

async function main() {
  const workspaceIndex = process.argv.indexOf("--workspace");
  const workspace =
    workspaceIndex >= 0 && process.argv[workspaceIndex + 1]
      ? resolve(process.argv[workspaceIndex + 1])
      : root;
  const loadedContract = loadProjectContract(workspace, { enabledPacks: [] });
  const projectPreflight = collectProjectPreflight({
    workspace,
    contract: loadedContract.contract,
    contractSource: loadedContract.source,
    applyExcludes: false
  });
  const launchSnapshot = collectLaunchSnapshot({ root, workspace });
  const snapshot = {
    nodeVersion: process.version,
    envFilePresent: existsSync(resolve(root, "opencode.env")),
    docker: commandAvailable("docker", [
      "version",
      "--format",
      "{{.Server.Version}}"
    ]),
    qualityService: await qualityHealth(),
    dirtyPathCount: dirtyPathCount(),
    runs: readRuns(),
    deepSeekReviewerStatus: modelReviewStatus(),
    launchSnapshot
  };
  const report = evaluateDoctorSnapshot(snapshot);
  report.checks.push(
    projectPreflight.healthy
      ? check(
          "project-preflight",
          "pass",
          `Project preflight passed for ${workspace}.`
        )
      : check(
          "project-preflight",
          "fail",
          `Project preflight failed for ${workspace}.`,
          projectPreflight.checks
            .filter((entry) => entry.status === "fail")
            .map((entry) => entry.summary)
        )
  );
  report.healthy = report.checks.every((entry) => entry.status !== "fail");
  process.stdout.write(
    `${JSON.stringify({ ...report, launch: launchSnapshot, project: projectPreflight }, null, 2)}\n`
  );
  for (const line of snapshotLines(launchSnapshot)) {
    process.stdout.write(`${line}\n`);
  }
  for (const line of preflightLines(projectPreflight)) {
    process.stdout.write(`${line}\n`);
  }
  if (
    !report.healthy ||
    (process.argv.includes("--strict") &&
      report.checks.some((entry) => entry.status !== "pass"))
  ) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  await main();
}
