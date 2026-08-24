import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function workflowFiles() {
  return readdirSync(path.join(root, ".github/workflows"))
    .filter((file) => /\.ya?ml$/u.test(file))
    .sort();
}

test("open-source governance files and templates are present", () => {
  for (const relativePath of [
    "SECURITY.md",
    "SUPPORT.md",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    "DCO",
    "CHANGELOG.md",
    ".github/CODEOWNERS",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
    "docs/threat-model.md",
    "docs/product-boundary.md",
    "docs/rfcs/0000-template.md"
  ]) {
    assert.equal(existsSync(path.join(root, relativePath)), true, relativePath);
  }
});

test("every GitHub Action is pinned to an immutable commit", () => {
  for (const file of workflowFiles()) {
    const workflow = read(`.github/workflows/${file}`);
    const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gmu)];
    for (const [, action] of uses) {
      if (action.startsWith("./")) continue;
      assert.match(action, /^[^@\s]+@[0-9a-f]{40}$/u, `${file}: ${action}`);
    }
  }
});

test("required public CI is credential-free and paid evaluations are opt-in", () => {
  const required = [
    "agent-quality.yml",
    "sanity-check.yml",
    "secret-history.yml",
    "semgrep.yml",
    "supply-chain.yml"
  ];
  for (const file of required) {
    const workflow = read(`.github/workflows/${file}`).replaceAll(
      "${{ secrets.GITHUB_TOKEN }}",
      ""
    );
    assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./u, file);
  }

  const manual = read(".github/workflows/model-eval.yml");
  assert.match(manual, /workflow_dispatch:/u);
  assert.doesNotMatch(manual, /\npush:|\npull_request:/u);

  const scheduled = read(".github/workflows/scheduled-model-regression.yml");
  assert.match(scheduled, /vars\.AGENT_EVALS_ENABLED\s*==\s*'true'/u);
});

test("public CI covers safety, provenance, dependencies, images, SBOMs, and secrets", () => {
  const quality = read(".github/workflows/agent-quality.yml");
  assert.match(quality, /npm run quality:test/u);
  assert.match(quality, /npm audit --omit=dev --audit-level=high/u);

  const supplyChain = read(".github/workflows/supply-chain.yml");
  assert.match(supplyChain, /npm run provenance:check/u);
  assert.match(supplyChain, /google\/osv-scanner-action/u);
  assert.match(supplyChain, /anchore\/sbom-action/u);
  assert.match(supplyChain, /anchore\/scan-action/u);
  assert.match(supplyChain, /severity-cutoff:\s*critical/u);

  const secrets = read(".github/workflows/secret-history.yml");
  assert.match(secrets, /gitleaks\/gitleaks-action/u);
  assert.match(secrets, /trufflesecurity\/trufflehog/u);
});

test("the credential gateway runtime excludes its unused package manager", () => {
  const dockerfile = read("docker/agent-gateway/Dockerfile");
  assert.match(dockerfile, /rm -rf -- \/usr\/local\/lib\/node_modules\/npm/u);
  assert.match(
    dockerfile,
    /rm -f -- \/usr\/local\/bin\/npm \/usr\/local\/bin\/npx/u
  );
});

test("v0.x public policy forbids product telemetry and documents the private boundary", () => {
  const boundary = read("docs/product-boundary.md");
  assert.match(boundary, /no outbound product telemetry in v0\.x/iu);
  assert.match(boundary, /external versioned pack/iu);
  assert.match(boundary, /company-specific/iu);

  const packageJson = JSON.parse(read("package.json"));
  assert.equal(packageJson.version.startsWith("0."), true);
  assert.doesNotMatch(
    JSON.stringify(packageJson.scripts),
    /telemetry|analytics/iu
  );
  const directPackages = Object.keys({
    ...packageJson.dependencies,
    ...packageJson.devDependencies
  });
  assert.equal(
    directPackages.some((name) =>
      /(?:^|\/)(?:amplitude|mixpanel|posthog|segment|sentry)(?:$|[-/])/iu.test(
        name
      )
    ),
    false
  );
});
