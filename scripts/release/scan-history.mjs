#!/usr/bin/env node

import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

function requireBinary(name) {
  const result = spawnSync(name, ["--version"], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    throw new Error(`${name} is required for the history release gate.`);
  }
  if (result.status !== 0) {
    throw new Error(`${name} --version failed.`);
  }
}

function run(name, arguments_) {
  const result = spawnSync(name, arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error(`${name} scan failed.`);
  }
}

function gitOutput(arguments_) {
  const result = spawnSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) throw new Error(result.stderr.trim());
  return result.stdout.trim();
}

function reachableTips() {
  const output = gitOutput([
    "for-each-ref",
    "--format=%(objectname)",
    "refs/heads",
    "refs/remotes",
    "refs/tags"
  ]);
  return [...new Set(output.split("\n").filter(Boolean))].sort();
}

try {
  requireBinary("gitleaks");
  requireBinary("trufflehog");
  run("gitleaks", [
    "git",
    ".",
    "--redact",
    "--no-banner",
    "--exit-code=1",
    "--log-opts=--all"
  ]);
  for (const tip of reachableTips()) {
    run("trufflehog", [
      "git",
      `file://${repositoryRoot}`,
      "--branch",
      tip,
      "--fail",
      "--no-update",
      "--results=verified,unknown"
    ]);
  }
  console.log("Gitleaks and TruffleHog passed for every reachable ref tip.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
