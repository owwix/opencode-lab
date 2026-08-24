# Restricted Notion publisher

The publisher is intentionally separate from OpenCode. It accepts one fixed
operation: create a Markdown page under a named, preconfigured parent page.
It cannot search, read, update arbitrary pages, proxy arbitrary URLs, or expose a
Notion token to an agent.

1. Create an **internal** Notion connection with **Insert content** capability
   only. Share only the parent pages for approved output categories.
2. Add these ignored values to `opencode.env`:

```dotenv
NOTION_API_TOKEN=ntn_...
NOTION_PUBLISH_TARGETS_JSON={"research":"<parent-page-id>"}
```

3. Start the optional sidecar:

```bash
npm run opencode:notion
```

4. An agent stages research first. After explicit human approval, it may request
   approval for this exact command inside OpenCode:

```bash
node /opencode-config/scripts/notion/publish.mjs --target research --file artifacts/research/result.md --title "Research brief"
```

The client rejects secret paths, links, and files outside `/workspace`. The relay
uses a content-derived idempotency key. If the outcome of a write is unknown, it
returns a conflict and refuses an automatic retry; inspect Notion before resolving
the operation.

An agent can stage content and then request publication, but the actual write is
gated by explicit operator approval. From inside OpenCode use the `/notion`
command:

```text
/notion --target research --file artifacts/research/approved-brief.md --title "Approved research brief"
```

The command checks the path, asks for confirmation, and then invokes the
restricted publisher. The bash invocation remains individually approval-gated
in `opencode.json`.

The Notion API requires a parent page for an internal connection and supports
create-page Markdown content. The integration should have no more than Insert
content capability. See the official [Create a page](https://developers.notion.com/reference/post-page)
and [connection capabilities](https://developers.notion.com/reference/capabilities)
documentation.
