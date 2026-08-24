#!/usr/bin/env node
/**
 * Lab workspace checkpoints: capture HEAD + WIP (via git stash create) and
 * rewind the mounted project to that state.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const workspace = resolve(
  process.env.OPENCODE_WORKSPACE_CONTAINER ||
    process.env.OPENCODE_WORKSPACE ||
    process.cwd()
);
const storeRoot = join(workspace, ".lab-checkpoints");

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", ["-C", workspace, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch (error) {
    if (allowFail) return "";
    const message = error instanceof Error ? error.message : String(error);
    const stderr = error?.stderr?.toString?.() ?? "";
    throw new Error(stderr || message);
  }
}

function assertRepo() {
  const ok = git(["rev-parse", "--is-inside-work-tree"], { allowFail: true });
  if (ok !== "true") {
    throw new Error(
      "Checkpoints require a git repository at the workspace root."
    );
  }
}

function ensureStore() {
  mkdirSync(storeRoot, { recursive: true });
}

function listCheckpoints() {
  if (!existsSync(storeRoot)) return [];
  return readdirSync(storeRoot)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(storeRoot, name), "utf8")))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function createCheckpoint(label = "") {
  assertRepo();
  ensureStore();
  const head = git(["rev-parse", "HEAD"]);
  const dirty = git(["status", "--porcelain"]);
  const stashSha = dirty
    ? git(["stash", "create", `lab-checkpoint:${label || "manual"}`])
    : "";
  const id = new Date().toISOString().replace(/[:.]/gu, "-");
  const record = {
    id,
    label: label || "manual",
    createdAt: new Date().toISOString(),
    head,
    stashSha: stashSha || null,
    dirty: Boolean(dirty)
  };
  writeFileSync(
    join(storeRoot, `${id}.json`),
    `${JSON.stringify(record, null, 2)}\n`
  );
  return record;
}

function rewindTo(id) {
  assertRepo();
  const record = listCheckpoints().find(
    (item) => item.id === id || item.id.startsWith(id)
  );
  if (!record) throw new Error(`Unknown checkpoint: ${id}`);
  const currentDirty = git(["status", "--porcelain"]);
  if (currentDirty) {
    // Preserve current WIP before destructive rewind.
    createCheckpoint("pre-rewind-autosave");
  }
  git(["reset", "--hard", record.head]);
  git(["clean", "-fd"], { allowFail: true });
  if (record.stashSha) {
    git(["stash", "apply", "--index", record.stashSha], { allowFail: true }) ||
      git(["stash", "apply", record.stashSha]);
  }
  return record;
}

function usage() {
  console.log(`Usage:
  node checkpoint.mjs create [label]
  node checkpoint.mjs list
  node checkpoint.mjs rewind <id-prefix>
`);
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "create") {
    const record = createCheckpoint(rest.join(" ").trim());
    console.log(JSON.stringify(record, null, 2));
  } else if (command === "list") {
    const rows = listCheckpoints();
    if (rows.length === 0) {
      console.log("No lab checkpoints yet.");
    } else {
      for (const row of rows.slice(0, 30)) {
        console.log(
          `${row.id}  head=${row.head.slice(0, 8)}  dirty=${row.dirty}  ${row.label}`
        );
      }
    }
  } else if (command === "rewind") {
    const id = rest[0];
    if (!id) throw new Error("rewind requires a checkpoint id prefix.");
    const record = rewindTo(id);
    console.log(`Rewound to ${record.id} (${record.label})`);
  } else {
    usage();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
