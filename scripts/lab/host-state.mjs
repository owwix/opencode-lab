import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync
} from "node:fs";

function explicitRoot(name, env) {
  const value = env[name]?.trim();
  if (!value) return null;
  if (!isAbsolute(value)) {
    throw new Error(`${name} must be an absolute host path.`);
  }
  return resolve(value);
}

export function labStateRoot({
  env = process.env,
  home = homedir(),
  platform = process.platform
} = {}) {
  const configured = explicitRoot("OPENCODE_LAB_STATE_ROOT", env);
  if (configured) return configured;
  if (env.XDG_STATE_HOME?.trim()) {
    return resolve(env.XDG_STATE_HOME, "opencode-lab");
  }
  return platform === "darwin"
    ? join(home, "Library", "Application Support", "OpenCode Lab", "state")
    : join(home, ".local", "state", "opencode-lab");
}

export function labConfigRoot({
  env = process.env,
  home = homedir(),
  platform = process.platform
} = {}) {
  const configured = explicitRoot("OPENCODE_LAB_CONFIG_ROOT", env);
  if (configured) return configured;
  if (env.XDG_CONFIG_HOME?.trim()) {
    return resolve(env.XDG_CONFIG_HOME, "opencode-lab");
  }
  return platform === "darwin"
    ? join(home, "Library", "Application Support", "OpenCode Lab", "config")
    : join(home, ".config", "opencode-lab");
}

export function labHostPaths(options = {}) {
  const stateRoot = labStateRoot(options);
  const configRoot = labConfigRoot(options);
  return Object.freeze({
    stateRoot,
    configRoot,
    registryPath: join(stateRoot, "host-registry.json"),
    preferencesPath: join(configRoot, "preferences.json"),
    releasesRoot: join(stateRoot, "releases"),
    updatesRoot: join(stateRoot, "updates"),
    backupsRoot: join(dirname(stateRoot), "backups")
  });
}

export function projectHostState(projectId, options = {}) {
  if (!/^project_[a-f0-9]{24}$/u.test(projectId)) {
    throw new Error("A valid stable project ID is required for Lab state.");
  }
  return join(labStateRoot(options), "projects", projectId);
}

export function adoptLegacyHostFile(source, destination) {
  if (!existsSync(source) || existsSync(destination)) return false;
  const details = lstatSync(source);
  if (
    details.isSymbolicLink() ||
    !details.isFile() ||
    details.size > 1024 * 1024
  ) {
    throw new Error(`Refusing unsafe legacy Lab state file: ${source}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination, constants.COPYFILE_EXCL);
  chmodSync(destination, 0o600);
  return true;
}
