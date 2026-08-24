#!/usr/bin/env node
/**
 * Detached managed ship: quality-controller run in the background, optional
 * host `gh pr create` when the run reaches state `passed`.
 */
import { mkdirSync, openSync, closeSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
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

if (!workspace || !prompt) {
  usage();
  process.exit(1);
}

const logDir = resolve(harnessRoot, ".quality/background");
mkdirSync(logDir, { recursive: true });
const id = new Date().toISOString().replace(/[:.]/gu, "-");
const logFile = join(logDir, `${id}.log`);
const metaFile = join(logDir, `${id}.json`);
const worker = resolve(harnessRoot, "scripts/lab/background-ship-worker.mjs");

const meta = {
  id,
  mode,
  agent,
  openPr,
  allowDirty,
  workspace: resolve(workspace),
  prompt,
  createdAt: new Date().toISOString(),
  logFile,
  metaFile
};
writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);

const output = openSync(logFile, "a");
const child = spawn(
  process.execPath,
  [
    worker,
    "--meta",
    metaFile,
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
child.unref();
writeFileSync(join(logDir, `${id}.pid`), `${child.pid}\n`);

console.log(
  JSON.stringify(
    {
      ...meta,
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
