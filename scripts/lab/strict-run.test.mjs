import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { launchStrictRun } from "./strict-run.mjs";

function fixture({ signingKey = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "strict-run-source-"));
  execFileSync("git", ["init", "-b", "main", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  execFileSync("git", [
    "-C",
    root,
    "config",
    "user.email",
    "test@example.invalid"
  ]);
  writeFileSync(join(root, "README.md"), "test\n");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "commit", "-m", "base"]);
  const envDirectory = mkdtempSync(join(tmpdir(), "strict-run-env-"));
  const envFile = join(envDirectory, "strict.env");
  writeFileSync(
    envFile,
    `STRICT_GATEWAY_URL=https://gateway.example.test\nAGENT_GATEWAY_SIGNING_KEY=${signingKey ? "test-signing-key-with-sufficient-length" : ""}\n`
  );
  return { root, envFile };
}

test("strict run creates an isolated clone sandbox with a scoped lease", () => {
  const { root, envFile } = fixture();
  const stateRoot = mkdtempSync(join(tmpdir(), "strict-run-state-"));
  const calls = [];
  const native = (command, args, options = {}) =>
    execFileSync(command, args, { cwd: options.cwd, encoding: "utf8" }).trim();
  const runner = (command, args, options = {}) => {
    if (command === "git") return native(command, args, options);
    calls.push({ command, args: [...args], stdio: options.stdio });
    if (args[0] === "exec" && args[2] === "pwd") return "/workspace";
    return "";
  };
  const result = launchStrictRun({
    workspace: root,
    envFile,
    stateRoot,
    runner,
    doctor: () => ({ ready: true }),
    interactive: false,
    now: new Date("2026-01-01T00:00:00.000Z"),
    uuid: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
  });
  assert.equal(result.mode, "clone");
  assert.equal(result.sharedSkills, false);
  assert.equal(result.status, "stopped");
  assert.equal(result.sandboxWorkspace, "/workspace");
  assert.deepEqual(calls[0].args.slice(0, 5), [
    "create",
    "--clone",
    "--no-share-skills",
    "--name",
    result.sandboxName
  ]);
  const runCall = calls.find(({ args }) => args[0] === "run");
  assert.ok(runCall.args.includes("--env-file"));
  assert.equal(
    runCall.args.some((value) => String(value).includes("test-signing-key")),
    false
  );
  const state = JSON.parse(readFileSync(result.statePath, "utf8"));
  assert.equal(state.credentials, "short-lived chat capability only");
  assert.equal(JSON.stringify(state).includes("test-signing-key"), false);
});

test("strict run creates its host-only signer without a prior normal launch", () => {
  const { root, envFile } = fixture({ signingKey: false });
  launchStrictRun({
    workspace: root,
    envFile,
    stateRoot: mkdtempSync(join(tmpdir(), "strict-run-state-")),
    runner(command, args, options = {}) {
      if (command === "git") {
        return execFileSync(command, args, {
          cwd: options.cwd,
          encoding: "utf8"
        }).trim();
      }
      if (args[0] === "exec" && args[2] === "pwd") return "/workspace";
      return "";
    },
    doctor: () => ({ ready: true }),
    interactive: false
  });
  const configured = readFileSync(envFile, "utf8").match(
    /^AGENT_GATEWAY_SIGNING_KEY=(.+)$/mu
  );
  assert.ok(configured);
  assert.equal(Buffer.byteLength(configured[1]) >= 32, true);
});

test("strict run refuses dirty source repositories before creating a sandbox", () => {
  const { root, envFile } = fixture();
  writeFileSync(join(root, "dirty.txt"), "dirty\n");
  assert.throws(
    () =>
      launchStrictRun({
        workspace: root,
        envFile,
        runner(command, args, options = {}) {
          if (command !== "git") throw new Error("sandbox must not start");
          return execFileSync(command, args, {
            cwd: options.cwd,
            encoding: "utf8"
          }).trim();
        },
        doctor: () => ({ ready: true })
      }),
    /clean source/u
  );
});
