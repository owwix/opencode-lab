import { basename } from "node:path";

export const IMPLEMENTATION_LANES = Object.freeze([
  Object.freeze({
    agent: "fast",
    model: "GLM-4.7 Flash",
    use: "small, bounded, low-risk changes"
  }),
  Object.freeze({
    agent: "lab",
    model: "GPT-OSS 120B",
    use: "everyday implementation"
  }),
  Object.freeze({
    agent: "deep",
    model: "Kimi K2.7 Code",
    use: "complex or high-risk implementation"
  })
]);

export const HARNESS_AGENTS = Object.freeze([
  ...IMPLEMENTATION_LANES.map(({ agent }) => agent),
  "plan",
  "reviewer",
  "dispatcher",
  "research"
]);

/**
 * @param {{ directory?: string, workspaceName?: string, env?: NodeJS.ProcessEnv }} input
 */
export function resolveMountName({
  directory,
  workspaceName,
  env = process.env
} = {}) {
  const fromEnv = String(
    workspaceName ?? env.OPENCODE_WORKSPACE_NAME ?? ""
  ).trim();
  if (fromEnv) return fromEnv;
  const dir = String(directory ?? env.OPENCODE_WORKSPACE ?? "").trim();
  if (dir) return basename(dir);
  return "workspace";
}

/**
 * @param {{ directory?: string, workspaceName?: string, env?: NodeJS.ProcessEnv }} input
 */
export function loadedPacks(env = process.env) {
  try {
    const packs = JSON.parse(env.OPENCODE_LAB_PACKS_JSON ?? "[]");
    if (!Array.isArray(packs)) return [];
    return packs
      .filter((pack) => pack && typeof pack === "object")
      .map((pack) => ({
        id: String(pack.id ?? "pack"),
        label: String(pack.label ?? pack.id ?? "Pack"),
        version: String(pack.version ?? ""),
        agents: Array.isArray(pack.agents) ? pack.agents.map(String) : [],
        commands: Array.isArray(pack.commands) ? pack.commands.map(String) : []
      }));
  } catch {
    return [];
  }
}

/**
 * @param {{ directory?: string, workspaceName?: string, env?: NodeJS.ProcessEnv }} input
 */
export function agentStripLine(input = {}) {
  const harness = HARNESS_AGENTS.join("/");
  const packAgents = loadedPacks(input.env)
    .flatMap(({ agents }) => agents)
    .filter((agent, index, all) => all.indexOf(agent) === index);
  return packAgents.length
    ? `Agents: ${harness} · packs:${packAgents.join("/")}`
    : `Agents: ${harness}`;
}

/**
 * @param {{ directory?: string, workspaceName?: string, env?: NodeJS.ProcessEnv }} input
 */
export function startupMountHint(input = {}) {
  const mount = resolveMountName(input);
  return `Mount: ${mount} · ${agentStripLine(input)}`;
}
