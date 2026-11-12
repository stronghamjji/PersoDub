// The packaged app's names (electron-builder.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { builderConfig } from "../electron-builder.js";

test("the build keeps PersoDub's names", () => {
  const c = builderConfig();
  assert.equal(c.productName, "PersoDub");
  assert.equal(c.appId, "com.persodub.desktop");
  assert.deepEqual(c.extraMetadata, { name: "persodub-desktop-shell" });
  assert.equal(c.win.artifactName, "${productName}-Setup-${version}.${ext}");
});

test("the arm64 dmg is copied again as <name>-mac.dmg, and nothing else is", () => {
  const dir = mkdtempSync(join(tmpdir(), "odbuilder-"));
  const dmg = join(dir, "PersoDub-0.9.1-arm64.dmg");
  writeFileSync(dmg, "dmg");
  const zip = join(dir, "PersoDub-0.9.1-arm64-mac.zip");
  const out = builderConfig().afterAllArtifactBuild({ artifactPaths: [dmg, zip] });
  assert.deepEqual(out, [join(dir, "PersoDub-mac.dmg")]);
  assert.equal(readFileSync(out[0], "utf8"), "dmg");
  assert.deepEqual(builderConfig().afterAllArtifactBuild({ artifactPaths: [zip] }), []);
});

test("the build's publish entry is the public releases", () => {
  assert.deepEqual(builderConfig().publish, [{ provider: "github", owner: "stronghamjji", repo: "PersoDub" }]);
});
