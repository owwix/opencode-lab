import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertContract,
  detectMediaType,
  inspectBufferDimensions,
  objectDigest,
  validateEvidence
} from "./visual-evidence-lib.mjs";
import {
  parseArtifactSpec,
  parseCliArgs,
  parseDerivationSpec
} from "./visual-evidence.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../..");
const CONTRACT_ROOT = resolve(REPO_ROOT, "quality/contracts");

function pngHeader(width, height, minimumBytes = 64) {
  const buffer = Buffer.alloc(Math.max(minimumBytes, 24));
  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer, 0);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

const FULL_SHA = "abcdef0123456789abcdef0123456789abcdef01";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function bindManifest(manifest) {
  return {
    ...manifest,
    taskBinding: {
      sha256: objectDigest({
        agent: manifest.agent,
        task: manifest.task,
        commitSha: manifest.commitSha
      }),
      artifactIds: manifest.artifacts.map((artifact) => artifact.id)
    }
  };
}

function passingVisualTool(command) {
  if (command === "magick") {
    return {
      status: 0,
      stdout: "mean=0.5;standardDeviation=0.2;minimum=0.05;maximum=0.95",
      stderr: ""
    };
  }
  if (command === "tesseract") {
    return {
      status: 0,
      stdout:
        "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n" +
        "5\t1\t1\t1\t1\t1\t100\t100\t200\t50\t99\tVisual quality\n",
      stderr: ""
    };
  }
  return { status: null, stdout: "", stderr: "", error: { code: "ENOENT" } };
}

async function loadContract(id) {
  return JSON.parse(
    await readFile(resolve(CONTRACT_ROOT, `${id}.json`), "utf8")
  );
}

function visualFixtureContract({ brandReview = false } = {}) {
  return {
    id: "visual",
    version: 1,
    description: "Generic visual evidence contract used by core tests.",
    requiredEvidence: brandReview
      ? [
          { kind: "brief", minCount: 1 },
          { kind: "composition", minCount: 1 },
          { kind: "render", minCount: 1 },
          { kind: "review", minCount: 1 }
        ]
      : [
          { kind: "source", minCount: 1 },
          { kind: "render", minCount: 1 }
        ],
    checks: {
      taskBinding: { required: true },
      nonEmpty: true,
      minimumBytes: 1,
      allowedExtensions: {
        source: [".pptx"],
        render: [".png"],
        brief: [".md"],
        composition: [".json"],
        review: [".json"],
        "contact-sheet": [".png"]
      },
      dimensions: {
        enabled: true,
        requiredFor: ["render", "contact-sheet"],
        minimumByKind: {
          render: { width: 100, height: 100 },
          "contact-sheet": { width: 100, height: 100 }
        }
      },
      contactSheet: {
        required: true,
        requiredWhenKindsPresent: ["render"],
        coverageKinds: ["render"]
      },
      visualInspection: {
        enabled: true,
        kinds: ["render", "contact-sheet"],
        pixelStatistics: { enabled: true, required: false },
        ocr: { enabled: true, required: false, kinds: ["render"] }
      },
      ...(brandReview
        ? {
            brandReview: {
              enabled: true,
              reviewerModel: "@cf/moonshotai/kimi-k2.6",
              minimumScore: 3,
              minimumAverage: 4,
              maximumGenericAiRisk: 2
            }
          }
        : {})
    },
    completionCriteria: ["Every render is represented by verified evidence."]
  };
}

async function withWorkspace(run) {
  const workspace = await mkdtemp(join(tmpdir(), "visual-evidence-test-"));
  try {
    return await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test("all predictable agent contracts have the controller-facing fields", async () => {
  for (const id of ["coding", "research"]) {
    const contract = await loadContract(id);
    assert.equal(contract.id, id);
    assert.ok(Array.isArray(contract.requiredEvidence));
    assert.ok(contract.checks);
    assert.ok(Array.isArray(contract.completionCriteria));
    assert.doesNotThrow(() => assertContract(contract));
  }
});

test("native image and PDF metadata parsers return dimensions", () => {
  const png = pngHeader(1920, 1080);
  assert.equal(detectMediaType(png), "image/png");
  assert.deepEqual(inspectBufferDimensions(png, ".png"), {
    width: 1920,
    height: 1080,
    unit: "pixels",
    source: "png-header"
  });

  const pdf = Buffer.from(
    "%PDF-1.7\n1 0 obj << /Type /Page /MediaBox [0 0 612 792] >> endobj\n%%EOF",
    "latin1"
  );
  assert.deepEqual(inspectBufferDimensions(pdf, ".pdf"), {
    width: 612,
    height: 792,
    pages: 1,
    unit: "points",
    source: "pdf-mediabox"
  });
});

test("stable object digests do not depend on object key insertion order", () => {
  assert.equal(
    objectDigest({ alpha: 1, beta: { x: 2, y: 3 } }),
    objectDigest({ beta: { y: 3, x: 2 }, alpha: 1 })
  );
});

test("visual evidence passes with valid source, render, and complete contact sheet", async () => {
  await withWorkspace(async (workspace) => {
    const slide = pngHeader(1920, 1080);
    const contactSheet = pngHeader(1600, 900);
    await writeFile(join(workspace, "presentation.pptx"), Buffer.alloc(32, 1));
    await writeFile(join(workspace, "slide-01.png"), slide);
    await writeFile(join(workspace, "contact-sheet.png"), contactSheet);
    const manifest = bindManifest({
      manifestVersion: 1,
      agent: "visual",
      task: "Refresh presentation",
      commitSha: FULL_SHA,
      artifacts: [
        {
          id: "presentation-source",
          kind: "source",
          path: "presentation.pptx"
        },
        {
          id: "slide-01",
          kind: "render",
          path: "slide-01.png",
          derivedFrom: ["presentation-source"]
        },
        { id: "overview", kind: "contact-sheet", path: "contact-sheet.png" }
      ],
      contactSheet: {
        artifactId: "overview",
        covers: ["slide-01"],
        entries: [{ artifactId: "slide-01", sha256: sha256(slide) }]
      }
    });
    const evidence = await validateEvidence({
      workspace,
      manifest,
      contract: visualFixtureContract(),
      expectedTask: "Refresh presentation",
      toolRunner: passingVisualTool,
      now: new Date("2026-08-18T00:00:00.000Z")
    });
    assert.equal(evidence.passed, true, JSON.stringify(evidence.errors));
    assert.deepEqual(evidence.summary, {
      checkedArtifacts: 3,
      validArtifacts: 3,
      failedChecks: 0,
      warnings: 0
    });
    assert.deepEqual(evidence.contactSheet.missingArtifactIds, []);
    assert.equal(evidence.artifacts[1].dimensions.width, 1920);
    assert.match(evidence.artifacts[1].sha256, /^[a-f0-9]{64}$/u);
  });
});

test("contact sheets fail when they omit a rendered artifact", async () => {
  await withWorkspace(async (workspace) => {
    const slideOne = pngHeader(1920, 1080);
    const slideTwo = pngHeader(1920, 1080);
    await writeFile(join(workspace, "presentation.pptx"), Buffer.alloc(32, 1));
    await writeFile(join(workspace, "slide-01.png"), slideOne);
    await writeFile(join(workspace, "slide-02.png"), slideTwo);
    await writeFile(join(workspace, "contact-sheet.png"), pngHeader(1600, 900));
    const evidence = await validateEvidence({
      workspace,
      contract: visualFixtureContract(),
      toolRunner: passingVisualTool,
      manifest: bindManifest({
        manifestVersion: 1,
        agent: "visual",
        task: "Refresh presentation",
        commitSha: FULL_SHA,
        artifacts: [
          { id: "source", kind: "source", path: "presentation.pptx" },
          {
            id: "slide-01",
            kind: "render",
            path: "slide-01.png",
            derivedFrom: ["source"]
          },
          {
            id: "slide-02",
            kind: "render",
            path: "slide-02.png",
            derivedFrom: ["source"]
          },
          { id: "overview", kind: "contact-sheet", path: "contact-sheet.png" }
        ],
        contactSheet: {
          artifactId: "overview",
          covers: ["slide-01"],
          entries: [{ artifactId: "slide-01", sha256: sha256(slideOne) }]
        }
      })
    });
    assert.equal(evidence.passed, false);
    assert.deepEqual(evidence.contactSheet.missingArtifactIds, ["slide-02"]);
    assert.ok(evidence.errors.some((message) => message.includes("slide-02")));
  });
});

test("artifact paths cannot escape lexically or through symbolic links", async (t) => {
  await withWorkspace(async (workspace) => {
    const outside = join(dirname(workspace), `${Date.now()}-outside.json`);
    await writeFile(outside, "{}", "utf8");
    try {
      await symlink(outside, join(workspace, "linked.json"));
    } catch (error) {
      if (error.code === "EPERM") {
        t.skip("Symbolic links are not available in this environment.");
        return;
      }
      throw error;
    }
    try {
      const contract = await loadContract("coding");
      const base = {
        manifestVersion: 1,
        agent: "coding",
        task: "Unsafe paths",
        commitSha: FULL_SHA
      };
      const escaped = await validateEvidence({
        workspace,
        contract,
        manifest: bindManifest({
          ...base,
          artifacts: [
            { id: "summary", kind: "change-summary", path: "../outside.md" },
            { id: "checks", kind: "verification", path: "linked.json" }
          ]
        })
      });
      assert.equal(escaped.passed, false);
      assert.ok(
        escaped.errors.some((message) =>
          message.includes("escapes the workspace")
        )
      );
      assert.ok(
        escaped.errors.some((message) => message.includes("resolves outside"))
      );
    } finally {
      await rm(outside, { force: true });
    }
  });
});

test("duplicate declared and resolved artifact paths are rejected", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, "evidence.txt"), "shared evidence", "utf8");
    const manifest = bindManifest({
      manifestVersion: 1,
      agent: "coding",
      task: "Reject duplicate files",
      commitSha: FULL_SHA,
      artifacts: [
        { id: "summary", kind: "change-summary", path: "evidence.txt" },
        { id: "checks", kind: "verification", path: "./evidence.txt" }
      ]
    });
    const evidence = await validateEvidence({
      workspace,
      manifest,
      contract: await loadContract("coding")
    });
    assert.equal(evidence.passed, false);
    assert.ok(
      evidence.checks.some(
        (check) =>
          check.id === "manifest.unique-artifact-paths" && !check.passed
      )
    );
    assert.ok(
      evidence.checks.some(
        (check) =>
          check.id === "manifest.unique-resolved-artifact-paths" &&
          !check.passed
      )
    );
  });
});

test("media signatures must match their declared extensions", async () => {
  await withWorkspace(async (workspace) => {
    const jpegInPng = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    await writeFile(join(workspace, "fake.png"), jpegInPng);
    const contract = {
      id: "media-test",
      version: 1,
      requiredEvidence: [{ kind: "render", minCount: 1 }],
      checks: {
        nonEmpty: true,
        allowedExtensions: { render: [".png"] },
        dimensions: { enabled: false, requiredFor: [], minimumByKind: {} },
        contactSheet: {
          required: false,
          requiredWhenKindsPresent: [],
          coverageKinds: []
        }
      },
      completionCriteria: ["Signature matches extension."]
    };
    const manifest = {
      manifestVersion: 1,
      agent: "media-test",
      task: "Check signature",
      commitSha: FULL_SHA,
      artifacts: [{ id: "render", kind: "render", path: "fake.png" }]
    };
    const evidence = await validateEvidence({ workspace, manifest, contract });
    assert.equal(evidence.passed, false);
    assert.ok(
      evidence.errors.some((message) => message.includes("does not match"))
    );
  });
});

test("task binding covers exact task identity and every artifact", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, "summary.md"), "Implemented task.", "utf8");
    await writeFile(join(workspace, "checks.json"), '{"passed":true}', "utf8");
    const manifest = bindManifest({
      manifestVersion: 1,
      agent: "coding",
      task: "Original task",
      commitSha: FULL_SHA,
      artifacts: [
        { id: "summary", kind: "change-summary", path: "summary.md" },
        { id: "checks", kind: "verification", path: "checks.json" }
      ]
    });
    manifest.task = "Substituted task";
    const evidence = await validateEvidence({
      workspace,
      manifest,
      expectedTask: "Original task",
      contract: await loadContract("coding")
    });
    assert.equal(evidence.passed, false);
    assert.ok(
      evidence.checks.some(
        (check) => check.id === "task-binding.digest" && !check.passed
      )
    );
    assert.ok(
      evidence.checks.some(
        (check) => check.id === "manifest.task" && !check.passed
      )
    );
  });
});

test("visual semantic checks reject blank renders and OCR overflow", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, "render.png"), pngHeader(1000, 600));
    const toolRunner = (command) => {
      if (command === "magick") {
        return {
          status: 0,
          stdout: "mean=0.99;standardDeviation=0.0001;minimum=0.98;maximum=1.0",
          stderr: ""
        };
      }
      if (command === "tesseract") {
        return {
          status: 0,
          stdout:
            "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n" +
            "5\t1\t1\t1\t1\t1\t950\t100\t100\t40\t99\tOverflow\n",
          stderr: ""
        };
      }
      return {
        status: null,
        stdout: "",
        stderr: "",
        error: { code: "ENOENT" }
      };
    };
    const contract = {
      id: "visual-test",
      version: 1,
      requiredEvidence: [{ kind: "render", minCount: 1 }],
      checks: {
        nonEmpty: true,
        allowedExtensions: { render: [".png"] },
        dimensions: {
          enabled: true,
          requiredFor: ["render"],
          minimumByKind: { render: { width: 960, height: 540 } }
        },
        contactSheet: {
          required: false,
          requiredWhenKindsPresent: [],
          coverageKinds: []
        },
        visualInspection: {
          enabled: true,
          kinds: ["render"],
          pixelStatistics: {
            enabled: true,
            required: false,
            minimumStandardDeviation: 0.01,
            minimumDynamicRange: 0.15
          },
          ocr: {
            enabled: true,
            required: false,
            kinds: ["render"],
            minimumCharacters: 4,
            overflowMargin: 0
          }
        }
      },
      completionCriteria: ["Render is inspectable."]
    };
    const evidence = await validateEvidence({
      workspace,
      toolRunner,
      contract,
      manifest: {
        manifestVersion: 1,
        agent: "visual-test",
        task: "Inspect render",
        commitSha: FULL_SHA,
        artifacts: [{ id: "render", kind: "render", path: "render.png" }]
      }
    });
    assert.equal(evidence.passed, false);
    assert.ok(
      evidence.checks.some(
        (check) => check.id.endsWith("visual.not-blank") && !check.passed
      )
    );
    assert.ok(
      evidence.checks.some(
        (check) => check.id.endsWith("visual.ocr-overflow") && !check.passed
      )
    );
  });
});

test("optional visual tools fail gracefully with explicit warnings", async () => {
  await withWorkspace(async (workspace) => {
    const render = pngHeader(1920, 1080);
    await writeFile(
      join(workspace, "brief.md"),
      "Audience and format brief.",
      "utf8"
    );
    await writeFile(
      join(workspace, "composition.json"),
      '{"headline":"Launch"}'
    );
    await writeFile(join(workspace, "render.png"), render);
    await writeFile(join(workspace, "sheet.png"), pngHeader(1200, 800));
    await writeFile(
      join(workspace, "review.json"),
      JSON.stringify({
        schemaVersion: 1,
        reviewerModel: "@cf/moonshotai/kimi-k2.6",
        imageSha256: sha256(render),
        verdict: "pass",
        scores: {
          brandSpecificity: 4,
          messageClarity: 5,
          brandConsistency: 4,
          composition: 4,
          productAccuracy: 4,
          mobileReadability: 4,
          genericAiRisk: 1
        },
        defects: []
      })
    );
    const manifest = bindManifest({
      manifestVersion: 1,
      agent: "visual",
      task: "Create launch art",
      commitSha: FULL_SHA,
      artifacts: [
        { id: "brief", kind: "brief", path: "brief.md" },
        {
          id: "composition",
          kind: "composition",
          path: "composition.json"
        },
        {
          id: "render",
          kind: "render",
          path: "render.png",
          derivedFrom: ["brief", "composition"]
        },
        {
          id: "review",
          kind: "review",
          path: "review.json",
          derivedFrom: ["render"]
        },
        { id: "sheet", kind: "contact-sheet", path: "sheet.png" }
      ],
      contactSheet: {
        artifactId: "sheet",
        covers: ["render"],
        entries: [{ artifactId: "render", sha256: sha256(render) }]
      }
    });
    const evidence = await validateEvidence({
      workspace,
      manifest,
      contract: visualFixtureContract({ brandReview: true }),
      toolRunner: () => ({
        status: null,
        stdout: "",
        stderr: "",
        error: { code: "ENOENT" }
      })
    });
    assert.equal(evidence.passed, true, JSON.stringify(evidence.errors));
    assert.ok(evidence.warnings.length >= 1);
    assert.ok(
      evidence.warnings.every((message) => message.includes("inspection tool"))
    );
  });
});

test("brand evidence rejects reviews that are not bound to the final pixels", async () => {
  await withWorkspace(async (workspace) => {
    const render = pngHeader(1080, 1350);
    await writeFile(join(workspace, "brief.md"), "Approved brief");
    await writeFile(join(workspace, "composition.json"), "{}");
    await writeFile(join(workspace, "render.png"), render);
    await writeFile(join(workspace, "sheet.png"), pngHeader(1200, 800));
    await writeFile(
      join(workspace, "review.json"),
      JSON.stringify({
        schemaVersion: 1,
        reviewerModel: "@cf/moonshotai/kimi-k2.6",
        imageSha256: "0".repeat(64),
        verdict: "pass",
        scores: {
          brandSpecificity: 5,
          messageClarity: 5,
          brandConsistency: 5,
          composition: 5,
          productAccuracy: 5,
          mobileReadability: 5,
          genericAiRisk: 1
        },
        defects: []
      })
    );
    const manifest = bindManifest({
      manifestVersion: 1,
      agent: "visual",
      task: "Create campaign",
      commitSha: FULL_SHA,
      artifacts: [
        { id: "brief", kind: "brief", path: "brief.md" },
        { id: "composition", kind: "composition", path: "composition.json" },
        {
          id: "render",
          kind: "render",
          path: "render.png",
          derivedFrom: ["brief", "composition"]
        },
        {
          id: "review",
          kind: "review",
          path: "review.json",
          derivedFrom: ["render"]
        },
        { id: "sheet", kind: "contact-sheet", path: "sheet.png" }
      ],
      contactSheet: {
        artifactId: "sheet",
        covers: ["render"],
        entries: [{ artifactId: "render", sha256: sha256(render) }]
      }
    });
    const evidence = await validateEvidence({
      workspace,
      manifest,
      contract: visualFixtureContract({ brandReview: true }),
      toolRunner: () => ({
        status: null,
        stdout: "",
        stderr: "",
        error: { code: "ENOENT" }
      })
    });
    assert.equal(evidence.passed, false);
    assert.ok(
      evidence.errors.some((message) => message.includes("exact render digest"))
    );
  });
});

test("research semantics enforce primary sources and claim traceability", async () => {
  await withWorkspace(async (workspace) => {
    const synthesis =
      "# Findings\n\nC1 is sourced. C2 is explicitly an inference.\n";
    const sources = {
      sources: [
        {
          id: "S1",
          title: "Primary documentation",
          url: "https://example.com/primary",
          type: "primary"
        }
      ]
    };
    const traceability = {
      claims: [
        { id: "C1", text: "Documented fact", type: "fact", sourceIds: ["S1"] },
        {
          id: "C2",
          text: "Reasoned implication",
          type: "inference",
          confidence: "medium",
          sourceIds: ["S1"]
        }
      ]
    };
    await writeFile(join(workspace, "synthesis.md"), synthesis, "utf8");
    await writeFile(
      join(workspace, "sources.json"),
      JSON.stringify(sources),
      "utf8"
    );
    await writeFile(
      join(workspace, "claims.json"),
      JSON.stringify(traceability),
      "utf8"
    );
    const manifest = bindManifest({
      manifestVersion: 1,
      agent: "research",
      task: "Trace research",
      commitSha: FULL_SHA,
      artifacts: [
        {
          id: "synthesis",
          kind: "synthesis",
          path: "synthesis.md",
          derivedFrom: ["sources", "claims"]
        },
        { id: "sources", kind: "sources", path: "sources.json" },
        { id: "claims", kind: "traceability", path: "claims.json" }
      ]
    });
    const contract = await loadContract("research");
    const passing = await validateEvidence({ workspace, manifest, contract });
    assert.equal(passing.passed, true, JSON.stringify(passing.errors));
    assert.deepEqual(passing.semantic.research, {
      sources: 1,
      claims: 2,
      primarySources: 1
    });

    traceability.claims[1].sourceIds = ["missing"];
    delete traceability.claims[1].confidence;
    await writeFile(
      join(workspace, "claims.json"),
      JSON.stringify(traceability),
      "utf8"
    );
    const failing = await validateEvidence({ workspace, manifest, contract });
    assert.equal(failing.passed, false);
    assert.ok(
      failing.checks.some(
        (check) => check.id === "research.claim-traceability" && !check.passed
      )
    );
  });
});

test("CLI parsing supports repeatable inline artifacts", () => {
  assert.deepEqual(parseArtifactSpec("output-pdf=render:out/report.pdf", 0), {
    id: "output-pdf",
    kind: "render",
    path: "out/report.pdf"
  });
  assert.deepEqual(
    parseCliArgs([
      "--workspace",
      ".",
      "--agent",
      "coding",
      "--artifact",
      "summary=change-summary:summary.md",
      "--artifact",
      "checks=verification:checks.json"
    ]).artifacts,
    ["summary=change-summary:summary.md", "checks=verification:checks.json"]
  );
  assert.deepEqual(parseDerivationSpec("page-01=presentation-source"), {
    child: "page-01",
    parent: "presentation-source"
  });
});

test("CLI emits passing JSON evidence and writes the requested output", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(
      join(workspace, "summary.md"),
      "Implemented the bounded change.",
      "utf8"
    );
    await writeFile(join(workspace, "checks.json"), '{"passed":true}', "utf8");
    const output = join(workspace, "evidence.json");
    const result = spawnSync(
      process.execPath,
      [
        resolve(TEST_DIR, "visual-evidence.mjs"),
        "--workspace",
        workspace,
        "--agent",
        "coding",
        "--task",
        "Implement bounded change",
        "--commit-sha",
        FULL_SHA,
        "--artifact",
        "summary=change-summary:summary.md",
        "--artifact",
        "checks=verification:checks.json",
        "--output",
        output,
        "--compact"
      ],
      { encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const stdout = JSON.parse(result.stdout);
    const written = JSON.parse(await readFile(output, "utf8"));
    assert.equal(stdout.passed, true);
    assert.equal(written.manifest.sha256, stdout.manifest.sha256);
  });
});
