#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { objectDigest, validateEvidence } from "./visual-evidence-lib.mjs";
import {
  configuredPackRoots,
  loadPackSet,
  qualityContractPath
} from "../lab/pack-loader.mjs";

const CONTRACT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../quality/contracts"
);
const HARNESS_ROOT = resolve(CONTRACT_ROOT, "../..");

const USAGE = `Usage:
  node scripts/quality/visual-evidence.mjs --workspace <dir> --manifest <file> [options]

  node scripts/quality/visual-evidence.mjs --workspace <dir> --agent <agent> \\
    --task <task> --commit-sha <sha> --artifact '[id=]kind:path' [options]

Options:
  --contract <id|path>        Contract ID or JSON path (defaults to manifest agent)
  --expected-task <task>      Require the manifest task to equal the managed-run task
  --artifact <spec>           Repeatable [id=]kind:path artifact declaration
  --derive <child=parent>     Repeatable provenance edge between artifact IDs
  --contact-sheet <path>      Add a contact-sheet artifact in inline-manifest mode
  --cover <artifact-id>       Repeatable contact-sheet coverage ID
  --inspect-dimensions        Inspect dimensions even when the contract does not require it
  --output <path>             Also write the JSON evidence to this file
  --compact                   Emit compact JSON instead of formatted JSON
  --help                      Show this help

Built-in contracts: coding, research. Loaded packs may contribute more.
`;

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${flag} requires a value.`);
  return value;
}

export function parseCliArgs(argv) {
  const options = {
    artifacts: [],
    covers: [],
    derivations: [],
    compact: false,
    inspectDimensions: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") options.help = true;
    else if (token === "--compact") options.compact = true;
    else if (token === "--inspect-dimensions") options.inspectDimensions = true;
    else if (token === "--workspace")
      options.workspace = takeValue(argv, index++, token);
    else if (token === "--manifest")
      options.manifestPath = takeValue(argv, index++, token);
    else if (token === "--contract")
      options.contract = takeValue(argv, index++, token);
    else if (token === "--agent")
      options.agent = takeValue(argv, index++, token);
    else if (token === "--task") options.task = takeValue(argv, index++, token);
    else if (token === "--expected-task")
      options.expectedTask = takeValue(argv, index++, token);
    else if (token === "--commit-sha")
      options.commitSha = takeValue(argv, index++, token);
    else if (token === "--artifact")
      options.artifacts.push(takeValue(argv, index++, token));
    else if (token === "--derive")
      options.derivations.push(takeValue(argv, index++, token));
    else if (token === "--contact-sheet")
      options.contactSheet = takeValue(argv, index++, token);
    else if (token === "--cover")
      options.covers.push(takeValue(argv, index++, token));
    else if (token === "--output")
      options.output = takeValue(argv, index++, token);
    else throw new Error(`Unknown option: ${token}`);
  }
  return options;
}

function safeId(value) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized || "artifact";
}

export function parseArtifactSpec(spec, index) {
  const separator = spec.indexOf(":");
  if (separator <= 0 || separator === spec.length - 1) {
    throw new Error(
      `Invalid artifact ${JSON.stringify(spec)}; expected [id=]kind:path.`
    );
  }
  const descriptor = spec.slice(0, separator);
  const path = spec.slice(separator + 1);
  const equals = descriptor.indexOf("=");
  const kind = equals >= 0 ? descriptor.slice(equals + 1) : descriptor;
  const id =
    equals >= 0 ? descriptor.slice(0, equals) : `${safeId(kind)}-${index + 1}`;
  if (!id || !kind || !path) {
    throw new Error(
      `Invalid artifact ${JSON.stringify(spec)}; expected [id=]kind:path.`
    );
  }
  return { id, kind, path };
}

export function parseDerivationSpec(spec) {
  const separator = spec.indexOf("=");
  if (separator <= 0 || separator === spec.length - 1) {
    throw new Error(
      `Invalid provenance edge ${JSON.stringify(spec)}; expected child=parent.`
    );
  }
  return { child: spec.slice(0, separator), parent: spec.slice(separator + 1) };
}

async function readJson(path, label) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(
      `${label} could not be read: ${error.code ?? error.message}`
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

async function loadManifest(options, workspace) {
  if (options.manifestPath) {
    if (
      options.artifacts.length ||
      options.derivations.length ||
      options.contactSheet
    ) {
      throw new Error(
        "--manifest cannot be combined with --artifact, --derive, or --contact-sheet."
      );
    }
    return readJson(
      resolve(workspace, options.manifestPath),
      "Evidence manifest"
    );
  }
  if (
    !options.agent ||
    !options.task ||
    !options.commitSha ||
    !options.artifacts.length
  ) {
    throw new Error(
      "Inline-manifest mode requires --agent, --task, --commit-sha, and at least one --artifact."
    );
  }
  const artifacts = options.artifacts.map(parseArtifactSpec);
  for (const edge of options.derivations.map(parseDerivationSpec)) {
    const child = artifacts.find((artifact) => artifact.id === edge.child);
    if (!child) {
      throw new Error(`Unknown derived artifact ID: ${edge.child}`);
    }
    if (!artifacts.some((artifact) => artifact.id === edge.parent)) {
      throw new Error(`Unknown provenance parent artifact ID: ${edge.parent}`);
    }
    child.derivedFrom ??= [];
    child.derivedFrom.push(edge.parent);
  }
  let contactSheet;
  if (options.contactSheet) {
    if (artifacts.some((artifact) => artifact.id === "contact-sheet")) {
      throw new Error(
        'The generated artifact ID "contact-sheet" is already in use.'
      );
    }
    artifacts.push({
      id: "contact-sheet",
      kind: "contact-sheet",
      path: options.contactSheet
    });
    contactSheet = {
      artifactId: "contact-sheet",
      covers:
        options.covers.length > 0
          ? options.covers
          : artifacts
              .filter((artifact) => artifact.kind === "render")
              .map((artifact) => artifact.id)
    };
  } else if (options.covers.length) {
    throw new Error("--cover requires --contact-sheet.");
  }
  const manifest = {
    manifestVersion: 1,
    agent: options.agent,
    task: options.task,
    commitSha: options.commitSha,
    artifacts,
    ...(contactSheet ? { contactSheet } : {})
  };
  manifest.taskBinding = {
    sha256: objectDigest({
      agent: manifest.agent,
      task: manifest.task,
      commitSha: manifest.commitSha
    }),
    artifactIds: artifacts.map((artifact) => artifact.id)
  };
  return manifest;
}

function contractPath(value) {
  if (!value) throw new Error("A contract ID or path is required.");
  if (
    value.includes("/") ||
    value.includes("\\") ||
    extname(value) === ".json"
  ) {
    return resolve(value);
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/iu.test(value)) {
    throw new Error(`Invalid contract ID: ${value}`);
  }
  const packSet = loadPackSet({
    roots: configuredPackRoots({
      envFile: resolve(HARNESS_ROOT, "opencode.env")
    })
  });
  return qualityContractPath(packSet, value, CONTRACT_ROOT);
}

async function emit(payload, options) {
  const json = `${JSON.stringify(payload, null, options.compact ? 0 : 2)}\n`;
  if (options.output) {
    const output = resolve(options.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, json, "utf8");
  }
  process.stdout.write(json);
}

export async function main(argv = process.argv.slice(2)) {
  let options = { compact: false };
  try {
    options = parseCliArgs(argv);
    if (options.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    if (!options.workspace) throw new Error("--workspace is required.");
    const workspace = resolve(options.workspace);
    const manifest = await loadManifest(options, workspace);
    const contractId = options.contract ?? manifest.agent;
    const contract = await readJson(
      contractPath(contractId),
      "Quality contract"
    );
    const evidence = await validateEvidence({
      workspace,
      manifest,
      contract,
      inspectDimensions: options.inspectDimensions,
      expectedTask: options.expectedTask
    });
    await emit(evidence, options);
    return evidence.passed ? 0 : 1;
  } catch (error) {
    const failure = {
      evidenceVersion: 1,
      generatedAt: new Date().toISOString(),
      passed: false,
      fatal: true,
      error: {
        name: error.name ?? "Error",
        message: error.message ?? String(error)
      }
    };
    await emit(failure, options);
    return 2;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main();
}
