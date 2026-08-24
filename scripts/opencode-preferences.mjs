import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const PREFERENCES_PATH = resolve(".opencode-user/preferences.json");

export const APPROVAL_MODES = Object.freeze(["ask", "safe-auto", "broad-auto"]);

const DEFAULTS = Object.freeze({
  approvalMode: "safe-auto"
});

function normalizedApprovalMode(value, legacyAutoApprove) {
  if (APPROVAL_MODES.includes(value)) return value;
  if (legacyAutoApprove === true) return "broad-auto";
  if (legacyAutoApprove === false) return "ask";
  return DEFAULTS.approvalMode;
}

export function readLabPreferences(path = PREFERENCES_PATH) {
  if (!existsSync(path)) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
      approvalMode: normalizedApprovalMode(
        parsed?.approvalMode,
        parsed?.autoApprove
      )
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeLabPreferences(update, path = PREFERENCES_PATH) {
  const next = {
    ...readLabPreferences(path),
    ...update,
    updatedAt: new Date().toISOString()
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * Persist the host-owned approval mode and remove launcher-only flags before
 * OpenCode starts. We deliberately never forward OpenCode's raw --auto flag:
 * the Lab plugin applies the narrower mode while hard permission denies remain
 * outside the project process.
 */
export function applyAutoApproveArgs(
  argv,
  { path = PREFERENCES_PATH, preferences = readLabPreferences(path) } = {}
) {
  const args = [...argv];
  const hasAuto = args.includes("--auto");
  const hasNoAuto = args.includes("--no-auto");
  const modeIndex = args.indexOf("--approval-mode");
  const requestedMode = modeIndex === -1 ? null : args[modeIndex + 1];
  if (modeIndex !== -1 && !APPROVAL_MODES.includes(requestedMode)) {
    throw new Error(
      `--approval-mode must be one of: ${APPROVAL_MODES.join(", ")}.`
    );
  }
  const withoutFlags = args.filter((value, index) => {
    if (value === "--auto" || value === "--no-auto") return false;
    if (modeIndex !== -1 && (index === modeIndex || index === modeIndex + 1)) {
      return false;
    }
    return true;
  });

  if (requestedMode) {
    writeLabPreferences({ approvalMode: requestedMode }, path);
    return withoutFlags;
  }

  if (hasNoAuto) {
    writeLabPreferences({ approvalMode: "ask" }, path);
    return withoutFlags;
  }

  if (hasAuto) {
    writeLabPreferences({ approvalMode: "broad-auto" }, path);
    return withoutFlags;
  }

  return withoutFlags;
}
