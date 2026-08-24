---
name: project-skills
description: Load project-local OpenCode skills and AGENTS.md from the mounted workspace. Use when starting work on a mount, or when a task matches a project-specific skill (run-*, deploy, test) not already covered by harness skills.
---

# Project-local guidance

Harness skills live under `/opencode-config/.opencode/skills/`.

Product doctrine and runbooks live in the **mounted project**:

1. Read `/workspace/AGENTS.md` when present (canonical for that repo).
2. Follow any matching `/workspace/.opencode/skills/*/SKILL.md`.
3. Also check `/opencode-config/project-skills/*/SKILL.md` when that mount path is used.

Prefer the most specific **workspace** skill for run/preview/deploy tasks. A
loaded pack may contribute additional fallback skills, but core never guesses a
company-specific runbook from a folder name.

Project **agents** (Tab) also load from `/workspace/.opencode/agents/` — see
`docs/lab/workspace-agents.md`. Do not redefine reserved harness agent names.

Still obey `local-preview` host URL rules (Mac `3100`/`3101` only).
