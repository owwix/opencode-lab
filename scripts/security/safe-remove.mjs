#!/usr/bin/env node

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";

const PLAN_PREFIX = "opencode-delete-plan-";
const PLAN_NAME = "plan.json";
const PLAN_TTL_MS = 15 * 60 * 1000;
const TRASH_DIRECTORY = ".agent-trash";

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function workspaceRoot(value = process.cwd()) {
  return realpathSync(value);
}

function normalizedTarget(root, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Every deletion target must be a non-empty relative path.");
  }
  if (value.includes("\0") || isAbsolute(value)) {
    throw new Error(
      `Deletion target must be relative to the workspace: ${value}`
    );
  }
  const absolute = resolve(root, value);
  if (!isInside(root, absolute)) {
    throw new Error(
      `Refusing deletion outside or at the workspace root: ${value}`
    );
  }
  const rel = relative(root, absolute);
  if (rel === TRASH_DIRECTORY || rel.startsWith(`${TRASH_DIRECTORY}${sep}`)) {
    throw new Error("The recovery directory cannot be a deletion target.");
  }
  // A symlink itself may be moved safely, but its containing directory must still
  // resolve inside the confirmed workspace.
  const parent = realpathSync(dirname(absolute));
  if (parent !== root && !isInside(root, parent)) {
    throw new Error(
      `Deletion target escapes the workspace through a symlink: ${rel}`
    );
  }
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error(`Deletion target does not exist: ${rel}`);
    }
    throw error;
  }
  return {
    path: rel,
    kind: stat.isSymbolicLink()
      ? "symlink"
      : stat.isDirectory()
        ? "directory"
        : "file",
    identity: {
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      size: stat.size,
      mtimeMs: stat.mtimeMs
    }
  };
}

function assertNoOverlap(targets) {
  const sorted = [...targets].sort((left, right) =>
    left.path.localeCompare(right.path)
  );
  for (let index = 1; index < sorted.length; index += 1) {
    const parent = sorted[index - 1].path;
    const child = sorted[index].path;
    if (child === parent || child.startsWith(`${parent}${sep}`)) {
      throw new Error(`Deletion targets overlap: ${parent} and ${child}`);
    }
  }
}

export function createDeletionPlan(
  values,
  { workspace = process.cwd(), temporaryRoot = tmpdir(), now = Date.now } = {}
) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("Specify one or more exact deletion targets.");
  }
  const root = workspaceRoot(workspace);
  const targets = values.map((value) => normalizedTarget(root, value));
  assertNoOverlap(targets);

  const directory = mkdtempSync(join(temporaryRoot, PLAN_PREFIX));
  chmodSync(directory, 0o700);
  const path = join(directory, PLAN_NAME);
  const plan = {
    version: 1,
    workspace: root,
    createdAt: new Date(now()).toISOString(),
    expiresAt: new Date(now() + PLAN_TTL_MS).toISOString(),
    targets
  };
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  return { planPath: path, ...plan };
}

function readBoundPlan(planPath, temporaryRoot) {
  const absolute = resolve(planPath);
  const parent = dirname(absolute);
  if (
    basename(absolute) !== PLAN_NAME ||
    dirname(parent) !== resolve(temporaryRoot) ||
    !basename(parent).startsWith(PLAN_PREFIX)
  ) {
    throw new Error(
      "Deletion execution requires a plan created by safe-remove."
    );
  }
  return { absolute, parent, plan: JSON.parse(readFileSync(absolute, "utf8")) };
}

function sameIdentity(actual, expected) {
  return (
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.mode === expected.mode &&
    actual.size === expected.size &&
    actual.mtimeMs === expected.mtimeMs
  );
}

export function executeDeletionPlan(
  planPath,
  { workspace = process.cwd(), temporaryRoot = tmpdir(), now = Date.now } = {}
) {
  const root = workspaceRoot(workspace);
  const bound = readBoundPlan(planPath, temporaryRoot);
  const { plan } = bound;
  if (plan.version !== 1 || plan.workspace !== root) {
    throw new Error("Deletion plan belongs to a different workspace.");
  }
  if (Date.parse(plan.expiresAt) < now()) {
    throw new Error("Deletion plan expired; inspect the targets again.");
  }
  if (!Array.isArray(plan.targets) || plan.targets.length === 0) {
    throw new Error("Deletion plan contains no targets.");
  }

  // Complete every check before moving any path.
  const sources = plan.targets.map((target) => {
    const current = normalizedTarget(root, target.path);
    if (
      current.kind !== target.kind ||
      !sameIdentity(current.identity, target.identity)
    ) {
      throw new Error(`Deletion target changed after approval: ${target.path}`);
    }
    return { ...target, absolute: resolve(root, target.path) };
  });
  assertNoOverlap(sources);

  const trashRoot = join(root, TRASH_DIRECTORY);
  mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
  const recoveryRoot = mkdtempSync(join(trashRoot, "deletion-"));
  const moved = [];
  try {
    for (const source of sources) {
      const destination = join(recoveryRoot, source.path);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      renameSync(source.absolute, destination);
      moved.push({ source: source.absolute, destination });
    }
  } catch (error) {
    const rollbackFailures = [];
    for (const entry of moved.reverse()) {
      try {
        mkdirSync(dirname(entry.source), { recursive: true });
        renameSync(entry.destination, entry.source);
      } catch (rollbackError) {
        rollbackFailures.push(String(rollbackError));
      }
    }
    if (rollbackFailures.length) {
      throw new Error(
        `Deletion move failed and rollback was incomplete: ${rollbackFailures.join("; ")}`
      );
    }
    throw error;
  }

  const manifestPath = join(recoveryRoot, "recovery-manifest.json");
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        version: 1,
        workspace: root,
        movedAt: new Date(now()).toISOString(),
        targets: plan.targets
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" }
  );
  unlinkSync(bound.absolute);
  rmdirSync(bound.parent);
  return {
    recoveryRoot,
    manifestPath,
    targets: plan.targets.map((target) => target.path)
  };
}

function usage() {
  return [
    "Usage:",
    "  safe-remove.mjs plan <relative-path> [relative-path...]",
    "  safe-remove.mjs execute <plan-path>"
  ].join("\n");
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  try {
    const [action, ...args] = process.argv.slice(2);
    let result;
    if (action === "plan") result = createDeletionPlan(args);
    else if (action === "execute" && args.length === 1) {
      result = executeDeletionPlan(args[0]);
    } else {
      throw new Error(usage());
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
