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

import { envWithKit } from "./kitEnv.js";

test("the user's switches are kit.env laid over the process's environment, read fresh every time", () => {
  const d = kit();
  assert.equal(envWithKit(d), process.env, "no kit.env: the process's own");
  assert.equal(envWithKit(null), process.env, "no kit at all: the same");
  writeFileSync(join(d, KIT_ENV), "PERSODUB_NO_REPORTS=1\n");
  assert.equal(envWithKit(d).PERSODUB_NO_REPORTS, "1");
  // The rest of the environment is still there, each variable under its own
  // spelling: on Windows process.env answers PATH for "Path", but a copy keeps
  // only the real name, so the check walks the real names (Windows, 2026-10-10).
  const merged = envWithKit(d);
  for (const [name, value] of Object.entries(process.env)) {
    if (name !== "PERSODUB_NO_REPORTS") assert.equal(merged[name], value, `the rest of the environment is still there (${name})`);
  }
  // Settings turned it back: the very next read sees it, no restart.
  writeFileSync(join(d, KIT_ENV), "PERSODUB_NO_REPORTS=0\n");
  assert.equal(envWithKit(d).PERSODUB_NO_REPORTS, "0");
  // A kit.env that cannot be read is no kit.env, never an error.
  const unreadable = kit();
  mkdirSync(join(unreadable, KIT_ENV));
  assert.equal(envWithKit(unreadable), process.env);
});

import { setKitEnvValue, withKitEnvValue } from "./kitEnv.js";

// The engine writes this file too (app/settings_env.py update_env_text), so the
// shell's one writer -- the folder the Download dialog's Change picks -- does it
// the same way: one line in force, every other line as it was.
test("withKitEnvValue sets the key's line, commented out or not, and leaves every other line", () => {
  const text = "PERSODUB_KIT_DIR=/k\n# PERSODUB_DOWNLOAD_DIR=/old\nPERSO_API_KEY=secret-value\n";
  assert.equal(withKitEnvValue(text, "PERSODUB_DOWNLOAD_DIR", "/Volumes/Work SSD"),
    "PERSODUB_KIT_DIR=/k\nPERSODUB_DOWNLOAD_DIR=/Volumes/Work SSD\nPERSO_API_KEY=secret-value\n");
  // Not there yet: added at the end. Emptied: a line of its own, not no line.
  assert.equal(withKitEnvValue("A=1", "PERSODUB_DOWNLOAD_DIR", "D:\\Work"), "A=1\nPERSODUB_DOWNLOAD_DIR=D:\\Work\n");
  assert.equal(withKitEnvValue("PERSODUB_DOWNLOAD_DIR=D:\\Work\n", "PERSODUB_DOWNLOAD_DIR", ""), "PERSODUB_DOWNLOAD_DIR=\n");
  // A key that only starts the same is another key; Windows line ends read as lines.
  assert.equal(withKitEnvValue("PERSODUB_DOWNLOAD_DIRS=x\r\nB=2\r\n", "PERSODUB_DOWNLOAD_DIR", "/a"),
    "PERSODUB_DOWNLOAD_DIRS=x\nB=2\nPERSODUB_DOWNLOAD_DIR=/a\n");
  assert.equal(parseEnvFile(withKitEnvValue("", "K", "/a=b")).K, "/a=b");
});

test("setKitEnvValue writes kit.env, keeps the file as it was beside it, and takes one line of text only", () => {
  const d = kit();
  writeFileSync(join(d, KIT_ENV), "PERSO_API_KEY=secret-value\n");
  setKitEnvValue(d, "PERSODUB_DOWNLOAD_DIR", "/Volumes/작업용 SSD");
  assert.equal(readFileSync(join(d, KIT_ENV), "utf8"), "PERSO_API_KEY=secret-value\nPERSODUB_DOWNLOAD_DIR=/Volumes/작업용 SSD\n");
  assert.equal(readFileSync(join(d, `${KIT_ENV}.bak`), "utf8"), "PERSO_API_KEY=secret-value\n");
  assert.equal(existsSync(join(d, `${KIT_ENV}.tmp`)), false, "written through a copy that is renamed into place");
  assert.equal(envWithKit(d).PERSODUB_DOWNLOAD_DIR, "/Volumes/작업용 SSD");
  // A line break would write a line of its own into the engine's settings.
  assert.throws(() => setKitEnvValue(d, "PERSODUB_DOWNLOAD_DIR", "/a\nPERSO_API_KEY=stolen"), /one line of text/);
  assert.equal(envWithKit(d).PERSO_API_KEY, "secret-value");
  // No kit.env: nothing is made, and the caller hears so.
  assert.throws(() => setKitEnvValue(kit(), "PERSODUB_DOWNLOAD_DIR", "/a"), { code: "ENOENT" });
});
