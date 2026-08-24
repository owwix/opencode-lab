#!/usr/bin/env node
/**
 * Background worker for lab:background — runs quality-controller (or legacy
 * OpenCode task) and optionally opens a PR with host gh when the run passed.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

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
const metaPath = argValue(argv, "--meta");
const mode = argValue(argv, "--mode") || "quality";
const workspace = argValue(argv, "--workspace");
const prompt = argValue(argv, "--prompt");
const agent = argValue(argv, "--agent") || "lab";
const openPr = hasFlag(argv, "--open-pr");
const allowDirty = hasFlag(argv, "--allow-dirty-source");

if (!workspace || !prompt) {
  console.error("background-ship-worker requires --workspace and --prompt");
  process.exit(1);
}

function updateMeta(patch) {
  if (!metaPath || !existsSync(metaPath)) return;
  const current = JSON.parse(readFileSync(metaPath, "utf8"));
  writeFileSync(
    metaPath,
    `${JSON.stringify({ ...current, ...patch, updatedAt: new Date().toISOString() }, null, 2)}\n`
  );
}

if (mode === "task") {
  const result = run(process.execPath, [
    join(harnessRoot, "scripts/opencode.mjs"),
    "--workspace",
    resolve(workspace),
    "task",
    "--auto",
    prompt
  ]);
  updateMeta({
    exitCode: result.status ?? 1,
    finishedAt: new Date().toISOString()
  });
  process.exit(result.status ?? 1);
}

const controllerArgs = [
  join(harnessRoot, "scripts/quality-controller.mjs"),
  "run",
  "--workspace",
  resolve(workspace),
  "--agent",
  agent,
  "--task",
  prompt
];
if (allowDirty) controllerArgs.push("--allow-dirty-source");

console.log(`[background-ship] starting quality-controller run…`);
const result = run(process.execPath, controllerArgs);
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");

let runId = null;
let branch = null;
let managedWorkspace = null;
try {
  const match = String(result.stdout || "").match(
    /"id"\s*:\s*"(run_[^"]+|[^"]+)"/u
  );
  // Prefer the first JSON object that looks like a prepare/run print.
  const jsonBlocks = String(result.stdout || "")
    .split(/\n(?=\{)/u)
    .map((block) => {
      try {
        return JSON.parse(block.trim());
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const prepared = jsonBlocks.find((row) => row.id && row.workspace);
  if (prepared) {
    runId = prepared.id;
    branch = prepared.branch ?? null;
    managedWorkspace = prepared.workspace ?? null;
  } else if (match) {
    runId = match[1];
  }
} catch {
  // Keep going with exit code only.
}

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

if (!runId) {
  console.error(
    "[background-ship] could not parse run id from controller output"
  );
  process.exit(1);
}

const statusResult = run(process.execPath, [
  join(harnessRoot, "scripts/quality-controller.mjs"),
  "status",
  "--run",
  runId
]);
process.stdout.write(statusResult.stdout || "");

const runJsonPath = join(harnessRoot, ".quality", "runs", runId, "run.json");
let state = null;
if (existsSync(runJsonPath)) {
  try {
    const runRecord = JSON.parse(readFileSync(runJsonPath, "utf8"));
    state = runRecord.state ?? null;
    branch = branch || runRecord.branch || null;
    managedWorkspace = managedWorkspace || runRecord.workspace || null;
  } catch {
    state = null;
  }
}
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
