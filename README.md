# OpenCode Lab

Docker-isolated [OpenCode](https://opencode.ai) harness: mount any
project, route models through a local credential gateway, and keep secrets out
of the agent container.

OpenCode Lab is an independent project. It is not affiliated with, endorsed by,
or sponsored by OpenCode or its maintainers. OpenCode is a separate upstream
project and its name and trademarks remain with their respective owners.

Core is product-neutral. Company agents, commands, themes, contracts, and run
skills load from external versioned packs and are not stored in this repository.

## Requirements

- Docker Desktop
- Node.js 24 (`nvm use` reads `.nvmrc`)
- Cloudflare Workers Paid (for default Kimi / Workers AI models)

## Quick start

```bash
cp opencode.env.example opencode.env
# Fill CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (optional OpenAI / Vertex)
npm install
npm run opencode
# or:
npm run opencode -- --workspace "$HOME/Projects/some-app"
```

Install a global launcher (optional):

```bash
npm link
opencode-lab --setup
opencode-lab --workspace "$HOME/Projects/some-app"
```

macOS shortcut: `launch-opencode.command`.

## Tool profiles and rebuilds

The default interactive launch is the fast coding profile: it starts the
required credential gateway and state initializer, while Hound and OpenDesign
stay disabled. Generic research selects Hound automatically; loaded packs
declare whether their agents require research or design tooling.

```bash
opencode-lab --with-research               # Hound only
opencode-lab --with-design                 # OpenDesign only
opencode-lab --full-tools                  # both optional stacks
opencode-lab --rebuild --with-research     # rebuild only core + research images
```

Launcher-only flags are removed before OpenCode starts. Warm launches reuse
images; use `--rebuild` after changing a Dockerfile or image build input.
Switching agents with Tab during an existing interactive session cannot start a
new tool stack: relaunch with `--with-research` or `--with-design` first.

Lab keeps one foreground interactive workspace. Opening another shows the
canonical path and PID of the active launch, then offers to resume it or stop it
before opening the new project. Background managed runs register separately and
continue without taking foreground ownership. Project/session/helper ownership
is recorded in ignored `.quality/host-registry.json`; no project receives the
launch registration token or access to that registry.

## What stays in Docker

| Piece              | Role                                                             |
| ------------------ | ---------------------------------------------------------------- |
| OpenCode container | TUI + agents; Node/npm/pnpm/Git; scoped gateway token only       |
| Agent gateway      | Real CF / Vertex / Quality credentials; model allowlist          |
| Hound              | On-demand research profile; isolated through its fixed relay     |
| OpenDesign         | On-demand design profile; separate scoped daemon token           |
| opencode-preview   | Mac `3100`/`3101` → app `:3000`/`:3001` (skipped if ports taken) |
| Gallery            | Host `http://127.0.0.1:3110` for safe image artifacts            |
| Browser relays     | Verify `:3111`, interactive session `:3112` (Playwright on Mac)  |

## Agents (Tab)

**Coding lanes for ordinary prompts:** **fast** (GLM-4.7 Flash, small low-risk
changes), **lab** (GPT-OSS 120B, standard/default), and **deep** (Kimi K2.7
Code, complex or high-risk work). Choose the lane with Tab before the coding
prompt; models do not switch automatically mid-turn.

**Workflow agents (always):** **plan**, **research**, **dispatcher**, and
**reviewer**. Managed `/ship` and `/parallel` runs use their separate task router.

**Extensions:** project-local `.opencode` files and enabled external packs add
agents and commands without changing core. See `docs/packs.md`,
`docs/lab/workspace-agents.md`, and `docs/lab/when-to-use-agents.md`.

## Local preview contract

Inside Lab, apps bind `:3000` / `:3001`. On the Mac open only:

- `http://127.0.0.1:3100`
- `http://127.0.0.1:3101`

Never Codespaces / VS Code Ports. Skills: `local-preview`, `project-skills`, and
workspace or loaded-pack `run-*-dev` contributions.

## Useful commands

```text
/agents-help /plan /checkpoint /rewind /browser /preview /compact /gallery
/ship /parallel /research /publish
```

```bash
npm run lab:background -- --workspace ~/Projects/app --prompt "…"
npm run lab:fleet -- enqueue --workspace ~/Projects/app --prompt "A" --prompt "B"
npm run lab:browser:setup
npm run lab:browser -- http://127.0.0.1:3100
```

## Safety

- Workspace credential files are masked; use `safe-git.mjs` / `safe-remove.mjs`
- Tool lifecycle plugin audits/blocks dangerous bash and credential paths
- OpenCode has no direct outbound network; model, browser, research, design,
  preview, publishing, and approved downloads cross fixed-purpose relays
- Host browser relays require the current scoped launch capability and run under
  macOS seatbelt when available
- Sessions, configuration, caches, and optional-service state use project-ID
  namespaced volumes, so one project cannot inherit another project's state
- Gallery, browser, preview, quality, GitHub, and companion helpers are reused
  only when their reported project ID and workspace hash match the launch
- Container: `read_only`, `cap_drop: ALL`, `no-new-privileges`, optional bwrap

The supported trust boundaries, attacker model, and known experimental limits
are documented in the [threat model](docs/threat-model.md). The public core has
no outbound product telemetry in v0.x. Company-specific agents, destinations,
credentials, evaluation cases, and operating policy belong in private packs;
see the [public/private product boundary](docs/product-boundary.md).

## Verify

```bash
npm run test:lab
npm run quality:test   # broader Lab + quality suite
npm run provenance:check
npm run release:test
```

Public release candidates are exported from the private development repository
as a provenance-checked allowlisted tree with one new root commit. See
`docs/public-release.md`. Original contributions are Apache-2.0; retained
upstream notices are in `THIRD_PARTY_NOTICES.md`.

## Community and support

- Security reports: [SECURITY.md](SECURITY.md)
- Supported versions and help: [SUPPORT.md](SUPPORT.md)
- Contributions and DCO sign-off: [CONTRIBUTING.md](CONTRIBUTING.md)
- Community standards: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- Proposed design changes: [RFC template](docs/rfcs/0000-template.md)
- Release history: [CHANGELOG.md](CHANGELOG.md)

## Layout

```text
.opencode/          Generic agents, commands, plugins, and skills
docker-compose.opencode.yml
Dockerfile.opencode
docker/agent-gateway/   Credential gateway
docker/opencode-preview/
scripts/opencode.mjs    Launcher
scripts/lab/            Checkpoints, browser, fleet, sandbox
scripts/quality*/       Managed runs
quality/                Generic contracts + model routing
docs/packs.md           Versioned external pack contract
docs/agent-safety.md
docs/lab/
```

## License

Apache-2.0 for original OpenCode Lab contributions. See
`THIRD_PARTY_NOTICES.md` and `provenance/files.json` for retained upstream
attributions.
