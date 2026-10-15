// Which build this is, and so which repository the app points at: the
// build's strict check, the running app's lenient read, and the update feed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EDITIONS, buildEdition, readEdition, editionFeed, rememberedEdition } from "./edition.js";

// A payload folder, with an EDITION file when `edition` is given.
function payload(edition) {
  const dir = mkdtempSync(join(tmpdir(), "odedition-"));
  if (edition !== undefined) writeFileSync(join(dir, "EDITION"), edition);
  return dir;
}

test("both editions name the public repository", () => {
  assert.deepEqual(EDITIONS, { opensource: "stronghamjji/PersoDub", production: "stronghamjji/PersoDub" });
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

test("the installer's mark in the user data folder wins over the payload", () => {
  // desktop/build/installer.nsh writes it when the installer's file name ends
  // in -production.exe; the same signed build then installs as production.
  assert.equal(readEdition({ payloadDir: payload("opensource"), env: {}, userDataDir: payload("production\n") }), "production");
  assert.equal(readEdition({ payloadDir: payload("opensource"), env: {}, userDataDir: payload() }), "opensource");
  assert.equal(readEdition({ payloadDir: null, env: {}, userDataDir: payload("nonsense") }), "opensource");
});

test("an unknown edition at run time is the open-source one", () => {
  assert.equal(readEdition({ payloadDir: payload("nonsense"), env: { PERSODUB_EDITION: "production" } }), "opensource");
  assert.equal(readEdition({ payloadDir: payload(""), env: { PERSODUB_EDITION: "production" } }), "opensource");
  assert.equal(readEdition({ payloadDir: null, env: { PERSODUB_EDITION: "constructor" } }), "opensource");
});

test("each edition's update feed is its repository's GitHub Releases", () => {
  assert.deepEqual(editionFeed("production"), { provider: "github", owner: "stronghamjji", repo: "PersoDub" });
  assert.deepEqual(editionFeed("opensource"), { provider: "github", owner: "stronghamjji", repo: "PersoDub" });
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
