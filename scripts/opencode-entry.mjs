#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = resolve(packageRoot, "scripts/opencode.mjs");
const setup = resolve(packageRoot, "scripts/opencode-setup.mjs");
const prune = resolve(packageRoot, "scripts/lab/prune.mjs");
const args = process.argv.slice(2);

const requiredNodeVersion = readFileSync(resolve(packageRoot, ".nvmrc"), "utf8")
  .trim()
  .replace(/^v/u, "");
if (process.versions.node !== requiredNodeVersion) {
  const pinnedNode = resolve(
    homedir(),
    ".nvm",
    "versions",
    "node",
    `v${requiredNodeVersion}`,
    "bin",
    "node"
  );
  if (!existsSync(pinnedNode)) {
    console.error(
      `OpenCode Lab requires Node ${requiredNodeVersion}. Install it with nvm before launching.`
    );
    process.exit(1);
  }
  const result = spawnSync(pinnedNode, [process.argv[1], ...args], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env
  });
  process.exit(result.status ?? 1);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`OpenCode Lab launcher

Usage:
  opencode-lab                              Choose a workspace and start the TUI
  opencode-lab --workspace <folder>         Start in a specific workspace
  opencode-lab task <type> <request>        Run a managed task
  opencode-lab --setup                      Check or create local configuration
  opencode-lab prune [--apply]              Report legacy Lab volumes; delete only with --apply

Tool profiles (launcher-only; never passed to OpenCode):
  --with-research  Start Hound (auto for managed runs that request research)
  --with-design    Start OpenDesign (auto for managed runs that request design)
  --full-tools     Start both optional tool stacks
  --rebuild        Rebuild images for the selected profile before launch

Approval modes (host-owned; project code cannot modify them):
  --approval-mode ask        Ask for every non-allowlisted action
  --approval-mode safe-auto  Auto-approve only low-risk file tools (default)
  --approval-mode broad-auto Auto-approve broad non-shell work, but never
                              credentials, publishing, network, or hard denies
  --auto                     Alias for persistent broad-auto
  --no-auto                  Alias for persistent ask

The default interactive launch uses the fast coding profile: optional tool
containers and MCP clients stay disabled. Missing selected images are still
built automatically once. Tab-switching agents does not activate a tool stack;
quit and relaunch with \`lab --with-research\` or \`lab --with-design\` first.

Aliases: lab

Run from any directory. Credentials stay in this harness opencode.env and are
never copied into the selected workspace.

Named 'opencode-lab' / 'lab' so it does not collide with the standalone
OpenCode CLI binary.`);
  process.exit(0);
}

if (args.includes("--setup")) {
  const result = spawnSync(process.execPath, [setup], {
    cwd: packageRoot,
    stdio: "inherit",
    env: process.env
  });
  process.exitCode = result.status ?? 1;
} else if (args[0] === "prune") {
  const result = spawnSync(process.execPath, [prune, ...args.slice(1)], {
    cwd: packageRoot,
    stdio: "inherit",
    env: process.env
  });
  process.exitCode = result.status ?? 1;
} else {
  const result = spawnSync(process.execPath, [launcher, ...args], {
    cwd: packageRoot,
    stdio: "inherit",
    env: process.env
  });
  process.exitCode = result.status ?? 1;
}
