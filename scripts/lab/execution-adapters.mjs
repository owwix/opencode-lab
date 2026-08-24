import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const EXECUTION_ADAPTER_SCHEMA_VERSION = 1;

const NODE_IMAGE =
  "node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059";
const PYTHON_IMAGE =
  "python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7";

function regularFile(path) {
  if (!existsSync(path)) return false;
  const details = lstatSync(path);
  return details.isFile() && !details.isSymbolicLink();
}

function readJson(path) {
  if (!regularFile(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function commandToShell(command) {
  const prefix = Object.entries(command.env ?? {})
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(" ");
  const invocation = command.argv.map(shellQuote).join(" ");
  const body = prefix ? `${prefix} ${invocation}` : invocation;
  return command.cwd ? `cd ${shellQuote(command.cwd)} && ${body}` : body;
}

function nodeWorkspace(workspace, manifest) {
  return (
    Boolean(manifest?.workspaces) ||
    regularFile(join(workspace, "pnpm-workspace.yaml")) ||
    regularFile(join(workspace, "turbo.json")) ||
    regularFile(join(workspace, "nx.json"))
  );
}

function classify(workspace) {
  const packageJson = readJson(join(workspace, "package.json"));
  const python =
    regularFile(join(workspace, "pyproject.toml")) ||
    regularFile(join(workspace, "requirements.txt")) ||
    regularFile(join(workspace, "setup.py"));
  if (packageJson) {
    return {
      kind: nodeWorkspace(workspace, packageJson) ? "monorepo" : "node",
      runtime: "node",
      image: NODE_IMAGE
    };
  }
  if (python) return { kind: "python", runtime: "python", image: PYTHON_IMAGE };
  return { kind: "generic", runtime: "generic", image: NODE_IMAGE };
}

function supportedExecutables(runtime) {
  if (runtime === "python") {
    return ["python", "python3", "pip", "pip3", "uv", "poetry", "sh"];
  }
  if (runtime === "node") {
    return ["node", "npm", "npx", "pnpm", "pnpx", "yarn", "bun", "sh"];
  }
  return ["git", "node", "npm", "npx", "pnpm", "pnpx", "sh"];
}

export function resolveExecutionAdapter({ workspace, contract }) {
  const root = resolve(workspace);
  const identity = classify(root);
  const install = (contract?.install ?? []).map((command) => ({
    ...structuredClone(command),
    shell: commandToShell(command)
  }));
  const verify = (contract?.verify ?? []).map((command) => ({
    ...structuredClone(command),
    shell: commandToShell(command)
  }));
  return {
    schemaVersion: EXECUTION_ADAPTER_SCHEMA_VERSION,
    ...identity,
    workspace: root,
    supportedExecutables: supportedExecutables(identity.runtime),
    install,
    verify
  };
}

export function adapterVerificationCommands(adapter) {
  return adapter.verify.map(({ shell }) => shell);
}
