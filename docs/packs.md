# External workflow packs

OpenCode Lab core is product-neutral. Private or public packs can add agents,
commands, skills, themes, managed-run kinds, and quality contracts without
editing the harness.

## Enable packs

Set `OPENCODE_LAB_PACKS` in ignored `opencode.env` to one or more absolute pack
directories separated by the host path delimiter (`:` on macOS/Linux):

```text
OPENCODE_LAB_PACKS=/absolute/path/to/company-pack
```

The launcher reads this value on the host. It validates every manifest and
declared source, then copies only declared files into a fresh, project-scoped,
host-owned config directory. The OpenCode container receives the materialized
files and a non-sensitive UI summary—not host pack paths.

## Manifest v1

Every pack root contains `opencode-lab.pack.json`:

```json
{
  "schemaVersion": 1,
  "id": "example-pack",
  "label": "Example",
  "version": "0.1.0",
  "minimumLabVersion": "1.0.0",
  "resources": [
    { "source": "opencode/agents/slides.md", "target": "agents/slides.md" },
    {
      "source": "opencode/commands/slides.md",
      "target": "commands/slides.md"
    }
  ],
  "managedRuns": {
    "slides": {
      "agent": "slides",
      "aliases": ["presentation"],
      "capabilities": [],
      "model": "cloudflare-ai/@cf/openai/gpt-oss-120b",
      "qualityContract": "coding",
      "taskPatterns": ["slide|presentation"],
      "taskPrefix": "Create slides for: ",
      "tooling": ["research", "design"]
    }
  },
  "qualityContracts": {}
}
```

Resource targets must remain under `agents/`, `commands/`, `skills/`, `themes/`,
or `resources/`. Sources must be regular files inside the pack—symlinks,
traversal, unsupported fields, duplicate IDs, namespace collisions, and
incompatible versions fail closed.

Every managed run must declare its matching `agents/<agent>.md` resource. Its
quality contract must be the built-in `coding` / `research` contract or a
contract declared by the same pack.

Managed-run capabilities are allowlisted. Schema v1 accepts only the `image`
capability and the optional `research` / `design` tooling profiles. Packs do not
receive gateway signing authority, credentials, arbitrary service execution, or
permission-policy write access.

Quality contracts declared by a pack are available to host-managed runs and are
also materialized under
`/opencode-config/.opencode/resources/contracts/<id>.json` for explicit in-agent
verification.
