import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

const lanes = [
  {
    agent: "fast",
    model: "cloudflare-ai/@cf/zai-org/glm-4.7-flash",
    label: "GLM-4.7 Flash"
  },
  {
    agent: "lab",
    model: "cloudflare-ai/@cf/openai/gpt-oss-120b",
    label: "GPT-OSS 120B"
  },
  {
    agent: "deep",
    model: "cloudflare-ai/@cf/moonshotai/kimi-k2.7-code",
    label: "Kimi K2.7 Code"
  }
];

test("ordinary prompts have explicit safe primary coding lanes", () => {
  for (const lane of lanes) {
    const profile = read(`.opencode/agents/${lane.agent}.md`);
    assert.match(profile, /mode: primary/u, lane.agent);
    assert.ok(profile.includes(`model: ${lane.model}`), lane.agent);
    assert.match(profile, /edit: allow/u, lane.agent);
    for (const denied of [
      "task",
      "external_directory",
      '"quality_*"',
      '"notion_*"',
      '"open-design_*"',
      '"hound_*"'
    ]) {
      assert.ok(
        profile.includes(`${denied}: deny`),
        `${lane.agent}: ${denied}`
      );
    }
    assert.match(profile, /AGENTS\.md/u, lane.agent);
    assert.match(profile, /safe-git\.mjs diff/u, lane.agent);
    assert.match(profile, /safe-remove\.mjs plan/u, lane.agent);
  }
});

test("Tab and command help describe fixed lanes without promising auto-switching", () => {
  const menu = read(".opencode/plugins/workflow-menu.tsx");
  const menuSource = `${menu}\n${read(".opencode/plugins/lab-ui-lib.mjs")}`;
  const guide = read("docs/lab/when-to-use-agents.md");
  for (const lane of lanes) {
    assert.match(menuSource, new RegExp(lane.agent, "u"), lane.agent);
    assert.match(
      menuSource,
      new RegExp(lane.label.replaceAll(".", "\\."), "u")
    );
    assert.match(guide, new RegExp(`\\*\\*${lane.agent}\\*\\*`, "u"));
  }
  assert.match(menu, /no automatic mid-turn\s+switch/u);
  assert.match(guide, /no automatic mid-turn model switch/u);
  assert.match(guide, /Managed[\s\S]*task router/u);
});
