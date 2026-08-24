import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

const EXAMPLE_MARKERS =
  /(?:^|[._-])(?:example|sample|template)(?:[._-]|$)|\.dist$/iu;
const ENV_FILE =
  /(?:^|\/)(?:\.env(?:\..+)?|\.dev\.vars(?:\..+)?|[^/]+\.env(?:\..+)?)$/iu;
const PRIVATE_KEY_FILE = /\.(?:age|jks|kdbx|key|p12|pem|pfx)$/iu;
const SECRET_BASENAME =
  /^(?:\.netrc|\.npmrc|\.pypirc|credentials(?:\.(?:json|ya?ml|toml))?|secrets?(?:\.(?:json|ya?ml|toml))?|service-account(?:[._-].+)?\.json|id_(?:dsa|ecdsa|ed25519|rsa)(?:\.pub)?)$/iu;

function normalizedRelativePath(candidate) {
  const normalized = String(candidate).replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    isAbsolute(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`Unsafe verification snapshot path: ${candidate}`);
  }
  return normalized.replace(/^\.\//u, "");
}

export function isSensitiveSnapshotPath(candidate) {
  const path = normalizedRelativePath(candidate);
  const lower = path.toLowerCase();
  const basename = lower.split("/").at(-1);
  if (EXAMPLE_MARKERS.test(basename)) return false;
  if (
    lower === ".git" ||
    lower.startsWith(".git/") ||
    lower.includes("/.git/") ||
    lower === ".agent-trash" ||
    lower.startsWith(".agent-trash/") ||
    lower.includes("/.agent-trash/") ||
    ENV_FILE.test(lower) ||
    PRIVATE_KEY_FILE.test(basename) ||
    SECRET_BASENAME.test(basename)
  ) {
    return true;
  }
  return (
    lower === ".aws/credentials" ||
    lower.endsWith("/.aws/credentials") ||
    lower === ".docker/config.json" ||
    lower.endsWith("/.docker/config.json") ||
    lower === ".config/gcloud/application_default_credentials.json" ||
    lower.endsWith("/.config/gcloud/application_default_credentials.json")
  );
}

export function listVerificationSnapshotFiles(workspace) {
  const root = resolve(workspace);
  const output = execFileSync(
    "git",
    [
      "-C",
      root,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z"
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  const files = [...new Set(output.split("\0").filter(Boolean))]
    .map(normalizedRelativePath)
    .filter((path) => !isSensitiveSnapshotPath(path))
    .filter((path) => existsSync(resolve(root, path)))
    .sort();

  for (const path of files) {
    const absolute = resolve(root, path);
    if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
      throw new Error(`Verification snapshot escaped its workspace: ${path}`);
    }
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Verification snapshots reject symbolic links to prevent source escapes: ${path}`
      );
    }
    if (!stat.isFile()) {
      throw new Error(`Verification snapshot entry is not a file: ${path}`);
    }
  }
  return files;
}

const PACKAGE_MANIFEST = /(?:^|\/)package\.json$/u;
const PACKAGE_LOCK = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json)$/u;
const DEPENDENCY_PATCH = /(?:^|\/)patches\//u;
const INSTALL_LIFECYCLES = ["preinstall", "install", "postinstall", "prepare"];

function manifestNeedsSourceDuringInstall(manifest) {
  if (
    INSTALL_LIFECYCLES.some(
      (name) => typeof manifest?.scripts?.[name] === "string"
    )
  ) {
    return true;
  }
  return [
    manifest?.dependencies,
    manifest?.devDependencies,
    manifest?.optionalDependencies
  ].some((dependencies) =>
    Object.values(dependencies ?? {}).some((value) =>
      /^(?:file|link):/u.test(String(value))
    )
  );
}

/**
 * Return the smallest safe input set for the cached dependency-install layer.
 * Projects with install lifecycle hooks or local file dependencies retain the
 * conservative full-source behavior because those installs may execute or pack
 * arbitrary repository files.
 */
export function listDependencySnapshotFiles(workspace, snapshotFiles) {
  const root = resolve(workspace);
  const files = [...snapshotFiles];
  const sourceSensitiveInstall = files
    .filter((path) => PACKAGE_MANIFEST.test(path))
    .some((path) => {
      try {
        return manifestNeedsSourceDuringInstall(
          JSON.parse(readFileSync(resolve(root, path), "utf8"))
        );
      } catch {
        // npm will produce the authoritative parse error during verification.
        // Keep the conservative input set so caching cannot hide that failure.
        return true;
      }
    });
  if (sourceSensitiveInstall) return files;
  return files.filter(
    (path) =>
      PACKAGE_MANIFEST.test(path) ||
      PACKAGE_LOCK.test(path) ||
      DEPENDENCY_PATCH.test(path)
  );
}

export function listTrackedSensitiveFiles(workspace) {
  const root = resolve(workspace);
  const output = execFileSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  return output
    .split("\0")
    .filter(Boolean)
    .map(normalizedRelativePath)
    .filter(isSensitiveSnapshotPath)
    .sort();
}
