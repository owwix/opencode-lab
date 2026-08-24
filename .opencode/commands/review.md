---
description: Review current changes without modifying them
agent: reviewer
---

Review $ARGUMENTS. If no target is supplied, review the current worktree diff.
Do not modify files. Return actionable findings first, ordered by severity, with
precise file and line references. Include missing tests and security or product
risks. If there are no material findings, state that directly.
