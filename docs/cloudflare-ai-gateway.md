# Cloudflare AI Gateway handoff

The local `agent-gateway` is the credential boundary for OpenCode. The account-side
AI Gateway is a separate Cloudflare resource and should be configured before using
paid or high-volume lanes. This repository includes a provider-neutral manifest at
`cloudflare/ai-gateway.routes.example.json`; it does not contain credentials and is
safe to review or check into source control.

Recommended setup:

1. Create one AI Gateway named `opencode-lab` in the same Cloudflare account.
2. Add named routes for `dispatch`, `standard`, `frontier-code`, `long-context-vision`,
   and `review` using the model IDs in `quality/model-routing.json`.
3. Enable request metadata for `lab.run_id`, `lab.agent`, `lab.phase`, and
   `lab.model`. The controller supplies these as
   process-level telemetry and the local gateway emits a request ID, model, and
   duration header.
4. Set a monthly spend limit and per-route rate limits. Keep the review route
   separate so a review storm cannot consume the implementation budget.
5. Configure fallbacks only within the same capability class: standard → dispatch
   for non-critical work, frontier-code → standard only when the task is not high
   risk, and never silently fall back for a security/deployment review.
6. Enable caching only for explicitly cache-safe, read-only requests. Do not cache
   prompts containing credentials, private customer data, or uncommitted source.

The local harness remains fail-closed when the selected route or model is not in its
allowlist. Account-side route changes therefore cannot grant an agent a new model by
accident; update the checked-in registry and run `npm run quality:routes` first.

This is an operator handoff, not an automatic Cloudflare API mutation. Applying the
manifest requires an authenticated Cloudflare session and an explicit production
change review.

Once the API token has the **AI Gateway Write** permission, the gateway-level settings
can be applied idempotently with:

```bash
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
  npm run cloudflare:ai-gateway -- --apply
```

The command only creates or updates the named `opencode-lab` gateway. It never
deletes gateways or prints credentials. Dynamic route graphs remain a separate
reviewed change because Cloudflare validates their model/fallback elements server-side.
