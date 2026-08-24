# Agent quality in OpenCode Lab

OpenCode Lab is a local, Docker-isolated harness for coding work. It provides
predictable execution boundaries and evidence; it does not promise that an
agent is correct without verification.

## Start the right session

Run `lab` from anywhere to choose a workspace, or pass one directly:

```bash
lab --workspace "$HOME/Projects/example"
```

The default launch is the fast coding profile. It starts the gateway and
OpenCode only. Hound research and OpenDesign are deliberately optional:

```bash
lab --with-research
lab --with-design
lab --full-tools
```

Tab selects the next coding lane; it cannot start a research or design service
in the current session. Quit and relaunch with `lab --with-research` or
`lab --with-design` first.

The host registry allows one foreground interactive workspace. A second launch
must explicitly resume the active project or stop its verified Lab launcher.
Background managed runs receive separate launch registrations and Compose
projects, so they do not replace foreground ownership. Quality maps the
container path `/workspace` only from the current short-lived registration
token; there is no global current-workspace pointer.

`lab --setup` and `npm run doctor` print the same launch snapshot: the stable
`opencode-lab-*` volumes, default profile, runtime-config writability, pinned
OpenCode/OpenDesign sources, and whether the local OpenCode image needs
`lab --rebuild`. Doctor only inspects; it never builds.

## Lanes and agents

Use one coding lane per ordinary prompt:

- `fast` uses GLM-4.7 Flash for small, bounded, low-risk edits.
- `lab` uses GPT-OSS 120B for routine implementation.
- `deep` uses Kimi K2.7 Code for complex or high-risk changes.

The model is fixed for the current prompt or managed task. There is no hidden
mid-task routing. The sidebar and `/cache-stats` show cost accumulated by the
fast, lab, and deep lanes.

Use `/workflow` for the command map and `/agents-help` for agent selection.
Those commands are Lab-wide. Product-specific commands are shown only when a
versioned external pack contributes them.

## Managed work

`/ship`, `/research`, `/review`, `/eval`, and `/parallel` submit bounded work
through the quality controller. Managed runs use separate Git worktrees and
persist a run record under ignored `.quality/runs/`. Verify the resulting
worktree before adopting changes; parallel runs do not merge themselves.

The controller preserves authority boundaries: research gathers evidence,
review is read-only, and publishing/deployment remain explicit operator actions.
Credentials remain in the gateway or ignored local environment file rather than
in the OpenCode workspace. OpenCode has no unrestricted egress: models,
research, design, browser control, previews, publishing, and allowlisted HTTPS
artifacts cross authenticated fixed-purpose relays. Every artifact redirect is
re-resolved and pinned to a public IP before download.

## Verification standard

For every changed outcome, establish three things:

1. The intended source change is present in the selected worktree.
2. Relevant deterministic checks passed, or a concrete blocker is recorded.
3. Any claim about a visual, external system, or release has inspectable
   evidence rather than an unsupported agent assertion.

Run the project’s narrowest useful checks first, then its normal CI-equivalent
check before release. Use `npm run doctor` when launch state is suspect; use
`npm run quality:test` when changing the harness itself.

## Disk and recovery

Runtime state uses project-scoped named
`opencode-lab-project_<id>-*` volumes so it survives a restart without sharing
configuration, caches, sessions, or optional-service state with another
project.
Inspect legacy volumes safely with:

```bash
lab prune
```

It reports only recognized legacy Lab volume names and ignores unrelated Docker
volumes. Nothing is deleted unless the exact follow-up command is supplied:

```bash
lab prune --apply
```

The command does not stop containers or delete workspaces. If Docker rejects a
volume because it is in use, stop or inspect that specific old service first.
