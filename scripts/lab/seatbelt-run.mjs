#!/usr/bin/env node
/**
 * Run a Lab host helper under macOS seatbelt when available.
 * Usage: node scripts/lab/seatbelt-run.mjs -- <command> [args...]
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const profile = resolve(here, "seatbelt-lab.sb");
const sep = process.argv.indexOf("--");
const command = sep === -1 ? [] : process.argv.slice(sep + 1);
if (command.length === 0) {
  console.error("Usage: node seatbelt-run.mjs -- <command> [args...]");
  process.exit(1);
}

const workspace = resolve(
  process.env.OPENCODE_WORKSPACE || process.env.PWD || process.cwd()
);
const sandboxExec = "/usr/bin/sandbox-exec";

if (
  process.platform === "darwin" &&
  existsSync(sandboxExec) &&
  existsSync(profile)
) {
  const result = spawnSync(
    sandboxExec,
    [
      "-f",
      profile,
      "-D",
      `WORKSPACE=${workspace}`,
      "-D",
      `HOME=${homedir()}`,
      ...command
    ],
    { stdio: "inherit", env: process.env }
  );
  process.exit(result.status ?? 1);
}

const result = spawnSync(command[0], command.slice(1), {
  stdio: "inherit",
  env: process.env
});
process.exit(result.status ?? 1);
