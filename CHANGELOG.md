# Changelog

All notable changes will be documented here. This project follows Keep a
Changelog and uses semantic versioning once releases begin.

## [Unreleased]

### Added

- Shared Node, Python, and monorepo execution adapters consumed by both
  `lab verify` and managed Dagger verification.
- Evidence-backed manual reviewer promotion, immutable run outcomes, operational
  quality metrics, and end-to-end correlation IDs.
- Workflow-pack manifest v2 with declared services, permissions, models,
  contracts, verification, artifacts, and generic coding/research examples.
- Read-only `lab strict doctor` checks for supported macOS, Apple silicon,
  Docker Desktop, and the standalone Docker Sandboxes CLI.
- Clone-isolated `lab strict run` sessions with no shared skills, a generated
  minimal configuration, and a short-lived chat-only gateway capability.
- Fresh strict launches atomically create their host-only capability signer
  without requiring a prior normal Lab session.
- Signed, size-bounded `lab strict export` bundles and explicit, idempotent
  `lab strict adopt --approve` commits bound to the original clean base SHA.
- Apache-2.0 public core with retained upstream notices and file provenance.
- Clean-root public export and full-history secret scans.
- Security, governance, support, contribution, and RFC policies.
- Dependency, SBOM, container, and provenance CI.
- Consistent `lab open`, `new`, `recent`, `status`, `stop`, `resume`, `doctor`,
  and `prune` project-lifecycle commands with v0.x launcher aliases.
- Optional project contract schema v1, bounded auto-detection, approval-gated
  `lab init`, and project-specific external-pack selection.
- Host-owned runtime/config roots, project preflight diagnostics, repository-
  local Git excludes, and credential masks that do not create project files.
- Unified durable run records for foreground, detached, parallel, and fleet
  work, with migrations, heartbeats, bounded retry history, startup
  reconciliation, Git recovery refs, and idempotent external-action receipts.
- Project-scoped `/runs` TUI with evidence-linked quality status and confirmed
  resume, retry, approval, cancellation, archive, cleanup, adoption, and PR
  actions through separate read/operate capabilities.
- Project/run-scoped artifact indexes covering patches, verification, review,
  research, images, browser captures, previews, and PR receipts; deduplicated
  run notifications; and conservative configurable artifact-cache retention.
- `versions.lock` compatibility manifest for pinned components, images,
  schemas, and configuration adapters, plus offline source checks and real
  digest-pinned OpenCode runtime probes.
- Staged `lab version`, `lab update`, and `lab rollback` lifecycle with
  commit-specific candidate images, pre-activation compatibility checks,
  state backups, and an atomic active-release pointer.

### Security

- Safe public defaults use scoped capability leases, fixed-purpose relays,
  project-namespaced state, and approval-gated privileged actions.

## [0.1.0-beta.1] - Unreleased

### Distribution

- Signed-tag release workflow with provenance-allowlisted source archives,
  SHA-256 checksums, CycloneDX source SBOM, OCI image SBOM/provenance, GitHub
  artifact attestations, release notes, and a versioned migration manifest.
- Read-only five-repository dogfood command and privacy-preserving beta cohort
  checklist. Tag publication remains blocked on the Phase 4 release gate.

[Unreleased]: https://github.com/owwix/opencode-lab/commits/main
[0.1.0-beta.1]: https://github.com/owwix/opencode-lab/releases/tag/v0.1.0-beta.1
