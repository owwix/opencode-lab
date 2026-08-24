# When to use which Lab agent

Lab Tab agents are **harness** personas. Product-specific agents appear only
from the mounted project's `.opencode` directory or an enabled external pack.
See `docs/lab/workspace-agents.md` and `docs/packs.md`.

## Start here

1. Ordinary coding prompt? Choose the lane with Tab **before** the prompt:
   **fast** for a small low-risk change, **lab** for standard work, or **deep**
   for complex/high-risk implementation. There is no automatic mid-turn model switch.
2. Need a plan before code? → **plan** (`/plan`)
3. Only want a critique? → **reviewer** (`/review`)
4. Kick off managed/parallel quality runs? → **dispatcher** (`/ship`, `/parallel`, …)

Ordinary TUI prompts use the selected primary agent's fixed model lane. Managed
commands such as `/ship` use the quality task router instead.

Any repository receives **fast**, **lab**, **deep**, **plan**, **reviewer**,
**dispatcher**, and **research**. Project and pack agents are additive and are
shown in `/agents-help` only when loaded.

## By job

| You’re doing…                             | Use                        |
| ----------------------------------------- | -------------------------- |
| Small, bounded, low-risk edit             | **fast** — GLM-4.7 Flash   |
| Everyday implementation / fix / refactor  | **lab** — GPT-OSS 120B     |
| Complex, cross-cutting, or high-risk code | **deep** — Kimi K2.7 Code  |
| Evidence gathering / hard public pages    | **research**               |
| Managed quality dispatch only             | **dispatcher**             |
| Product-specific workflow                 | matching loaded-pack agent |

## Typical loops

```text
plan → fast / lab / deep → reviewer
research → (optional) plan → fast / lab / deep
loaded-pack agent (when the pack declares one)
dispatcher only for quality-run dispatch — then switch back
```

## Don’t

- Don’t expect a product agent unless its project config or pack is loaded.
- Don’t redefine reserved harness agent names in a project (`fast`, `lab`, `deep`, …).
- Don’t use a specialist pack agent outside its declared scope.
- Don’t use **reviewer** or **plan** when you want files changed.
- Don’t use **dispatcher** to write code.

## Lab TUI

- `/workflow` or Ctrl+Shift+W — Lab command menu (includes `/preview`, `/run-local`)
- `/agents-help` or Ctrl+Shift+A — fixed model lanes and workflow agents
- Tab — select the agent/model lane for the next prompt; switching is explicit
- Sidebar shows mount name + generic and loaded-pack agents
