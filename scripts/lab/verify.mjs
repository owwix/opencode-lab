#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { loadProjectContract } from "./project-contract.mjs";
import {
  adapterVerificationCommands,
  resolveExecutionAdapter
} from "./execution-adapters.mjs";

export function verifyProject(workspace, { execute = spawnSync } = {}) {
  const root = resolve(workspace);
  const loaded = loadProjectContract(root);
  const adapter = resolveExecutionAdapter({
    workspace: root,
    contract: loaded.contract
  });
  const commands = adapterVerificationCommands(adapter);
  if (commands.length === 0) {
    throw new Error("Project contract does not declare verification commands.");
  }
  const results = commands.map((command) => {
    const startedAt = Date.now();
    const result = execute("sh", ["-lc", command], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return {
      command,
      passed: !result.error && result.status === 0,
      status: result.status,
      durationMs: Date.now() - startedAt,
      output: String(result.stdout ?? "").trim(),
      error: String(result.stderr ?? result.error?.message ?? "").trim()
    };
  });
  return {
    schemaVersion: 1,
    runner: "local",
    adapter: adapter.kind,
    workspace: root,
    passed: results.every(({ passed }) => passed),
    commands: results
  };
}

if (process.argv[1]?.endsWith("/verify.mjs")) {
  try {
    const result = verifyProject(process.argv[2] ?? process.cwd());
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
