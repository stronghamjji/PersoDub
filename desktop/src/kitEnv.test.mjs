import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseEnvFile, KIT_ENV, LEGACY_KIT_ENV, migrateKitEnv } from "./kitEnv.js";

// --- mac.env -> kit.env ---------------------------------------------------

function kit() {
  const d = mkdtempSync(join(tmpdir(), "odkit-"));
  mkdirSync(join(d, "sub"), { recursive: true });
  return d;
}

test("an existing kit's mac.env becomes kit.env, contents intact", () => {
  // The file holds the user's API keys, so this is a rename and never a
  // rewrite. It also has to happen before checkKit looks for kit.env, or an
  // installed kit reads as missing and gets re-downloaded whole.
  const d = kit();
  const body = "PERSODUB_KIT_DIR=/k\nPERSO_API_KEY=secret-value\n";
  writeFileSync(join(d, LEGACY_KIT_ENV), body);
  assert.equal(migrateKitEnv(d), true);
  assert.equal(existsSync(join(d, LEGACY_KIT_ENV)), false);
  assert.equal(readFileSync(join(d, KIT_ENV), "utf8"), body);
});

test("a kit that already has kit.env is left alone", () => {
  const d = kit();
  writeFileSync(join(d, KIT_ENV), "NEW=1\n");
  writeFileSync(join(d, LEGACY_KIT_ENV), "OLD=1\n");
  assert.equal(migrateKitEnv(d), false);
  assert.equal(readFileSync(join(d, KIT_ENV), "utf8"), "NEW=1\n");
});

test("a kit with neither file is not a failure", () => {
  // The normal path on a first install: nothing to migrate, nothing to report.
  assert.equal(migrateKitEnv(kit()), false);
  assert.equal(migrateKitEnv(join(tmpdir(), "odkit-does-not-exist")), false);
});

test("parses KEY=value lines, skipping comments and blanks", () => {
  const text = [
    "# comment",
    "",
    "PERSODUB_APP_REPO_DIR=/Users/me/persodub",
    'QUOTED="hello world"',
    "SINGLE='x=y'",
    "NOEQUALS_LINE",
    "TRAILING = spaced ",
    'export EXPORTED="/some/path"',
  ].join("\n");
  const env = parseEnvFile(text);
  assert.equal(env.EXPORTED, "/some/path");
  assert.equal(env.PERSODUB_APP_REPO_DIR, "/Users/me/persodub");
  assert.equal(env.QUOTED, "hello world");
  assert.equal(env.SINGLE, "x=y");
  assert.equal(env.TRAILING, "spaced");
  assert.ok(!("NOEQUALS_LINE" in env));
  assert.equal(Object.keys(env).length, 5);
});
