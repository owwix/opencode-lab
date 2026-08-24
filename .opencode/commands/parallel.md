---
description: Start 2-4 isolated managed tasks in parallel
agent: dispatcher
---

Start a parallel managed batch from: $ARGUMENTS

First call the Quality MCP `list_managed_run_kinds` tool. Interpret the request as
2-4 concrete run definitions using only a returned core or loaded-pack kind and a
bounded task. Use the current repository's absolute path as the shared `workspace`.
Call `start_parallel_runs` exactly once. Do not edit the current UI worktree and do
not start equivalent individual runs if the batch call fails.

Return a compact table containing the batch ID, each kind, run ID, isolated worktree,
initial state, and status command, followed by any launch failures. Explain that the
runs execute independently and completion must be checked per run.

Example input: `research: validate the buyer problem | ship: implement the bounded fix`
