import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  collectLaunchSnapshot,
  defaultProfileIsMinimal,
  readImageBuildDefinition,
  snapshotLines
} from "./launch-snapshot.mjs";
import { evaluateDoctorSnapshot } from "../agent-doctor.mjs";

const pin = "a".repeat(64);
const openDesignPin = "b".repeat(64);
const files = {
  "/tmp/lab/Dockerfile.opencode": [
    "FROM ghcr.io/nexu-io/od@sha256:" +
      openDesignPin +
      " AS open-design-runtime",
    "FROM ghcr.io/anomalyco/opencode@sha256:" + pin
  ].join("\n"),
  "/tmp/lab/docker-compose.opencode.yml": [
    "name: opencode-lab",
    "services:",
    "  open-design:",
    '    profiles: ["design"]',
    "    image: ghcr.io/nexu-io/od@sha256:" + openDesignPin,
    "  agent-gateway:",
    "    image: local",
    "  hound-firewall:",
    '    profiles: ["research"]',
    "  hound:",
    '    profiles: ["research"]',
    "  hound-relay:",
    '    profiles: ["research"]',
    "  opencode:",
    "    depends_on:",
    "      agent-gateway:",
    "        condition: service_healthy"
  ].join("\n")
};

function read(path) {
  if (!(path in files)) throw new Error(`missing fixture ${path}`);
  return files[path];
}

test("launch snapshot shares stable volume, profile, writable-runtime, and pin state", () => {
  const definition = readImageBuildDefinition({
    root: "/tmp/lab",
    readFile: read
  });
  const docker = (_command, args) => {
    if (args[0] === "version") return { ok: true, output: "28.1.0" };
    if (args[1] === "ls") {
      return {
        ok: true,
        output: [
          "opencode-lab-opencode-state",
          "opencode-lab-opencode-user-config",
          "cf-coding-agent_opencode-state",
          "unrelated-volume"
        ].join("\n")
      };
    }
    if (args[1] === "inspect") {
      return {
        ok: true,
        output: JSON.stringify([
          {
            Id: "sha256:local-image",
            Config: {
              Labels: {
                "io.opencode-lab.build-fingerprint": definition.fingerprint
              }
            }
          }
        ])
      };
    }
    throw new Error(`unexpected docker args: ${args.join(" ")}`);
  };
  const snapshot = collectLaunchSnapshot({
    root: "/tmp/lab",
    readFile: read,
    docker,
    exists: () => true,
    access: () => {}
  });
  assert.equal(snapshot.composeProject, "opencode-lab");
  assert.equal(snapshot.defaultProfile.ok, true);
  assert.equal(snapshot.runtimeConfig.writable, true);
  assert.equal(snapshot.image.matchesDockerfile, true);
  assert.equal(snapshot.image.openDesignPinMatchesCompose, true);
  assert.deepEqual(snapshot.volumes.legacy, ["cf-coding-agent_opencode-state"]);
  assert.match(snapshotLines(snapshot).join("\n"), /opencode-lab-\*/u);
});

test("doctor warns for a stale image but never builds it", () => {
  const source = readFileSync(
    new URL("../agent-doctor.mjs", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /docker\s+build/u);
  const report = evaluateDoctorSnapshot({
    nodeVersion: "v24.18.0",
    envFilePresent: true,
    docker: { ok: true },
    qualityService: "healthy",
    dirtyPathCount: 0,
    runs: [],
    deepSeekReviewerStatus: "eligible",
    launchSnapshot: {
      defaultProfile: { ok: true },
      runtimeConfig: { writable: true },
      image: { matchesDockerfile: false, openDesignPinMatchesCompose: true }
    }
  });
  assert.equal(report.healthy, true);
  assert.equal(
    report.checks.find((check) => check.id === "opencode-image").status,
    "warn"
  );
});

test("default profile rejects a Compose dependency on optional services", () => {
  const result = defaultProfileIsMinimal(
    [
      "\n  open-design:",
      '    profiles: ["design"]',
      "\n  hound-firewall:",
      '    profiles: ["research"]',
      "\n  hound:",
      '    profiles: ["research"]',
      "\n  hound-relay:",
      '    profiles: ["research"]',
      "\n  agent-gateway:",
      "\n  opencode:",
      "    depends_on:",
      "      hound:",
      "        condition: service_started"
    ].join("\n")
  );
  assert.equal(result.ok, false);
});
