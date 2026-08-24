import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { hasUnpublishedChanges } from "./run-service.mjs";

export const RUN_ARTIFACT_INDEX_VERSION = 1;
const MAX_DISCOVERED_ARTIFACTS = 512;
const MAX_PATCH_BYTES = 8 * 1024 * 1024;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/u;
const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp"
]);

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600
  });
  renameSync(temporary, path);
}

function runDirectory(root, runId) {
  if (!RUN_ID.test(String(runId ?? ""))) throw new Error("Unsafe run ID.");
  return join(resolve(root), "runs", runId);
}

function isWithin(candidate, parent) {
  const child = resolve(candidate);
  const root = resolve(parent);
  return child === root || child.startsWith(`${root}${sep}`);
}

function categoryFor(path, hint = null) {
  if (hint) return hint;
  const normalized = String(path).replaceAll("\\", "/").toLowerCase();
  if (normalized.includes("browser") || normalized.includes("screenshot"))
    return "browser-capture";
  if (normalized.includes("research")) return "research";
  if (normalized.endsWith(".patch") || normalized.endsWith(".diff"))
    return "patch";
  if (IMAGE_EXTENSIONS.has(extname(normalized))) return "image";
  if (normalized.includes("review")) return "review";
  if (normalized.includes("verif")) return "verification";
  if (normalized.endsWith(".log") || normalized.endsWith(".jsonl"))
    return "log";
  return "artifact";
}

function fileEntry(path, { category = null, root = null } = {}) {
  if (!path || !existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  const target = resolve(path);
  const id = createHash("sha256")
    .update(`${categoryFor(target, category)}\0${target}`)
    .digest("hex")
    .slice(0, 24);
  return {
    id,
    category: categoryFor(target, category),
    location: "file",
    target,
    relativePath:
      root && isWithin(target, root) ? relative(root, target) : null,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString()
  };
}

function urlEntry(url, category, metadata = {}) {
  if (!url) return null;
  const id = createHash("sha256")
    .update(`${category}\0${url}`)
    .digest("hex")
    .slice(0, 24);
  return {
    id,
    category,
    location: "url",
    target: url,
    relativePath: null,
    size: null,
    modifiedAt: null,
    metadata
  };
}

function discoverFiles(directory, workspace, output) {
  if (!existsSync(directory) || output.length >= MAX_DISCOVERED_ARTIFACTS)
    return;
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return;
  for (const name of readdirSync(directory).sort()) {
    if (output.length >= MAX_DISCOVERED_ARTIFACTS) break;
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) discoverFiles(path, workspace, output);
    else if (stat.isFile()) {
      const entry = fileEntry(path, { root: workspace });
      if (entry) output.push(entry);
    }
  }
}

function writePatch({ directory, durable }) {
  const { baseSha, headSha } = durable.git ?? {};
  if (
    !/^[a-f0-9]{40}$/u.test(baseSha ?? "") ||
    !/^[a-f0-9]{40}$/u.test(headSha ?? "") ||
    baseSha === headSha
  ) {
    return null;
  }
  const repository = [durable.git?.worktree, durable.git?.source].find(
    (candidate) => candidate && existsSync(candidate)
  );
  if (!repository) return null;
  const result = spawnSync(
    "git",
    ["-C", repository, "diff", "--binary", "--no-ext-diff", baseSha, headSha],
    { encoding: "utf8", timeout: 30_000, maxBuffer: MAX_PATCH_BYTES }
  );
  if (result.status !== 0 || result.error) return null;
  const patch = String(result.stdout ?? "");
  if (!patch || Buffer.byteLength(patch) > MAX_PATCH_BYTES) return null;
  const path = join(directory, "implementation.patch");
  writeFileSync(path, patch, { mode: 0o600 });
  return path;
}

function writePrReceipt(directory, receipt) {
  if (!receipt?.url && !receipt?.headSha) return null;
  const path = join(directory, "pr-receipt.json");
  atomicJson(path, receipt);
  return path;
}

function addPath(entries, path, options = {}) {
  const entry = fileEntry(path, options);
  if (entry) entries.push(entry);
}

export function buildRunArtifactIndex({
  root,
  durable,
  controller = null,
  retentionDays = Number(process.env.QUALITY_ARTIFACT_RETENTION_DAYS ?? 30)
}) {
  if (!durable?.id) throw new Error("Durable run is required.");
  const directory = runDirectory(root, durable.id);
  mkdirSync(directory, { recursive: true });
  const workspace = durable.git?.worktree ?? controller?.workspace ?? null;
  const entries = [];

  for (const [name, category] of [
    ["run.json", "state"],
    ["service.json", "state"],
    ["orchestrator.log", "log"],
    ["trace.jsonl", "log"],
    ["artifact-evidence.json", "verification"]
  ]) {
    addPath(entries, join(directory, name), { category });
  }

  addPath(entries, writePatch({ directory, durable }), { category: "patch" });
  addPath(entries, controller?.verification?.log, { category: "verification" });
  for (const path of [
    ...(controller?.review?.logs ?? []),
    controller?.review?.log
  ].filter(Boolean)) {
    addPath(entries, path, { category: "review" });
  }
  for (const path of [
    ...(controller?.artifacts?.visual ?? []),
    controller?.artifacts?.manifest,
    controller?.artifacts?.migrationPlan,
    controller?.research?.stagedPath
  ].filter(Boolean)) {
    addPath(entries, path, { root: workspace });
  }

  if (workspace && existsSync(workspace)) {
    discoverFiles(join(workspace, "artifacts"), workspace, entries);
  }

  const pr =
    controller?.publishing?.pr ??
    durable.externalActions?.preparePr?.receipt ??
    null;
  addPath(entries, writePrReceipt(directory, pr), { category: "pr-receipt" });
  const prUrl = urlEntry(pr?.url, "pull-request", {
    base: pr?.base ?? null,
    branch: pr?.branch ?? durable.git?.branch ?? null,
    headSha: pr?.headSha ?? durable.git?.headSha ?? null
  });
  if (prUrl) entries.push(prUrl);
  const preview = urlEntry(
    controller?.preview?.url ?? controller?.artifacts?.preview,
    "preview",
    { evidence: controller?.preview?.evidence ?? null }
  );
  if (preview) entries.push(preview);

  const unique = [
    ...new Map(entries.map((entry) => [entry.id, entry])).values()
  ];
  const index = {
    schemaVersion: RUN_ARTIFACT_INDEX_VERSION,
    projectId: durable.projectId,
    runId: durable.id,
    implementationSha: durable.git?.headSha ?? controller?.headSha ?? null,
    generatedAt: new Date().toISOString(),
    retention: {
      days: Math.max(1, Number.isFinite(retentionDays) ? retentionDays : 30),
      unpublishedWorkProtected: hasUnpublishedChanges(durable),
      policy:
        "Only Lab-owned artifact-cache copies may be pruned. Source worktree artifacts and evidence metadata are retained."
    },
    categories: Object.fromEntries(
      [...new Set(unique.map((entry) => entry.category))].map((category) => [
        category,
        unique.filter((entry) => entry.category === category).length
      ])
    ),
    entries: unique
  };
  atomicJson(join(directory, "artifacts.json"), index);
  return index;
}

export function readRunArtifactIndex({ root, runId }) {
  const path = join(runDirectory(root, runId), "artifacts.json");
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
    throw new Error("Unsafe artifact index.");
  return JSON.parse(readFileSync(path, "utf8"));
}

export function pruneRunArtifactCache({
  root,
  durable,
  retentionDays,
  now = Date.now()
}) {
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || days < 1)
    throw new Error("Retention days must be at least 1.");
  if (hasUnpublishedChanges(durable)) {
    throw new Error(
      "Run has unpublished work; artifact retention refuses to delete anything."
    );
  }
  if (
    !new Set([
      "passed",
      "failed",
      "cancelled",
      "abandoned",
      "archived",
      "completed"
    ]).has(durable.state)
  ) {
    throw new Error("Only terminal runs are eligible for artifact retention.");
  }
  const directory = runDirectory(root, durable.id);
  const cache = join(directory, "artifact-cache");
  if (!existsSync(cache))
    return { pruned: false, reason: "no Lab-owned cache" };
  const age = now - statSync(cache).mtimeMs;
  if (age < days * 24 * 60 * 60 * 1000) {
    return { pruned: false, reason: "retention window active" };
  }
  rmSync(cache, { recursive: true, force: true });
  return { pruned: true, cache };
}
