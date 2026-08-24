import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PROJECT_CONTRACT_SCHEMA_URL,
  detectProjectContract,
  loadProjectContract,
  validateProjectContract,
  writeProjectContract
} from "./project-contract.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lab-project-contract-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  return { root, workspace };
}

function validContract(overrides = {}) {
  return {
    $schema: PROJECT_CONTRACT_SCHEMA_URL,
    schemaVersion: 1,
    install: [{ name: "npm", argv: ["npm", "ci"] }],
    verify: [{ name: "check", argv: ["npm", "run", "check"] }],
    development: [
      {
        name: "app",
        argv: ["npm", "run", "dev"],
        env: { HOST: "0.0.0.0", PORT: "3000" }
      }
    ],
    previewPorts: [{ name: "primary", container: 3000, host: 3100 }],
    artifactRoots: ["artifacts"],
    riskLevel: "standard",
    enabledPacks: ["example-pack"],
    ...overrides
  };
}

test("validates strict argv-based project contracts", () => {
  assert.deepEqual(validateProjectContract(validContract()), validContract());
  assert.throws(
    () => validateProjectContract({ ...validContract(), extra: true }),
    /unsupported field extra/u
  );
  assert.throws(
    () =>
      validateProjectContract({
        ...validContract(),
        verify: [{ name: "check", argv: "npm test" }]
      }),
    /argv must contain/u
  );
  assert.throws(
    () =>
      validateProjectContract({
        ...validContract(),
        development: [{ name: "app", argv: ["/bin/sh", "-c", "npm run dev"] }]
      }),
    /portable executable/u
  );
  assert.throws(
    () =>
      validateProjectContract({
        ...validContract(),
        development: [
          {
            name: "app",
            argv: ["npm", "run", "dev"],
            env: { API_TOKEN: "do-not-commit" }
          }
        ]
      }),
    /credential-shaped/u
  );
  assert.throws(
    () =>
      validateProjectContract({
        ...validContract(),
        artifactRoots: ["../outside"]
      }),
    /stay within the project/u
  );
  assert.throws(
    () =>
      validateProjectContract({
        ...validContract(),
        artifactRoots: ["C:outside"]
      }),
    /stay within the project/u
  );
  assert.throws(
    () =>
      validateProjectContract({
        ...validContract(),
        previewPorts: [{ name: "primary", container: 3000, host: 3101 }]
      }),
    /container 3000\/3001/u
  );
});

test("detects Node project commands, previews, artifacts, risk, and packs", () => {
  const state = fixture();
  try {
    writeFileSync(
      join(state.workspace, "package.json"),
      JSON.stringify({
        scripts: {
          check: "npm run lint && npm test",
          test: "node --test",
          dev: "vite"
        }
      })
    );
    writeFileSync(join(state.workspace, "package-lock.json"), "{}\n");
    mkdirSync(join(state.workspace, "artifacts"));
    mkdirSync(join(state.workspace, "auth"));
    const contract = detectProjectContract(state.workspace, {
      enabledPacks: ["example-pack"]
    });
    assert.deepEqual(contract.install, [{ name: "npm", argv: ["npm", "ci"] }]);
    assert.deepEqual(contract.verify, [
      { name: "check", argv: ["npm", "run", "check"] }
    ]);
    assert.deepEqual(contract.development[0].env, {
      HOST: "0.0.0.0",
      PORT: "3000"
    });
    assert.deepEqual(contract.previewPorts, [
      { name: "primary", container: 3000, host: 3100 }
    ]);
    assert.deepEqual(contract.artifactRoots, ["artifacts"]);
    assert.equal(contract.riskLevel, "high");
    assert.deepEqual(contract.enabledPacks, ["example-pack"]);
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test("mixed Node and Python detection keeps command names unique", () => {
  const state = fixture();
  try {
    writeFileSync(
      join(state.workspace, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } })
    );
    writeFileSync(join(state.workspace, "package-lock.json"), "{}\n");
    writeFileSync(join(state.workspace, "requirements.txt"), "pytest\n");
    mkdirSync(join(state.workspace, "tests"));
    const contract = detectProjectContract(state.workspace);
    assert.deepEqual(
      contract.install.map(({ name }) => name),
      ["npm", "python"]
    );
    assert.deepEqual(
      contract.verify.map(({ name }) => name),
      ["test", "python-test"]
    );
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test("init preview stays detected until an approved atomic write", () => {
  const state = fixture();
  try {
    const detected = loadProjectContract(state.workspace);
    assert.equal(detected.source, "detected");
    assert.equal(existsSync(detected.path), false);
    assert.throws(
      () => writeProjectContract(state.workspace, detected.contract),
      /requires approval/u
    );
    const written = writeProjectContract(state.workspace, detected.contract, {
      approved: true
    });
    assert.equal(existsSync(written.path), true);
    assert.deepEqual(
      JSON.parse(readFileSync(written.path, "utf8")),
      detected.contract
    );
    const declared = loadProjectContract(state.workspace);
    assert.equal(declared.source, "declared");
    assert.throws(
      () =>
        writeProjectContract(state.workspace, detected.contract, {
          approved: true
        }),
      /already exists/u
    );
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test("contract loading rejects symlinked configuration directories", () => {
  const state = fixture();
  try {
    const outside = join(state.root, "outside");
    mkdirSync(outside);
    writeFileSync(
      join(outside, "project.json"),
      JSON.stringify(validContract())
    );
    symlinkSync(outside, join(state.workspace, ".opencode-lab"));
    assert.throws(
      () => loadProjectContract(state.workspace),
      /must be a real directory/u
    );
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});
