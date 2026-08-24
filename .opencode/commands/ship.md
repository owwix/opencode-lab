---
description: Implement and verify one scoped outcome
agent: dispatcher
---

Start a managed quality run for this outcome: $ARGUMENTS

Do not edit the current UI worktree. Call the Quality MCP
`start_managed_run` tool with `kind=ship`, this outcome as `task`, and the
current repository's absolute path as `workspace`. Return the run id, isolated
worktree, and status command. The managed host workflow performs implementation,
Dagger verification, and independent review; it does not deploy or push.
