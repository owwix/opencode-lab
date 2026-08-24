import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function readRun(root, runId) {
  const path = join(resolve(root), "runs", runId, "run.json");
  if (!existsSync(path)) throw new Error(`Unknown parallel run: ${runId}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function synthesizeParallel({ root, groupId, runIds }) {
  if (!groupId?.trim())
    throw new Error("Parallel synthesis requires a group id.");
  const members = [...new Set(runIds ?? [])]
    .filter(Boolean)
    .map((id) => readRun(root, id));
  if (members.length < 2)
    throw new Error("Parallel synthesis requires at least two run members.");
  const fileOwners = new Map();
  for (const run of members) {
    for (const file of run.changedFiles ?? []) {
      const owners = fileOwners.get(file) ?? [];
      owners.push(run.id);
      fileOwners.set(file, owners);
    }
  }
  const conflicts = [...fileOwners.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([file, owners]) => ({ file, owners }));
  const incomplete = members.filter(
    (run) => !["passed", "failed", "cancelled", "abandoned"].includes(run.state)
  );
  const failed = members.filter((run) =>
    ["failed", "cancelled", "abandoned"].includes(run.state)
  );
  const result = {
    schemaVersion: 1,
    groupId,
    runIds: members.map((run) => run.id),
    task: [...new Set(members.map((run) => run.task))],
    status: incomplete.length
      ? "incomplete"
      : failed.length
        ? "failed"
        : conflicts.length
          ? "conflict"
          : "ready",
    incomplete: incomplete.map((run) => ({ id: run.id, state: run.state })),
    failed: failed.map((run) => ({ id: run.id, state: run.state })),
    conflicts,
    members: members.map((run) => ({
      id: run.id,
      agent: run.agent,
      model: run.model,
      state: run.state,
      workspace: run.workspace,
      headSha: run.headSha,
      changedFiles: run.changedFiles ?? [],
      verification: run.verification?.passed ?? null,
      review: run.review?.passed ?? null,
      artifacts: run.artifacts ?? {}
    })),
    mergePolicy: "operator-approved-only; no automatic merge",
    createdAt: new Date().toISOString()
  };
  result.synthesisHash = digest(result);
  const path = join(resolve(root), "parallel", `${groupId}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  return { ...result, path };
}
