import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, DEFAULTS } from "./config.js";

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
