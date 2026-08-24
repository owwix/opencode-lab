---
name: author-project-skill
description: Author a project-local OpenCode skill or agent under the mounted workspace. Use when adding run/preview guidance or a product Tab agent for a mount. Do not put harness-reserved agents or Lab-only tooling into the project.
---

# Author project OpenCode skills / agents

Create these in the **mounted project**, not under Lab’s harness tree (except Lab
concerns: preview, browser, safety).

## Skills

```text
/workspace/.opencode/skills/<name>/SKILL.md
```

### Frontmatter

```yaml
---
name: run-example-dev
description: When to use this skill (triggers). Mention Lab preview if relevant.
---
```

### Required for run/preview skills

1. Defer to Lab `local-preview`: Mac URLs only `http://127.0.0.1:3100` and
   `http://127.0.0.1:3101`.
2. Forbid Codespaces, Gitpod, VS Code Ports, SSH tunnels, and cloning as the
   primary path.
3. Prefer compose or `0.0.0.0:3000`/`3001` inside the Lab container.
4. Point verification at `node /opencode-config/scripts/local-preview/check.mjs`
   when running inside Lab.

## Agents (Tab)

```text
/workspace/.opencode/agents/<name>.md
```

OpenCode loads project agents automatically when cwd is `/workspace`. Lab’s
`OPENCODE_CONFIG_DIR` loads after and **wins on name collisions**.

Never redefine reserved harness names: `fast`, `lab`, `deep`, `plan`,
`reviewer`, `dispatcher`, `research`. See `docs/lab/workspace-agents.md`.

## Non-goals

- Payload schema / migrations / Railway / production auth as Lab harness skills
- Duplicating a full `AGENTS.md`—link to it instead

After writing, mention that **lab** + `project-skills` (and Tab for new agents)
will pick them up on the matching mount.
