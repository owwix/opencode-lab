---
description: Research a decision and capture evidence
agent: dispatcher
---

Start a managed research run for: $ARGUMENTS

Do not update Notion or edit the current UI worktree. Call the Quality MCP
`start_managed_run` tool with `kind=research`, this decision as `task`, and the
current repository's absolute path as `workspace`. Return the run id, isolated
worktree, and status command. Research must first produce a source-linked Markdown
artifact for staging; canonical Notion publishing remains a separate approved step.
