import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { venvBin, exeName } from "./platform.js";
import { KIT_ENV } from "./kitEnv.js";
import { MODEL_MARKERS } from "./installSpec.js";

export const REQUIRED = [
  KIT_ENV,
  // venv entrypoints and the ollama binary carry platform-specific layout
  // (bin/x vs Scripts\x.exe, ".exe" suffix) -- see platform.js.
  // The voice sidecar boots from the engines venv since the two were merged.
  venvBin("engines_venv", "uvicorn"),
  venvBin("app_venv", "uvicorn"),
  "sidecar/server.py",
  // The Ollama runtime binary, mirroring installSpec.js's ollama-runtime
  // step. Only the runtime: the big models (Gemma, Whisper, Qwen3-TTS) are
  // optional now, downloaded in-app through the model catalog, so requiring
  // any of them here would bounce every light install back to the installer.
  join("ollama", exeName("ollama")),
  // The always-installed models, taken straight from installSpec's own list
  // rather than copied -- MODEL_MARKERS now carries only those (Demucs), so
  // this boot check covers runtime + always-installed models and nothing more.
  ...MODEL_MARKERS.map((rel) => join(...rel)),
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
