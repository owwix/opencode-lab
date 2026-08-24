#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  configuredPackRoots,
  loadPackSet,
  managedRunProfiles
} from "./lab/pack-loader.mjs";

const harnessRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const controller = join(harnessRoot, "scripts", "quality-controller.mjs");
const [kind = "ship", ...input] = process.argv.slice(2);
const packSet = loadPackSet({
  roots: configuredPackRoots({ envFile: join(harnessRoot, "opencode.env") })
});
const profiles = managedRunProfiles(packSet, {
  ship: { agent: "lab", taskPrefix: "" },
  research: {
    agent: "research",
    taskPrefix:
      "Research this decision and write a source-linked Markdown deliverable under artifacts/research/ for staging; do not publish to Notion: "
  }
});

function fail(message) {
  console.error(message);
  process.exit(1);
}

const profile = profiles[kind];
if (!profile) fail(`Unknown managed task kind: ${kind}`);

const forwarded = [];
const taskParts = [];
for (let index = 0; index < input.length; index += 1) {
  const value = input[index];
  if (["--release", "--allow-dirty-source"].includes(value)) {
    forwarded.push(value);
    continue;
  }
  if (["--workspace", "--verify", "--model", "--base"].includes(value)) {
    const next = input[index + 1];
    if (!next) fail(`Missing value for ${value}`);
    forwarded.push(value, next);
    index += 1;
    continue;
  }
  if (value.startsWith("--")) fail(`Unsupported option: ${value}`);
  taskParts.push(value);
}

const hasWorkspace = forwarded.includes("--workspace");
if (!hasWorkspace) {
  const workspace = process.env.OPENCODE_WORKSPACE || process.cwd();
  forwarded.push("--workspace", workspace);
}

const task = taskParts.join(" ").trim();
if (!task) {
  fail(
    `Describe the outcome, for example: npm run ${kind} -- "Implement one bounded outcome"`
  );
}

const result = spawnSync(
  process.execPath,
  [
    controller,
    "run",
    "--agent",
    profile.agent,
    "--task",
    `${profile.taskPrefix}${task}`,
    ...forwarded
  ],
  {
    cwd: harnessRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCODE_LAB_PACKS: packSet.packs.map(({ root }) => root).join(delimiter)
    }
  }
);

if (result.error) fail(result.error.message);
process.exitCode = result.status ?? 1;
