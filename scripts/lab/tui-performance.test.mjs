import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";
import {
  createDebouncedTask,
  createSessionViewCache
} from "../../.opencode/plugins/session-view-cache.mjs";

const root = resolve(import.meta.dirname, "../..");

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function fixture() {
  const messages = [
    {
      id: "user-1",
      sessionID: "session-1",
      role: "user",
      agent: "lab"
    },
    {
      id: "assistant-1",
      sessionID: "session-1",
      role: "assistant",
      providerID: "cloudflare-ai",
      modelID: "@cf/openai/gpt-oss-120b",
      cost: 0.25,
      tokens: {
        input: 100,
        output: 20,
        reasoning: 5,
        cache: { read: 50, write: 10 }
      }
    }
  ];
  const parts = new Map([
    [
      "assistant-1",
      [
        { id: "text-1", messageID: "assistant-1", type: "text" },
        {
          id: "tool-1",
          sessionID: "session-1",
          messageID: "assistant-1",
          type: "tool",
          tool: "bash",
          state: { status: "completed", title: "npm test", output: "passed" }
        }
      ]
    ]
  ]);
  const reads = { messages: 0, parts: 0 };
  const api = {
    state: {
      session: {
        messages() {
          reads.messages += 1;
          return messages;
        },
        status() {
          return { type: "idle" };
        },
        permission() {
          return [];
        },
        todo() {
          return [];
        }
      },
      part(messageID) {
        reads.parts += 1;
        return parts.get(messageID) ?? [];
      }
    }
  };
  return { api, reads };
}

test("session view hydrates once and incrementally replaces message usage", () => {
  const { api, reads } = fixture();
  const cache = createSessionViewCache();
  const initial = cache.get(api, "session-1");
  assert.equal(initial.totals.requests, 1);
  assert.equal(initial.totals.input, 100);
  assert.equal(initial.totals.cacheRead, 50);
  assert.equal(initial.totals.cost, 0.25);
  assert.equal(initial.totals.costByLane.lab, 0.25);
  assert.equal(initial.toolParts.length, 1);

  cache.get(api, "session-1");
  assert.deepEqual(reads, { messages: 1, parts: 2 });

  cache.applyEvent({
    type: "message.updated",
    properties: {
      info: {
        id: "assistant-1",
        sessionID: "session-1",
        role: "assistant",
        modelID: "@cf/moonshotai/kimi-k2.7-code",
        cost: 0.5,
        tokens: {
          input: 140,
          output: 30,
          reasoning: 8,
          cache: { read: 80, write: 12 }
        }
      }
    }
  });
  const updated = cache.get(api, "session-1");
  assert.equal(updated.totals.requests, 1);
  assert.equal(updated.totals.input, 140);
  assert.equal(updated.totals.output, 30);
  assert.equal(updated.totals.cacheRead, 80);
  assert.equal(updated.totals.cost, 0.5);
  assert.equal(updated.totals.costByLane.lab, 0);
  assert.equal(updated.totals.costByLane.deep, 0.5);
  assert.deepEqual(reads, { messages: 1, parts: 2 });
});

test("session cache ignores streaming text while tracking tool transitions", () => {
  const { api } = fixture();
  const cache = createSessionViewCache();
  cache.get(api, "session-1");
  const text = cache.applyEvent({
    type: "message.part.updated",
    properties: {
      part: {
        id: "text-2",
        sessionID: "session-1",
        messageID: "assistant-1",
        type: "text",
        text: "streaming"
      }
    }
  });
  assert.equal(text.changed, false);
  assert.equal(cache.get(api, "session-1").toolParts.length, 1);

  const tool = cache.applyEvent({
    type: "message.part.updated",
    properties: {
      part: {
        id: "tool-2",
        sessionID: "session-1",
        messageID: "assistant-1",
        type: "tool",
        tool: "lsp",
        state: { status: "completed", title: "symbols", output: "passed" }
      }
    }
  });
  assert.equal(tool.changed, true);
  assert.equal(cache.get(api, "session-1").toolParts.length, 2);
});

test("debounced work coalesces bursts", async () => {
  let calls = 0;
  const task = createDebouncedTask(() => {
    calls += 1;
  }, 10);
  task.trigger();
  task.trigger();
  task.trigger();
  await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  assert.equal(calls, 1);
  task.cancel();
});

test("TUI plugins use event subscriptions rather than fixed polling", () => {
  const agentOps = read(".opencode/plugins/agent-ops.tsx");
  const cacheStats = read(".opencode/plugins/cache-stats.tsx");
  const runCenter = read(".opencode/plugins/run-center.tsx");
  assert.doesNotMatch(agentOps, /setInterval/u);
  assert.doesNotMatch(cacheStats, /session\.messages\([^)]*\).*for/su);
  assert.doesNotMatch(runCenter, /setInterval/u);
  assert.match(runCenter, /slashName: "runs"/u);
  assert.match(runCenter, /\/quality\/runs/u);
  assert.match(agentOps, /permission\.asked/u);
  assert.match(agentOps, /session\.status/u);
  assert.match(cacheStats, /subscribeSessionCache/u);
  assert.doesNotMatch(cacheStats, /latest\?\.providerID/u);
  assert.match(cacheStats, /costByLane\.fast/u);
  assert.match(cacheStats, /costByLane\.lab/u);
  assert.match(cacheStats, /costByLane\.deep/u);
});

test("workflow help renders only generic loaded-pack contributions", () => {
  const menu = read(".opencode/plugins/workflow-menu.tsx");
  assert.match(menu, /loadedPacks\(\)/u);
  assert.match(menu, /<b>Loaded packs<\/b>/u);
  assert.doesNotMatch(menu, /company-specific workflow/u);
  assert.match(
    menu,
    /Tab cannot start research or design\. Quit, then run lab --with-research/u
  );
});

test("common language servers are pinned and extension-scoped", () => {
  const config = JSON.parse(read("opencode.json"));
  assert.deepEqual(config.lsp.typescript.command, [
    "/usr/local/bin/typescript-language-server",
    "--stdio"
  ]);
  assert.ok(config.lsp.typescript.extensions.includes(".tsx"));
  assert.ok(config.lsp.typescript.extensions.includes(".mjs"));
  assert.deepEqual(config.lsp.pyright.extensions, [".py", ".pyi"]);
  assert.deepEqual(config.lsp.pyright.command, [
    "/usr/local/bin/pyright-langserver",
    "--stdio"
  ]);

  const dockerfile = read("Dockerfile.opencode");
  assert.match(dockerfile, /typescript-language-server@5\.3\.0/u);
  assert.match(dockerfile, /typescript@6\.0\.3/u);
  assert.match(dockerfile, /pyright@1\.1\.413/u);
  assert.match(dockerfile, /OPENCODE_EXPERIMENTAL_LSP_TOOL=true/u);
  assert.doesNotMatch(
    JSON.stringify(config.lsp),
    /(?:npx|npm|pnpm|yarn).*install/iu
  );
});
