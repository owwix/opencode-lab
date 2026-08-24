import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createGalleryServer,
  resolveSafeMarketingFile
} from "./gallery-server.mjs";

test("gallery only resolves images under artifacts/marketing", () => {
  const root = join(tmpdir(), `gallery-${Date.now()}`);
  mkdirSync(join(root, "artifacts/marketing/subdir"), { recursive: true });
  writeFileSync(join(root, "artifacts/marketing/ok.png"), "x");
  writeFileSync(join(root, "artifacts/marketing/subdir/nest.webp"), "x");
  writeFileSync(join(root, "secret.png"), "x");
  try {
    assert.equal(resolveSafeMarketingFile(root, "ok.png")?.rel, "ok.png");
    assert.equal(
      resolveSafeMarketingFile(root, "subdir/nest.webp")?.rel,
      "subdir/nest.webp"
    );
    assert.equal(resolveSafeMarketingFile(root, "../secret.png"), null);
    assert.equal(resolveSafeMarketingFile(root, "ok.txt"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gallery health and index stay on loopback marketing files", async () => {
  const root = join(tmpdir(), `gallery-srv-${Date.now()}`);
  mkdirSync(join(root, "artifacts/marketing"), { recursive: true });
  writeFileSync(join(root, "artifacts/marketing/shot.png"), "png");
  const gallery = createGalleryServer(root, {
    port: 0,
    host: "127.0.0.1",
    projectId: "project_gallery_test",
    workspaceHash: "workspace_gallery_test"
  });
  await new Promise((resolve) =>
    gallery.server.listen(0, "127.0.0.1", resolve)
  );
  const { port } = gallery.server.address();
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true,
      service: "lab-gallery",
      projectId: "project_gallery_test",
      workspaceHash: "workspace_gallery_test"
    });
    const index = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.match(html, /shot\.png/u);
    const denied = await fetch(`http://127.0.0.1:${port}/file/../secret.png`);
    assert.equal(denied.status, 404);
    const file = await fetch(`http://127.0.0.1:${port}/file/shot.png`);
    assert.equal(file.status, 200);
    assert.match(file.headers.get("content-type") ?? "", /image\/png/u);
  } finally {
    await new Promise((resolve) => gallery.server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
