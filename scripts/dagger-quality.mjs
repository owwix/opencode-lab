#!/usr/bin/env node

import { connect } from "@dagger.io/dagger";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { inferRequirements, selectPackageCommands } from "./quality-lib.mjs";
import {
  listDependencySnapshotFiles,
  listTrackedSensitiveFiles,
  listVerificationSnapshotFiles
} from "./quality/dagger-source-policy.mjs";

function parseArgs(argv) {
  const options = { commands: [], release: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--release") {
      options.release = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${token}`);
    index += 1;
    if (token === "--command") options.commands.push(value);
    else if (token === "--workspace") options.workspace = resolve(value);
    else if (token === "--output") options.output = resolve(value);
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!options.workspace) throw new Error("--workspace is required");
  return options;
}

function defaultCommands(workspace, release) {
  const packageJson = JSON.parse(
    readFileSync(`${workspace}/package.json`, "utf8")
  );
  return selectPackageCommands(packageJson, inferRequirements([]), { release });
}

const options = parseArgs(process.argv.slice(2));
const commands = options.commands.length
  ? options.commands
  : defaultCommands(options.workspace, options.release);
const trackedSensitiveFiles = listTrackedSensitiveFiles(options.workspace);
if (trackedSensitiveFiles.length) {
  throw new Error(
    `Credential-class files must not be tracked before verification: ${trackedSensitiveFiles.join(", ")}`
  );
}
const snapshotFiles = listVerificationSnapshotFiles(options.workspace);
const evidence = {
  schemaVersion: 1,
  runner: "dagger",
  // The full Bookworm image includes Git, which repository contract tests use.
  // Pin the manifest so repeated verification does not drift with a mutable tag.
  image:
    "node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059",
  workspace: options.workspace,
  startedAt: new Date().toISOString(),
  passed: false,
  sourcePolicy: {
    kind: "git-index-and-untracked-nonignored-files",
    fileCount: snapshotFiles.length,
    secretsExcluded: true,
    symlinksRejected: true,
    verificationNetwork: "Dagger engine default (no deny API in SDK 0.21.8)"
  },
  commands: []
};

try {
  await connect(async (client) => {
    let source = client.directory();
    for (const path of snapshotFiles) {
      source = source.withFile(
        path,
        client.host().file(resolve(options.workspace, path))
      );
    }
    // Keep dependency installation independent from ordinary source edits.
    // Dagger keys an exec by its complete input filesystem; installing after
    // mounting the full source caused every code change to invalidate `npm ci`.
    // Package manifests, lockfiles, workspace manifests, install helpers, and
    // dependency patches are the only inputs that may affect installation.
    const dependencyInputFiles = listDependencySnapshotFiles(
      options.workspace,
      snapshotFiles
    );
    let dependencySource = client.directory();
    for (const path of dependencyInputFiles) {
      dependencySource = dependencySource.withFile(
        path,
        client.host().file(resolve(options.workspace, path))
      );
    }
    const npmCache = client.cacheVolume("opencode-lab-quality-npm");
    const dependencies = client
      .container()
      .from(evidence.image)
      .withDirectory("/workspace", dependencySource)
      .withMountedCache("/root/.npm", npmCache)
      .withWorkdir("/workspace")
      .withEnvVariable("CI", "true")
      .withExec(["npm", "ci"]);
    const base = dependencies.withDirectory("/workspace", source);

    evidence.sourcePolicy.dependencyInputs = dependencyInputFiles;

    for (const command of commands) {
      const startedAt = Date.now();
      try {
        const output = await base.withExec(["sh", "-lc", command]).stdout();
        evidence.commands.push({
          command,
          passed: true,
          durationMs: Date.now() - startedAt,
          outputTail: output.trim().split("\n").slice(-20).join("\n")
        });
      } catch (error) {
        evidence.commands.push({
          command,
          passed: false,
          durationMs: Date.now() - startedAt,
          error:
            error instanceof Error
              ? error.message.slice(0, 4000)
              : String(error).slice(0, 4000)
        });
        throw error;
      }
    }
    evidence.passed = true;
  });
} catch (error) {
  evidence.error =
    error instanceof Error
      ? error.message.slice(0, 4000)
      : String(error).slice(0, 4000);
}

evidence.finishedAt = new Date().toISOString();
if (options.output)
  writeFileSync(options.output, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
if (!evidence.passed) process.exitCode = 1;
