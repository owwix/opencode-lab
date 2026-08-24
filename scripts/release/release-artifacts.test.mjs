import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertSignedTag,
  sha256,
  writeChecksums
} from "./release-artifacts.mjs";

test("release tags must be exact versions and structurally signed", () => {
  assert.equal(
    assertSignedTag("v0.1.0-beta.1", () => ({
      status: 0,
      stdout: "object deadbeef\ntype commit\n-----BEGIN SSH SIGNATURE-----\n"
    })),
    true
  );
  assert.throws(
    () => assertSignedTag("latest", () => ({ status: 0, stdout: "" })),
    /invalid/u
  );
  assert.throws(
    () =>
      assertSignedTag("v0.1.0", () => ({
        status: 0,
        stdout: "object deadbeef\ntype commit\n"
      })),
    /not signed/u
  );
});

test("release checksums are complete, sorted, and omit their own file", () => {
  const output = mkdtempSync(join(tmpdir(), "lab-release-checksums-"));
  writeFileSync(join(output, "z.txt"), "z\n");
  writeFileSync(join(output, "a.txt"), "a\n");
  const result = writeChecksums(output);
  assert.deepEqual(result.files, ["a.txt", "z.txt"]);
  assert.equal(sha256(join(output, "a.txt")).length, 64);
  assert.deepEqual(writeChecksums(output).files, ["a.txt", "z.txt"]);
  rmSync(output, { recursive: true, force: true });
});

test("tag releases are signed, pinned, attested, checksummed, and migration-aware", () => {
  const root = process.cwd();
  const workflow = readFileSync(
    join(root, ".github/workflows/release.yml"),
    "utf8"
  );
  const migrations = JSON.parse(
    readFileSync(join(root, "migrations/manifest.json"), "utf8")
  );
  assert.match(workflow, /verify-tag --tag/u);
  assert.match(workflow, /SHA256SUMS|checksums --out/u);
  assert.match(workflow, /sbom=true/u);
  assert.match(workflow, /provenance=mode=max/u);
  assert.match(workflow, /actions\/attest-build-provenance@[a-f0-9]{40}/u);
  assert.doesNotMatch(workflow, /uses:\s*[^\s]+@(v\d+|main|master)\b/u);
  assert.equal(migrations.releases[0].version, "0.1.0-beta.1");
  assert.ok(migrations.releases[0].migrations.length >= 2);
});
