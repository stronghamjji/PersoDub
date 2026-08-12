import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { venvBin, exeName } from "./platform.js";

export const REQUIRED = [
  "mac.env",
  // venv entrypoints and the ollama binary carry platform-specific layout
  // (bin/x vs Scripts\x.exe, ".exe" suffix) -- see platform.js.
  venvBin("qwen_venv", "uvicorn"),
  venvBin("app_venv", "uvicorn"),
  "sidecar/server.py",
  // Local Gemma translation, the app's default engine. Left out of this list
  // the install's biggest download (~8 GB) was also its only unverified one:
  // a kit that lost the pull partway still passed, so boot never re-ran the
  // installer and no amount of restarting brought local translation back.
  // Paths mirror installSpec.js's ollama step (binary + GEMMA_MANIFEST).
  join("ollama", exeName("ollama")),
  "models/ollama/manifests/registry.ollama.ai/library/gemma3/12b",
];

// Reads a KIT_VERSION file (a kit's own, or the app's bundled payload's --
// both use the same filename at their root). Never throws: a missing or
// unreadable file returns null instead of crashing the caller.
export function readKitVersion(dir) {
  try {
    return readFileSync(join(dir, "KIT_VERSION"), "utf8").trim();
  } catch {
    return null;
  }
}

// A kit only counts as installed if it has the 4 required files AND its
// KIT_VERSION matches expectedVersion (the app's own bundled payload
// version) -- otherwise the app would silently keep running an old kit's
// code snapshot forever. Missing/mismatching version -> not installed.
// When expectedVersion itself is unavailable (null/undefined -- e.g. a dev
// checkout that never ran collect-payload.mjs, so there's no bundled
// payload to compare against), falls back to the pre-versioning 4-file-only
// check; callers should warn when this fallback is taken.
export function checkKit(kitDir, expectedVersion) {
  const missing = REQUIRED.filter((rel) => !existsSync(join(kitDir, rel)));
  if (expectedVersion == null) {
    return { ok: missing.length === 0, missing };
  }
  const actualVersion = readKitVersion(kitDir);
  const ok = missing.length === 0 && actualVersion !== null && actualVersion === expectedVersion;
  return { ok, missing };
}
