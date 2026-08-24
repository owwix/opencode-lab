/**
 * OpenCode hook plugin: audit + gate tool calls before/after execution.
 * Auto-loaded from `.opencode/plugins/`.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DENY_BASH = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\b/u,
  /\bgit\s+push\s+.*--force\b/u,
  /\bgit\s+push\s+-f\b/u,
  /\bdocker\s+system\s+prune\b/u,
  /\bcurl\s+[^\n]*\|\s*(ba)?sh\b/u,
  /\bwget\s+[^\n]*\|\s*(ba)?sh\b/u,
  /\bchmod\s+777\b/u
];

const DENY_PATH = [
  /(^|\/)\.env(\.|$)/u,
  /(^|\/)\.dev\.vars(\.|$)/u,
  /(^|\/)opencode\.env$/u,
  /(^|\/)credentials\.json$/u,
  /(^|\/)secrets\.json$/u,
  /\.pem$/u,
  /\.key$/u
];

function logRoot() {
  return (
    process.env.OPENCODE_WORKSPACE_CONTAINER ||
    process.env.OPENCODE_WORKSPACE ||
    process.cwd()
  );
}

function writeAudit(event) {
  try {
    const root = logRoot();
    mkdirSync(join(root, ".lab-hooks"), { recursive: true });
    appendFileSync(
      join(root, ".lab-hooks", "tool-events.jsonl"),
      `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`
    );
  } catch {
    // never break the agent loop
  }
}

function pathFromArgs(args = {}) {
  return String(
    args.filePath ||
      args.path ||
      args.file ||
      args.target ||
      args.filepath ||
      ""
  );
}

export const LabToolLifecycle = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      const tool = String(input.tool || "");
      const args = output?.args ?? {};
      writeAudit({
        type: "tool.before",
        tool,
        sessionID: input.sessionID ?? null,
        callID: input.callID ?? null,
        argsPreview: JSON.stringify(args).slice(0, 500)
      });

      if (tool === "bash" || tool === "shell") {
        const command = String(args.command || args.cmd || "");
        for (const pattern of DENY_BASH) {
          if (pattern.test(command)) {
            writeAudit({
              type: "tool.blocked",
              tool,
              reason: `Matched deny pattern ${pattern}`,
              command: command.slice(0, 300)
            });
            throw new Error(
              `Lab lifecycle hook blocked dangerous shell: ${pattern}`
            );
          }
        }
      }

      if (["read", "edit", "write", "apply_patch"].includes(tool)) {
        const filePath = pathFromArgs(args);
        for (const pattern of DENY_PATH) {
          if (filePath && pattern.test(filePath)) {
            writeAudit({
              type: "tool.blocked",
              tool,
              reason: `Credential path denied: ${filePath}`
            });
            throw new Error(
              `Lab lifecycle hook blocked credential path access: ${filePath}`
            );
          }
        }
      }
    },
    "tool.execute.after": async (input, output) => {
      writeAudit({
        type: "tool.after",
        tool: String(input.tool || ""),
        sessionID: input.sessionID ?? null,
        callID: input.callID ?? null,
        error: output?.error ? String(output.error).slice(0, 400) : null,
        title: output?.title ?? null
      });
    }
  };
};

export default LabToolLifecycle;
