import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { basename, delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseTaskInvocation, routeTask } from "./opencode-routing.mjs";
import {
  applyAutoApproveArgs,
  readLabPreferences
} from "./opencode-preferences.mjs";
import {
  agentArgument,
  parseLauncherFlags,
  selectTooling,
  withToolingConfig
} from "./opencode-tooling.mjs";
import { decidePreviewLaunch } from "./lab/preview-launch-policy.mjs";
import { readImageBuildDefinition } from "./lab/launch-snapshot.mjs";
import { createCapabilityLease } from "../docker/agent-gateway/capability-lease.mjs";
import {
  configuredPackRoots,
  loadPackSet,
  materializePackConfig,
  packAgentConfig,
  packUiSummary
} from "./lab/pack-loader.mjs";
import {
  projectIdentity,
  recordProjectHelper,
  registerBackgroundLaunch,
  registerForegroundLaunch,
  unregisterBackgroundLaunch,
  unregisterForegroundLaunch
} from "./lab/workspace-registry.mjs";

const envFile = resolve("opencode.env");
const rawArgs = process.argv.slice(2);
const labVersion = JSON.parse(
  readFileSync(resolve("package.json"), "utf8")
).version;
let packSet;
try {
  packSet = loadPackSet({
    roots: configuredPackRoots({ envFile }),
    labVersion
  });
} catch (error) {
  console.error(`OpenCode Lab pack configuration is invalid: ${error.message}`);
  process.exit(1);
}

function workspaceArgument(argv) {
  const index = argv.indexOf("--workspace");
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error("--workspace requires a folder path.");
  }
  return value;
}

function withoutWorkspaceArgument(argv) {
  const index = argv.indexOf("--workspace");
  if (index === -1) return argv;
  return [...argv.slice(0, index), ...argv.slice(index + 2)];
}

function chooseWorkspaceOnMac() {
  try {
    const selected = execFileSync(
      "osascript",
      [
        "-e",
        'POSIX path of (choose folder with prompt "Choose a project folder to open in OpenCode")'
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    return selected || null;
  } catch (error) {
    // AppleScript reports a user cancel with status 1. Treat that as a normal
    // no-op instead of falling through to a surprising default workspace.
    if (error && typeof error === "object" && error.status === 1) return null;
    throw error;
  }
}

function selectWorkspace(argv) {
  const explicit = workspaceArgument(argv) || process.env.OPENCODE_WORKSPACE;
  if (explicit) return resolve(explicit);
  if (process.platform === "darwin" && process.stdin.isTTY) {
    return chooseWorkspaceOnMac();
  }
  // Non-interactive callers such as CI retain the original behavior. An
  // interactive macOS launch always presents the Finder folder picker.
  return resolve(".");
}

const launcherOptions = parseLauncherFlags(withoutWorkspaceArgument(rawArgs));
const args = launcherOptions.args;
const isTask = args[0] === "task";
let taskRoute;
if (isTask) {
  try {
    taskRoute = routeTask(parseTaskInvocation(args, { packSet }), undefined, {
      packSet
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
const isRemoteTui = args[0] === "remote-tui";
const isNotionStart = args[0] === "notion:start";
const isMcpAuth = args[0] === "mcp" && args[1] === "auth";
const isForegroundLaunch = !isTask && !isNotionStart && !isMcpAuth;
const tooling = selectTooling({
  requested: launcherOptions.requested,
  agent: taskRoute?.agent ?? agentArgument(args),
  packSet
});
const authContainerName = `opencode-lab-opencode-auth-${process.pid}`;
const workspacePath = selectWorkspace(rawArgs);
if (!workspacePath) {
  console.log("No workspace selected. OpenCode was not started.");
  process.exit(0);
}
if (!existsSync(workspacePath) || !lstatSync(workspacePath).isDirectory()) {
  console.error(
    `Workspace folder does not exist or is not a directory: ${workspacePath}`
  );
  process.exit(1);
}
const {
  canonicalPath: canonicalWorkspacePath,
  workspaceHash,
  projectId
} = projectIdentity(workspacePath);
const launchId = `launch_${randomUUID().replaceAll("-", "")}`;
const launchSessionId = `session_${randomUUID().replaceAll("-", "")}`;
const launchRunId = `run_${randomUUID().replaceAll("-", "")}`;
const launchRegistrationToken = randomBytes(32).toString("hex");
const qualityDirectory = resolve(".quality");
const hostRegistryFile = resolve(qualityDirectory, "host-registry.json");
const projectStateDirectory = resolve(qualityDirectory, "projects", projectId);
let generatedPackConfigRoot = null;
const qualityPidFile = resolve(qualityDirectory, "quality-mcp.pid");
const qualityLogFile = resolve(qualityDirectory, "quality-mcp.log");
const galleryPidFile = resolve(qualityDirectory, "gallery.pid");
const galleryLogFile = resolve(qualityDirectory, "gallery.log");
const GALLERY_PORT = 3110;
const browserRelayPidFile = resolve(qualityDirectory, "browser-verify.pid");
const browserRelayLogFile = resolve(qualityDirectory, "browser-verify.log");
const BROWSER_RELAY_PORT = 3111;
const browserSessionPidFile = resolve(qualityDirectory, "browser-session.pid");
const browserSessionLogFile = resolve(qualityDirectory, "browser-session.log");
const BROWSER_SESSION_PORT = 3112;
const githubRelayPidFile = resolve(
  qualityDirectory,
  "github-publish-relay.pid"
);
const githubRelayLogFile = resolve(
  qualityDirectory,
  "github-publish-relay.log"
);
const openPetsRelayPidFile = resolve(qualityDirectory, "openpets-relay.pid");
const openPetsRelayLogFile = resolve(qualityDirectory, "openpets-relay.log");
const runtimeConfigFile = resolve(
  projectStateDirectory,
  `opencode-runtime-${process.pid}-${randomBytes(6).toString("hex")}.json`
);
const maskedWorkspaceFiles = [
  ".dev.vars",
  ".env",
  "docker.env",
  "opencode.env",
  ".npmrc",
  ".netrc"
];
const baseLocalImages = new Map([
  ["agent-gateway", "opencode-lab-agent-gateway:local"],
  ["opencode", "opencode-lab-opencode:local"]
]);
const researchLocalImages = new Map([
  ["hound-firewall", "opencode-lab-hound-firewall:local"],
  ["hound", "opencode-lab-hound:13.1.2"],
  ["hound-relay", "opencode-lab-hound-relay:local"]
]);
const runtimeConfigMaxAgeMs = 24 * 60 * 60 * 1000;

function removeStaleRuntimeConfigs(now = Date.now()) {
  if (!existsSync(projectStateDirectory)) return;
  for (const entry of readdirSync(projectStateDirectory)) {
    if (!/^opencode-runtime-\d+-[0-9a-f]{12}\.json$/u.test(entry)) continue;
    const path = resolve(projectStateDirectory, entry);
    try {
      const stats = lstatSync(path);
      if (stats.isFile() && now - stats.mtimeMs > runtimeConfigMaxAgeMs) {
        unlinkSync(path);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn(`Could not remove stale runtime config: ${entry}`);
      }
    }
  }
}

function writeRuntimeConfig() {
  mkdirSync(projectStateDirectory, { recursive: true });
  removeStaleRuntimeConfigs();
  const config = withToolingConfig(
    JSON.parse(readFileSync(resolve("opencode.json"), "utf8")),
    tooling
  );
  const descriptor = openSync(runtimeConfigFile, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(config, null, 2)}\n`);
  } finally {
    closeSync(descriptor);
  }
  return runtimeConfigFile;
}

function removeRuntimeConfig() {
  if (existsSync(runtimeConfigFile)) unlinkSync(runtimeConfigFile);
}

function preparePackConfig() {
  if (packSet.packs.length === 0) return resolve(".opencode");
  mkdirSync(projectStateDirectory, { recursive: true });
  const parent = mkdtempSync(
    join(projectStateDirectory, "launch-pack-config-")
  );
  generatedPackConfigRoot = parent;
  return materializePackConfig({
    coreConfigRoot: resolve(".opencode"),
    destination: join(parent, ".opencode"),
    packSet
  });
}

function removePackConfig() {
  if (!generatedPackConfigRoot) return;
  const expectedParent = `${projectStateDirectory}/`;
  if (!generatedPackConfigRoot.startsWith(expectedParent)) {
    throw new Error(
      "Refusing to remove pack config outside project runtime state."
    );
  }
  rmSync(generatedPackConfigRoot, { recursive: true, force: true });
  generatedPackConfigRoot = null;
}

function ensureWorkspaceMaskTargets() {
  // Docker Desktop requires the nested bind target to exist on the host when
  // /workspace is itself a bind mount. Create only missing, ignored empty
  // placeholders; never overwrite or follow a user's credential file.
  for (const basename of maskedWorkspaceFiles) {
    const target = join(workspacePath, basename);
    if (existsSync(target)) {
      if (lstatSync(target).isSymbolicLink()) {
        throw new Error(
          `Refusing to mask symbolic-link credential path: ${target}`
        );
      }
      continue;
    }
    const descriptor = openSync(target, "wx", 0o600);
    closeSync(descriptor);
  }
}

function safeHostEnvironment(extra = {}) {
  const allowed = [
    "DOCKER_CONFIG",
    "DOCKER_CONTEXT",
    "DOCKER_HOST",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOGNAME",
    "PATH",
    "SHELL",
    "TMP",
    "TMPDIR",
    "TEMP",
    "USER",
    "XDG_RUNTIME_DIR"
  ];
  return {
    ...Object.fromEntries(
      allowed
        .filter((name) => process.env[name] !== undefined)
        .map((name) => [name, process.env[name]])
    ),
    ...extra
  };
}

function ensureEnvSecret(name) {
  const contents = readFileSync(envFile, "utf8");
  const tokenPattern = new RegExp(`^${name}=(.*)$`, "m");
  const match = contents.match(tokenPattern);
  if (match?.[1]?.trim()) {
    chmodSync(envFile, 0o600);
    return match[1].trim();
  }

  const token = randomBytes(32).toString("hex");
  const tokenLine = `${name}=${token}`;
  const updated = match
    ? contents.replace(tokenPattern, tokenLine)
    : `${contents.replace(/\s*$/, "")}\n${tokenLine}\n`;
  writeFileSync(envFile, updated, { mode: 0o600 });
  chmodSync(envFile, 0o600);
  return token;
}

function envValue(name) {
  const contents = readFileSync(envFile, "utf8");
  const match = contents.match(new RegExp(`^${name}=(.*)$`, "m"));
  let value = match?.[1]?.trim() ?? "";
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

function requiredEnvValue(name) {
  const value = envValue(name);
  if (!value) throw new Error(`${name} is required in opencode.env.`);
  return value;
}

function selectedLaunchProfile() {
  if (tooling.research && tooling.design) return "research+design";
  if (tooling.research) return "research";
  if (tooling.design) return "design";
  return "fast";
}

async function foregroundConflictAction(existing) {
  console.error(
    `OpenCode Lab already has a foreground workspace:\n  ${existing.canonicalPath}\n  PID ${existing.pid} · ${existing.profile}`
  );
  const configured = process.env.LAB_FOREGROUND_ACTION?.trim().toLowerCase();
  if (["stop", "resume"].includes(configured)) return configured;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return "resume";
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    const answer = (
      await prompt.question(
        "[r]esume the existing workspace or [s]top it and open this one? [r] "
      )
    )
      .trim()
      .toLowerCase();
    return answer === "s" || answer === "stop" ? "stop" : "resume";
  } finally {
    prompt.close();
  }
}

function stopRegisteredForeground(pid) {
  let command = "";
  try {
    command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    throw new Error(`Registered foreground PID ${pid} is no longer running.`);
  }
  const expected = resolve("scripts/opencode.mjs");
  if (!command.includes(expected)) {
    throw new Error(
      `Refusing to stop PID ${pid}: it is not the registered ${expected} launcher.`
    );
  }
  process.kill(pid, "SIGTERM");
}

async function claimForegroundWorkspace() {
  const registration = {
    registryPath: hostRegistryFile,
    identity: {
      canonicalPath: canonicalWorkspacePath,
      workspaceHash,
      projectId
    },
    launchId,
    sessionId: launchSessionId,
    runId: launchRunId,
    profile: selectedLaunchProfile(),
    registrationToken: launchRegistrationToken
  };
  const first = registerForegroundLaunch(registration);
  if (first.registered) return true;
  const action = await foregroundConflictAction(first.existing);
  if (action === "resume") {
    console.log(
      `Existing workspace remains active: ${first.existing.canonicalPath}`
    );
    return false;
  }
  const replacement = registerForegroundLaunch(
    {
      ...registration,
      conflictAction: "stop"
    },
    { stop: stopRegisteredForeground }
  );
  if (!replacement.registered) {
    throw new Error("Could not replace the existing foreground workspace.");
  }
  return true;
}

function releaseForegroundWorkspace() {
  try {
    unregisterForegroundLaunch({
      registryPath: hostRegistryFile,
      launchId,
      registrationToken: launchRegistrationToken
    });
  } catch (error) {
    console.warn(
      `Could not release foreground registration: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function registerBackgroundWorkspace() {
  registerBackgroundLaunch({
    registryPath: hostRegistryFile,
    identity: {
      canonicalPath: canonicalWorkspacePath,
      workspaceHash,
      projectId
    },
    launchId,
    sessionId: launchSessionId,
    runId: launchRunId,
    profile: selectedLaunchProfile(),
    registrationToken: launchRegistrationToken
  });
  process.once("exit", () => {
    try {
      unregisterBackgroundLaunch({
        registryPath: hostRegistryFile,
        projectId,
        sessionId: launchSessionId,
        registrationToken: launchRegistrationToken
      });
    } catch (error) {
      console.warn(
        `Could not release background registration: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  });
}

function launchCapabilityScope() {
  const routes = ["chat", "quality"];
  const actions = ["chat:invoke", "quality:mcp"];
  if (isForegroundLaunch) {
    routes.push(
      "browser-session",
      "browser-verify",
      "github-publish",
      "openpets"
    );
    actions.push(
      "browser-session:control",
      "browser-verify:verify",
      "github-publish:status",
      "openpets:react"
    );
  }
  if (envValue("OPENAI_API_KEY")) {
    routes.push("openai-chat");
    actions.push("openai-chat:invoke");
  }
  if (envValue("GOOGLE_CLOUD_PROJECT")) {
    routes.push("vertex-chat");
    actions.push("vertex-chat:invoke");
  }
  if (tooling.design) {
    routes.push("open-design");
    actions.push("open-design:mcp");
  }
  const contributed = packAgentConfig(
    packSet,
    taskRoute?.agent ?? agentArgument(args)
  );
  if (contributed?.capabilities.includes("image")) {
    routes.push("image");
    actions.push("image:generate");
  }
  if (isNotionStart) {
    routes.push("notion-publish");
    actions.push("notion-publish:publish");
  }
  if (envValue("ARTIFACT_DOWNLOAD_ALLOWLIST")) {
    routes.push("artifact");
    actions.push("artifact:download");
  }
  return { routes, actions };
}

function dockerComposeArguments(composeArgs) {
  const composeProjectName = isTask
    ? `opencode-lab-${launchRunId.slice(-12)}`
    : "opencode-lab";
  return [
    "compose",
    "-p",
    composeProjectName,
    "--env-file",
    envFile,
    "-f",
    "docker-compose.opencode.yml",
    ...composeArgs
  ];
}

function runDockerCompose(composeArgs, environment) {
  execFileSync("docker", dockerComposeArguments(composeArgs), {
    stdio: "inherit",
    env: environment
  });
}

function runDockerComposeAsync(composeArgs, environment) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("docker", dockerComposeArguments(composeArgs), {
      stdio: "inherit",
      env: environment
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(
        new Error(
          `Docker Compose ${composeArgs[0] ?? "command"} failed${
            signal ? ` with signal ${signal}` : ` with status ${code ?? 1}`
          }.`
        )
      );
    });
  });
}

function dockerComposeServiceRunning(service, environment) {
  try {
    const runningServices = execFileSync(
      "docker",
      dockerComposeArguments([
        "ps",
        "--status",
        "running",
        "--services",
        service
      ]),
      { encoding: "utf8", env: environment }
    );
    return runningServices
      .split(/\r?\n/u)
      .some((candidate) => candidate.trim() === service);
  } catch {
    return false;
  }
}

function dockerComposeServiceContainer(service, environment) {
  try {
    return execFileSync(
      "docker",
      dockerComposeArguments(["ps", "-q", service]),
      { encoding: "utf8", env: environment }
    ).trim();
  } catch {
    return "";
  }
}

function dockerComposeServiceIdentityMatches(service, environment) {
  const container = dockerComposeServiceContainer(service, environment);
  if (!container) return false;
  try {
    const configured = JSON.parse(
      execFileSync(
        "docker",
        ["inspect", "--format", "{{json .Config.Env}}", container],
        { encoding: "utf8", env: environment }
      )
    );
    return (
      configured.includes(`OPENCODE_PROJECT_ID=${projectId}`) &&
      configured.includes(`OPENCODE_WORKSPACE_HASH=${workspaceHash}`)
    );
  } catch {
    return false;
  }
}

function dockerComposeServicePid(service, environment) {
  const container = dockerComposeServiceContainer(service, environment);
  if (!container) return null;
  try {
    const pid = Number(
      execFileSync(
        "docker",
        ["inspect", "--format", "{{.State.Pid}}", container],
        { encoding: "utf8", env: environment }
      ).trim()
    );
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

function dockerImageAvailable(image, environment) {
  try {
    execFileSync("docker", ["image", "inspect", image], {
      stdio: "ignore",
      env: environment
    });
    return true;
  } catch {
    return false;
  }
}

async function ensureRequestedLocalImages(environment) {
  const requestedImages = new Map([
    ...baseLocalImages,
    ...(tooling.research ? researchLocalImages : [])
  ]);
  const servicesToBuild = launcherOptions.rebuild
    ? [...requestedImages.keys()]
    : [...requestedImages].flatMap(([service, image]) =>
        dockerImageAvailable(image, environment) ? [] : [service]
      );
  if (!servicesToBuild.length) return;
  console.log(
    launcherOptions.rebuild
      ? `Rebuilding requested Lab images: ${servicesToBuild.join(", ")}`
      : `Building missing Lab images once: ${servicesToBuild.join(", ")}`
  );
  await runDockerComposeAsync(
    [
      ...(tooling.research ? ["--profile", "research"] : []),
      "build",
      ...servicesToBuild
    ],
    environment
  );
}

async function refreshAgentGateway(environment) {
  // Session and workspace claims are part of the rendered Compose config, so
  // Compose recreates the gateway whenever a new launch lease is issued.
  await runDockerComposeAsync(
    [
      "up",
      "-d",
      "--no-build",
      "--wait",
      "--wait-timeout",
      "30",
      "agent-gateway"
    ],
    environment
  );
}

async function startRequestedToolServices(environment) {
  const starts = [];
  if (tooling.research) {
    starts.push(
      runDockerComposeAsync(
        [
          "--profile",
          "research",
          "up",
          "-d",
          "--no-build",
          "--wait",
          "--wait-timeout",
          "90",
          "hound-relay"
        ],
        environment
      )
    );
  }
  if (tooling.design) {
    starts.push(
      runDockerComposeAsync(
        [
          "--profile",
          "design",
          "up",
          "-d",
          "--no-build",
          "--wait",
          "--wait-timeout",
          "60",
          "open-design"
        ],
        environment
      )
    );
  }
  await Promise.all(starts);
}

function hostPortListeners(port) {
  try {
    const output = execFileSync(
      "lsof",
      ["-nP", "-Fpc", `-iTCP:${port}`, "-sTCP:LISTEN"],
      { encoding: "utf8" }
    );
    const listeners = [];
    let pid = null;
    let command = null;
    for (const line of output.split(/\r?\n/u)) {
      if (line.startsWith("p")) pid = line.slice(1);
      if (line.startsWith("c")) {
        command = line.slice(1);
        if (pid && command) listeners.push({ command, pid });
      }
    }
    return listeners;
  } catch {
    return [];
  }
}

function hostPortListening(port) {
  return hostPortListeners(port).length > 0;
}

function printHostPortListeners(ports = [3100, 3101]) {
  for (const port of ports) {
    const listeners = hostPortListeners(port);
    if (!listeners.length) {
      console.log(`Host listener ${port}: none found by lsof.`);
      continue;
    }
    for (const listener of listeners) {
      console.log(
        `Host listener ${port}: COMMAND=${listener.command} PID=${listener.pid}`
      );
    }
  }
}

/**
 * Start the Lab preview relay only when 3100/3101 are free.
 * A mounted workspace stack may already publish those ports on the Mac.
 */
async function ensureOpencodePreview(environment) {
  const previewRunning = dockerComposeServiceRunning(
    "opencode-preview",
    environment
  );
  const previewMatches =
    previewRunning &&
    dockerComposeServiceIdentityMatches("opencode-preview", environment);
  if (previewRunning && !previewMatches) {
    runDockerCompose(["rm", "-s", "-f", "opencode-preview"], environment);
  }
  const action = decidePreviewLaunch({
    isOwnPreviewRunning: () => previewMatches,
    isHostPortListening: hostPortListening
  });
  if (action === "reuse") {
    recordProjectHelper({
      registryPath: hostRegistryFile,
      projectId,
      launchId,
      helper: "preview",
      pid: dockerComposeServicePid("opencode-preview", environment),
      port: 3100,
      workspaceHash
    });
    console.log("Reusing the running opencode-preview relay.");
    return;
  }
  if (action === "skip-external") {
    console.log(
      "Host 3100/3101 already in use (workspace compose). Skipping opencode-preview relay."
    );
    printHostPortListeners();
    console.log("  http://127.0.0.1:3100  <- app primary");
    console.log("  http://127.0.0.1:3101  <- app secondary");
    // Drop any leftover Created/Exited relay that failed an earlier bind.
    try {
      runDockerCompose(["rm", "-s", "-f", "opencode-preview"], environment);
    } catch {
      // No leftover container.
    }
    return;
  }
  if (
    launcherOptions.rebuild ||
    !dockerImageAvailable("opencode-lab-opencode-preview:local", environment)
  ) {
    await runDockerComposeAsync(["build", "opencode-preview"], environment);
  }
  await runDockerComposeAsync(["up", "-d", "opencode-preview"], environment);
  recordProjectHelper({
    registryPath: hostRegistryFile,
    projectId,
    launchId,
    helper: "preview",
    pid: dockerComposeServicePid("opencode-preview", environment),
    port: 3100,
    workspaceHash
  });
}

async function initializeOpenCodeVolumes(environment) {
  // The launcher starts OpenCode with --no-deps after this explicit check, so
  // state init runs exactly once. The script performs its recursive ownership
  // migration only when its version/UID/GID marker changes.
  await runDockerComposeAsync(
    ["run", "--rm", "--no-deps", "opencode-state-init"],
    environment
  );
}

function stopOwnedHelper(pidFile, helperScript) {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new Error(`Invalid helper PID file: ${pidFile}`);
  }
  let command = "";
  try {
    command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    unlinkSync(pidFile);
    return;
  }
  const expected = resolve(helperScript);
  if (!command.includes(expected)) {
    throw new Error(
      `Refusing to stop PID ${pid}: it is not the registered ${expected} helper.`
    );
  }
  process.kill(pid, "SIGTERM");
  unlinkSync(pidFile);
}

function helperMatches(payload, service) {
  return (
    payload?.ok === true &&
    payload?.service === service &&
    payload?.projectId === projectId &&
    payload?.workspaceHash === workspaceHash
  );
}

function registerHelper(name, pidFile, port) {
  const pid = existsSync(pidFile)
    ? Number(readFileSync(pidFile, "utf8").trim())
    : null;
  recordProjectHelper({
    registryPath: hostRegistryFile,
    projectId,
    launchId,
    helper: name,
    pid: Number.isInteger(pid) ? pid : null,
    port,
    workspaceHash
  });
}

async function galleryServerHealthy() {
  try {
    const response = await fetch(`http://127.0.0.1:${GALLERY_PORT}/health`, {
      signal: AbortSignal.timeout(1000)
    });
    const payload = await response.json().catch(() => null);
    return response.ok && helperMatches(payload, "lab-gallery");
  } catch {
    return false;
  }
}

async function ensureGalleryServer(workspace) {
  mkdirSync(qualityDirectory, { recursive: true });
  if (await galleryServerHealthy()) {
    registerHelper("gallery", galleryPidFile, GALLERY_PORT);
    return;
  }
  stopOwnedHelper(galleryPidFile, "scripts/artifacts/gallery-server.mjs");
  const output = openSync(galleryLogFile, "a");
  const child = spawn(
    process.execPath,
    [resolve("scripts/artifacts/gallery-server.mjs")],
    {
      cwd: resolve("."),
      env: safeHostEnvironment({
        OPENCODE_WORKSPACE: workspace,
        OPENCODE_GALLERY_PORT: String(GALLERY_PORT),
        OPENCODE_GALLERY_HOST: "127.0.0.1",
        OPENCODE_PROJECT_ID: projectId,
        OPENCODE_WORKSPACE_HASH: workspaceHash
      }),
      detached: true,
      stdio: ["ignore", output, output]
    }
  );
  closeSync(output);
  child.unref();
  writeFileSync(galleryPidFile, `${child.pid}\n`);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await galleryServerHealthy()) {
      registerHelper("gallery", galleryPidFile, GALLERY_PORT);
      console.log(`Lab gallery: http://127.0.0.1:${GALLERY_PORT}`);
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  console.warn(`Lab gallery did not start. See ${galleryLogFile}.`);
}

async function browserRelayHealthy() {
  try {
    const response = await fetch(
      `http://127.0.0.1:${BROWSER_RELAY_PORT}/health`,
      { signal: AbortSignal.timeout(1000) }
    );
    const payload = await response.json().catch(() => null);
    return response.ok && helperMatches(payload, "lab-browser-verify");
  } catch {
    return false;
  }
}

async function ensureBrowserVerifyRelay(workspace, token) {
  mkdirSync(qualityDirectory, { recursive: true });
  if (await browserRelayHealthy()) {
    registerHelper("browser-verify", browserRelayPidFile, BROWSER_RELAY_PORT);
    return;
  }
  stopOwnedHelper(browserRelayPidFile, "scripts/lab/browser-verify-relay.mjs");
  const output = openSync(browserRelayLogFile, "a");
  const child = spawn(
    process.execPath,
    [
      resolve("scripts/lab/seatbelt-run.mjs"),
      "--",
      process.execPath,
      resolve("scripts/lab/browser-verify-relay.mjs")
    ],
    {
      cwd: resolve("."),
      env: safeHostEnvironment({
        OPENCODE_WORKSPACE: workspace,
        LAB_BROWSER_PORT: String(BROWSER_RELAY_PORT),
        LAB_BROWSER_HOST: "127.0.0.1",
        LAB_BROWSER_VERIFY_RELAY_TOKEN: token,
        OPENCODE_PROJECT_ID: projectId,
        OPENCODE_WORKSPACE_HASH: workspaceHash
      }),
      detached: true,
      stdio: ["ignore", output, output]
    }
  );
  closeSync(output);
  child.unref();
  writeFileSync(browserRelayPidFile, `${child.pid}\n`);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await browserRelayHealthy()) {
      registerHelper("browser-verify", browserRelayPidFile, BROWSER_RELAY_PORT);
      console.log(
        `Lab browser verify relay: http://127.0.0.1:${BROWSER_RELAY_PORT}`
      );
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  console.warn(
    `Lab browser verify relay did not start. See ${browserRelayLogFile}.`
  );
}

async function browserSessionHealthy() {
  try {
    const response = await fetch(
      `http://127.0.0.1:${BROWSER_SESSION_PORT}/health`,
      { signal: AbortSignal.timeout(1000) }
    );
    const payload = await response.json().catch(() => null);
    return response.ok && helperMatches(payload, "lab-browser-session");
  } catch {
    return false;
  }
}

async function ensureBrowserSessionRelay(workspace, token) {
  mkdirSync(qualityDirectory, { recursive: true });
  if (await browserSessionHealthy()) {
    registerHelper(
      "browser-session",
      browserSessionPidFile,
      BROWSER_SESSION_PORT
    );
    return;
  }
  stopOwnedHelper(
    browserSessionPidFile,
    "scripts/lab/browser-session-relay.mjs"
  );
  const output = openSync(browserSessionLogFile, "a");
  const child = spawn(
    process.execPath,
    [
      resolve("scripts/lab/seatbelt-run.mjs"),
      "--",
      process.execPath,
      resolve("scripts/lab/browser-session-relay.mjs")
    ],
    {
      cwd: resolve("."),
      env: safeHostEnvironment({
        OPENCODE_WORKSPACE: workspace,
        LAB_BROWSER_SESSION_PORT: String(BROWSER_SESSION_PORT),
        LAB_BROWSER_SESSION_HOST: "127.0.0.1",
        LAB_BROWSER_SESSION_RELAY_TOKEN: token,
        OPENCODE_PROJECT_ID: projectId,
        OPENCODE_WORKSPACE_HASH: workspaceHash
      }),
      detached: true,
      stdio: ["ignore", output, output]
    }
  );
  closeSync(output);
  child.unref();
  writeFileSync(browserSessionPidFile, `${child.pid}\n`);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await browserSessionHealthy()) {
      registerHelper(
        "browser-session",
        browserSessionPidFile,
        BROWSER_SESSION_PORT
      );
      console.log(
        `Lab browser session relay: http://127.0.0.1:${BROWSER_SESSION_PORT}`
      );
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  console.warn(
    `Lab browser session relay did not start. See ${browserSessionLogFile}.`
  );
}

function startOptionalHostServices(
  workspace,
  childEnvironment,
  browserVerifyToken,
  browserSessionToken
) {
  Object.assign(childEnvironment, {
    LAB_BROWSER_VERIFY_RELAY_URL: `http://host.docker.internal:${BROWSER_RELAY_PORT}`,
    LAB_BROWSER_VERIFY_RELAY_TOKEN: browserVerifyToken,
    LAB_BROWSER_SESSION_RELAY_URL: `http://host.docker.internal:${BROWSER_SESSION_PORT}`,
    LAB_BROWSER_SESSION_RELAY_TOKEN: browserSessionToken
  });
  const services = [
    ["gallery", () => ensureGalleryServer(workspace)],
    [
      "browser verify relay",
      () => ensureBrowserVerifyRelay(workspace, browserVerifyToken)
    ],
    [
      "browser session relay",
      () => ensureBrowserSessionRelay(workspace, browserSessionToken)
    ]
  ];
  for (const [label, start] of services) {
    void Promise.resolve()
      .then(start)
      .catch((error) => {
        console.warn(
          `Optional ${label} did not start: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
  }
}

async function qualityServerHealthy(registrationToken) {
  try {
    const response = await fetch("http://127.0.0.1:8793/health", {
      headers: { "x-lab-registration-token": registrationToken },
      signal: AbortSignal.timeout(1000)
    });
    const payload = await response.json().catch(() => null);
    return response.ok && helperMatches(payload, "quality");
  } catch {
    return false;
  }
}

async function ensureQualityServer(environment, registrationToken) {
  mkdirSync(qualityDirectory, { recursive: true });
  if (await qualityServerHealthy(registrationToken)) {
    registerHelper("quality", qualityPidFile, 8793);
    return;
  }
  stopOwnedHelper(qualityPidFile, "scripts/quality-mcp/server.mjs");
  const output = openSync(qualityLogFile, "a");
  let child;
  try {
    child = spawn(
      process.execPath,
      [resolve("scripts/quality-mcp/server.mjs")],
      {
        cwd: resolve("."),
        env: environment,
        detached: true,
        stdio: ["ignore", output, output]
      }
    );
    closeSync(output);
    child.unref();
    writeFileSync(qualityPidFile, `${child.pid}\n`, { mode: 0o600 });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await qualityServerHealthy(registrationToken)) {
        registerHelper("quality", qualityPidFile, 8793);
        return;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error(`Quality service did not start. See ${qualityLogFile}.`);
  } catch (error) {
    if (Number.isInteger(child?.pid) && child.pid > 1) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        // The failed child may already have exited.
      }
      try {
        if (
          existsSync(qualityPidFile) &&
          Number(readFileSync(qualityPidFile, "utf8").trim()) === child.pid
        ) {
          unlinkSync(qualityPidFile);
        }
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") {
          console.warn(
            `Could not remove failed Quality PID file: ${cleanupError.message}`
          );
        }
      }
    }
    throw error;
  }
}

async function waitForGitHubRelay(port) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500)
      });
      if (response.ok) {
        const payload = await response.json().catch(() => null);
        if (helperMatches(payload, "github-publish-relay")) return;
      }
    } catch {
      // The host relay may still be binding its loopback socket.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(
    `GitHub publish relay did not start. See ${githubRelayLogFile}.`
  );
}

async function startGitHubRelay(token, capabilityEnvironment) {
  mkdirSync(qualityDirectory, { recursive: true });
  stopGitHubRelay();
  const port = Number(process.env.GITHUB_PUBLISH_RELAY_PORT || 8794);
  const output = openSync(githubRelayLogFile, "a");
  const child = spawn(
    process.execPath,
    [resolve("scripts/github/publish-relay.mjs")],
    {
      cwd: resolve("."),
      detached: true,
      stdio: ["ignore", output, output],
      env: safeHostEnvironment({
        GITHUB_PUBLISH_RELAY_HOST: "127.0.0.1",
        GITHUB_PUBLISH_RELAY_PORT: String(port),
        GITHUB_PUBLISH_RELAY_TOKEN: token,
        GITHUB_PUBLISH_WORKSPACE: workspacePath,
        ...capabilityEnvironment
      })
    }
  );
  closeSync(output);
  child.unref();
  writeFileSync(githubRelayPidFile, `${child.pid}\n`, { mode: 0o600 });
  const relayEnvironment = {
    GITHUB_PUBLISH_RELAY_URL: `http://host.docker.internal:${port}`,
    GITHUB_PUBLISH_RELAY_TOKEN: token
  };
  await waitForGitHubRelay(port);
  registerHelper("github-publish", githubRelayPidFile, port);
  return relayEnvironment;
}

function stopGitHubRelay() {
  stopOwnedHelper(githubRelayPidFile, "scripts/github/publish-relay.mjs");
}

async function waitForOpenPetsRelay(port) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500)
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && helperMatches(payload, "openpets-relay")) return;
    } catch {
      // The optional desktop companion may still be starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`OpenPets relay did not start. See ${openPetsRelayLogFile}.`);
}

async function startOpenPetsRelay(token) {
  mkdirSync(qualityDirectory, { recursive: true });
  stopOpenPetsRelay();
  const port = Number(process.env.OPENPETS_RELAY_PORT || 8795);
  const output = openSync(openPetsRelayLogFile, "a");
  const child = spawn(
    process.execPath,
    [resolve("scripts/openpets/relay.mjs")],
    {
      cwd: resolve("."),
      detached: true,
      stdio: ["ignore", output, output],
      env: safeHostEnvironment({
        OPENPETS_RELAY_HOST: "127.0.0.1",
        OPENPETS_RELAY_PORT: String(port),
        OPENPETS_RELAY_TOKEN: token,
        OPENCODE_PROJECT_ID: projectId,
        OPENCODE_WORKSPACE_HASH: workspaceHash
      })
    }
  );
  closeSync(output);
  child.unref();
  writeFileSync(openPetsRelayPidFile, `${child.pid}\n`, { mode: 0o600 });
  await waitForOpenPetsRelay(port);
  registerHelper("openpets", openPetsRelayPidFile, port);
  return {
    OPENPETS_RELAY_URL: `http://host.docker.internal:${port}`,
    OPENPETS_RELAY_TOKEN: token
  };
}

async function prepareGatewayHostServices(
  childEnvironment,
  qualityEnvironment,
  githubRelayToken,
  openPetsRelayToken,
  capabilityEnvironment
) {
  const openPetsPromise = startOpenPetsRelay(openPetsRelayToken).catch(
    (error) => {
      stopOpenPetsRelay();
      console.warn(
        `Optional OpenPets relay did not start: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return {};
    }
  );
  const [, githubRelayEnvironment, openPetsEnvironment] = await Promise.all([
    ensureQualityServer(qualityEnvironment, launchRegistrationToken),
    startGitHubRelay(githubRelayToken, capabilityEnvironment),
    openPetsPromise
  ]);
  Object.assign(childEnvironment, githubRelayEnvironment, openPetsEnvironment);
}

function stopOpenPetsRelay() {
  stopOwnedHelper(openPetsRelayPidFile, "scripts/openpets/relay.mjs");
}

function stopForegroundRelays() {
  if (!isForegroundLaunch) return;
  stopGitHubRelay();
  stopOpenPetsRelay();
}

function readGlobalGitConfig(key) {
  try {
    return execFileSync("git", ["config", "--global", "--get", key], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}

const gitUserName =
  process.env.OPENCODE_GIT_USER_NAME?.trim() ||
  readGlobalGitConfig("user.name");
const gitUserEmail =
  process.env.OPENCODE_GIT_USER_EMAIL?.trim() ||
  readGlobalGitConfig("user.email");

function startOAuthRelay() {
  return new Promise((resolveRelay, rejectRelay) => {
    const relay = createServer((request, response) => {
      if (!request.url?.startsWith("/mcp/oauth/callback")) {
        response.writeHead(404).end();
        return;
      }

      const callbackUrl = `http://127.0.0.1:19876${request.url}`;
      const forward = spawn(
        "docker",
        ["exec", authContainerName, "/usr/bin/wget", "-qO-", callbackUrl],
        { env: safeHostEnvironment() }
      );

      forward.stdout.pipe(response);
      forward.on("error", (error) => {
        response
          .writeHead(502)
          .end(`Could not complete OAuth callback: ${error.message}`);
      });
      forward.on("close", (code) => {
        if (code && !response.headersSent) response.writeHead(502);
        response.end();
      });
    });

    relay.once("error", rejectRelay);
    relay.listen(19876, "127.0.0.1", () => resolveRelay(relay));
  });
}

if (!gitUserName || !gitUserEmail) {
  console.error(
    "Git identity is not configured. Set user.name and user.email globally, or provide OPENCODE_GIT_USER_NAME and OPENCODE_GIT_USER_EMAIL."
  );
  process.exitCode = 1;
} else if (!existsSync(envFile)) {
  console.error(
    "OpenCode is not configured. Copy opencode.env.example to opencode.env and add your Cloudflare account ID and Workers AI token."
  );
  process.exitCode = 1;
} else {
  if (isForegroundLaunch) {
    try {
      if (!(await claimForegroundWorkspace())) process.exit(0);
      process.once("exit", releaseForegroundWorkspace);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  } else if (isTask) {
    registerBackgroundWorkspace();
  }
  mkdirSync(resolve(".opencode-user"), { recursive: true });
  ensureWorkspaceMaskTargets();
  const cloudflareAccountId = requiredEnvValue("CLOUDFLARE_ACCOUNT_ID");
  const cloudflareApiToken = requiredEnvValue("CLOUDFLARE_API_TOKEN");
  const openDesignToken = ensureEnvSecret("OD_API_TOKEN");
  const qualityMcpToken = ensureEnvSecret("QUALITY_MCP_TOKEN");
  const agentGatewaySigningKey = ensureEnvSecret("AGENT_GATEWAY_SIGNING_KEY");
  const githubRelayToken = ensureEnvSecret("GITHUB_PUBLISH_RELAY_TOKEN");
  const openPetsRelayToken = ensureEnvSecret("OPENPETS_RELAY_TOKEN");
  const browserVerifyRelayToken = ensureEnvSecret(
    "LAB_BROWSER_VERIFY_RELAY_TOKEN"
  );
  const browserSessionRelayToken = ensureEnvSecret(
    "LAB_BROWSER_SESSION_RELAY_TOKEN"
  );
  const remoteTuiToken = isRemoteTui
    ? ensureEnvSecret("REMOTE_TUI_TOKEN")
    : null;
  const notionPublisherToken = isNotionStart
    ? ensureEnvSecret("NOTION_PUBLISHER_TOKEN")
    : null;
  // Validate the real gateway credentials without copying them into any child
  // process other than Compose's fixed agent-gateway service.
  void cloudflareAccountId;
  void cloudflareApiToken;
  void openDesignToken;
  const capabilityScope = launchCapabilityScope();
  const capabilityLease = createCapabilityLease({
    key: agentGatewaySigningKey,
    workspaceHash,
    projectId,
    sessionId: launchSessionId,
    runId: launchRunId,
    routes: capabilityScope.routes,
    actions: capabilityScope.actions,
    ttlSeconds: 4 * 60 * 60
  });
  const capabilityContext = {
    OPENCODE_WORKSPACE_HASH: workspaceHash,
    OPENCODE_PROJECT_ID: projectId,
    OPENCODE_LAUNCH_SESSION_ID: launchSessionId,
    OPENCODE_RUN_ID: launchRunId
  };
  const projectSkillsPath = join(workspacePath, ".opencode", "skills");
  const emptySkillsPath = resolve("docker/empty-skills");
  const configDirectory = preparePackConfig();
  process.once("exit", removePackConfig);
  const imageBuild = readImageBuildDefinition({ root: resolve(".") });
  const childEnvironment = safeHostEnvironment({
    ...capabilityContext,
    AGENT_CAPABILITY_LEASE: capabilityLease,
    QUALITY_REGISTRATION_TOKEN: launchRegistrationToken,
    // Fixed-purpose clients retain this compatibility name, but the value is
    // now a short-lived launch lease rather than stable gateway authority.
    AGENT_GATEWAY_TOKEN: capabilityLease,
    OPENCODE_GIT_USER_NAME: gitUserName,
    OPENCODE_GIT_USER_EMAIL: gitUserEmail,
    OPENCODE_UID: String(process.getuid?.() ?? 1000),
    OPENCODE_GID: String(process.getgid?.() ?? 1000),
    OPENCODE_LAB_IMAGE_FINGERPRINT: imageBuild.fingerprint,
    OPENCODE_WORKSPACE_NAME: basename(workspacePath),
    OPENCODE_WORKSPACE: workspacePath,
    OPENCODE_CONFIG_DIR_HOST: configDirectory,
    OPENCODE_LAB_PACKS_JSON: packUiSummary(packSet),
    OPENCODE_LAB_PACKS: packSet.packs.map(({ root }) => root).join(delimiter),
    OPENCODE_PROJECT_SKILLS: existsSync(projectSkillsPath)
      ? projectSkillsPath
      : emptySkillsPath,
    // Docker Desktop cannot reliably overlay protected files inside a bind mount
    // targeted at a host-absolute path. A fixed in-container path makes the
    // secret masks deterministic while the Quality MCP maps it to the host root.
    OPENCODE_WORKSPACE_CONTAINER: "/workspace"
  });
  const qualityWorkspaceRoots = [
    workspacePath,
    ...(process.env.QUALITY_WORKSPACE_ROOTS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  ].filter((value, index, all) => all.indexOf(value) === index);
  const qualityEnvironment = safeHostEnvironment({
    QUALITY_MCP_TOKEN: qualityMcpToken,
    OPENCODE_LAB_PACKS: packSet.packs.map(({ root }) => root).join(delimiter),
    QUALITY_WORKSPACE_ROOTS: qualityWorkspaceRoots.join(","),
    ...(process.env.QUALITY_MCP_PORT
      ? { QUALITY_MCP_PORT: process.env.QUALITY_MCP_PORT }
      : {})
  });

  if (isRemoteTui) {
    const remote = spawn(
      process.execPath,
      [
        resolve("scripts/remote-tui-server.mjs"),
        "--workspace",
        workspacePath,
        "--harness-root",
        resolve("."),
        ...args.slice(1)
      ],
      {
        stdio: "inherit",
        env: safeHostEnvironment({
          REMOTE_TUI_TOKEN: remoteTuiToken,
          OPENCODE_WORKSPACE_NAME: basename(workspacePath)
        })
      }
    );
    remote.on("error", (error) => {
      console.error(`Could not start remote console: ${error.message}`);
      process.exitCode = 1;
    });
    await new Promise((resolveRemote) => {
      remote.on("exit", (code) => {
        process.exitCode = code ?? 1;
        resolveRemote();
      });
    });
    process.exit();
  }

  if (isNotionStart) {
    try {
      requiredEnvValue("NOTION_API_TOKEN");
      requiredEnvValue("NOTION_PUBLISH_TARGETS_JSON");
      void notionPublisherToken;
      runDockerCompose(
        [
          "--profile",
          "notion",
          "up",
          "-d",
          "--build",
          "notion-publisher",
          "agent-gateway"
        ],
        childEnvironment
      );
      console.log(
        "Restricted Notion publisher is ready. Publishing remains approval-gated in OpenCode."
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    process.exit();
  }

  Object.assign(childEnvironment, {
    OPENCODE_RUNTIME_CONFIG: writeRuntimeConfig()
  });
  process.once("exit", removeRuntimeConfig);
  const enabledTools = [
    ...(tooling.research ? ["research"] : []),
    ...(tooling.design ? ["design"] : [])
  ];
  console.log(
    `Tool profile: ${enabledTools.length ? enabledTools.join(" + ") : "fast coding"}`
  );

  try {
    if (isForegroundLaunch) {
      startOptionalHostServices(
        workspacePath,
        childEnvironment,
        browserVerifyRelayToken,
        browserSessionRelayToken
      );
    }
    await Promise.all([
      ensureRequestedLocalImages(childEnvironment),
      isForegroundLaunch
        ? prepareGatewayHostServices(
            childEnvironment,
            qualityEnvironment,
            githubRelayToken,
            openPetsRelayToken,
            {
              ...capabilityContext,
              AGENT_GATEWAY_SIGNING_KEY: agentGatewaySigningKey
            }
          )
        : ensureQualityServer(qualityEnvironment, launchRegistrationToken)
    ]);
    await Promise.all([
      initializeOpenCodeVolumes(childEnvironment),
      refreshAgentGateway(childEnvironment),
      startRequestedToolServices(childEnvironment)
    ]);
  } catch (error) {
    stopForegroundRelays();
    removeRuntimeConfig();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const launchArgs = isTask
    ? [
        "run",
        "--agent",
        taskRoute.agent,
        "--model",
        taskRoute.model,
        taskRoute.task
      ]
    : applyAutoApproveArgs(args);
  if (!isTask && readLabPreferences().approvalMode === "broad-auto") {
    console.log(
      "Broad auto-approval is on (hard denies and protected boundaries still apply). Pass --no-auto to switch to ask mode."
    );
  }
  if (isTask) {
    if (taskRoute.auto) {
      // Task --auto also sticks for later interactive Lab launches.
      applyAutoApproveArgs(["--auto"]);
    }
    console.log(
      `Task route: ${taskRoute.agent} · ${taskRoute.lane ?? "unclassified"} · ${taskRoute.model}`
    );
    console.log(`Routing reason: ${taskRoute.reason}`);
    console.log(
      "Model is fixed for this task; start a new task to route again."
    );
  }

  const relay = isMcpAuth ? await startOAuthRelay() : undefined;
  const child = spawn(
    "docker",
    dockerComposeArguments([
      "run",
      "--rm",
      "--no-deps",
      "--use-aliases",
      ...(isMcpAuth ? ["--name", authContainerName] : []),
      "opencode",
      ...launchArgs
    ]),
    {
      stdio: "inherit",
      env: childEnvironment
    }
  );
  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  const forwardSigterm = () => forwardSignal("SIGTERM");
  const forwardSigint = () => forwardSignal("SIGINT");
  process.once("SIGTERM", forwardSigterm);
  process.once("SIGINT", forwardSigint);

  child.once("spawn", () => {
    // Preview, gallery, and browser helpers are useful but must not delay the
    // coding TUI. The relay remains loopback-only and on the restricted network.
    if (!isForegroundLaunch) return;
    void ensureOpencodePreview(childEnvironment).catch((error) => {
      console.warn(
        `Optional preview relay did not start: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  });

  child.on("error", (error) => {
    console.error(`Could not start Docker: ${error.message}`);
    relay?.close();
    removeRuntimeConfig();
    removePackConfig();
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.off("SIGTERM", forwardSigterm);
    process.off("SIGINT", forwardSigint);
    relay?.close();
    stopForegroundRelays();
    removeRuntimeConfig();
    removePackConfig();
    process.exitCode = code ?? 1;
  });
}
