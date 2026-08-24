# Compatibility

`versions.lock` is the source of truth for OpenCode Lab's supported runtime
combination. It binds the exact OpenCode and OpenDesign image digests, Hound and
Node versions, state schemas, and configuration-adapter fixtures used by this
checkout.

Run the offline source check after changing a pin, schema, adapter, Dockerfile,
or Compose file:

```bash
npm run compatibility:check
```

Before an update is promoted, exercise the real digest-pinned OpenCode binary
and the supported OpenCode configuration fixture in a networkless container:

```bash
npm run compatibility:runtime
```

The runtime probe may pull the public pinned image if it is absent locally. It
does not receive project files, credentials, or network access while loading
the compatibility fixture. Hound and OpenDesign remain optional profiles; the
default coding launch requires neither.

## Update and rollback

`lab version` reports the checkout commit, compatibility lock, and active staged
release. `lab update [--ref REF]` fetches an exact commit, creates a fresh
temporary checkout, pulls digest-pinned bases, builds every service under
commit-specific candidate tags, verifies the real candidate OpenCode binary and
configuration adapter without network access, and backs up host state. Only
after every step passes does it atomically switch the active-release pointer.

`lab rollback` switches that pointer and image set back to the immediately
previous staged release after taking another state backup. It deliberately does
not overwrite newer state automatically; the reported backup remains available
for an explicit recovery if a schema migration must also be reversed. Releases,
backups, and failed unpublished managed work are never deleted by update or
rollback.
