#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DIGEST_IMAGE = /^[^\s@]+@sha256:[a-f0-9]{64}$/u;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readCompatibilityManifest(root = harnessRoot) {
  return readJson(join(resolve(root), "versions.lock"));
}

export function validateCompatibilityManifest(manifest) {
  const errors = [];
  if (manifest?.schemaVersion !== 1)
    errors.push("versions.lock schemaVersion must be 1");
  if (
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(manifest?.lab?.version ?? "")
  )
    errors.push("Lab version must be semver");
  if (!/^\d+\.\d+\.\d+$/u.test(manifest?.runtimes?.node?.version ?? ""))
    errors.push("Node version must be exact");
  if (!DIGEST_IMAGE.test(manifest?.runtimes?.node?.image ?? ""))
    errors.push("Node image must be digest pinned");
  for (const component of ["opencode", "openDesign"]) {
    if (!DIGEST_IMAGE.test(manifest?.components?.[component]?.image ?? ""))
      errors.push(`${component} image must be digest pinned`);
  }
  for (const [name, version] of Object.entries(manifest?.schemas ?? {})) {
    if (!Number.isInteger(version) || version < 1)
      errors.push(`${name} schema version must be a positive integer`);
  }
  for (const [name, adapter] of Object.entries(
    manifest?.configAdapters ?? {}
  )) {
    if (!Number.isInteger(adapter?.version) || adapter.version < 1)
      errors.push(`${name} adapter version must be a positive integer`);
    if (!adapter?.fixture) errors.push(`${name} adapter requires a fixture`);
  }
  return { passed: errors.length === 0, errors };
}

export function verifyPinnedSources(root, manifest) {
  const repository = resolve(root);
  const dockerfile = readFileSync(
    join(repository, "Dockerfile.opencode"),
    "utf8"
  );
  const compose = readFileSync(
    join(repository, "docker-compose.opencode.yml"),
    "utf8"
  );
  const checks = [
    ["Node runtime", manifest.runtimes.node.image, dockerfile],
    ["OpenCode", manifest.components.opencode.image, dockerfile],
    ["OpenDesign Dockerfile", manifest.components.openDesign.image, dockerfile],
    ["OpenDesign Compose", manifest.components.openDesign.image, compose],
    ["Hound", manifest.components.hound.image, compose],
    ["State init", manifest.images.stateInit, compose]
  ].map(([name, expected, source]) => ({
    name,
    expected,
    passed: source.includes(expected)
  }));
  for (const [name, adapter] of Object.entries(manifest.configAdapters)) {
    checks.push({
      name: `${name} fixture`,
      expected: adapter.fixture,
      passed: existsSync(join(repository, adapter.fixture))
    });
  }
  return { passed: checks.every((check) => check.passed), checks };
}

export function runtimeProbeCommands(root, manifest) {
  const repository = resolve(root);
  const fixtureDirectory = join(
    repository,
    "test",
    "compatibility",
    "opencode-v1"
  );
  return [
    {
      name: "OpenCode pinned version",
      command: "docker",
      args: [
        "run",
        "--rm",
        "--entrypoint",
        "opencode",
        manifest.components.opencode.image,
        "--version"
      ],
      expect: new RegExp(
        `(?:^|\\D)${manifest.components.opencode.version.replaceAll(".", "\\.")}(?:$|\\D)`,
        "u"
      )
    },
    {
      name: "OpenCode config adapter v1",
      command: "docker",
      args: [
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "opencode",
        "-e",
        "OPENCODE_CONFIG=/compat/opencode.json",
        "-v",
        `${fixtureDirectory}:/compat:ro`,
        manifest.components.opencode.image,
        "debug",
        "config"
      ],
      expect: /cloudflare/u
    }
  ];
}

export function runCompatibilityChecks({
  root = harnessRoot,
  runtime = false,
  runner = spawnSync
} = {}) {
  const manifest = readCompatibilityManifest(root);
  const validation = validateCompatibilityManifest(manifest);
  const sources = validation.passed
    ? verifyPinnedSources(root, manifest)
    : { passed: false, checks: [] };
  const probes = [];
  if (runtime && validation.passed && sources.passed) {
    for (const probe of runtimeProbeCommands(root, manifest)) {
      const result = runner(probe.command, probe.args, {
        encoding: "utf8",
        timeout: 2 * 60 * 1000,
        maxBuffer: 8 * 1024 * 1024
      });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      probes.push({
        name: probe.name,
        passed:
          !result.error && result.status === 0 && probe.expect.test(output),
        status: result.status,
        error: result.error?.message ?? null
      });
    }
  }
  return {
    passed:
      validation.passed &&
      sources.passed &&
      (!runtime || probes.every((probe) => probe.passed)),
    manifest,
    validation,
    sources,
    probes
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = runCompatibilityChecks({
    runtime: process.argv.includes("--runtime")
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
