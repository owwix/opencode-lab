# Agent quality evaluations

This Inspect AI project has two complementary layers. The 31-case conversational
golden set measures behavioral contracts that ordinary repository tests cannot see.
The executable trajectory suite runs typed actions in fresh Git repositories and
grades both the resulting files/state and the path the agent took to get there.

The suite deliberately includes both negative and positive authority cases. A model
must refuse an unrequested production deploy, for example, but must also carry out a
safe deploy when the user explicitly requests it and exact-commit checks are green.
This prevents a model from scoring well merely by refusing every consequential task.

Install the pinned environment:

```bash
uv sync --project quality/inspect
```

Run against any Inspect-supported model:

```bash
npm run quality:eval -- --model openai/<model>
```

The repository command selects chat-completions compatibility for Cloudflare-hosted
models and writes logs into this directory's ignored `logs/` folder. It also caps
retries, request/sample time, output tokens, and API concurrency so a provider fault
cannot turn a manual evaluation into an unbounded credit-consuming run.

Run all model-free checks without calling a model:

```bash
uv run --project quality/inspect python -m unittest discover \
  -s quality/inspect/tests -v
```

The trajectory fixtures exercise real reads, allowlisted writes, focused subprocess
checks, denied paths, a disconnected-tool fallback, and an ambiguous external write.
The executor never accepts arbitrary shell from model output. A trial fails if the
final file is correct but the agent skipped read-before-write, omitted verification,
repeated an equivalent failed call, crossed a permission boundary, or retried an
ambiguous write without inspecting state.

Run the optional metered trajectory task with repeated trials:

```bash
AGENT_QUALITY_TRIALS=3 uv run --project quality/inspect \
  inspect eval quality/inspect/evals/trajectory_quality.py \
  --model openai/<model> --log-dir quality/inspect/logs \
  -M responses_api=false -M background=false
```

`aggregate_trial_results` reports pass rate, all-trials pass, threshold pass, and
pass-power-k so one lucky run cannot hide flaky behavior. Keep conversational and
trajectory scores separate: one measures stated judgment; the other measures a
restricted action plan against real end state and trajectory evidence.

For Cloudflare Workers AI, configure Inspect's OpenAI-compatible provider with the
account-scoped Workers AI base URL and a narrowly scoped token in the shell. Never
commit those values. Add new cases whenever a real agent failure escapes the current
suite; keep the prompt, required behavior, and forbidden behavior independently
reviewable. Every case has a stable ID and category so results can be compared across
models and prompt revisions. The static validation requires at least 20 unique cases,
checks contract structure, and proves that each required group and forbidden phrase is
independently enforceable.

Reviewer diversity is fail-closed in the pure routing hook. Kimi K2.7 Code is the only
candidate with recorded local smoke evidence. DeepSeek V4 Pro is registered as the
distinct-family candidate but remains `eval-required`; it does not count toward a
high-risk review until it passes the fixed and executable suites across multiple
trials and is explicitly promoted in `quality/model-routing.json`. Model-free tests
never edit routing status or auto-promote a candidate.
