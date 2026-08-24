const LAUNCHER_FLAGS = new Set([
  "--with-research",
  "--with-design",
  "--full-tools",
  "--rebuild"
]);

export function parseLauncherFlags(argv) {
  const args = [];
  const requested = {
    research: false,
    design: false,
    full: false
  };
  let rebuild = false;
  for (const value of argv) {
    if (!LAUNCHER_FLAGS.has(value)) {
      args.push(value);
      continue;
    }
    if (value === "--with-research") requested.research = true;
    if (value === "--with-design") requested.design = true;
    if (value === "--full-tools") requested.full = true;
    if (value === "--rebuild") rebuild = true;
  }
  return { args, requested, rebuild };
}

export function agentArgument(argv) {
  const index = argv.indexOf("--agent");
  if (index === -1) return null;
  const value = argv[index + 1];
  return value && !value.startsWith("-") ? value : null;
}

export function selectTooling({
  requested,
  agent,
  packSet = { managedRuns: {} }
}) {
  const normalizedAgent = String(agent ?? "").toLowerCase();
  const contributed = new Set(
    packAgentConfig(packSet, normalizedAgent)?.tooling ?? []
  );
  return {
    research:
      requested.full ||
      requested.research ||
      normalizedAgent === "research" ||
      contributed.has("research"),
    design: requested.full || requested.design || contributed.has("design")
  };
}

export function withToolingConfig(config, tooling) {
  const next = structuredClone(config);
  if (!next.mcp?.hound || !next.mcp?.["open-design"]) {
    throw new Error("OpenCode config is missing optional MCP definitions.");
  }
  next.mcp.hound.enabled = tooling.research;
  next.mcp["open-design"].enabled = tooling.design;
  return next;
}
import { packAgentConfig } from "./lab/pack-loader.mjs";
