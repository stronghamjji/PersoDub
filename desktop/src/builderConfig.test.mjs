// The packaged app's names follow the edition it carries (electron-builder.js):
// the production edition installs as PersoDubbing beside PersoDub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { builderConfig } from "../electron-builder.js";

test("the open-source build keeps PersoDub's names", () => {
  const c = builderConfig("opensource");
  assert.equal(c.productName, "PersoDub");
  assert.equal(c.appId, "com.persodub.desktop");
  assert.deepEqual(c.extraMetadata, { name: "persodub-desktop-shell" });
  assert.equal(c.win.artifactName, "${productName}-Setup-${version}.${ext}");
});

test("the production build is PersoDubbing, with its own app id and data folder", () => {
  const c = builderConfig("production");
  assert.equal(c.productName, "PersoDubbing");
  assert.equal(c.appId, "ai.perso.desktopapp");
  assert.deepEqual(c.extraMetadata, { name: "perso-desktopapp-shell" });
});

test("the arm64 dmg is copied again as <name>-mac.dmg, and nothing else is", () => {
  const dir = mkdtempSync(join(tmpdir(), "odbuilder-"));
  const dmg = join(dir, "PersoDubbing-0.9.1-arm64.dmg");
  writeFileSync(dmg, "dmg");
  const zip = join(dir, "PersoDubbing-0.9.1-arm64-mac.zip");
  const out = builderConfig("production").afterAllArtifactBuild({ artifactPaths: [dmg, zip] });
  assert.deepEqual(out, [join(dir, "PersoDubbing-mac.dmg")]);
  assert.equal(readFileSync(out[0], "utf8"), "dmg");
  assert.deepEqual(builderConfig("opensource").afterAllArtifactBuild({ artifactPaths: [zip] }), []);
});

test("the production build's publish entry is its own update address, Perso's folder by default", () => {
  assert.deepEqual(builderConfig("production", "https://updates.example/prod/").publish,
    [{ provider: "generic", url: "https://updates.example/prod/" }]);
  assert.deepEqual(builderConfig("production").publish,
    [{ provider: "generic", url: "https://portal-static.perso.ai/public/app/desktop/" }]);
  assert.equal(builderConfig("production", "").publish, null);
  assert.deepEqual(builderConfig("opensource", "https://updates.example/prod/").publish,
    [{ provider: "github", owner: "stronghamjji", repo: "PersoDub" }]);
});
