export function mergeTelemetry(current = {}, next = {}) {
  const requests = [...(current.requests ?? []), ...(next.requests ?? [])];
  const models = [
    ...new Set([...(current.models ?? []), ...(next.models ?? [])])
  ];
  return {
    tokens: Number(current.tokens ?? 0) + Number(next.tokens ?? 0),
    cost: Number(current.cost ?? 0) + Number(next.cost ?? 0),
    toolCalls: Number(current.toolCalls ?? 0) + Number(next.toolCalls ?? 0),
    toolErrors: Number(current.toolErrors ?? 0) + Number(next.toolErrors ?? 0),
    modelCalls: Number(current.modelCalls ?? 0) + Number(next.modelCalls ?? 0),
    durationMs: Number(current.durationMs ?? 0) + Number(next.durationMs ?? 0),
    usageTelemetryObserved: Boolean(
      current.usageTelemetryObserved || next.usageTelemetryObserved
    ),
    requests: requests.slice(-100),
    models
  };
}

export function recordPhaseTelemetry(run, phase, telemetry) {
  const field =
    phase === "implementation"
      ? "implementationTelemetry"
      : phase === "review"
        ? "reviewTelemetry"
        : null;
  if (!field) throw new Error(`Unsupported telemetry phase: ${phase}`);
  run[field] = mergeTelemetry(run[field], telemetry);
  run.telemetry = mergeTelemetry(run.telemetry, telemetry);
  return run;
}
