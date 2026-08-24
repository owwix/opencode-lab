import assert from "node:assert/strict";
import test from "node:test";
import {
  inferRouteEnvelope,
  validateRouteEnvelope
} from "./routing-envelope.mjs";

test("builds bounded structured routing metadata", () => {
  const envelope = inferRouteEnvelope({
    agent: "lab",
    task: "debug the production authentication regression",
    requirements: { security: true, deployment: true },
    model: "cloudflare-ai/@cf/moonshotai/kimi-k2.7-code"
  });
  assert.equal(envelope.protocol, "route-envelope/v1");
  assert.equal(envelope.risk, "high");
  assert.equal(envelope.complexity, "frontier");
  assert.equal(envelope.model.includes("kimi-k2.7"), true);
  assert.equal(validateRouteEnvelope(envelope), envelope);
});

test("rejects extra fields and unsupported dimensions", () => {
  const envelope = inferRouteEnvelope({
    agent: "research",
    task: "summarize notes"
  });
  assert.throws(
    () => validateRouteEnvelope({ ...envelope, secret: "no" }),
    /exactly/u
  );
  assert.throws(
    () => validateRouteEnvelope({ ...envelope, risk: "critical" }),
    /supported/u
  );
});
