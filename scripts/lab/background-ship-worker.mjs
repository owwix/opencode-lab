#!/usr/bin/env node
/**
 * Background worker for lab:background — runs quality-controller (or legacy
 * OpenCode task) and optionally opens a PR with host gh when the run passed.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { labStateRoot } from "./host-state.mjs";
import {
  beginDurableAttempt,
  finishDurableAttempt,
  readDurableRun,
  updateDurableRun
} from "../quality/run-service.mjs";

const harnessRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function argValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    cwd: options.cwd ?? harnessRoot,
    env: process.env,
    maxBuffer: 20 * 1024 * 1024
  });
  return result;
}

const argv = process.argv.slice(2);
const runId = argValue(argv, "--run");
const mode = argValue(argv, "--mode") || "quality";
const workspace = argValue(argv, "--workspace");
const prompt = argValue(argv, "--prompt");
const agent = argValue(argv, "--agent") || "lab";
const openPr = hasFlag(argv, "--open-pr");

if (!runId || !workspace || !prompt) {
  console.error(
    "background-ship-worker requires --run, --workspace, and --prompt"
  );
  process.exit(1);
}

function updateMeta(patch) {
  updateDurableRun({
    root: stateRoot,
    runId,
    update(record) {
      if (patch.state) record.state = patch.state;
      if (patch.finishedAt) record.finishedAt = patch.finishedAt;
      record.payload = {
        ...record.payload,
        background: { ...(record.payload?.background ?? {}), ...patch }
      };
      return record;
    }
  });
}

const stateRoot = resolve(process.env.QUALITY_STATE_ROOT ?? labStateRoot());

if (mode === "task") {
  const leaseId = randomUUID();
  beginDurableAttempt({
    root: stateRoot,
    runId,
    leaseId,
    workerPid: process.pid,
    operation: "legacy-task",
    leaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
  });
  updateMeta({ state: "running", workerPid: process.pid });
  const result = run(process.execPath, [
    join(harnessRoot, "scripts/opencode.mjs"),
    "--workspace",
    resolve(workspace),
    "task",
    "--auto",
    prompt
  ]);
  const exitCode = result.status ?? 1;
  updateMeta({
    state: exitCode === 0 ? "completed" : "failed",
    exitCode,
    finishedAt: new Date().toISOString()
  });
  finishDurableAttempt({
    root: stateRoot,
    runId,
    leaseId,
    status: exitCode === 0 ? "completed" : "failed",
    error: exitCode === 0 ? null : "Legacy task process failed."
  });
  process.exit(result.status ?? 1);
}

const controllerArgs = [
  join(harnessRoot, "scripts/quality-controller.mjs"),
  "resume",
  "--run",
  runId
];

console.log(`[background-ship] resuming prepared run ${runId}…`);
const result = run(process.execPath, controllerArgs);
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");

let durable = readDurableRun({ root: stateRoot, runId });
let branch = durable?.git?.branch ?? null;
let managedWorkspace = durable?.git?.worktree ?? null;

updateMeta({
  runId,
  branch,
  managedWorkspace,
  exitCode: result.status ?? 1
});

if ((result.status ?? 1) !== 0) {
  console.error(`[background-ship] quality run failed (exit ${result.status})`);
  process.exit(result.status ?? 1);
}

const statusResult = run(process.execPath, [
  join(harnessRoot, "scripts/quality-controller.mjs"),
  "status",
  "--run",
  runId
]);
process.stdout.write(statusResult.stdout || "");

durable = readDurableRun({ root: stateRoot, runId });
const state = durable?.state ?? null;
branch = branch || durable?.git?.branch || null;
managedWorkspace = managedWorkspace || durable?.git?.worktree || null;
updateMeta({ state, branch, managedWorkspace });

if (!openPr) {
  console.log(
    `[background-ship] done. run=${runId} state=${state}. PR not requested.`
  );
  process.exit(0);
}

if (state !== "passed") {
  console.error(
    `[background-ship] refusing --open-pr: run state is ${state}, expected passed.`
  );
  process.exit(1);
}

if (!managedWorkspace || !existsSync(managedWorkspace)) {
  console.error("[background-ship] managed worktree missing; cannot open PR.");
  process.exit(1);
}

const title = `ship: ${prompt}`.slice(0, 72);
const body = [
  "## Summary",
  `- Managed Lab background ship for run \`${runId}\``,
  `- Agent: \`${agent}\``,
  "",
  "## Test plan",
  "- [ ] Review quality-controller verification + independent review",
  "- [ ] Confirm no unrelated WIP was absorbed"
].join("\n");

const pr = run(process.execPath, [
  join(harnessRoot, "scripts/quality-controller.mjs"),
  "prepare-pr",
  "--run",
  runId,
  "--title",
  title,
  "--body",
  body,
  "--base",
  "main"
]);
process.stdout.write(pr.stdout || "");
process.stderr.write(pr.stderr || "");
let receipt = null;
try {
  receipt = JSON.parse(String(pr.stdout || "").trim());
} catch {
  receipt = null;
}
const prUrl = receipt?.url ?? null;
updateMeta({
  prUrl,
  prHeadSha: receipt?.headSha ?? null,
  prBranch: receipt?.branch ?? branch,
  prBase: receipt?.base ?? "main",
  prExitCode: pr.status ?? 1,
  finishedAt: new Date().toISOString()
});
if ((pr.status ?? 1) !== 0) {
  console.error("[background-ship] reviewed PR preparation failed.");
  process.exit(pr.status ?? 1);
}
console.log(
  `[background-ship] ${receipt?.reused ? "reused" : "opened"} ${prUrl}`
);
process.exit(0);
