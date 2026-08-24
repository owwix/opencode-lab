import { readFileSync } from "node:fs";
import { CHAT_MODELS } from "../../docker/agent-gateway/gateway.mjs";

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function validateModelRegistry({
  routingPolicy,
  openCodeConfig,
  chatModels = CHAT_MODELS
} = {}) {
  const errors = [];
  const policy =
    typeof routingPolicy === "string"
      ? loadJson(routingPolicy)
      : (routingPolicy ?? {});
  const config =
    typeof openCodeConfig === "string"
      ? loadJson(openCodeConfig)
      : (openCodeConfig ?? {});
  const models = policy.models ?? {};
  const configured = new Set(
    Object.keys(config.provider?.["cloudflare-ai"]?.models ?? {})
  );
  for (const model of Object.keys(models)) {
    const providerModel = model.replace(/^cloudflare-ai\//u, "");
    if (!configured.has(providerModel))
      errors.push(`${model} is missing from opencode.json provider models`);
    if (!new Set(chatModels).has(providerModel))
      errors.push(`${model} is missing from the gateway chat allowlist`);
    if (!models[model]?.family || !models[model]?.lane)
      errors.push(`${model} needs a family and lane`);
  }
  for (const [lane, value] of Object.entries(policy.lanes ?? {})) {
    if (!models[value.model])
      errors.push(`lane ${lane} points to an unknown model ${value.model}`);
    for (const field of ["maxTokens", "maxCost", "maxToolCalls"]) {
      const valid =
        lane === "intelligence" && field === "maxToolCalls"
          ? Number(value[field]) >= 0
          : Number(value[field]) > 0;
      if (!valid)
        errors.push(
          `lane ${lane} needs a ${
            lane === "intelligence" && field === "maxToolCalls"
              ? "non-negative"
              : "positive"
          } ${field}`
        );
    }
  }
  for (const rule of policy.rules ?? []) {
    if (!models[rule.model])
      errors.push(`routing rule points to an unknown model ${rule.model}`);
  }
  for (const candidate of policy.reviewPolicy?.reviewerCandidates ?? []) {
    const providerModel = String(candidate.model ?? "").replace(
      /^cloudflare-ai\//u,
      ""
    );
    if (!models[candidate.model] && !new Set(chatModels).has(providerModel)) {
      errors.push(
        `reviewer candidate ${candidate.model} is not in the model registry or gateway allowlist`
      );
    }
  }
  return { passed: errors.length === 0, errors };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = validateModelRegistry({
    routingPolicy: process.argv[2] ?? "quality/model-routing.json",
    openCodeConfig: process.argv[3] ?? "opencode.json"
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
