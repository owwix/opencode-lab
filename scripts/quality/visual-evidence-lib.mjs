import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import {
  inspectBrandReviewSemantics,
  inspectResearchSemantics,
  inspectVisualSemantics
} from "./visual-evidence-semantic.mjs";

const IMAGE_EXTENSIONS = new Set([
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp"
]);
const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ".pdf"]);
const MEDIA_TYPES_BY_EXTENSION = {
  ".gif": new Set(["image/gif"]),
  ".jpeg": new Set(["image/jpeg"]),
  ".jpg": new Set(["image/jpeg"]),
  ".pdf": new Set(["application/pdf"]),
  ".png": new Set(["image/png"]),
  ".svg": new Set(["image/svg+xml"]),
  ".webp": new Set(["image/webp"])
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)])
  );
}

export function objectDigest(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function fileDigest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function insideDirectory(root, target) {
  const child = relative(root, target);
  return child !== "" && !child.startsWith("..") && !isAbsolute(child);
}

function parsePng(buffer) {
  if (
    buffer.length < 24 ||
    !buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  ) {
    return null;
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    unit: "pixels",
    source: "png-header"
  };
}

function parseGif(buffer) {
  if (buffer.length < 10) return null;
  const signature = buffer.subarray(0, 6).toString("ascii");
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;
  return {
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8),
    unit: "pixels",
    source: "gif-header"
  };
}

function parseJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }
  const sizeMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
  ]);
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }
    if (offset + 2 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
    if (sizeMarkers.has(marker) && segmentLength >= 7) {
      return {
        width: buffer.readUInt16BE(offset + 5),
        height: buffer.readUInt16BE(offset + 3),
        unit: "pixels",
        source: "jpeg-header"
      };
    }
    offset += segmentLength;
  }
  return null;
}

function readUint24LE(buffer, offset) {
  return (
    buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
  );
}

function parseWebp(buffer) {
  if (
    buffer.length < 30 ||
    buffer.subarray(0, 4).toString("ascii") !== "RIFF" ||
    buffer.subarray(8, 12).toString("ascii") !== "WEBP"
  ) {
    return null;
  }
  const format = buffer.subarray(12, 16).toString("ascii");
  if (format === "VP8X") {
    return {
      width: readUint24LE(buffer, 24) + 1,
      height: readUint24LE(buffer, 27) + 1,
      unit: "pixels",
      source: "webp-vp8x-header"
    };
  }
  if (format === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
    const b1 = buffer[21];
    const b2 = buffer[22];
    const b3 = buffer[23];
    const b4 = buffer[24];
    return {
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + ((b4 & 0x0f) << 10) + (b3 << 2) + ((b2 & 0xc0) >> 6),
      unit: "pixels",
      source: "webp-vp8l-header"
    };
  }
  if (format === "VP8 ") {
    const start = buffer.indexOf(Buffer.from([0x9d, 0x01, 0x2a]), 20);
    if (start >= 0 && start + 7 <= buffer.length) {
      return {
        width: buffer.readUInt16LE(start + 3) & 0x3fff,
        height: buffer.readUInt16LE(start + 5) & 0x3fff,
        unit: "pixels",
        source: "webp-vp8-header"
      };
    }
  }
  return null;
}

function parseSvg(buffer) {
  const text = buffer.subarray(0, 262_144).toString("utf8").trimStart();
  if (!/^<\?xml\b|^<svg\b/iu.test(text) || !/<svg\b/iu.test(text)) return null;
  const svgTag = text.match(/<svg\b[^>]*>/iu)?.[0] ?? "";
  const parseLength = (name) => {
    const match = svgTag.match(
      new RegExp(`\\b${name}=["']([0-9.]+)(?:px)?["']`, "iu")
    );
    return match ? Number.parseFloat(match[1]) : null;
  };
  let width = parseLength("width");
  let height = parseLength("height");
  if (!width || !height) {
    const viewBox = svgTag.match(
      /\bviewBox=["']\s*[-0-9.]+\s+[-0-9.]+\s+([0-9.]+)\s+([0-9.]+)\s*["']/iu
    );
    if (viewBox) {
      width ||= Number.parseFloat(viewBox[1]);
      height ||= Number.parseFloat(viewBox[2]);
    }
  }
  if (!width || !height) return null;
  return { width, height, unit: "pixels", source: "svg-metadata" };
}

function parsePdf(buffer) {
  if (
    buffer.length < 5 ||
    buffer.subarray(0, 5).toString("ascii") !== "%PDF-"
  ) {
    return null;
  }
  const text = buffer.subarray(0, 1_048_576).toString("latin1");
  const mediaBox = text.match(
    /\/MediaBox\s*\[\s*(-?[0-9.]+)\s+(-?[0-9.]+)\s+(-?[0-9.]+)\s+(-?[0-9.]+)\s*\]/u
  );
  const pageMatches = text.match(/\/Type\s*\/Page\b/gu);
  if (!mediaBox) {
    return pageMatches
      ? { pages: pageMatches.length, unit: "points", source: "pdf-objects" }
      : null;
  }
  return {
    width: Math.abs(Number(mediaBox[3]) - Number(mediaBox[1])),
    height: Math.abs(Number(mediaBox[4]) - Number(mediaBox[2])),
    pages: pageMatches?.length,
    unit: "points",
    source: "pdf-mediabox"
  };
}

export function inspectBufferDimensions(buffer, extension = "") {
  const ext = extension.toLowerCase();
  if (ext === ".png") return parsePng(buffer);
  if (ext === ".gif") return parseGif(buffer);
  if (ext === ".jpg" || ext === ".jpeg") return parseJpeg(buffer);
  if (ext === ".webp") return parseWebp(buffer);
  if (ext === ".svg") return parseSvg(buffer);
  if (ext === ".pdf") return parsePdf(buffer);
  return null;
}

function inspectWithAvailableTool(filePath, extension, runner = spawnSync) {
  if (extension === ".pdf") {
    const result = runner("pdfinfo", [filePath], {
      encoding: "utf8",
      timeout: 10_000
    });
    if (result.status === 0) {
      const size = result.stdout.match(
        /Page size:\s*([0-9.]+)\s+x\s+([0-9.]+)\s+pts/iu
      );
      const pages = result.stdout.match(/Pages:\s*([0-9]+)/iu);
      if (size || pages) {
        return {
          width: size ? Number(size[1]) : undefined,
          height: size ? Number(size[2]) : undefined,
          pages: pages ? Number(pages[1]) : undefined,
          unit: "points",
          source: "pdfinfo"
        };
      }
    }
    return null;
  }

  const sips = runner(
    "sips",
    ["-g", "pixelWidth", "-g", "pixelHeight", filePath],
    { encoding: "utf8", timeout: 10_000 }
  );
  if (sips.status === 0) {
    const width = sips.stdout.match(/pixelWidth:\s*([0-9.]+)/iu);
    const height = sips.stdout.match(/pixelHeight:\s*([0-9.]+)/iu);
    if (width && height) {
      return {
        width: Number(width[1]),
        height: Number(height[1]),
        unit: "pixels",
        source: "sips"
      };
    }
  }

  const identify = runner("identify", ["-format", "%w %h", filePath], {
    encoding: "utf8",
    timeout: 10_000
  });
  if (identify.status === 0) {
    const match = identify.stdout.trim().match(/^([0-9.]+)\s+([0-9.]+)/u);
    if (match) {
      return {
        width: Number(match[1]),
        height: Number(match[2]),
        unit: "pixels",
        source: "imagemagick-identify"
      };
    }
  }
  return null;
}

export function detectMediaType(buffer) {
  if (parsePng(buffer)) return "image/png";
  if (parseGif(buffer)) return "image/gif";
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (parseSvg(buffer)) return "image/svg+xml";
  if (
    buffer.length >= 5 &&
    buffer.subarray(0, 5).toString("ascii") === "%PDF-"
  ) {
    return "application/pdf";
  }
  return null;
}

export function assertContract(contract) {
  const errors = [];
  if (!isObject(contract)) errors.push("contract must be a JSON object");
  if (typeof contract?.id !== "string" || !contract.id.trim()) {
    errors.push("contract.id must be a non-empty string");
  }
  if (!Array.isArray(contract?.requiredEvidence)) {
    errors.push("contract.requiredEvidence must be an array");
  } else {
    for (const [index, requirement] of contract.requiredEvidence.entries()) {
      if (!isObject(requirement) || typeof requirement.kind !== "string") {
        errors.push(
          `contract.requiredEvidence[${index}].kind must be a string`
        );
      }
      if (
        !Number.isInteger(requirement?.minCount) ||
        requirement.minCount < 1
      ) {
        errors.push(
          `contract.requiredEvidence[${index}].minCount must be a positive integer`
        );
      }
    }
  }
  if (!isObject(contract?.checks))
    errors.push("contract.checks must be an object");
  if (
    !Array.isArray(contract?.completionCriteria) ||
    !contract.completionCriteria.length
  ) {
    errors.push("contract.completionCriteria must be a non-empty array");
  }
  if (errors.length)
    throw new Error(`Invalid quality contract: ${errors.join("; ")}`);
  return contract;
}

function makeRecorder() {
  const checks = [];
  return {
    checks,
    check(id, passed, message, { artifactId, severity = "error" } = {}) {
      checks.push({
        id,
        passed: Boolean(passed),
        severity,
        ...(artifactId ? { artifactId } : {}),
        message
      });
      return Boolean(passed);
    }
  };
}

function duplicates(values) {
  return [
    ...new Set(values.filter((value, index) => values.indexOf(value) !== index))
  ];
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  if (
    new Set(left).size !== left.length ||
    new Set(right).size !== right.length
  ) {
    return false;
  }
  const expected = new Set(right);
  return left.every(
    (value) => typeof value === "string" && expected.has(value)
  );
}

async function inspectArtifact({
  artifact,
  index,
  workspaceReal,
  contract,
  recorder,
  forceDimensions,
  toolRunner
}) {
  const key = `artifact[${index}]`;
  const artifactId =
    typeof artifact?.id === "string" ? artifact.id : `${key}:invalid`;
  const result = {
    id: artifactId,
    kind: artifact?.kind,
    path: artifact?.path,
    derivedFrom: artifact?.derivedFrom,
    passed: false
  };
  const startCheckIndex = recorder.checks.length;

  const idValid =
    typeof artifact?.id === "string" &&
    /^[a-z0-9][a-z0-9._-]*$/iu.test(artifact.id);
  recorder.check(
    `${key}.id`,
    idValid,
    idValid
      ? "Artifact ID is valid."
      : "Artifact ID must be shell-safe and non-empty.",
    {
      artifactId
    }
  );
  const kindValid =
    typeof artifact?.kind === "string" && artifact.kind.trim().length > 0;
  recorder.check(
    `${key}.kind`,
    kindValid,
    kindValid ? "Artifact kind is present." : "Artifact kind is required.",
    {
      artifactId
    }
  );
  const pathValid =
    typeof artifact?.path === "string" && artifact.path.trim().length > 0;
  recorder.check(
    `${key}.path`,
    pathValid,
    pathValid ? "Artifact path is present." : "Artifact path is required.",
    {
      artifactId
    }
  );
  if (!pathValid) return result;

  const declaredPath = artifact.path.replaceAll("\\", "/");
  const candidate = resolve(workspaceReal, declaredPath);
  const lexicalSafe =
    !isAbsolute(declaredPath) && insideDirectory(workspaceReal, candidate);
  recorder.check(
    `${key}.workspace-boundary`,
    lexicalSafe,
    lexicalSafe
      ? "Artifact path is inside the workspace."
      : "Artifact path escapes the workspace.",
    { artifactId }
  );
  if (!lexicalSafe) return result;

  const extension = extname(declaredPath).toLowerCase();
  const allowed = contract.checks?.allowedExtensions?.[artifact.kind];
  const extensionAllowed =
    !Array.isArray(allowed) || allowed.includes(extension);
  recorder.check(
    `${key}.extension`,
    extensionAllowed,
    extensionAllowed
      ? `Extension ${extension || "(none)"} is allowed for ${artifact.kind}.`
      : `Extension ${extension || "(none)"} is not allowed for ${artifact.kind}.`,
    { artifactId }
  );

  let fileStats;
  let fileReal;
  try {
    [fileStats, fileReal] = await Promise.all([
      stat(candidate),
      realpath(candidate)
    ]);
  } catch (error) {
    recorder.check(
      `${key}.exists`,
      false,
      `Artifact cannot be read: ${error.code ?? error.message}.`,
      {
        artifactId
      }
    );
    return result;
  }
  recorder.check(`${key}.exists`, true, "Artifact exists.", { artifactId });
  const symlinkSafe = insideDirectory(workspaceReal, fileReal);
  recorder.check(
    `${key}.real-workspace-boundary`,
    symlinkSafe,
    symlinkSafe
      ? "Resolved artifact remains inside the workspace."
      : "Artifact resolves outside the workspace.",
    { artifactId }
  );
  const regularFile = fileStats.isFile();
  recorder.check(
    `${key}.regular-file`,
    regularFile,
    regularFile
      ? "Artifact is a regular file."
      : "Artifact is not a regular file.",
    {
      artifactId
    }
  );
  if (!symlinkSafe || !regularFile) return result;

  const minimumBytes =
    contract.checks?.minimumBytesByKind?.[artifact.kind] ??
    contract.checks?.minimumBytes ??
    1;
  const nonEmpty = contract.checks?.nonEmpty !== false;
  const sizeValid =
    (!nonEmpty || fileStats.size > 0) && fileStats.size >= minimumBytes;
  recorder.check(
    `${key}.size`,
    sizeValid,
    sizeValid
      ? `Artifact contains ${fileStats.size} bytes.`
      : `Artifact must contain at least ${minimumBytes} bytes.`,
    { artifactId }
  );

  let buffer;
  try {
    buffer = await readFile(candidate);
  } catch (error) {
    recorder.check(
      `${key}.read`,
      false,
      `Artifact read failed: ${error.code ?? error.message}.`,
      {
        artifactId
      }
    );
    return result;
  }
  result.bytes = fileStats.size;
  result.sha256 = fileDigest(buffer);
  result.extension = extension;
  result.realPath = fileReal;
  Object.defineProperty(result, "buffer", {
    value: buffer,
    enumerable: false
  });

  if (MEDIA_EXTENSIONS.has(extension)) {
    result.mediaType = detectMediaType(buffer);
    const expectedMediaTypes = MEDIA_TYPES_BY_EXTENSION[extension];
    const signatureMatchesExtension = Boolean(
      result.mediaType && expectedMediaTypes?.has(result.mediaType)
    );
    recorder.check(
      `${key}.media-signature`,
      signatureMatchesExtension,
      signatureMatchesExtension
        ? `Artifact signature ${result.mediaType} matches ${extension}.`
        : result.mediaType
          ? `Artifact extension ${extension} does not match detected type ${result.mediaType}.`
          : `Artifact does not have a valid ${extension} media signature.`,
      { artifactId }
    );
  }

  const dimensionRules = contract.checks?.dimensions ?? {};
  const requiredForDimensions = new Set(dimensionRules.requiredFor ?? []);
  const shouldInspect =
    forceDimensions ||
    dimensionRules.enabled ||
    requiredForDimensions.has(artifact.kind);
  if (shouldInspect && MEDIA_EXTENSIONS.has(extension)) {
    result.dimensions =
      inspectBufferDimensions(buffer, extension) ??
      inspectWithAvailableTool(candidate, extension, toolRunner);
    const dimensionsRequired = requiredForDimensions.has(artifact.kind);
    recorder.check(
      `${key}.dimensions`,
      Boolean(result.dimensions) || !dimensionsRequired,
      result.dimensions
        ? `Dimensions were inspected with ${result.dimensions.source}.`
        : dimensionsRequired
          ? "Required dimensions could not be inspected."
          : "Dimensions were unavailable but are optional for this artifact.",
      { artifactId, severity: dimensionsRequired ? "error" : "warning" }
    );

    const minimum = dimensionRules.minimumByKind?.[artifact.kind];
    if (minimum && result.dimensions?.unit === "pixels") {
      const widthValid = result.dimensions.width >= minimum.width;
      const heightValid = result.dimensions.height >= minimum.height;
      recorder.check(
        `${key}.minimum-dimensions`,
        widthValid && heightValid,
        widthValid && heightValid
          ? `Raster dimensions meet the ${minimum.width}x${minimum.height} minimum.`
          : `Raster dimensions must be at least ${minimum.width}x${minimum.height}; found ${result.dimensions.width}x${result.dimensions.height}.`,
        { artifactId }
      );
    } else if (minimum && result.dimensions?.unit === "points") {
      recorder.check(
        `${key}.minimum-dimensions`,
        true,
        "Raster pixel minimum does not apply to PDF dimensions measured in points.",
        { artifactId }
      );
    }
  }

  if (MEDIA_EXTENSIONS.has(extension) && result.mediaType) {
    const visual = inspectVisualSemantics({
      filePath: candidate,
      extension,
      kind: artifact.kind,
      dimensions: result.dimensions,
      rules: contract.checks?.visualInspection,
      runner: toolRunner
    });
    result.semanticMetrics = visual.metrics;
    for (const check of visual.checks) {
      recorder.check(`${key}.${check.id}`, check.passed, check.message, {
        artifactId,
        severity: check.severity
      });
    }
  }

  const artifactChecks = recorder.checks.slice(startCheckIndex);
  result.passed = artifactChecks.every(
    (check) => check.passed || check.severity === "warning"
  );
  return result;
}

export async function validateEvidence({
  workspace,
  manifest,
  contract,
  inspectDimensions = false,
  expectedTask,
  toolRunner = spawnSync,
  now = new Date()
}) {
  assertContract(contract);
  if (!isObject(manifest))
    throw new Error("Evidence manifest must be a JSON object.");
  const workspaceReal = await realpath(resolve(workspace));
  const workspaceStats = await stat(workspaceReal);
  if (!workspaceStats.isDirectory())
    throw new Error("Evidence workspace must be a directory.");

  const recorder = makeRecorder();
  recorder.check(
    "manifest.version",
    manifest.manifestVersion === 1,
    manifest.manifestVersion === 1
      ? "Manifest version is supported."
      : "manifestVersion must equal 1."
  );
  recorder.check(
    "manifest.agent",
    manifest.agent === contract.id,
    manifest.agent === contract.id
      ? `Manifest targets the ${contract.id} contract.`
      : `Manifest agent ${JSON.stringify(manifest.agent)} does not match contract ${contract.id}.`
  );
  recorder.check(
    "manifest.task",
    typeof manifest.task === "string" &&
      manifest.task.trim().length > 0 &&
      (expectedTask === undefined || manifest.task === expectedTask),
    typeof manifest.task === "string" &&
      manifest.task.trim().length > 0 &&
      (expectedTask === undefined || manifest.task === expectedTask)
      ? "Manifest identifies its task."
      : expectedTask === undefined
        ? "Manifest task is required."
        : "Manifest task does not match the expected managed-run task."
  );
  const fullCommitSha =
    typeof manifest.commitSha === "string" &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(manifest.commitSha);
  recorder.check(
    "manifest.commit-sha",
    fullCommitSha,
    fullCommitSha
      ? "Manifest is bound to a full Git object ID."
      : "Manifest commitSha must be a full 40- or 64-character hexadecimal Git object ID."
  );
  const artifactsDeclared = Array.isArray(manifest.artifacts);
  recorder.check(
    "manifest.artifacts",
    artifactsDeclared && manifest.artifacts.length > 0,
    artifactsDeclared && manifest.artifacts.length > 0
      ? `Manifest declares ${manifest.artifacts.length} artifact(s).`
      : "Manifest must declare at least one artifact."
  );
  const artifacts = artifactsDeclared ? manifest.artifacts : [];
  const ids = artifacts
    .map((artifact) => artifact?.id)
    .filter((id) => typeof id === "string");
  const duplicateIds = duplicates(ids);
  recorder.check(
    "manifest.unique-artifact-ids",
    duplicateIds.length === 0,
    duplicateIds.length === 0
      ? "Artifact IDs are unique."
      : `Duplicate artifact IDs: ${duplicateIds.join(", ")}.`
  );
  const normalizedPaths = artifacts
    .map((artifact) => artifact?.path)
    .filter((path) => typeof path === "string" && path.trim())
    .map((path) =>
      relative(
        workspaceReal,
        resolve(workspaceReal, path.replaceAll("\\", "/"))
      ).replaceAll("\\", "/")
    );
  const duplicatePaths = duplicates(normalizedPaths);
  recorder.check(
    "manifest.unique-artifact-paths",
    duplicatePaths.length === 0,
    duplicatePaths.length === 0
      ? "Artifact paths are unique after normalization."
      : `Duplicate artifact paths: ${duplicatePaths.join(", ")}.`
  );

  const taskRules = contract.checks?.taskBinding ?? {};
  const binding = isObject(manifest.taskBinding) ? manifest.taskBinding : null;
  const expectedTaskDigest = objectDigest({
    agent: manifest.agent,
    task: manifest.task,
    commitSha: manifest.commitSha
  });
  recorder.check(
    "task-binding.declaration",
    Boolean(binding) || !taskRules.required,
    binding
      ? "Manifest declares a task binding."
      : taskRules.required
        ? "This contract requires taskBinding."
        : "Task binding is optional for this contract."
  );
  if (binding) {
    recorder.check(
      "task-binding.digest",
      binding.sha256 === expectedTaskDigest,
      binding.sha256 === expectedTaskDigest
        ? "Task binding matches agent, exact task, and commit."
        : "taskBinding.sha256 does not match the manifest task identity."
    );
    recorder.check(
      "task-binding.artifacts",
      sameStringSet(binding.artifactIds, ids),
      sameStringSet(binding.artifactIds, ids)
        ? "Task binding names every artifact exactly once."
        : "taskBinding.artifactIds must exactly match all declared artifact IDs."
    );
  }

  const artifactResults = [];
  for (const [index, artifact] of artifacts.entries()) {
    artifactResults.push(
      await inspectArtifact({
        artifact,
        index,
        workspaceReal,
        contract,
        recorder,
        forceDimensions: inspectDimensions,
        toolRunner
      })
    );
  }

  const resolvedPaths = artifactResults
    .map((artifact) => artifact.realPath)
    .filter((path) => typeof path === "string");
  const duplicateResolvedPaths = duplicates(resolvedPaths);
  recorder.check(
    "manifest.unique-resolved-artifact-paths",
    duplicateResolvedPaths.length === 0,
    duplicateResolvedPaths.length === 0
      ? "Resolved artifact files are unique."
      : "Multiple artifact declarations resolve to the same file."
  );

  for (const requirement of contract.requiredEvidence) {
    const validCount = artifactResults.filter(
      (artifact) => artifact.kind === requirement.kind && artifact.passed
    ).length;
    recorder.check(
      `contract.required-evidence.${requirement.kind}`,
      validCount >= requirement.minCount,
      validCount >= requirement.minCount
        ? `${validCount} valid ${requirement.kind} artifact(s) satisfy the minimum of ${requirement.minCount}.`
        : `${requirement.kind} requires ${requirement.minCount} valid artifact(s); found ${validCount}.`
    );
  }

  const provenanceRules = contract.checks?.provenance?.requiredByKind ?? {};
  const artifactById = new Map(
    artifactResults.map((artifact) => [artifact.id, artifact])
  );
  for (const [kind, requiredKinds] of Object.entries(provenanceRules)) {
    for (const artifact of artifactResults.filter(
      (item) => item.kind === kind
    )) {
      const derivedFrom = Array.isArray(artifact.derivedFrom)
        ? artifact.derivedFrom
        : [];
      const references = derivedFrom.map((id) => artifactById.get(id));
      const unknown = derivedFrom.filter((id) => !artifactById.has(id));
      const referenceKinds = new Set(
        references.filter(Boolean).map((reference) => reference.kind)
      );
      const missingKinds = requiredKinds.filter(
        (requiredKind) => !referenceKinds.has(requiredKind)
      );
      const provenanceValid =
        derivedFrom.length > 0 &&
        new Set(derivedFrom).size === derivedFrom.length &&
        !derivedFrom.includes(artifact.id) &&
        unknown.length === 0 &&
        missingKinds.length === 0;
      recorder.check(
        `provenance.${artifact.id}`,
        provenanceValid,
        provenanceValid
          ? `${artifact.id} is bound to the required upstream evidence.`
          : `${artifact.id} provenance is invalid; unknown IDs: ${unknown.join(", ") || "none"}; missing kinds: ${missingKinds.join(", ") || "none"}.`,
        { artifactId: artifact.id }
      );
    }
  }

  const researchInspection = inspectResearchSemantics({
    artifacts: artifactResults,
    rules: contract.checks?.researchSemantics
  });
  for (const check of researchInspection.checks) {
    recorder.check(check.id, check.passed, check.message, {
      severity: check.severity
    });
  }
  const brandInspection = inspectBrandReviewSemantics({
    artifacts: artifactResults,
    rules: contract.checks?.brandReview
  });
  for (const check of brandInspection.checks) {
    recorder.check(check.id, check.passed, check.message, {
      severity: check.severity
    });
  }

  const contactRules = contract.checks?.contactSheet ?? {};
  const presentKinds = new Set(artifacts.map((artifact) => artifact?.kind));
  const conditionallyRequired = (
    contactRules.requiredWhenKindsPresent ?? []
  ).some((kind) => presentKinds.has(kind));
  const contactRequired = Boolean(
    contactRules.required || conditionallyRequired
  );
  const contact = isObject(manifest.contactSheet)
    ? manifest.contactSheet
    : null;
  recorder.check(
    "contact-sheet.declaration",
    Boolean(contact) || !contactRequired,
    contact
      ? "Contact-sheet coverage is declared."
      : contactRequired
        ? "This contract requires a contactSheet declaration."
        : "This contract does not require a contact sheet."
  );

  let contactSummary = null;
  if (contact) {
    const sheet = artifactResults.find(
      (artifact) => artifact.id === contact.artifactId
    );
    const sheetValid = Boolean(
      sheet && sheet.kind === "contact-sheet" && sheet.passed
    );
    recorder.check(
      "contact-sheet.artifact",
      sheetValid,
      sheetValid
        ? "Contact sheet references a valid contact-sheet artifact."
        : "contactSheet.artifactId must reference a valid contact-sheet artifact."
    );
    const covers = Array.isArray(contact.covers) ? contact.covers : [];
    const uniqueCovers = [...new Set(covers)];
    recorder.check(
      "contact-sheet.unique-coverage",
      uniqueCovers.length === covers.length,
      uniqueCovers.length === covers.length
        ? "Contact-sheet coverage IDs are unique."
        : "Contact-sheet coverage contains duplicate artifact IDs."
    );
    const knownIds = new Set(artifactResults.map((artifact) => artifact.id));
    const unknownCovers = uniqueCovers.filter((id) => !knownIds.has(id));
    recorder.check(
      "contact-sheet.known-coverage",
      unknownCovers.length === 0,
      unknownCovers.length === 0
        ? "Every coverage ID references a declared artifact."
        : `Unknown coverage artifact IDs: ${unknownCovers.join(", ")}.`
    );
    const coverageKinds = new Set(contactRules.coverageKinds ?? []);
    const requiredIds = artifactResults
      .filter((artifact) => coverageKinds.has(artifact.kind))
      .map((artifact) => artifact.id);
    const missingIds = requiredIds.filter((id) => !uniqueCovers.includes(id));
    const extraIds = uniqueCovers.filter((id) => !requiredIds.includes(id));
    recorder.check(
      "contact-sheet.complete-coverage",
      missingIds.length === 0 && extraIds.length === 0,
      missingIds.length === 0 && extraIds.length === 0
        ? `Contact sheet covers exactly all ${requiredIds.length} required artifact(s).`
        : `Contact-sheet coverage mismatch; missing: ${missingIds.join(", ") || "none"}; extra: ${extraIds.join(", ") || "none"}.`
    );
    recorder.check(
      "contact-sheet.no-self-coverage",
      !uniqueCovers.includes(contact.artifactId),
      !uniqueCovers.includes(contact.artifactId)
        ? "Contact sheet does not claim to cover itself."
        : "Contact sheet may not list itself in covers."
    );

    const entries = Array.isArray(contact.entries) ? contact.entries : [];
    const verifiedEntries = requiredIds.map((artifactId) => ({
      artifactId,
      sha256: artifactById.get(artifactId)?.sha256
    }));
    if (contactRules.cryptographicEntries) {
      const entryIds = entries
        .map((entry) => entry?.artifactId)
        .filter((id) => typeof id === "string");
      recorder.check(
        "contact-sheet.entry-coverage",
        entries.length === 0 || sameStringSet(entryIds, requiredIds),
        entries.length === 0
          ? "Validator generated cryptographic entries for exact render coverage."
          : sameStringSet(entryIds, requiredIds)
            ? "Contact-sheet entries exactly match required render coverage."
            : "contactSheet.entries must name every required render exactly once and no other artifact."
      );
      const invalidEntries = entries.filter((entry) => {
        const artifact = artifactById.get(entry?.artifactId);
        return !artifact || artifact.sha256 !== entry?.sha256;
      });
      recorder.check(
        "contact-sheet.entry-digests",
        invalidEntries.length === 0,
        invalidEntries.length === 0
          ? "Every contact-sheet entry is cryptographically bound to its render."
          : `${invalidEntries.length} contact-sheet entry digest(s) failed validation.`
      );
    }
    contactSummary = {
      artifactId: contact.artifactId,
      covers: uniqueCovers,
      requiredArtifactIds: requiredIds,
      missingArtifactIds: missingIds,
      extraArtifactIds: extraIds,
      entries: verifiedEntries
    };
  }

  const errors = recorder.checks.filter(
    (check) => !check.passed && check.severity === "error"
  );
  const warnings = recorder.checks.filter(
    (check) => !check.passed && check.severity === "warning"
  );
  return {
    evidenceVersion: 1,
    generatedAt: now.toISOString(),
    passed: errors.length === 0,
    workspace: workspaceReal,
    manifest: {
      agent: manifest.agent,
      task: manifest.task,
      commitSha: manifest.commitSha,
      artifactCount: artifacts.length,
      sha256: objectDigest(manifest)
    },
    contract: {
      id: contract.id,
      version: contract.version,
      sha256: objectDigest(contract),
      completionCriteria: contract.completionCriteria
    },
    summary: {
      checkedArtifacts: artifactResults.length,
      validArtifacts: artifactResults.filter((artifact) => artifact.passed)
        .length,
      failedChecks: errors.length,
      warnings: warnings.length
    },
    artifacts: artifactResults,
    contactSheet: contactSummary,
    semantic: {
      research: researchInspection.summary
    },
    checks: recorder.checks,
    errors: errors.map((check) => check.message),
    warnings: warnings.map((check) => check.message)
  };
}
