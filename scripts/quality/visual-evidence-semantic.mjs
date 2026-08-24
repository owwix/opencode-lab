import { spawnSync } from "node:child_process";

function runTool(runner, command, args) {
  const result = runner(command, args, {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024
  });
  return {
    command,
    available: result?.error?.code !== "ENOENT",
    succeeded: result?.status === 0,
    stdout:
      typeof result?.stdout === "string"
        ? result.stdout
        : Buffer.isBuffer(result?.stdout)
          ? result.stdout.toString("utf8")
          : "",
    stderr:
      typeof result?.stderr === "string"
        ? result.stderr
        : Buffer.isBuffer(result?.stderr)
          ? result.stderr.toString("utf8")
          : ""
  };
}

function firstSuccessful(runner, attempts) {
  let available = false;
  for (const [command, args] of attempts) {
    const result = runTool(runner, command, args);
    available ||= result.available;
    if (result.succeeded) return { ...result, anyToolAvailable: true };
  }
  return { succeeded: false, anyToolAvailable: available };
}

function parseImageStatistics(stdout) {
  const values = Object.fromEntries(
    stdout
      .trim()
      .split(";")
      .map((part) => part.split("=", 2).map((value) => value.trim()))
      .filter(([key, value]) => key && value)
  );
  const metrics = {
    mean: Number(values.mean),
    standardDeviation: Number(values.standardDeviation),
    minimum: Number(values.minimum),
    maximum: Number(values.maximum)
  };
  if (Object.values(metrics).some((value) => !Number.isFinite(value))) {
    return null;
  }
  metrics.dynamicRange = metrics.maximum - metrics.minimum;
  return metrics;
}

function inspectImageStatistics(filePath, runner) {
  const format =
    "mean=%[fx:mean];standardDeviation=%[fx:standard_deviation];" +
    "minimum=%[fx:minima];maximum=%[fx:maxima]";
  const args = [
    filePath,
    "-alpha",
    "off",
    "-colorspace",
    "Gray",
    "-format",
    format,
    "info:"
  ];
  const result = firstSuccessful(runner, [
    ["magick", args],
    ["convert", args]
  ]);
  return {
    available: result.anyToolAvailable,
    metrics: result.succeeded ? parseImageStatistics(result.stdout) : null,
    source: result.succeeded ? result.command : null
  };
}

function decodeXml(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function parsePdfWords(stdout) {
  const pages = [...stdout.matchAll(/<page\b([^>]*)>([\s\S]*?)<\/page>/giu)];
  const words = [];
  for (const page of pages) {
    const width = Number(page[1].match(/\bwidth="([0-9.]+)"/iu)?.[1]);
    const height = Number(page[1].match(/\bheight="([0-9.]+)"/iu)?.[1]);
    for (const word of page[2].matchAll(
      /<word\b([^>]*)>([\s\S]*?)<\/word>/giu
    )) {
      words.push({
        text: decodeXml(word[2].replace(/<[^>]*>/gu, "").trim()),
        left: Number(word[1].match(/\bxMin="(-?[0-9.]+)"/iu)?.[1]),
        top: Number(word[1].match(/\byMin="(-?[0-9.]+)"/iu)?.[1]),
        right: Number(word[1].match(/\bxMax="(-?[0-9.]+)"/iu)?.[1]),
        bottom: Number(word[1].match(/\byMax="(-?[0-9.]+)"/iu)?.[1]),
        width,
        height
      });
    }
  }
  return words.filter(
    (word) =>
      word.text &&
      [
        word.left,
        word.top,
        word.right,
        word.bottom,
        word.width,
        word.height
      ].every(Number.isFinite)
  );
}

function parseTesseractWords(stdout, dimensions) {
  const lines = stdout.trim().split(/\r?\n/u);
  if (lines.length < 2) return [];
  const headings = lines[0].split("\t");
  const indexes = Object.fromEntries(
    headings.map((heading, index) => [heading, index])
  );
  return lines
    .slice(1)
    .map((line) => line.split("\t"))
    .filter((fields) => fields[indexes.text]?.trim())
    .map((fields) => {
      const left = Number(fields[indexes.left]);
      const top = Number(fields[indexes.top]);
      const width = Number(fields[indexes.width]);
      const height = Number(fields[indexes.height]);
      return {
        text: fields[indexes.text].trim(),
        left,
        top,
        right: left + width,
        bottom: top + height,
        width: dimensions?.width,
        height: dimensions?.height
      };
    })
    .filter((word) =>
      [word.left, word.top, word.right, word.bottom].every(Number.isFinite)
    );
}

function inspectWords(filePath, extension, dimensions, runner) {
  if (extension === ".pdf") {
    const result = runTool(runner, "pdftotext", [
      "-bbox-layout",
      filePath,
      "-"
    ]);
    return {
      available: result.available,
      words: result.succeeded ? parsePdfWords(result.stdout) : null,
      source: result.succeeded ? "pdftotext" : null
    };
  }
  const result = runTool(runner, "tesseract", [filePath, "stdout", "tsv"]);
  return {
    available: result.available,
    words: result.succeeded
      ? parseTesseractWords(result.stdout, dimensions)
      : null,
    source: result.succeeded ? "tesseract" : null
  };
}

function unavailableCheck(id, label, required) {
  return {
    id,
    passed: false,
    severity: required ? "error" : "warning",
    message: `${label} could not run because no compatible local inspection tool produced results.`
  };
}

export function inspectVisualSemantics({
  filePath,
  extension,
  kind,
  dimensions,
  rules,
  runner = spawnSync
}) {
  const checks = [];
  const metrics = {};
  const raster = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
  const enabledKinds = new Set(rules?.kinds ?? []);
  if (!rules?.enabled || !enabledKinds.has(kind)) return { checks, metrics };

  const pixelRules = rules.pixelStatistics ?? {};
  if (pixelRules.enabled && raster.has(extension)) {
    const inspection = inspectImageStatistics(filePath, runner);
    if (!inspection.metrics) {
      checks.push(
        unavailableCheck(
          "visual.pixel-statistics",
          "Blank/contrast inspection",
          pixelRules.required === true
        )
      );
    } else {
      metrics.pixelStatistics = {
        ...inspection.metrics,
        source: inspection.source
      };
      const standardDeviationValid =
        inspection.metrics.standardDeviation >=
        (pixelRules.minimumStandardDeviation ?? 0);
      const dynamicRangeValid =
        inspection.metrics.dynamicRange >=
        (pixelRules.minimumDynamicRange ?? 0);
      checks.push({
        id: "visual.not-blank",
        passed: standardDeviationValid,
        severity: "error",
        message: standardDeviationValid
          ? `Pixel variation ${inspection.metrics.standardDeviation.toFixed(4)} is above the blank threshold.`
          : `Render appears blank or nearly blank; pixel variation is ${inspection.metrics.standardDeviation.toFixed(4)}.`
      });
      checks.push({
        id: "visual.contrast-range",
        passed: dynamicRangeValid,
        severity: "error",
        message: dynamicRangeValid
          ? `Dynamic range ${inspection.metrics.dynamicRange.toFixed(4)} meets the contrast floor.`
          : `Dynamic range ${inspection.metrics.dynamicRange.toFixed(4)} is below the configured contrast floor.`
      });
    }
  } else if (pixelRules.enabled && extension === ".pdf") {
    checks.push({
      id: "visual.pixel-statistics",
      passed: false,
      severity: "warning",
      message:
        "PDF pixel statistics require a rendered-page artifact; OCR still inspects the PDF directly."
    });
  }

  const ocrRules = rules.ocr ?? {};
  const ocrKinds = new Set(ocrRules.kinds ?? rules.kinds ?? []);
  if (ocrRules.enabled && ocrKinds.has(kind)) {
    const inspection = inspectWords(filePath, extension, dimensions, runner);
    if (!inspection.words) {
      checks.push(
        unavailableCheck(
          "visual.ocr",
          "OCR/overflow inspection",
          ocrRules.required === true
        )
      );
    } else {
      const characters = inspection.words
        .map((word) => word.text)
        .join("")
        .replace(/\s+/gu, "").length;
      const minimumCharacters = ocrRules.minimumCharacters ?? 0;
      const textPresent = characters >= minimumCharacters;
      checks.push({
        id: "visual.ocr-text",
        passed: textPresent,
        severity: "error",
        message: textPresent
          ? `OCR found ${characters} non-whitespace character(s).`
          : `OCR found ${characters} character(s); at least ${minimumCharacters} are required.`
      });
      const margin = ocrRules.overflowMargin ?? 0;
      const overflowing = inspection.words.filter(
        (word) =>
          Number.isFinite(word.width) &&
          Number.isFinite(word.height) &&
          (word.left < margin ||
            word.top < margin ||
            word.right > word.width - margin ||
            word.bottom > word.height - margin)
      );
      checks.push({
        id: "visual.ocr-overflow",
        passed: overflowing.length === 0,
        severity: "error",
        message:
          overflowing.length === 0
            ? `OCR bounds remain inside the ${margin}-unit safe edge.`
            : `${overflowing.length} OCR word box(es) touch or cross the configured safe edge.`
      });
      metrics.ocr = {
        characters,
        words: inspection.words.length,
        overflowingWords: overflowing.length,
        source: inspection.source
      };
    }
  }
  return { checks, metrics };
}

function parseStructured(buffer, extension) {
  const text = buffer.toString("utf8").trim();
  if (extension === ".json") return JSON.parse(text);
  if (extension === ".jsonl") {
    return text
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  throw new Error("semantic research ledgers must use .json or .jsonl");
}

function listFrom(value, key) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value[key])) {
    return value[key];
  }
  return [];
}

export function inspectBrandReviewSemantics({ artifacts, rules }) {
  const checks = [];
  if (!rules?.enabled) return { checks };
  const renders = new Map(
    artifacts
      .filter((artifact) => artifact.kind === "render")
      .map((artifact) => [artifact.id, artifact])
  );
  const reviews = artifacts.filter((artifact) => artifact.kind === "review");
  const covered = new Set();
  for (const reviewArtifact of reviews) {
    const renderIds = (reviewArtifact.derivedFrom ?? []).filter((id) =>
      renders.has(id)
    );
    const render = renderIds.length === 1 ? renders.get(renderIds[0]) : null;
    let review;
    try {
      review = JSON.parse(reviewArtifact.buffer.toString("utf8"));
    } catch {
      review = null;
    }
    const scoreNames = [
      "brandSpecificity",
      "messageClarity",
      "brandConsistency",
      "composition",
      "productAccuracy",
      "mobileReadability"
    ];
    const scores = scoreNames.map((name) => review?.scores?.[name]);
    const average = scores.every(Number.isInteger)
      ? scores.reduce((sum, value) => sum + value, 0) / scores.length
      : 0;
    const valid = Boolean(
      render &&
      review?.schemaVersion === 1 &&
      review?.reviewerModel ===
        (rules.reviewerModel ?? "@cf/moonshotai/kimi-k2.6") &&
      review?.imageSha256 === render.sha256 &&
      review?.verdict === "pass" &&
      scores.every(
        (value) => value >= (rules.minimumScore ?? 3) && value <= 5
      ) &&
      average >= (rules.minimumAverage ?? 4) &&
      Number.isInteger(review?.scores?.genericAiRisk) &&
      review.scores.genericAiRisk <= (rules.maximumGenericAiRisk ?? 2) &&
      !(review?.defects ?? []).some((defect) => defect?.severity === "critical")
    );
    if (valid) covered.add(render.id);
    checks.push({
      id: `brand.review.${reviewArtifact.id}`,
      passed: valid,
      severity: "error",
      message: valid
        ? `${reviewArtifact.id} is an independent passing pixel review bound to ${render.id}.`
        : `${reviewArtifact.id} is missing a passing independent review, required scores, or the exact render digest.`
    });
  }
  const missing = [...renders.keys()].filter((id) => !covered.has(id));
  checks.push({
    id: "brand.review-coverage",
    passed: missing.length === 0,
    severity: "error",
    message:
      missing.length === 0
        ? "Every final render has a passing independent pixel review."
        : `Final renders without a passing review: ${missing.join(", ")}.`
  });
  return { checks };
}

export function inspectResearchSemantics({ artifacts, rules }) {
  const checks = [];
  const summary = {};
  if (!rules?.enabled) return { checks, summary };
  const sourceArtifact = artifacts.find(
    (artifact) => artifact.kind === "sources"
  );
  const traceArtifact = artifacts.find(
    (artifact) => artifact.kind === "traceability"
  );
  const synthesisArtifacts = artifacts.filter(
    (artifact) => artifact.kind === "synthesis"
  );
  let sources = [];
  let claims = [];
  try {
    sources = listFrom(
      parseStructured(
        sourceArtifact?.buffer ?? Buffer.alloc(0),
        sourceArtifact?.extension
      ),
      "sources"
    );
    checks.push({
      id: "research.sources-structured",
      passed: sources.length >= (rules.minimumSources ?? 1),
      severity: "error",
      message: `Parsed ${sources.length} structured source record(s).`
    });
  } catch (error) {
    checks.push({
      id: "research.sources-structured",
      passed: false,
      severity: "error",
      message: `Source ledger could not be validated: ${error.message}.`
    });
  }
  try {
    claims = listFrom(
      parseStructured(
        traceArtifact?.buffer ?? Buffer.alloc(0),
        traceArtifact?.extension
      ),
      "claims"
    );
    checks.push({
      id: "research.claims-structured",
      passed: claims.length >= (rules.minimumClaims ?? 1),
      severity: "error",
      message: `Parsed ${claims.length} structured claim record(s).`
    });
  } catch (error) {
    checks.push({
      id: "research.claims-structured",
      passed: false,
      severity: "error",
      message: `Traceability ledger could not be validated: ${error.message}.`
    });
  }

  const sourceIds = sources
    .map((source) => source?.id)
    .filter((id) => typeof id === "string" && id.trim());
  const uniqueSourceIds = new Set(sourceIds);
  checks.push({
    id: "research.unique-source-ids",
    passed: uniqueSourceIds.size === sourceIds.length,
    severity: "error",
    message:
      uniqueSourceIds.size === sourceIds.length
        ? "Source IDs are unique."
        : "Source IDs contain duplicates."
  });
  const validSources = sources.filter(
    (source) =>
      source &&
      typeof source.id === "string" &&
      typeof source.title === "string" &&
      /^https?:\/\//iu.test(source.url ?? "") &&
      ["primary", "secondary", "commentary"].includes(source.type)
  );
  checks.push({
    id: "research.source-records",
    passed: validSources.length === sources.length && sources.length > 0,
    severity: "error",
    message: `${validSources.length}/${sources.length} source record(s) have ID, title, stable URL, and evidence type.`
  });
  if (rules.requirePrimarySource) {
    const primaryCount = sources.filter(
      (source) => source?.type === "primary"
    ).length;
    checks.push({
      id: "research.primary-source",
      passed: primaryCount > 0,
      severity: "error",
      message: `${primaryCount} primary source record(s) found.`
    });
  }

  const claimIds = claims
    .map((claim) => claim?.id)
    .filter((id) => typeof id === "string" && id.trim());
  checks.push({
    id: "research.unique-claim-ids",
    passed: new Set(claimIds).size === claimIds.length,
    severity: "error",
    message: "Claim IDs must be unique."
  });
  const invalidClaims = claims.filter((claim) => {
    const references = Array.isArray(claim?.sourceIds) ? claim.sourceIds : [];
    return (
      typeof claim?.id !== "string" ||
      typeof claim?.text !== "string" ||
      !["fact", "inference"].includes(claim?.type) ||
      references.length === 0 ||
      references.some((id) => !uniqueSourceIds.has(id)) ||
      (claim.type === "inference" && claim.confidence === undefined)
    );
  });
  checks.push({
    id: "research.claim-traceability",
    passed: claims.length > 0 && invalidClaims.length === 0,
    severity: "error",
    message:
      invalidClaims.length === 0
        ? "Every claim maps to known sources and every inference states confidence."
        : `${invalidClaims.length} claim record(s) are untraceable or incompletely labeled.`
  });

  if (rules.requireClaimIdsInSynthesis) {
    const synthesis = synthesisArtifacts
      .map((artifact) => artifact.buffer?.toString("utf8") ?? "")
      .join("\n");
    const missing = claimIds.filter((id) => !synthesis.includes(id));
    checks.push({
      id: "research.synthesis-claim-links",
      passed: missing.length === 0 && claimIds.length > 0,
      severity: "error",
      message:
        missing.length === 0
          ? "Every structured claim ID appears in the synthesis."
          : `Synthesis does not reference claim ID(s): ${missing.join(", ")}.`
    });
  }
  summary.sources = sources.length;
  summary.claims = claims.length;
  summary.primarySources = sources.filter(
    (source) => source?.type === "primary"
  ).length;
  return { checks, summary };
}
