#!/usr/bin/env node
/**
 * Detached managed ship: quality-controller run in the background, optional
 * host `gh pr create` when the run reaches state `passed`.
 */
import { mkdirSync, openSync, closeSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { labStateRoot } from "./host-state.mjs";
import {
  createDurableRun,
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

function usage() {
  console.error(`Usage:
  node scripts/lab/background-ship.mjs --workspace <path> --prompt <text>
    [--agent NAME]
    [--allow-dirty-source]
    [--open-pr]
    [--mode quality|task]

Default --mode quality starts an isolated quality-controller run (detached).
--mode task keeps the legacy headless OpenCode task path.
--open-pr only applies after a quality run reaches state "passed".`);
}

const argv = process.argv.slice(2);
const workspace =
  argValue(argv, "--workspace") || process.env.OPENCODE_WORKSPACE;
const prompt = argValue(argv, "--prompt") || argValue(argv, "--task");
const agent = argValue(argv, "--agent") || "lab";
const mode = argValue(argv, "--mode") || "quality";
const openPr = hasFlag(argv, "--open-pr");
const allowDirty = hasFlag(argv, "--allow-dirty-source");
const parentRunId = argValue(argv, "--parent-run-id");

if (!workspace || !prompt) {
  usage();
  process.exit(1);
}

const stateRoot = resolve(process.env.QUALITY_STATE_ROOT ?? labStateRoot());
const worker = resolve(harnessRoot, "scripts/lab/background-ship-worker.mjs");
const controller = resolve(harnessRoot, "scripts/quality-controller.mjs");

function parseControllerJson(output) {
  const start = String(output).indexOf("{");
  if (start < 0) throw new Error("Controller returned no run record.");
  return JSON.parse(String(output).slice(start));
}

let runId;
let prepared = null;
if (mode === "quality") {
  const args = [
    controller,
    "prepare",
    "--workspace",
    resolve(workspace),
    "--agent",
    agent,
    "--task",
    prompt,
    "--run-kind",
    "background",
    "--idempotency-key",
    `background:${randomUUID()}`
  ];
  if (allowDirty) args.push("--allow-dirty-source");
  if (parentRunId) args.push("--parent-run-id", parentRunId);
  const result = spawnSync(process.execPath, args, {
    cwd: harnessRoot,
    env: process.env,
    encoding: "utf8",
    timeout: 2 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      String(result.stderr || result.stdout || "Could not prepare run").trim()
    );
  }
  prepared = parseControllerJson(result.stdout);
  runId = prepared.id;
} else {
  runId = `background_${randomUUID()}`;
  createDurableRun({
    root: stateRoot,
    id: runId,
    kind: "background",
    state: "queued",
    task: prompt,
    agent,
    source: resolve(workspace),
    controllerRunId: null,
    parentId: parentRunId,
    payload: { legacyTask: true }
  });
}

const runDirectory = join(stateRoot, "runs", runId);
mkdirSync(runDirectory, { recursive: true });
const logFile = join(runDirectory, "orchestrator.log");

const output = openSync(logFile, "a");
const child = spawn(
  process.execPath,
  [
    worker,
    "--run",
    runId,
    "--mode",
    mode === "task" ? "task" : "quality",
    ...(openPr ? ["--open-pr"] : []),
    ...(allowDirty ? ["--allow-dirty-source"] : []),
    "--agent",
    agent,
    "--workspace",
    resolve(workspace),
    "--prompt",
    prompt
  ],
  {
    cwd: harnessRoot,
    detached: true,
    stdio: ["ignore", output, output],
    env: process.env
  }
);
closeSync(output);
if (!child.pid) {
  updateDurableRun({
    root: stateRoot,
    runId,
    update(record) {
      record.state = "failed";
      record.phase = "terminal";
      record.payload = {
        ...record.payload,
        background: {
          pid: null,
          logFile,
          launchError: "Detached worker did not return a process id."
        }
      };
      return record;
    }
  });
  throw new Error("Could not start the detached background worker.");
}
child.unref();
updateDurableRun({
  root: stateRoot,
  runId,
  update(record) {
    record.payload = {
      ...record.payload,
      background: {
        pid: child.pid,
        logFile,
        openPr,
        allowDirty,
        launchedAt: new Date().toISOString()
      }
    };
    return record;
  }
});

const durable = readDurableRun({ root: stateRoot, runId });

console.log(
  JSON.stringify(
    {
      id: runId,
      runId,
      mode,
      agent,
      openPr,
      allowDirty,
      workspace: resolve(workspace),
      managedWorkspace: prepared?.workspace ?? durable.git?.worktree ?? null,
      branch: prepared?.branch ?? durable.git?.branch ?? null,
      state: durable.state,
      parentRunId,
      logFile,
      pid: child.pid,
      hint:
        mode === "quality"
          ? "Detached quality-controller ship. Watch the log; use npm run quality:status -- --run <id> when the run id appears. --open-pr opens a PR only after state=passed."
          : "Legacy headless OpenCode task with --auto."
    },
    null,
    2
  )
);
