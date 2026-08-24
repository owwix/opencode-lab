const MAX_FILES = 80;
const MAX_PATH_LENGTH = 300;
const MAX_TASK_LENGTH = 4_000;

function tokens(task) {
  return new Set(
    String(task ?? "")
      .toLowerCase()
      .match(/[a-z0-9_-]{3,}/gu) ?? []
  );
}

function scorePath(path, taskTokens) {
  const normalized = path.toLowerCase();
  let score = 0;
  for (const token of taskTokens) if (normalized.includes(token)) score += 3;
  if (/^(src|scripts|docker|quality|docs)\//u.test(normalized)) score += 1;
  if (/test|spec|contract|route|gateway|agent|model/u.test(normalized))
    score += 2;
  if (/node_modules|\.git\//u.test(normalized)) score -= 100;
  return score;
}

export function buildContextPack({
  task = "",
  agent = "lab",
  paths = [],
  changedFiles = []
} = {}) {
  const taskText = String(task).slice(0, MAX_TASK_LENGTH);
  const taskTokens = tokens(taskText);
  const safe = [...new Set(paths.concat(changedFiles))]
    .filter(
      (path) => typeof path === "string" && path.length <= MAX_PATH_LENGTH
    )
    .filter(
      (path) => !path.startsWith("/") && !path.split(/[\\/]/u).includes("..")
    )
    .filter(
      (path) =>
        !/(?:\.env|\.dev\.vars|docker\.env|opencode\.env|\.pem|\.key)$/iu.test(
          path
        )
    )
    .sort(
      (left, right) =>
        scorePath(right, taskTokens) - scorePath(left, taskTokens) ||
        left.localeCompare(right)
    )
    .slice(0, MAX_FILES);
  return {
    protocol: "context-pack/v1",
    agent: String(agent).slice(0, 80),
    task: taskText,
    changedFiles: [...new Set(changedFiles)].filter((path) =>
      safe.includes(path)
    ),
    candidateFiles: safe,
    omittedFileCount: Math.max(
      0,
      new Set(paths.concat(changedFiles)).size - safe.length
    )
  };
}
