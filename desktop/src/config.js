import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = {
  kitDir: join(homedir(), "persodub_full_mac"),
  sidecarPort: 3901,
  sidecarHealthTimeoutMs: 120000,
  backendHealthTimeoutMs: 60000,
  sidecarCmd: null,
  backendCmd: null,
  backendCwd: null,
};

export function loadConfig({ configPath, env = process.env } = {}) {
  const path = configPath ?? join(SRC_DIR, "..", "config.json");
  let fileCfg = {};
  if (existsSync(path)) fileCfg = JSON.parse(readFileSync(path, "utf8"));
  if (fileCfg.kitDir === "") delete fileCfg.kitDir;
  const cfg = { ...DEFAULTS, ...fileCfg };
  if (env.PERSODUB_KIT_DIR) cfg.kitDir = env.PERSODUB_KIT_DIR;
  return cfg;
}
