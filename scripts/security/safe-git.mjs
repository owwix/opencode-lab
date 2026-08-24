#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { isSensitiveSnapshotPath } from "../quality/dagger-source-policy.mjs";

const MAX_DIFF_BYTES = 1024 * 1024;

function git(args, { binary = false, allowedStatuses = [0] } = {}) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: binary ? undefined : "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) throw result.error;
  if (!allowedStatuses.includes(result.status)) {
    const message = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : result.stderr;
    throw new Error(message.trim() || `git ${args[0]} failed`);
  }
  return result.stdout;
}

function safePaths(values) {
  return values.filter((path) => path && !isSensitiveSnapshotPath(path));
}

export function safeGitOutput(action) {
  if (action === "status") {
    const records = git([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all"
    ]).split("\0");
    const output = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record) continue;
      const status = record.slice(0, 2);
      const path = record.slice(3);
      const previousPath = /[RC]/u.test(status) ? records[++index] : undefined;
      if (
        isSensitiveSnapshotPath(path) ||
        (previousPath && isSensitiveSnapshotPath(previousPath))
      ) {
        continue;
      }
      output.push(`${status} ${path}`);
    }
    return output.length ? `${output.join("\n")}\n` : "";
  }
  if (action === "head") return git(["rev-parse", "HEAD"]);
  if (action === "files") {
    const paths = git(["ls-files", "-z"], { binary: true })
      .toString("utf8")
      .split("\0");
    return `${safePaths(paths).sort().join("\n")}\n`;
  }
  if (action === "diff") {
    const paths = git(["diff", "--name-only", "-z", "HEAD", "--"], {
      binary: true
    })
      .toString("utf8")
      .split("\0");
    const allowed = safePaths(paths);
    const untracked = safePaths(
      git(["ls-files", "--others", "--exclude-standard", "-z"], {
        binary: true
      })
        .toString("utf8")
        .split("\0")
    );
    const sections = [];
    if (allowed.length) {
      sections.push(
        git(["diff", "--no-ext-diff", "--no-color", "HEAD", "--", ...allowed])
      );
    }
    for (const path of untracked) {
      sections.push(
        git(["diff", "--no-index", "--no-color", "--", "/dev/null", path], {
          allowedStatuses: [0, 1]
        })
      );
    }
    const output = sections.join("\n");
    if (Buffer.byteLength(output) > MAX_DIFF_BYTES) {
      throw new Error(
        `Safe diff exceeds ${MAX_DIFF_BYTES} bytes; inspect the listed safe files individually.`
      );
    }
    return output;
  }
  throw new Error("Usage: safe-git.mjs <status|diff|head|files>");
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  try {
    process.stdout.write(safeGitOutput(process.argv[2]));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
