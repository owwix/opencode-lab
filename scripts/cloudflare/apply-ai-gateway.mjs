const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
const gatewayId = (process.env.AI_GATEWAY_ID ?? "opencode-lab").trim();
const apply = process.argv.includes("--apply");

if (!accountId || !token) {
  throw new Error(
    "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required."
  );
}
if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/u.test(gatewayId)) {
  throw new Error("AI_GATEWAY_ID must be a lowercase, hyphenated identifier.");
}

const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/gateways`;
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json"
};
const desired = {
  id: gatewayId,
  cache_invalidate_on_update: true,
  cache_ttl: 0,
  collect_logs: true,
  authentication: true,
  rate_limiting_interval: 60,
  rate_limiting_limit: 20,
  rate_limiting_technique: "sliding",
  retry_backoff: "exponential",
  retry_delay: 250,
  retry_max_attempts: 1,
  workers_ai_billing_mode: "unified",
  spend_limits: {
    enabled: true,
    rules: [
      {
        id: "lab-monthly",
        enabled: true,
        limit: 100,
        limitType: "cost",
        window: 2_592_000,
        technique: "sliding"
      }
    ]
  },
  metadata: {
    "lab.run_id": { mode: "partition" },
    "lab.agent": { mode: "partition" },
    "lab.phase": { mode: "partition" },
    "lab.model": { mode: "partition" }
  }
};

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    const detail =
      body.errors?.map((error) => error.message).join("; ") ||
      `HTTP ${response.status}`;
    throw new Error(`Cloudflare AI Gateway request failed: ${detail}`);
  }
  return body.result;
}

const gateways = await request(base);
const existing = (gateways ?? []).find((gateway) => gateway.id === gatewayId);
if (!apply) {
  console.log(
    JSON.stringify(
      { mode: "dry-run", gatewayId, exists: Boolean(existing), desired },
      null,
      2
    )
  );
  process.exit(0);
}

const result = existing
  ? await request(`${base}/${encodeURIComponent(gatewayId)}`, {
      method: "PUT",
      body: JSON.stringify(desired)
    })
  : await request(base, { method: "POST", body: JSON.stringify(desired) });
console.log(
  JSON.stringify(
    {
      mode: existing ? "updated" : "created",
      id: result.id,
      collect_logs: result.collect_logs,
      rate_limiting_limit: result.rate_limiting_limit,
      workers_ai_billing_mode: result.workers_ai_billing_mode
    },
    null,
    2
  )
);
