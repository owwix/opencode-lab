# Reviewer qualification and operational metrics

Reviewer candidates stay `eval-required` until an operator records an
evidence-backed report and explicitly promotes the exact registered model and
family:

```bash
npm run quality:reviewer:promote -- \
  --report quality/reviewer-reports/candidate.json \
  --policy quality/model-routing.json \
  --approve --actor "$USER"
```

The report must include at least the policy's minimum runs, accuracy, task
completion, and local evidence files. Promotion records the report digest,
metrics, approving operator, and timestamp. Evaluation never promotes a model
automatically.

Terminal managed runs create an immutable `outcome.json` receipt bound to the
run, trace, and implementation SHA. `npm run quality:metrics` reports
time-to-verified, observed cost per verified changed file, rework,
infrastructure failures, approval wait, and PR conversion. Cost metrics remain
`null` when provider usage was not observed.

The controller propagates one correlation ID through implementation, review,
gateway, upstream model calls, verification evidence, trace events, and PR
receipts. Request IDs remain unique per model call beneath that correlation.
