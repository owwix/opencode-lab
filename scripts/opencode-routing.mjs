import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { selectModelRoute } from "./quality-lib.mjs";
import {
  inferPackAgent,
  packAgentAlias,
  packAgentConfig
} from "./lab/pack-loader.mjs";

const ROUTING_POLICY_PATH = resolve("quality/model-routing.json");

const AGENT_ALIASES = new Map([
  ["ship", "lab"],
  ["build", "lab"],
  ["lab", "lab"],
  ["research", "research"]
]);

function readPolicy(policyPath = ROUTING_POLICY_PATH) {
  return JSON.parse(readFileSync(policyPath, "utf8"));
}

function inferAgent(task, { packSet = { managedRuns: {} } } = {}) {
  const prefix = String(task)
    .trim()
    .match(/^\/([a-z][a-z0-9-]*)\b/iu);
  if (prefix) {
    const value = prefix[1].toLowerCase();
    return AGENT_ALIASES.get(value) ?? packAgentAlias(packSet, value) ?? "lab";
  }
  const normalized = String(task).toLowerCase();
  const contributed = inferPackAgent(packSet, normalized);
  if (contributed) return contributed;
  if (/\b(?:research|literature|sources?|evidence review)\b/u.test(normalized))
    return "research";
  return "lab";
}

function routeReason(agent, task, policy, model) {
  const matches = (policy.rules ?? [])
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => {
      const agentMatches = !rule.agent || rule.agent === agent;
      const taskMatches =
        !rule.taskPattern || new RegExp(rule.taskPattern, "iu").test(task);
      return agentMatches && taskMatches;
    })
    .sort((left, right) => {
      const priority =
        Number(right.rule.priority ?? 0) - Number(left.rule.priority ?? 0);
      return priority || left.index - right.index;
    });
  return (
    matches.find(({ rule }) => rule.model === model)?.rule.reason ??
    "Default routing policy."
  );
}

export function parseTaskInvocation(
  argv,
  { packSet = { managedRuns: {} } } = {}
) {
  if (argv[0] !== "task") {
    throw new Error("Task invocations must start with the `task` subcommand.");
  }
  let agent;
  let model;
  let auto = false;
  const taskParts = [];
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--auto") {
      auto = true;
      continue;
    }
    if (value === "--agent" || value === "--model") {
      const next = argv[index + 1];
      if (!next || next.startsWith("-"))
        throw new Error(`${value} requires a value.`);
      if (value === "--agent") agent = next;
      else model = next;
      index += 1;
      continue;
    }
    if (value.startsWith("--"))
      throw new Error(`Unsupported task option: ${value}`);
    taskParts.push(value);
  }
  const task = taskParts.join(" ").trim();
  if (!task) throw new Error("A task description is required.");
  return {
    agent: agent
      ? (AGENT_ALIASES.get(agent.toLowerCase()) ??
        packAgentAlias(packSet, agent) ??
        agent)
      : inferAgent(task, { packSet }),
    model,
    auto,
    task
  };
}

export function routeTask(
  invocation,
  policy = readPolicy(),
  { packSet = { managedRuns: {} } } = {}
) {
  const agent = invocation.agent || inferAgent(invocation.task, { packSet });
  const contributed = packAgentConfig(packSet, agent);
  const selected =
    invocation.model ||
    contributed?.model ||
    selectModelRoute(agent, invocation.task, policy);
  if (!selected || !policy.models?.[selected]) {
    throw new Error(
      `Model is not in quality/model-routing.json: ${selected ?? "(none)"}`
    );
  }
  const lane =
    Object.entries(policy.lanes ?? {}).find(
      ([, value]) => value.model === selected
    )?.[0] ?? null;
  return {
    ...invocation,
    agent,
    model: selected,
    lane,
    source: invocation.model
      ? "explicit override"
      : "quality/model-routing.json",
    reason: invocation.model
      ? "Explicit model override."
      : contributed?.model
        ? `Model declared by pack ${contributed.packId}.`
        : routeReason(agent, invocation.task, policy, selected)
  };
}

export { inferAgent, readPolicy };
