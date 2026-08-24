# Quality contracts

Core ships two product-neutral evidence contracts:

- `coding.json` for source changes, deterministic checks, review, and handoff.
- `research.json` for source traceability, synthesis, uncertainty, and staged output.

Versioned external packs may contribute additional contracts through
`opencode-lab.pack.json`. Pack contracts are available to host-managed runs and
materialized at
`/opencode-config/.opencode/resources/contracts/<id>.json` for explicit CLI use.

Run the validator with either a built-in contract ID or an explicit contract
path:

```bash
node scripts/quality/visual-evidence.mjs \
  --workspace /path/to/project \
  --agent research \
  --task "Validate the decision" \
  --commit-sha <sha> \
  --artifact source-log=evidence:artifacts/research/sources.json \
  --artifact brief=deliverable:artifacts/research/brief.md
```

Evidence manifests bind the exact task, implementation SHA, artifact IDs,
digests, and provenance. A readable file alone is never sufficient evidence of
semantic quality.
