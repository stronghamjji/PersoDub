import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, DEFAULTS, defaultKitDir, kitPathTooLong, KIT_DEEPEST_RELATIVE, WINDOWS_PATH_LIMIT } from "./config.js";

// --- where the kit goes when nothing overrides it -------------------------

test("each platform gets its own conventional application-data directory", () => {
  const home = mkdtempSync(join(tmpdir(), "odhome-"));
  assert.equal(
    defaultKitDir({ platform: "win32", home, env: { LOCALAPPDATA: "C:\\U\\AppData\\Local" } }),
    join("C:\\U\\AppData\\Local", "PersoDub"),
  );
  assert.equal(
    defaultKitDir({ platform: "darwin", home, env: {} }),
    join(home, "Library", "Application Support", "PersoDub"),
  );
  assert.equal(defaultKitDir({ platform: "linux", home, env: {} }), join(home, ".persodub"));
});

test("no platform default carries the word mac in its name", () => {
  const home = mkdtempSync(join(tmpdir(), "odhome-"));
  for (const platform of ["win32", "darwin", "linux"]) {
    const dir = defaultKitDir({ platform, home, env: { LOCALAPPDATA: "C:\\U\\AppData\\Local" } });
    assert.ok(!/persodub_full_mac|mac\b/i.test(dir.replace(home, "")), `${platform}: ${dir}`);
  }
});

test("a kit installed at the old location keeps being used", () => {
  // Otherwise updating to this version silently re-downloads 30+ GB.
  const home = mkdtempSync(join(tmpdir(), "odhome-"));
  const legacy = join(home, "persodub_full_mac");
  mkdirSync(legacy);
  for (const platform of ["win32", "darwin", "linux"]) {
    assert.equal(defaultKitDir({ platform, home, env: { LOCALAPPDATA: "C:\\x" } }), legacy);
  }
});

test("ignoreLegacy asks for the fresh-install location instead", () => {
  // main.js uses this when the old kit exists but its version no longer
  // matches: the replacement must not land back in the folder being abandoned.
  const home = mkdtempSync(join(tmpdir(), "odhome-"));
  mkdirSync(join(home, "persodub_full_mac"));
  assert.equal(
    defaultKitDir({ platform: "darwin", home, env: {}, ignoreLegacy: true }),
    join(home, "Library", "Application Support", "PersoDub"),
  );
});

test("Windows falls back to a home-relative AppData when LOCALAPPDATA is unset", () => {
  const home = mkdtempSync(join(tmpdir(), "odhome-"));
  assert.equal(
    defaultKitDir({ platform: "win32", home, env: {} }),
    join(home, "AppData", "Local", "PersoDub"),
  );
});

// --- MAX_PATH preflight ---------------------------------------------------

test("a kit directory that would overrun MAX_PATH is rejected before installing", () => {
  // Windows refuses paths past 260 characters, and the deepest file in the kit
  // sits KIT_DEEPEST_RELATIVE characters below its root. Without this check the
  // install fails midway through unpacking a venv, after the download.
  const room = WINDOWS_PATH_LIMIT - KIT_DEEPEST_RELATIVE;
  const tooLong = "C:\\" + "x".repeat(room);
  const msg = kitPathTooLong(tooLong, "win32");
  assert.ok(msg && msg.includes(String(tooLong.length)), msg);
});

test("a normal Windows kit directory passes the preflight", () => {
  assert.equal(kitPathTooLong("C:\\Users\\someone\\AppData\\Local\\PersoDub", "win32"), null);
});

test("the preflight only applies to Windows", () => {
  const room = WINDOWS_PATH_LIMIT - KIT_DEEPEST_RELATIVE;
  assert.equal(kitPathTooLong("/" + "x".repeat(room), "darwin"), null);
});

test("defaults apply when no config file exists", () => {
  const cfg = loadConfig({ configPath: "/nonexistent/config.json", env: {} });
  assert.equal(cfg.sidecarPort, 3901);
  assert.equal(cfg.sidecarHealthTimeoutMs, 120000);
  assert.equal(cfg.backendHealthTimeoutMs, 60000);
  assert.equal(cfg.kitDir, DEFAULTS.kitDir);
  assert.equal(cfg.sidecarCmd, null);
});

test("config file overrides defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "odcfg-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify({ kitDir: "/custom/kit", sidecarPort: 4000 }));
  const cfg = loadConfig({ configPath: p, env: {} });
  assert.equal(cfg.kitDir, "/custom/kit");
  assert.equal(cfg.sidecarPort, 4000);
});

test("PERSODUB_KIT_DIR env var beats config file", () => {
  const cfg = loadConfig({ configPath: "/nonexistent/config.json", env: { PERSODUB_KIT_DIR: "/env/kit" } });
  assert.equal(cfg.kitDir, "/env/kit");
});

test("empty kitDir in config file is ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "odcfg-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify({ kitDir: "" }));
  assert.equal(loadConfig({ configPath: p, env: {} }).kitDir, DEFAULTS.kitDir);
});
