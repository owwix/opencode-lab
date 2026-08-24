import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  realpathSync
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { processIsAlive } from "../quality/run-control.mjs";
import {
  configuredPackRoots,
  loadPackSet,
  managedRunProfiles
} from "../lab/pack-loader.mjs";
import { lookupRegistration } from "../lab/workspace-registry.mjs";

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const controller = join(harnessRoot, "scripts", "quality-controller.mjs");
const runLogsRoot = join(harnessRoot, ".quality", "runs");
const hostRegistryPath = join(harnessRoot, ".quality", "host-registry.json");
const packSet = loadPackSet({
  roots: configuredPackRoots({ envFile: join(harnessRoot, "opencode.env") })
});
const profileDefinitions = managedRunProfiles(packSet, {
  ship: { agent: "lab", taskPrefix: "" },
  research: { agent: "research", taskPrefix: "" }
});
const profiles = Object.freeze(
  Object.fromEntries(
    Object.entries(profileDefinitions).map(([kind, profile]) => [
      kind,
      profile.agent
    ])
  )
);
const launchedWorkers = new Map();
const parallelBatches = new Map();
const PARALLEL_BATCH_TTL_MS = 5 * 60 * 1000;
const managedKinds = Object.keys(profiles);
const managedKindSchema = z.enum(managedKinds);
const limitsSchema = z
  .object({
    implementation_timeout_ms: z.number().positive().optional(),
    verification_timeout_ms: z.number().positive().optional(),
    review_timeout_ms: z.number().positive().optional(),
    max_output_bytes: z.number().positive().optional(),
    max_tokens: z.number().positive().optional(),
    max_cost: z.number().positive().optional(),
    max_tool_calls: z.number().positive().optional()
  })
  .optional();

function jsonTool(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function allowedRoots() {
  const configured = process.env.QUALITY_WORKSPACE_ROOTS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const defaults = [harnessRoot];
  return (configured?.length ? configured : defaults)
    .filter(existsSync)
    .map((path) => realpathSync(path));
}

export function resolveAllowedWorkspace(requested, { registrationToken } = {}) {
  let hostRequested = requested;
  if (requested === "/workspace") {
    const registration = lookupRegistration(
      process.env.OPENCODE_LAB_REGISTRY_PATH ?? hostRegistryPath,
      registrationToken
    );
    if (!registration) {
      throw new Error("Launch registration is invalid or no longer active.");
    }
    hostRequested = registration.canonicalPath;
  }
  const candidate = realpathSync(resolve(hostRequested));
  const allowed = allowedRoots().some(
    (root) => candidate === root || candidate.startsWith(`${root}${sep}`)
  );
  if (!allowed)
    throw new Error("Workspace is outside the quality-service allowlist.");
  if (!existsSync(join(candidate, ".git"))) {
    throw new Error("Managed runs require a Git workspace.");
  }
  return candidate;
}

export function parseJsonOutput(output) {
  const objectStart = output.indexOf("{");
  const arrayStart = output.indexOf("[");
  const starts = [objectStart, arrayStart].filter((value) => value >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  if (start < 0)
    throw new Error(`Controller returned no JSON: ${output.trim()}`);
  return JSON.parse(output.slice(start));
}

function controllerSync(args) {
  const result = spawnSync(process.execPath, [controller, ...args], {
    cwd: harnessRoot,
    env: process.env,
    encoding: "utf8",
    timeout: 2 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
    killSignal: "SIGKILL"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.stdout || "Controller failed").trim()
    );
  }
  return parseJsonOutput(result.stdout);
}

export function startManagedRun(
  { kind, task, workspace, release = false, idempotency_key, limits },
  { registrationToken } = {}
) {
  const agent = profiles[kind];
  if (!agent) throw new Error(`Unsupported managed-run kind: ${kind}`);
  const source = resolveAllowedWorkspace(workspace, { registrationToken });
  const args = [
    "prepare",
    "--workspace",
    source,
    "--agent",
    agent,
    "--task",
    task
  ];
  if (release) args.push("--release");
  if (idempotency_key) args.push("--idempotency-key", idempotency_key);
  const limitArgs = {
    implementation_timeout_ms: "--implementation-timeout-ms",
    verification_timeout_ms: "--verification-timeout-ms",
    review_timeout_ms: "--review-timeout-ms",
    max_output_bytes: "--max-output-bytes",
    max_tokens: "--max-tokens",
    max_cost: "--max-cost",
    max_tool_calls: "--max-tool-calls"
  };
  for (const [name, flag] of Object.entries(limitArgs)) {
    if (limits?.[name] !== undefined) args.push(flag, String(limits[name]));
  }
  const prepared = controllerSync(args);
  const terminal = [
    "passed",
    "failed",
    "cancelled",
    "abandoned",
    "archived"
  ].includes(prepared.state);
  const launched = launchedWorkers.get(prepared.id);
  const launchedIsAlive = processIsAlive(launched?.pid);
  if (launched && !launchedIsAlive) launchedWorkers.delete(prepared.id);
  if (
    prepared.idempotentReplay &&
    (terminal || processIsAlive(prepared.worker?.pid) || launchedIsAlive)
  ) {
    return {
      ...prepared,
      kind,
      agent,
      processId: prepared.worker?.pid ?? launched?.pid ?? null,
      leaseId: prepared.worker?.leaseId ?? launched?.leaseId ?? null,
      statusCommand: `npm run quality:status -- --run ${prepared.id}`
    };
  }
  const runDirectory = join(runLogsRoot, prepared.id);
  mkdirSync(runDirectory, { recursive: true });
  const output = openSync(join(runDirectory, "orchestrator.log"), "a");
  const leaseId = randomUUID();
  const child = spawn(
    process.execPath,
    [controller, "resume", "--run", prepared.id],
    {
      cwd: harnessRoot,
      env: {
        ...process.env,
        QUALITY_DETACHED_WORKER: "1",
        QUALITY_WORKER_LEASE_ID: leaseId,
        CI: "1",
        OPENCODE_NON_INTERACTIVE: "1"
      },
      detached: true,
      stdio: ["ignore", output, output]
    }
  );
  closeSync(output);
  child.unref();
  launchedWorkers.set(prepared.id, { pid: child.pid, leaseId });
  child.once("error", (error) => {
    launchedWorkers.delete(prepared.id);
    console.error(
      `Could not start managed run ${prepared.id}: ${error.message}`
    );
  });
  child.once("exit", () => {
    if (launchedWorkers.get(prepared.id)?.pid === child.pid) {
      launchedWorkers.delete(prepared.id);
    }
  });
  return {
    ...prepared,
    kind,
    agent,
    processId: child.pid,
    leaseId,
    statusCommand: `npm run quality:status -- --run ${prepared.id}`
  };
}

function parallelFingerprint({ workspace, runs }) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspace,
        runs: runs.map(({ kind, task, release = false, limits }) => ({
          kind,
          task,
          release,
          limits: limits ?? null
        }))
      })
    )
    .digest("hex");
}

export function validateParallelRequest({ workspace, runs }) {
  if (typeof workspace !== "string" || !workspace.trim()) {
    throw new Error("Parallel runs require one workspace.");
  }
  if (!Array.isArray(runs) || runs.length < 2 || runs.length > 4) {
    throw new Error("Parallel batches require between 2 and 4 runs.");
  }
  for (const [index, run] of runs.entries()) {
    if (!profiles[run?.kind]) {
      throw new Error(`Run ${index + 1} has an unsupported kind.`);
    }
    if (
      typeof run.task !== "string" ||
      run.task.trim().length < 4 ||
      run.task.length > 4000
    ) {
      throw new Error(`Run ${index + 1} requires a concrete task.`);
    }
  }
  return { workspace, runs };
}

export function startParallelRuns(
  input,
  {
    starter = (run) => startManagedRun(run, { registrationToken }),
    registrationToken,
    now = Date.now
  } = {}
) {
  const request = validateParallelRequest(input);
  const fingerprint = parallelFingerprint(request);
  const currentTime = now();
  for (const [key, batch] of parallelBatches) {
    if (currentTime - batch.createdAt >= PARALLEL_BATCH_TTL_MS) {
      parallelBatches.delete(key);
    }
  }
  const cached = parallelBatches.get(fingerprint);
  if (cached && currentTime - cached.createdAt < PARALLEL_BATCH_TTL_MS) {
    return { ...cached.result, idempotentReplay: true };
  }
  const batchId = randomUUID();
  const started = [];
  const failures = [];
  for (const [index, run] of request.runs.entries()) {
    try {
      started.push(
        starter({
          ...run,
          workspace: request.workspace,
          idempotency_key: `parallel:${batchId}:${index + 1}:${run.kind}`
        })
      );
    } catch (error) {
      failures.push({
        index,
        kind: run.kind,
        task: run.task,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const result = {
    batchId,
    state:
      failures.length === 0
        ? "started"
        : started.length > 0
          ? "partially-started"
          : "failed",
    workspace: request.workspace,
    runs: started,
    failures,
    statusCommands: started.map((run) => run.statusCommand)
  };
  parallelBatches.set(fingerprint, { createdAt: currentTime, result });
  return result;
}

function getServer(registrationToken) {
  const server = new McpServer({ name: "quality", version: "1.0.0" });
  server.registerTool(
    "list_managed_run_kinds",
    {
      description:
        "List generic and loaded-pack managed-run kinds available in this Lab launch."
    },
    async () =>
      jsonTool({
        kinds: managedKinds.map((kind) => ({ kind, agent: profiles[kind] })),
        packs: packSet.packs.map(({ id, label, version }) => ({
          id,
          label,
          version
        }))
      })
  );
  server.registerTool(
    "start_managed_run",
    {
      description:
        "Start an isolated host-managed OpenCode run with verification and independent review. Supported kinds come from core and loaded packs.",
      inputSchema: {
        kind: managedKindSchema,
        task: z.string().min(4).max(4000),
        workspace: z.string().min(1),
        release: z.boolean().optional(),
        idempotency_key: z.string().min(8).max(200).optional(),
        limits: limitsSchema
      }
    },
    async (input) => jsonTool(startManagedRun(input, { registrationToken }))
  );
  server.registerTool(
    "start_parallel_runs",
    {
      description:
        "Start 2-4 independent managed runs for one Git workspace. Each run receives its own worktree, limits, verification, and review. The batch is duplicate-suppressed for five minutes.",
      inputSchema: {
        workspace: z.string().min(1),
        runs: z
          .array(
            z.object({
              kind: managedKindSchema,
              task: z.string().min(4).max(4000),
              release: z.boolean().optional(),
              limits: limitsSchema
            })
          )
          .min(2)
          .max(4)
      }
    },
    async (input) => jsonTool(startParallelRuns(input, { registrationToken }))
  );
  server.registerTool(
    "cancel_run",
    {
      description:
        "Cancel a managed run and terminate its active process group. Safe to retry for an already-cancelled run.",
      inputSchema: {
        run_id: z.string().min(8),
        reason: z.string().min(1).max(500).optional()
      }
    },
    async ({ run_id, reason }) => {
      const args = ["cancel", "--run", run_id];
      if (reason) args.push("--reason", reason);
      return jsonTool(controllerSync(args));
    }
  );
  server.registerTool(
    "get_run_status",
    {
      description: "Read one managed quality run and its evidence state.",
      inputSchema: { run_id: z.string().min(8) }
    },
    async ({ run_id }) => jsonTool(controllerSync(["status", "--run", run_id]))
  );
  server.registerTool(
    "list_runs",
    {
      description: "List managed quality runs. Read-only.",
      inputSchema: {}
    },
    async () => jsonTool(controllerSync(["status"]))
  );
  return server;
}

function authorized(request, token) {
  return request.headers.get("authorization") === `Bearer ${token}`;
}

function requestRegistration(registrationToken) {
  if (!registrationToken) return null;
  try {
    return lookupRegistration(
      process.env.OPENCODE_LAB_REGISTRY_PATH ?? hostRegistryPath,
      registrationToken
    );
  } catch {
    return null;
  }
}

export async function handleQualityMcp(request, token) {
  const url = new URL(request.url);
  const registrationToken = request.headers.get("x-lab-registration-token");
  const registration = requestRegistration(registrationToken);
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({
      ok: true,
      service: "quality",
      projectId: registration?.projectId ?? null,
      workspaceHash: registration?.workspaceHash ?? null
    });
  }
  if (!token || !authorized(request, token)) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!registration) {
    return new Response("Launch registration is invalid.", { status: 401 });
  }
  if (url.pathname !== "/mcp" || request.method === "GET") {
    return new Response("Not found", { status: 404 });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  const server = getServer(registrationToken);
  await server.connect(transport);
  return transport.handleRequest(request);
}
