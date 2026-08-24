#!/usr/bin/env node
/**
 * Async Lab fleet: enqueue multiple detached quality ships, list status, wait.
 *
 *   node scripts/lab/fleet.mjs enqueue --workspace PATH --prompt A --prompt B
 *   node scripts/lab/fleet.mjs status [--fleet ID]
 *   node scripts/lab/fleet.mjs wait --fleet ID [--timeout-ms N]
 */
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  openSync,
  closeSync
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const harnessRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fleetRoot = join(harnessRoot, ".quality/fleet");

function argValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("-"))
    throw new Error(`${name} requires a value.`);
  return value;
}

function allValues(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) {
      const value = argv[i + 1];
      if (!value || value.startsWith("-"))
        throw new Error(`${name} requires a value.`);
      out.push(value);
      i += 1;
    }
  }
  return out;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function loadFleet(id) {
  const path = join(fleetRoot, `${id}.json`);
  if (!existsSync(path)) throw new Error(`Unknown fleet: ${id}`);
  return { path, data: JSON.parse(readFileSync(path, "utf8")) };
}

function saveFleet(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function refreshJob(job) {
  if (!job.metaFile || !existsSync(job.metaFile)) return job;
  try {
    const meta = JSON.parse(readFileSync(job.metaFile, "utf8"));
    const exitCode = meta.exitCode ?? job.exitCode;
    let state = meta.state ?? job.state;
    if (typeof exitCode === "number" && !meta.state) {
      state = exitCode === 0 ? "completed" : "failed";
    }
    return {
      ...job,
      runId: meta.runId ?? job.runId,
      state,
      prUrl: meta.prUrl ?? job.prUrl,
      exitCode,
      finishedAt: meta.finishedAt ?? job.finishedAt
    };
  } catch {
    return job;
  }
}

const terminalJobStates = new Set([
  "passed",
  "failed",
  "cancelled",
  "abandoned",
  "completed"
]);

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function jobHasTerminalResult(job) {
  return typeof job.exitCode === "number" || terminalJobStates.has(job.state);
}

function jobFinished(job, isAlive = processAlive) {
  if (!jobHasTerminalResult(job)) return false;
  return !job.pid || !isAlive(job.pid);
}

function launchBackgroundJob(job, record) {
  const shipArgs = [
    resolve(harnessRoot, "scripts/lab/background-ship.mjs"),
    "--workspace",
    record.workspace,
    "--agent",
    record.agent,
    "--prompt",
    job.prompt,
    ...(record.openPr ? ["--open-pr"] : []),
    ...(record.allowDirty ? ["--allow-dirty-source"] : [])
  ];
  const result = spawnSync(process.execPath, shipArgs, {
    cwd: harnessRoot,
    encoding: "utf8",
    env: process.env
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      result.stderr || result.stdout || `Failed to enqueue: ${job.prompt}`
    );
  }
  try {
    return JSON.parse(String(result.stdout || "").trim());
  } catch {
    throw new Error(
      `Could not parse background-ship output for: ${job.prompt}`
    );
  }
}

/**
 * Reconcile running workers and fill only the available concurrency slots.
 * The injectable process/launcher functions keep the scheduling policy testable.
 */
export function scheduleFleetJobs(
  record,
  { launchJob = launchBackgroundJob, isAlive = processAlive } = {}
) {
  const capacity = Math.max(1, Math.min(4, Number(record.concurrency) || 1));
  let active = 0;

  for (const job of record.jobs || []) {
    if (!job.pid && job.state !== "running") continue;
    if (job.pid && isAlive(job.pid)) {
      active += 1;
      continue;
    }
    job.pid = null;
    job.finishedAt = job.finishedAt ?? new Date().toISOString();
    if (!jobHasTerminalResult(job)) {
      job.state = "failed";
      job.exitCode = 1;
      job.error = "Background worker exited without terminal metadata.";
    } else if (!terminalJobStates.has(job.state)) {
      job.state = job.exitCode === 0 ? "completed" : "failed";
    }
  }

  for (const job of record.jobs || []) {
    if (active >= capacity) break;
    if (job.state !== "queued") continue;
    try {
      const meta = launchJob(job, record);
      Object.assign(job, {
        pid: meta.pid ?? null,
        metaFile: meta.metaFile ?? null,
        logFile: meta.logFile ?? null,
        backgroundId: meta.id ?? null,
        state: "running",
        startedAt: new Date().toISOString()
      });
      active += 1;
    } catch (error) {
      Object.assign(job, {
        state: "failed",
        exitCode: 1,
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return record;
}

function enqueue(argv) {
  const workspace =
    argValue(argv, "--workspace") || process.env.OPENCODE_WORKSPACE;
  const prompts = allValues(argv, "--prompt");
  const agent = argValue(argv, "--agent") || "lab";
  const openPr = hasFlag(argv, "--open-pr");
  const allowDirty = hasFlag(argv, "--allow-dirty-source");
  const requestedConcurrency = Number(argValue(argv, "--concurrency") || "2");
  if (!Number.isInteger(requestedConcurrency) || requestedConcurrency < 1) {
    throw new Error("--concurrency must be a positive integer.");
  }
  const concurrency = Math.min(4, requestedConcurrency);
  if (!workspace || prompts.length === 0) {
    throw new Error(
      "fleet enqueue requires --workspace and one or more --prompt values"
    );
  }
  if (prompts.length > 8) {
    throw new Error("fleet enqueue accepts at most 8 prompts.");
  }

  mkdirSync(fleetRoot, { recursive: true });
  const id = `fleet_${new Date()
    .toISOString()
    .replace(/[:.]/gu, "-")}_${randomUUID().slice(0, 8)}`;
  const jobs = prompts.map((prompt) => ({
    prompt,
    pid: null,
    metaFile: null,
    logFile: null,
    backgroundId: null,
    runId: null,
    state: "queued",
    fingerprint: createHash("sha256").update(prompt).digest("hex").slice(0, 12)
  }));

  const record = {
    id,
    createdAt: new Date().toISOString(),
    workspace: resolve(workspace),
    agent,
    openPr,
    allowDirty,
    concurrency,
    jobs
  };
  const path = join(fleetRoot, `${id}.json`);
  saveFleet(path, record);

  const coordinatorLogFile = join(fleetRoot, `${id}.coordinator.log`);
  const output = openSync(coordinatorLogFile, "a");
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "run", "--fleet", id],
    {
      cwd: harnessRoot,
      detached: true,
      stdio: ["ignore", output, output],
      env: process.env
    }
  );
  closeSync(output);
  if (!child.pid) throw new Error(`Could not start coordinator for ${id}.`);
  child.unref();
  record.coordinatorPid = child.pid;
  record.coordinatorLogFile = coordinatorLogFile;
  saveFleet(path, record);
  console.log(JSON.stringify(record, null, 2));
}

async function runCoordinator(argv) {
  const fleetId = argValue(argv, "--fleet");
  if (!fleetId) throw new Error("run requires --fleet");
  let path;

  try {
    const claimDeadline = Date.now() + 5000;
    while (Date.now() < claimDeadline) {
      const loaded = loadFleet(fleetId);
      path = loaded.path;
      if (loaded.data.coordinatorPid === process.pid) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }

    const claimed = loadFleet(fleetId);
    path = claimed.path;
    if (claimed.data.coordinatorPid !== process.pid) {
      throw new Error(
        `Coordinator ${process.pid} could not claim fleet ${fleetId}.`
      );
    }

    while (true) {
      const loaded = loadFleet(fleetId);
      const data = loaded.data;
      if (data.coordinatorPid !== process.pid) return;
      data.jobs = (data.jobs || []).map(refreshJob);
      scheduleFleetJobs(data);
      data.updatedAt = new Date().toISOString();
      const finished = data.jobs.every((job) => jobFinished(job));
      if (finished) {
        data.finishedAt = new Date().toISOString();
        data.coordinatorPid = null;
      }
      saveFleet(loaded.path, data);
      if (finished) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
    }
  } catch (error) {
    if (path && existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, "utf8"));
        if (data.coordinatorPid === process.pid) {
          data.coordinatorPid = null;
          data.coordinatorError =
            error instanceof Error ? error.message : String(error);
          data.updatedAt = new Date().toISOString();
          saveFleet(path, data);
        }
      } catch {
        // Preserve the original coordinator failure.
      }
    }
    throw error;
  }
}

function status(argv) {
  mkdirSync(fleetRoot, { recursive: true });
  const fleetId = argValue(argv, "--fleet");
  const files = fleetId
    ? [`${fleetId}.json`]
    : readdirSync(fleetRoot).filter((name) => name.endsWith(".json"));
  const rows = [];
  for (const name of files) {
    const path = join(fleetRoot, name);
    if (!existsSync(path)) continue;
    const data = JSON.parse(readFileSync(path, "utf8"));
    data.jobs = (data.jobs || []).map(refreshJob);
    rows.push({
      id: data.id,
      createdAt: data.createdAt,
      jobs: data.jobs.map((job) => ({
        prompt: String(job.prompt).slice(0, 80),
        state: job.state ?? "unknown",
        runId: job.runId ?? null,
        prUrl: job.prUrl ?? null,
        exitCode: job.exitCode ?? null
      }))
    });
  }
  console.log(JSON.stringify({ fleets: rows }, null, 2));
}

async function wait(argv) {
  const fleetId = argValue(argv, "--fleet");
  if (!fleetId) throw new Error("wait requires --fleet");
  const timeoutMs = Number(argValue(argv, "--timeout-ms") || "3600000");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = loadFleet(fleetId);
    data.jobs = (data.jobs || []).map(refreshJob);
    const pending = data.jobs.filter((job) => !jobFinished(job));
    if (pending.length === 0) {
      console.log(JSON.stringify(data, null, 2));
      const failed = data.jobs.some(
        (job) =>
          (typeof job.exitCode === "number" && job.exitCode !== 0) ||
          job.state === "failed"
      );
      process.exit(failed ? 1 : 0);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timed out waiting for fleet ${fleetId}`);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === "enqueue") enqueue(rest);
    else if (command === "run") await runCoordinator(rest);
    else if (command === "status") status(rest);
    else if (command === "wait") await wait(rest);
    else {
      console.error(`Usage: fleet.mjs enqueue|run|status|wait ...`);
      process.exit(1);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
