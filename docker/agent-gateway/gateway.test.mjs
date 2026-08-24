import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_MODELS,
  createAgentGateway,
  isContextOverflowStatus,
  isGptOssSchemaError,
  isVertexThoughtSignatureError,
  LONG_CONTEXT_FALLBACK_MODEL,
  OPENAI_CHAT_MODELS,
  shouldFallbackGptOssToLongContext,
  shouldFallbackPayloadTooLarge,
  shouldRetryConcurrency,
  VERTEX_CHAT_MODELS
} from "./gateway.mjs";
import { createCapabilityLease } from "./capability-lease.mjs";

const gatewaySigningKey = "test-capability-signing-key-at-least-32-bytes"; // gitleaks:allow
const workspaceHash = "workspace_hash_1234567890";
const projectId = "project_1234567890";
const sessionId = "session_1234567890";
const runId = "run_1234567890";

function lease({
  routes = [
    "artifact",
    "browser-session",
    "browser-verify",
    "chat",
    "github-publish",
    "image",
    "notion-publish",
    "open-design",
    "openai-chat",
    "openpets",
    "quality",
    "vertex-chat"
  ],
  actions = [
    "artifact:download",
    "browser-session:control",
    "browser-verify:verify",
    "chat:invoke",
    "github-publish:pr",
    "github-publish:push",
    "github-publish:status",
    "image:generate",
    "notion-publish:publish",
    "open-design:mcp",
    "openai-chat:invoke",
    "openpets:react",
    "quality:mcp",
    "quality:operate",
    "quality:read",
    "vertex-chat:invoke"
  ]
} = {}) {
  return createCapabilityLease({
    key: gatewaySigningKey,
    workspaceHash,
    projectId,
    sessionId,
    runId,
    routes,
    actions
  });
}

const config = {
  gatewaySigningKey,
  expectedWorkspaceHash: workspaceHash,
  expectedProjectId: projectId,
  expectedSessionId: sessionId,
  expectedRunId: runId,
  gatewayToken: lease(),
  cloudflareAccountId: "account-id",
  cloudflareApiToken: "real-cloudflare-token",
  qualityMcpToken: "real-quality-token",
  qualityRegistrationToken: "quality-registration-token-123456",
  openDesignToken: "real-design-token"
};

test("allowlists the selected native Workers AI chat lanes", () => {
  for (const model of [
    "@cf/zai-org/glm-4.7-flash",
    "@cf/openai/gpt-oss-120b",
    "@cf/moonshotai/kimi-k2.7-code",
    "@cf/moonshotai/kimi-k2.6",
    "@cf/zai-org/glm-5.2"
  ]) {
    assert.equal(CHAT_MODELS.has(model), true, model);
  }
});

test("allowlists OpenAI chat through the credential gateway", async () => {
  assert.equal(OPENAI_CHAT_MODELS.has("gpt-5"), true);
  const calls = [];
  const server = createAgentGateway(
    { ...config, openaiApiKey: "real-openai-token" },
    {
      capabilities: ["openai-chat"],
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return Response.json({ choices: [{ message: { content: "ok" } }] });
      }
    }
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/openai/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.gatewayToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-5",
          messages: [{ role: "user", content: "hello" }]
        })
      }
    );
    assert.equal(response.status, 200);
    assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
    assert.equal(
      calls[0].options.headers.authorization,
      "Bearer real-openai-token"
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("allowlists Vertex Gemini chat through the credential gateway", async () => {
  assert.equal(VERTEX_CHAT_MODELS.has("gemini-3.1-pro-preview"), true);
  const calls = [];
  const server = createAgentGateway(
    {
      ...config,
      googleCloudProject: "light-result-504202-m9",
      googleAccessToken: "vertex-access-token"
    },
    {
      capabilities: ["vertex-chat"],
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return Response.json({ choices: [{ message: { content: "ok" } }] });
      }
    }
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/vertex/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.gatewayToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "gemini-3.1-pro-preview",
          messages: [{ role: "user", content: "hello" }]
        })
      }
    );
    assert.equal(response.status, 200);
    assert.equal(
      calls[0].url,
      "https://aiplatform.googleapis.com/v1/projects/light-result-504202-m9/locations/global/endpoints/openapi/chat/completions"
    );
    assert.equal(
      calls[0].options.headers.authorization,
      "Bearer vertex-access-token"
    );
    assert.equal(
      JSON.parse(calls[0].options.body.toString()).model,
      "google/gemini-3.1-pro-preview"
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("restores Gemini thought signatures stripped from OpenAI-compatible tool calls", async () => {
  const calls = [];
  const server = createAgentGateway(
    {
      ...config,
      googleCloudProject: "light-result-504202-m9",
      googleAccessToken: "vertex-access-token"
    },
    {
      capabilities: ["vertex-chat"],
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return Response.json({ choices: [{ message: { content: "ok" } }] });
      }
    }
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/vertex/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.gatewayToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "gemini-3.1-pro-preview",
          messages: [
            { role: "user", content: "implement this" },
            {
              role: "assistant",
              tool_calls: [
                {
                  id: "call-read",
                  type: "function",
                  function: {
                    name: "read",
                    arguments: '{"path":"src/bot/index.ts"}'
                  }
                }
              ]
            },
            {
              role: "tool",
              tool_call_id: "call-read",
              content: "export function start() {}"
            }
          ]
        })
      }
    );
    assert.equal(response.status, 200);
    const forwarded = JSON.parse(calls[0].options.body.toString());
    assert.equal(
      forwarded.messages[1].tool_calls[0].extra_content.google
        .thought_signature,
      "skip_thought_signature_validator"
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

async function withGateway(fetchImpl, callback) {
  const server = createAgentGateway(config, { fetchImpl });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("rejects missing local authentication before reaching an upstream", async () => {
  let calls = 0;
  await withGateway(
    async () => {
      calls += 1;
      return new Response();
    },
    async (origin) => {
      const response = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        body: "{}"
      });
      assert.equal(response.status, 401);
      assert.equal(calls, 0);
    }
  );
});

test("allowlists chat models, injects the real token, and streams output", async () => {
  const calls = [];
  await withGateway(
    async (url, options) => {
      calls.push({ url, options });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: first\n\n"));
            controller.enqueue(new TextEncoder().encode("data: second\n\n"));
            controller.close();
          }
        }),
        {
          headers: {
            "content-encoding": "gzip",
            "content-length": "999",
            "content-type": "text/event-stream"
          }
        }
      );
    },
    async (origin) => {
      const response = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.gatewayToken}`,
          "content-type": "application/json",
          "x-lab-request-id": "request-test-1",
          "x-lab-correlation-id": "trace-test-1",
          cookie: "must-not-cross"
        },
        body: JSON.stringify({
          model: "@cf/moonshotai/kimi-k2.7-code",
          stream: true,
          messages: [{ role: "user", content: "hello" }]
        })
      });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "data: first\n\ndata: second\n\n");
      assert.equal(response.headers.get("content-encoding"), null);
      assert.notEqual(response.headers.get("content-length"), "999");
      assert.equal(response.headers.get("x-lab-request-id"), "request-test-1");
      assert.equal(
        response.headers.get("x-lab-correlation-id"),
        "trace-test-1"
      );
      assert.equal(
        response.headers.get("x-lab-model"),
        "@cf/moonshotai/kimi-k2.7-code"
      );
      assert.match(response.headers.get("x-lab-duration-ms"), /^\d+$/u);
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/ai\/v1\/chat\/completions$/u);
      assert.equal(
        calls[0].options.headers.authorization,
        `Bearer ${config.cloudflareApiToken}`
      );
      assert.equal(calls[0].options.headers.cookie, undefined);
      assert.equal(
        calls[0].options.headers["x-lab-request-id"],
        "request-test-1"
      );
      assert.equal(
        calls[0].options.headers["x-lab-correlation-id"],
        "trace-test-1"
      );
    }
  );
});

test("retries GPT-OSS payload-too-large once on Kimi K2.6", async () => {
  assert.equal(
    shouldFallbackPayloadTooLarge(413, "@cf/openai/gpt-oss-120b", CHAT_MODELS),
    true
  );
  assert.equal(
    shouldFallbackPayloadTooLarge(200, "@cf/openai/gpt-oss-120b", CHAT_MODELS),
    false
  );
  assert.equal(
    isContextOverflowStatus(
      400,
      "Input length exceeds model's maximum context length"
    ),
    true
  );
  const calls = [];
  await withGateway(
    async (url, options) => {
      const body = JSON.parse(Buffer.from(options.body).toString());
      calls.push({ url, model: body.model });
      if (body.model === "@cf/openai/gpt-oss-120b") {
        return new Response(
          JSON.stringify({ error: { message: "Payload Too Large" } }),
          {
            status: 413,
            headers: { "content-type": "application/json" }
          }
        );
      }
      return Response.json({
        choices: [{ message: { role: "assistant", content: "fallback-ok" } }]
      });
    },
    async (origin) => {
      const response = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.gatewayToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "@cf/openai/gpt-oss-120b",
          messages: [{ role: "user", content: "continue a long session" }]
        })
      });
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("x-lab-model"),
        LONG_CONTEXT_FALLBACK_MODEL
      );
      assert.equal(
        response.headers.get("x-lab-fallback-from"),
        "@cf/openai/gpt-oss-120b"
      );
      assert.deepEqual(
        calls.map((call) => call.model),
        ["@cf/openai/gpt-oss-120b", LONG_CONTEXT_FALLBACK_MODEL]
      );
      const payload = await response.json();
      assert.equal(payload.choices[0].message.content, "fallback-ok");
    }
  );
});

test("retries GPT-OSS context-length 400 once on Kimi K2.6", async () => {
  const calls = [];
  await withGateway(
    async (_url, options) => {
      const body = JSON.parse(Buffer.from(options.body).toString());
      calls.push(body.model);
      if (body.model === "@cf/openai/gpt-oss-120b") {
        return new Response(
          JSON.stringify({
            error: {
              message:
                "Input length (200000) exceeds model's maximum context length (128000)"
            }
          }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }
      return Response.json({
        choices: [
          { message: { role: "assistant", content: "context-fallback-ok" } }
        ]
      });
    },
    async (origin) => {
      const response = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.gatewayToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "@cf/openai/gpt-oss-120b",
          messages: [{ role: "user", content: "huge thread" }]
        })
      });
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("x-lab-fallback-from"),
        "@cf/openai/gpt-oss-120b"
      );
      assert.deepEqual(calls, [
        "@cf/openai/gpt-oss-120b",
        LONG_CONTEXT_FALLBACK_MODEL
      ]);
    }
  );
});

test("retries GPT-OSS schema-shaped Bad Request once on Kimi K2.6", async () => {
  assert.equal(
    isGptOssSchemaError(400, "Invalid tool_call content parts in messages"),
    true
  );
  assert.equal(
    shouldFallbackGptOssToLongContext(
      400,
      "@cf/openai/gpt-oss-120b",
      "unsupported schema for tool_calls"
    ),
    true
  );
  assert.equal(
    shouldFallbackGptOssToLongContext(
      400,
      "@cf/openai/gpt-oss-120b",
      "plain bad request"
    ),
    false
  );
  assert.equal(
    shouldFallbackGptOssToLongContext(
      400,
      "@cf/openai/gpt-oss-120b",
      "Unauthorized: invalid api key"
    ),
    false
  );
  assert.equal(isGptOssSchemaError(400, "plain bad request"), false);
  const calls = [];
  await withGateway(
    async (_url, options) => {
      const body = JSON.parse(Buffer.from(options.body).toString());
      calls.push(body.model);
      if (body.model === "@cf/openai/gpt-oss-120b") {
        return new Response(
          JSON.stringify({
            error: { message: "Invalid tool_call content parts in messages" }
          }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }
      return Response.json({
        choices: [
          { message: { role: "assistant", content: "schema-fallback-ok" } }
        ]
      });
    },
    async (origin) => {
      const response = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.gatewayToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "@cf/openai/gpt-oss-120b",
          messages: [{ role: "user", content: "continue tool loop" }]
        })
      });
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("x-lab-fallback-from"),
        "@cf/openai/gpt-oss-120b"
      );
      assert.deepEqual(calls, [
        "@cf/openai/gpt-oss-120b",
        LONG_CONTEXT_FALLBACK_MODEL
      ]);
    }
  );
});

test("does not retry unclassified GPT-OSS Bad Request", async () => {
  const calls = [];
  await withGateway(
    async (_url, options) => {
      const body = JSON.parse(Buffer.from(options.body).toString());
      calls.push(body.model);
      if (body.model === "@cf/openai/gpt-oss-120b") {
        return new Response(
          JSON.stringify({ error: { message: "Bad Request" } }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }
      return Response.json({
        choices: [
          { message: { role: "assistant", content: "unclassified-ok" } }
        ]
      });
    },
    async (origin) => {
      const response = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.gatewayToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "@cf/openai/gpt-oss-120b",
          messages: [{ role: "user", content: "continue" }]
        })
      });
      assert.equal(response.status, 400);
      assert.deepEqual(calls, ["@cf/openai/gpt-oss-120b"]);
    }
  );
});

test("retries Vertex thought_signature Bad Request with forceAll signatures", async () => {
  assert.equal(
    isVertexThoughtSignatureError(
      400,
      "Missing thought_signature on functionCall"
    ),
    true
  );
  const calls = [];
  const server = createAgentGateway(
    {
      ...config,
      googleCloudProject: "light-result-504202-m9",
      googleAccessToken: "vertex-access-token"
    },
    {
      capabilities: ["vertex-chat"],
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(Buffer.from(options.body).toString());
        calls.push(body);
        const signatures = (body.messages ?? [])
          .flatMap((message) => message.tool_calls ?? [])
          .map((call) => call?.extra_content?.google?.thought_signature);
        if (signatures.filter(Boolean).length < 2) {
          return new Response(
            JSON.stringify({
              error: { message: "Missing thought_signature on functionCall" }
            }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }
        return Response.json({
          choices: [{ message: { role: "assistant", content: "vertex-ok" } }]
        });
      }
    }
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/vertex/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.gatewayToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "gemini-3.1-pro-preview",
          messages: [
            {
              role: "assistant",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "read", arguments: "{}" }
                },
                {
                  id: "call_2",
                  type: "function",
                  function: { name: "bash", arguments: "{}" }
                }
              ]
            },
            { role: "tool", tool_call_id: "call_1", content: "ok" },
            { role: "tool", tool_call_id: "call_2", content: "ok" },
            { role: "user", content: "continue" }
          ]
        })
      }
    );
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    const second = calls[1].messages
      .flatMap((message) => message.tool_calls ?? [])
      .map((call) => call?.extra_content?.google?.thought_signature);
    assert.deepEqual(second, [
      "skip_thought_signature_validator",
      "skip_thought_signature_validator"
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("retries chat once after upstream concurrency 429", async () => {
  assert.equal(shouldRetryConcurrency(429), true);
  assert.equal(shouldRetryConcurrency(200), false);
  const delays = [];
  const calls = [];
  const server = createAgentGateway(config, {
    delay: async (ms) => {
      delays.push(ms);
    },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(Buffer.from(options.body).toString());
      calls.push(body.model);
      if (calls.length === 1) {
        return new Response(
          JSON.stringify({
            error: { message: "Model concurrency limit reached." }
          }),
          { status: 429, headers: { "content-type": "application/json" } }
        );
      }
      return Response.json({
        choices: [{ message: { role: "assistant", content: "retry-ok" } }]
      });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.gatewayToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "@cf/openai/gpt-oss-120b",
          messages: [{ role: "user", content: "hello" }]
        })
      }
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-lab-concurrency-retry"), "1");
    assert.deepEqual(calls, [
      "@cf/openai/gpt-oss-120b",
      "@cf/openai/gpt-oss-120b"
    ]);
    assert.equal(delays.length, 1);
    assert.equal(delays[0], 750);
    const payload = await response.json();
    assert.equal(payload.choices[0].message.content, "retry-ok");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("normalizes GPT-OSS tool-loop messages without flattening vision models", async () => {
  const calls = [];
  await withGateway(
    async (url, options) => {
      calls.push({
        url,
        body: JSON.parse(Buffer.from(options.body).toString())
      });
      return Response.json({ ok: true });
    },
    async (origin) => {
      const gptResponse = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.gatewayToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "@cf/openai/gpt-oss-120b",
          messages: [
            { role: "system", content: [{ type: "text", text: "system" }] },
            {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call-1" }]
            },
            {
              role: "tool",
              tool_call_id: "call-1",
              content: [{ type: "text", text: "tool result" }]
            }
          ]
        })
      });
      assert.equal(gptResponse.status, 200);
      assert.deepEqual(calls[0].body.messages, [
        { role: "system", content: "system" },
        { role: "assistant", content: "", tool_calls: [{ id: "call-1" }] },
        { role: "tool", tool_call_id: "call-1", content: "tool result" }
      ]);

      const visionParts = [
        { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }
      ];
      const visionResponse = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.gatewayToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "@cf/moonshotai/kimi-k2.6",
          messages: [{ role: "user", content: visionParts }]
        })
      });
      assert.equal(visionResponse.status, 200);
      assert.deepEqual(calls[1].body.messages[0].content, visionParts);
    }
  );
});

test("rejects unapproved model and route requests", async () => {
  await withGateway(
    async () => new Response(),
    async (origin) => {
      for (const [path, body] of [
        ["/v1/chat/completions", { model: "@cf/unapproved/model" }],
        ["/run/@cf/unapproved/image", {}],
        ["/anything", {}]
      ]) {
        const response = await fetch(`${origin}${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.gatewayToken}`,
            "content-type": "application/json"
          },
          body: JSON.stringify(body)
        });
        assert.ok([403, 404].includes(response.status));
      }
    }
  );
});

test("allowlists draft, finalist, and reference image tiers", async () => {
  const calls = [];
  await withGateway(
    async (url) => {
      calls.push(url);
      return Response.json({ result: { image: "AA==" } });
    },
    async (origin) => {
      for (const model of [
        "@cf/black-forest-labs/flux-2-klein-4b",
        "@cf/black-forest-labs/flux-2-klein-9b",
        "@cf/black-forest-labs/flux-2-dev"
      ]) {
        const response = await fetch(`${origin}/run/${model}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.gatewayToken}`,
            "content-type": "application/json"
          },
          body: "{}"
        });
        assert.equal(response.status, 200);
      }
    }
  );
  assert.equal(calls.length, 3);
});

test("injects distinct fixed credentials for MCP and design upstreams", async () => {
  const calls = [];
  await withGateway(
    async (url, options) => {
      calls.push({ url, options });
      return Response.json({ ok: true });
    },
    async (origin) => {
      for (const [path, method] of [
        ["/quality/mcp", "POST"],
        ["/open-design/api/health", "GET"]
      ]) {
        const response = await fetch(`${origin}${path}`, {
          method,
          headers: { authorization: `Bearer ${config.gatewayToken}` },
          ...(method === "POST" ? { body: "{}" } : {})
        });
        assert.equal(response.status, 200);
      }
      assert.equal(
        calls[0].options.headers.authorization,
        `Bearer ${config.qualityMcpToken}`
      );
      assert.equal(
        calls[0].options.headers["x-lab-registration-token"],
        config.qualityRegistrationToken
      );
      assert.equal(
        calls[1].options.headers.authorization,
        `Bearer ${config.openDesignToken}`
      );
      assert.match(calls[0].url, /host\.docker\.internal:8793\/mcp$/u);
      assert.match(calls[1].url, /open-design:7456\/api\/health$/u);
    }
  );
});

test("forwards the project-scoped run control center through its own capability actions", async () => {
  const calls = [];
  await withGateway(
    async (url, options) => {
      calls.push({ url, options });
      return Response.json({ ok: true });
    },
    async (origin) => {
      const readResponse = await fetch(`${origin}/quality/runs`, {
        headers: { authorization: `Bearer ${config.gatewayToken}` }
      });
      const notificationResponse = await fetch(
        `${origin}/quality/notifications`,
        { headers: { authorization: `Bearer ${config.gatewayToken}` } }
      );
      const operateResponse = await fetch(
        `${origin}/quality/runs/run_12345678/actions/retry`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.gatewayToken}`,
            "content-type": "application/json"
          },
          body: "{}"
        }
      );
      assert.equal(readResponse.status, 200);
      assert.equal(notificationResponse.status, 200);
      assert.equal(operateResponse.status, 200);
      assert.deepEqual(
        calls.map((call) => call.url),
        [
          "http://host.docker.internal:8793/runs",
          "http://host.docker.internal:8793/notifications",
          "http://host.docker.internal:8793/runs/run_12345678/actions/retry"
        ]
      );
      assert.equal(
        calls[0].options.headers.authorization,
        `Bearer ${config.qualityMcpToken}`
      );
      assert.equal(
        calls[0].options.headers["x-lab-registration-token"],
        config.qualityRegistrationToken
      );
    }
  );
});

test("run operations require quality:operate even when run status is readable", async () => {
  const calls = [];
  await withGateway(
    async (url, options) => {
      calls.push({ url, options });
      return Response.json({ ok: true });
    },
    async (origin) => {
      const readOnlyLease = lease({
        routes: ["quality"],
        actions: ["quality:read"]
      });
      const readResponse = await fetch(`${origin}/quality/runs`, {
        headers: { authorization: `Bearer ${readOnlyLease}` }
      });
      const operateResponse = await fetch(
        `${origin}/quality/runs/run_12345678/actions/cancel`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${readOnlyLease}` },
          body: "{}"
        }
      );
      assert.equal(readResponse.status, 200);
      assert.equal(operateResponse.status, 403);
      assert.equal(calls.length, 1);
    }
  );
});

test("forwards Notion publish when notion-publish capability is enabled", async () => {
  const calls = [];
  const server = createAgentGateway(
    {
      ...config,
      cloudflareAccountId: "account-id",
      cloudflareApiToken: "real-cloudflare-token",
      qualityMcpToken: "real-quality-token",
      qualityRegistrationToken: "quality-registration-token-123456",
      openDesignToken: "real-design-token",
      notionPublisherToken: "notion-publisher-secret",
      notionPublisherUrl: "http://notion-publisher:8796"
    },
    {
      capabilities: ["chat", "quality", "open-design", "notion-publish"],
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return Response.json({ ok: true });
      }
    }
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/notion/publish`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.gatewayToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        target: "docs",
        title: "Test",
        markdown: "# Hello",
        idempotencyKey: "abc123"
      })
    });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://notion-publisher:8796/publish");
    assert.equal(
      calls[0].options.headers.authorization,
      "Bearer notion-publisher-secret"
    );
    assert.equal(
      calls[0].options.headers["x-opencode-capability-lease"],
      config.gatewayToken
    );
    assert.equal(calls[0].options.headers["content-type"], "application/json");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("blocks Notion publish when notion-publish capability is disabled", async () => {
  const calls = [];
  await withGateway(
    async (url, options) => {
      calls.push({ url, options });
      return Response.json({ ok: true });
    },
    async (origin) => {
      const response = await fetch(`${origin}/notion/publish`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.gatewayToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ target: "docs", markdown: "# Hello" })
      });
      assert.equal(response.status, 404);
      assert.equal(calls.length, 0);
    }
  );
});

test("forwards only the allowlisted GitHub publish routes with the relay token", async () => {
  const calls = [];
  const server = createAgentGateway(
    {
      ...config,
      githubRelayToken: "session-relay-token",
      githubRelayUrl: "http://host.docker.internal:8794"
    },
    {
      capabilities: ["chat", "github-publish"],
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return Response.json({ ok: true });
      }
    }
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/github/status`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.gatewayToken}`,
        "content-type": "application/json"
      },
      body: "{}"
    });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://host.docker.internal:8794/v1/status");
    assert.equal(
      calls[0].options.headers.authorization,
      "Bearer session-relay-token"
    );
    assert.equal(
      calls[0].options.headers["x-opencode-capability-lease"],
      config.gatewayToken
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a chat-only lease cannot use configured privileged routes", async () => {
  const calls = [];
  const server = createAgentGateway(
    {
      ...config,
      githubRelayToken: "session-relay-token",
      githubRelayUrl: "http://host.docker.internal:8794",
      notionPublisherToken: "notion-publisher-secret",
      notionPublisherUrl: "http://notion-publisher:8796"
    },
    {
      capabilities: ["chat", "github-publish", "notion-publish", "quality"],
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return Response.json({ ok: true });
      }
    }
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const headers = {
    authorization: `Bearer ${lease({ routes: ["chat"], actions: ["chat:invoke"] })}`,
    "content-type": "application/json"
  };
  try {
    for (const path of [
      "/github/status",
      "/github/push",
      "/notion/publish",
      "/quality/mcp"
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers,
        body: "{}"
      });
      assert.equal(response.status, 403, path);
    }
    assert.equal(calls.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("browser operations cross only fixed authenticated relay routes", async () => {
  const calls = [];
  const server = createAgentGateway(
    {
      ...config,
      browserVerifyRelayToken: "browser-verify-internal-token",
      browserVerifyRelayUrl: "http://host.docker.internal:3111",
      browserSessionRelayToken: "browser-session-internal-token",
      browserSessionRelayUrl: "http://host.docker.internal:3112"
    },
    {
      capabilities: ["browser-verify", "browser-session"],
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return Response.json({ ok: true });
      }
    }
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    for (const path of ["/browser/verify", "/browser/session"]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.gatewayToken}`,
          "content-type": "application/json"
        },
        body: "{}"
      });
      assert.equal(response.status, 200);
    }
    assert.deepEqual(
      calls.map((call) => call.url),
      [
        "http://host.docker.internal:3111/verify",
        "http://host.docker.internal:3112/action"
      ]
    );
    assert.equal(
      calls[0].options.headers.authorization,
      "Bearer browser-verify-internal-token"
    );
    assert.equal(
      calls[1].options.headers.authorization,
      "Bearer browser-session-internal-token"
    );
    assert.equal(
      calls[0].options.headers["x-opencode-capability-lease"],
      config.gatewayToken
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("forwards only a fixed OpenPets reaction enum with the relay token", async () => {
  const calls = [];
  const server = createAgentGateway(
    {
      ...config,
      openPetsRelayToken: "pet-session-relay-token",
      openPetsRelayUrl: "http://host.docker.internal:8795"
    },
    {
      capabilities: ["openpets"],
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return Response.json({ ok: true });
      }
    }
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const headers = {
      authorization: `Bearer ${config.gatewayToken}`,
      "content-type": "application/json"
    };
    const allowed = await fetch(`http://127.0.0.1:${port}/openpets/react`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reaction: "editing" })
    });
    assert.equal(allowed.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://host.docker.internal:8795/v1/react");
    assert.equal(
      calls[0].options.headers.authorization,
      "Bearer pet-session-relay-token"
    );

    const rejected = await fetch(`http://127.0.0.1:${port}/openpets/react`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reaction: "say arbitrary agent output" })
    });
    assert.equal(rejected.status, 403);
    assert.equal(calls.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("supports a chat-only gateway with one fixed model and no privileged credentials", async () => {
  const calls = [];
  const server = createAgentGateway(
    {
      gatewaySigningKey,
      expectedWorkspaceHash: workspaceHash,
      expectedProjectId: projectId,
      expectedSessionId: sessionId,
      expectedRunId: runId,
      cloudflareAccountId: "test-account",
      cloudflareApiToken: "test-cloudflare-token"
    },
    {
      capabilities: ["chat"],
      chatModels: ["@cf/moonshotai/kimi-k2.7-code"],
      imageModels: [],
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return Response.json({ ok: true });
      }
    }
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const headers = {
    authorization: `Bearer ${lease({ routes: ["chat"], actions: ["chat:invoke"] })}`,
    "content-type": "application/json"
  };
  try {
    const allowed = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "@cf/moonshotai/kimi-k2.7-code" })
    });
    assert.equal(allowed.status, 200);

    for (const [path, method, body] of [
      ["/v1/chat/completions", "POST", { model: "@cf/openai/gpt-oss-120b" }],
      ["/run/@cf/black-forest-labs/flux-2-klein-4b", "POST", {}],
      ["/quality/mcp", "POST", {}],
      ["/open-design/api/health", "GET", undefined]
    ]) {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      assert.ok([403, 404].includes(response.status), path);
    }
    assert.equal(calls.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
