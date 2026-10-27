// Which build this is, and so which repository the app points at: the
// build's strict check, the running app's lenient read, and the update feed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PRODUCTS, displayName, EDITIONS, buildEdition, readEdition, editionFeed, rememberedEdition, kitEdition, editionLine, buildEnvText, readBuildEnv,
  PRODUCTION_UPDATE_URL } from "./edition.js";

// A payload folder, with an EDITION file when `edition` is given.
function payload(edition) {
  const dir = mkdtempSync(join(tmpdir(), "odedition-"));
  if (edition !== undefined) writeFileSync(join(dir, "EDITION"), edition);
  return dir;
}

test("only the open-source edition names a repository", () => {
  assert.deepEqual(EDITIONS, { opensource: "stronghamjji/PersoDub", production: "" });
});

test("the build takes a known edition, and unset or empty is the open-source one", () => {
  assert.equal(buildEdition({ PERSODUB_EDITION: "production" }), "production");
  assert.equal(buildEdition({ PERSODUB_EDITION: "opensource" }), "opensource");
  assert.equal(buildEdition({}), "opensource");
  assert.equal(buildEdition({ PERSODUB_EDITION: "" }), "opensource");
});

test("the build stops on an unknown edition and names the ones it knows", () => {
  assert.throws(() => buildEdition({ PERSODUB_EDITION: "prod" }),
    { message: 'PERSODUB_EDITION="prod" is not an edition. Use one of: opensource, production.' });
  // A name every object answers to is still not an edition.
  for (const name of ["Production", "constructor", "toString"]) {
    assert.throws(() => buildEdition({ PERSODUB_EDITION: name }), /is not an edition/, name);
  }
});

test("the running app follows the payload's EDITION file, whatever the environment says", () => {
  assert.equal(readEdition({ payloadDir: payload("production\n"), env: { PERSODUB_EDITION: "opensource" } }), "production");
  assert.equal(readEdition({ payloadDir: payload("opensource"), env: { PERSODUB_EDITION: "production" } }), "opensource");
});

test("with no EDITION file the running app reads the environment", () => {
  // npm start has no payload; a payload collected before editions has no file.
  assert.equal(readEdition({ payloadDir: null, env: { PERSODUB_EDITION: "production" } }), "production");
  assert.equal(readEdition({ payloadDir: payload(), env: { PERSODUB_EDITION: "production" } }), "production");
  assert.equal(readEdition({ payloadDir: null, env: {} }), "opensource");
});

test("an unknown edition at run time is the open-source one", () => {
  assert.equal(readEdition({ payloadDir: payload("nonsense"), env: { PERSODUB_EDITION: "production" } }), "opensource");
  assert.equal(readEdition({ payloadDir: payload(""), env: { PERSODUB_EDITION: "production" } }), "opensource");
  assert.equal(readEdition({ payloadDir: null, env: { PERSODUB_EDITION: "constructor" } }), "opensource");
});

test("the open-source edition's update feed is its repository's GitHub Releases, and production's is Perso's folder", () => {
  assert.deepEqual(editionFeed("opensource"), { provider: "github", owner: "stronghamjji", repo: "PersoDub" });
  assert.equal(PRODUCTION_UPDATE_URL, "https://portal-static.perso.ai/public/app/desktop/", "the folder, ending with /");
  assert.deepEqual(editionFeed("production"), { provider: "generic", url: PRODUCTION_UPDATE_URL });
  assert.equal(editionFeed("production", ""), null, "with no address: never the public releases");
  // Any other folder given is the production edition's; the open-source edition never reads it.
  assert.deepEqual(editionFeed("production", "https://downloads.test/persodubbing/"), { provider: "generic", url: "https://downloads.test/persodubbing/" });
  assert.deepEqual(editionFeed("opensource", "https://downloads.test/persodubbing/"), { provider: "github", owner: "stronghamjji", repo: "PersoDub" });
});

test("build.env carries the production build's set values only", () => {
  const env = { PERSODUB_INQUIRY_URL: "", PERSODUB_UPDATE_URL: "https://updates.example/", OTHER: "x" };
  assert.equal(buildEnvText("production", env), "");
  assert.equal(buildEnvText("production", { ...env, PERSODUB_INQUIRY_URL: "https://script.example/exec" }),
    "PERSODUB_INQUIRY_URL=https://script.example/exec\n");
  assert.equal(buildEnvText("opensource", { ...env, PERSODUB_INQUIRY_URL: "https://script.example/exec" }), "");
});

test("the running app reads its build values from the payload's build.env, or the environment without a payload", () => {
  const dir = payload("production");
  writeFileSync(join(dir, "build.env"), "PERSODUB_INQUIRY_URL=https://script.example/exec\n");
  const env = { PERSODUB_INQUIRY_URL: "https://elsewhere.example/exec" };
  assert.deepEqual(readBuildEnv({ payloadDir: dir, env }), { PERSODUB_INQUIRY_URL: "https://script.example/exec" });
  assert.deepEqual(readBuildEnv({ payloadDir: payload("opensource"), env }), {});
  assert.deepEqual(readBuildEnv({ payloadDir: null, env: { ...env, OTHER: "x" } }), env);
});


// A kit's remembered edition: written once at its first run, then kept
// through updates (every packaged app updates from the open-source releases).
function kit(kitEnvText) {
  const dir = mkdtempSync(join(tmpdir(), "odkit-"));
  if (kitEnvText !== undefined) writeFileSync(join(dir, "kit.env"), kitEnvText);
  return dir;
}

test("rememberedEdition writes the running build's edition into a kit.env that has none, once", () => {
  const dir = kit("PERSODUB_KIT_DIR=/x\n");
  assert.equal(rememberedEdition(dir, "production"), "production");
  const text = readFileSync(join(dir, "kit.env"), "utf8");
  assert.ok(text.includes("PERSODUB_KIT_DIR=/x\n"), "keeps what was there");
  assert.ok(text.endsWith("PERSODUB_EDITION=production\n"), text);
  assert.equal(rememberedEdition(dir, "opensource"), "production", "an open-source update does not change it");
  assert.equal(readFileSync(join(dir, "kit.env"), "utf8"), text, "nothing appended twice");
});

test("rememberedEdition keeps a remembered edition over the build's", () => {
  const dir = kit("PERSODUB_EDITION=production\nPERSODUB_KIT_DIR=/x");
  assert.equal(rememberedEdition(dir, "opensource"), "production");
});

test("rememberedEdition falls back to the build without a kit.env, or with an unknown name", () => {
  assert.equal(rememberedEdition(kit(), "opensource"), "opensource");
  assert.equal(rememberedEdition(null, "production"), "production");
  const dir = kit("PERSODUB_EDITION=enterprise\n");
  assert.equal(rememberedEdition(dir, "opensource"), "opensource");
  assert.ok(readFileSync(join(dir, "kit.env"), "utf8").endsWith("PERSODUB_EDITION=opensource\n"));
});

test("kitEdition reads a kit's remembered edition and writes nothing", () => {
  const remembered = kit("PERSODUB_KIT_DIR=/x\nPERSODUB_EDITION=production\n");
  assert.equal(kitEdition(remembered), "production");
  const none = kit("PERSODUB_KIT_DIR=/x\n");
  assert.equal(kitEdition(none), null);
  assert.equal(readFileSync(join(none, "kit.env"), "utf8"), "PERSODUB_KIT_DIR=/x\n", "nothing written");
  assert.equal(kitEdition(kit("PERSODUB_EDITION=enterprise\n")), null);
  assert.equal(kitEdition(kit()), null);
  assert.equal(kitEdition(null), null);
});

test("the EDITION line says what the edition decides and where it came from", () => {
  assert.equal(editionLine("production", "opensource", "kept in kit.env"),
    "EDITION production: dubs default to the Perso API (kept in kit.env; app file: opensource build)");
  assert.equal(editionLine("opensource", "opensource", "first run of this kit, written to kit.env"),
    "EDITION opensource: dubs default to this computer (first run of this kit, written to kit.env; app file: opensource build)");
});

test("the name on screen: PersoDub for the open-source edition, PersoDubbing for the production edition", () => {
  assert.equal(displayName("opensource"), "PersoDub");
  assert.equal(displayName("production"), "PersoDubbing");
  assert.equal(displayName("nonsense"), "PersoDub");
  assert.deepEqual(Object.keys(PRODUCTS).sort(), ["opensource", "production"]);
});
