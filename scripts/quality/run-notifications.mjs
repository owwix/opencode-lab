import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/u;
const MAX_NOTIFICATIONS = 1_000;

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600
  });
  renameSync(temporary, path);
}

function notificationPath(root, projectId) {
  if (!PROJECT_ID.test(String(projectId ?? "")))
    throw new Error("Unsafe notification project ID.");
  return join(resolve(root), "projects", projectId, "notifications.json");
}

function readStore(root, projectId) {
  const path = notificationPath(root, projectId);
  if (!existsSync(path)) return { schemaVersion: 1, projectId, records: [] };
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
    throw new Error("Unsafe notification store.");
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return {
    schemaVersion: 1,
    projectId,
    records: Array.isArray(parsed.records) ? parsed.records : []
  };
}

function candidate(type, runId, identity, title, message, evidence = null) {
  return {
    type,
    runId,
    dedupeKey: `${runId}:${type}:${identity}`,
    title,
    message,
    evidence
  };
}

export function notificationCandidates({ durable, controller, artifactIndex }) {
  const candidates = [];
  for (const approval of (controller?.approvals ?? []).filter(
    (item) => item.status === "pending"
  )) {
    candidates.push(
      candidate(
        "approval-required",
        durable.id,
        approval.id,
        "Approval required",
        `${approval.phase ?? "Managed run"} is waiting for an operator decision.`,
        approval.id
      )
    );
  }
  if (durable.state === "needs_evidence") {
    candidates.push(
      candidate(
        "blocked",
        durable.id,
        durable.updatedAt,
        "Run blocked",
        "Required evidence is missing.",
        artifactIndex ? `run:${durable.id}:artifacts` : null
      )
    );
  }
  if (durable.state === "failed") {
    candidates.push(
      candidate(
        "failed",
        durable.id,
        durable.git?.headSha ?? durable.updatedAt,
        "Run failed",
        durable.task ?? "A managed run failed.",
        `run:${durable.id}`
      )
    );
  }
  if (durable.state === "passed") {
    candidates.push(
      candidate(
        "passed",
        durable.id,
        durable.git?.headSha ?? durable.updatedAt,
        "Run passed",
        durable.task ?? "A managed run passed verification and review.",
        `run:${durable.id}`
      )
    );
  }
  const meaningfulArtifacts = (artifactIndex?.entries ?? []).filter(
    (entry) => !new Set(["state", "log"]).has(entry.category)
  );
  if (meaningfulArtifacts.length) {
    const digest = createHash("sha256")
      .update(
        meaningfulArtifacts
          .map((entry) => entry.id)
          .sort()
          .join("\n")
      )
      .digest("hex")
      .slice(0, 16);
    candidates.push(
      candidate(
        "artifact-ready",
        durable.id,
        digest,
        "Artifacts ready",
        `${meaningfulArtifacts.length} run artifact${meaningfulArtifacts.length === 1 ? " is" : "s are"} ready.`,
        `run:${durable.id}:artifacts`
      )
    );
  }
  const pr =
    controller?.publishing?.pr ??
    durable.externalActions?.preparePr?.receipt ??
    null;
  if (pr?.url) {
    candidates.push(
      candidate(
        "pr-ready",
        durable.id,
        pr.headSha ?? pr.url,
        "Pull request ready",
        pr.url,
        pr.url
      )
    );
  }
  return candidates;
}

export function syncRunNotifications({
  root,
  durable,
  controller = null,
  artifactIndex = null
}) {
  if (!durable?.projectId) return [];
  const store = readStore(root, durable.projectId);
  const known = new Set(store.records.map((record) => record.dedupeKey));
  const created = [];
  for (const item of notificationCandidates({
    durable,
    controller,
    artifactIndex
  })) {
    if (known.has(item.dedupeKey)) continue;
    const record = {
      id: `notification_${createHash("sha256").update(item.dedupeKey).digest("hex").slice(0, 20)}`,
      projectId: durable.projectId,
      ...item,
      status: "unread",
      createdAt: new Date().toISOString(),
      readAt: null
    };
    store.records.push(record);
    known.add(item.dedupeKey);
    created.push(record);
  }
  if (created.length) {
    store.records = store.records.slice(-MAX_NOTIFICATIONS);
    atomicJson(notificationPath(root, durable.projectId), store);
  }
  return created;
}

export function listProjectNotifications({ root, projectId, runId = null }) {
  return readStore(root, projectId)
    .records.filter((record) => !runId || record.runId === runId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
