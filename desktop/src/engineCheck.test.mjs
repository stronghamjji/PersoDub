import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkKit, readKitVersion, REQUIRED } from "./engineCheck.js";
import { exeName, venvBin } from "./platform.js";

function makeKit(paths, { version } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "odkit-"));
  for (const rel of paths) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "");
  }
  if (version !== undefined) writeFileSync(join(dir, "KIT_VERSION"), version);
  return dir;
}

// The engine pack (engines_venv + Demucs) and the ollama-runtime pack are
// installed later on demand (installSpec.js's PACKS); the boot check must
// name only what the base install itself lays down.
test("REQUIRED names the base install's own outputs, not the packs'", () => {
  assert.ok(!REQUIRED.some((p) => String(p).includes("engines_venv")));
  assert.ok(!REQUIRED.some((p) => String(p).includes("ollama")));
  assert.ok(!REQUIRED.some((p) => String(p).includes(join("models", "demucs"))));
  assert.ok(REQUIRED.includes(venvBin("app_venv", "uvicorn")));
  assert.ok(REQUIRED.includes("kit.env"));
  assert.ok(REQUIRED.includes("sidecar/server.py"));
  assert.ok(REQUIRED.includes(join("models", "campplus", "campplus.onnx")));
});

test("complete kit with matching KIT_VERSION passes", () => {
  const dir = makeKit(REQUIRED, { version: "1.0.0+abc1234" });
  assert.deepEqual(checkKit(dir, "1.0.0+abc1234"), { ok: true, missing: [] });
});

test("complete kit with mismatching KIT_VERSION is not installed", () => {
  const dir = makeKit(REQUIRED, { version: "1.0.0+abc1234" });
  const res = checkKit(dir, "2.0.0+def5678");
  assert.equal(res.ok, false);
  assert.deepEqual(res.missing, []);
});

test("complete kit missing KIT_VERSION (legacy kit) is not installed", () => {
  const dir = makeKit(REQUIRED); // e.g. a hand-installed mac_kit predating this feature
  const res = checkKit(dir, "1.0.0+abc1234");
  assert.equal(res.ok, false);
  assert.deepEqual(res.missing, []);
});

test("missing uvicorn binaries are reported even with a matching version", () => {
  const dir = makeKit(["kit.env", "sidecar/server.py"], { version: "1.0.0+abc1234" });
  const res = checkKit(dir, "1.0.0+abc1234");
  assert.equal(res.ok, false);
  // Derived from REQUIRED (not hard-coded) so the expected paths carry each
  // platform's venv/exe layout -- POSIX bin/uvicorn vs Windows Scripts\uvicorn.exe.
  const present = ["kit.env", "sidecar/server.py"];
  assert.deepEqual(res.missing.sort(), REQUIRED.filter((r) => !present.includes(r)).sort());
});

// The Ollama runtime is a pack now (installSpec.js's PACKS): the boot flow
// only refreshes it when it is already on disk, so a kit that never had it
// -- or lost it -- must still boot, not bounce back to the installer.
test("kit missing the Ollama runtime still boots (it is a pack now)", () => {
  const ollamaRel = join("ollama", exeName("ollama"));
  assert.ok(!REQUIRED.includes(ollamaRel));
  const dir = makeKit(REQUIRED, { version: "1.0.0+abc1234" });
  assert.deepEqual(checkKit(dir, "1.0.0+abc1234"), { ok: true, missing: [] });
});

// The big models (Gemma, Whisper, Qwen3-TTS) are optional now -- downloaded
// in-app by the Python server -- so a kit without any of them must boot
// straight into the app instead of bouncing back to the installer forever.
test("kit without the optional models passes (base install's own files only)", () => {
  assert.ok(!REQUIRED.some((p) => String(p).includes("gemma3")), "Gemma manifest must not be required");
  assert.ok(!REQUIRED.some((p) => String(p).includes("qwen3-tts")), "TTS weights must not be required");
  assert.ok(!REQUIRED.some((p) => String(p).includes(join("models", "whisper"))), "Whisper weights must not be required");
  assert.ok(!REQUIRED.some((p) => String(p).includes("qwen_venv")), "the old voice venv is gone");
  const dir = makeKit(REQUIRED, { version: "1.0.0+abc1234" });
  assert.deepEqual(checkKit(dir, "1.0.0+abc1234"), { ok: true, missing: [] });
});

// Demucs is part of the "engine" pack now -- same reasoning as the Ollama
// runtime above: a kit missing it still boots, since the boot flow only
// refreshes a pack already on disk (a later task adds installing it fresh).
test("kit missing the Demucs weights still boots (it is part of the engine pack now)", () => {
  const weights = join("models", "demucs", "HTDemucs", "955717e8.safetensors");
  assert.ok(!REQUIRED.includes(weights));
  const dir = makeKit(REQUIRED, { version: "1.0.0+abc1234" });
  assert.deepEqual(checkKit(dir, "1.0.0+abc1234"), { ok: true, missing: [] });
});

test("nonexistent kitDir reports everything missing", () => {
  const res = checkKit("/nonexistent/kit", "1.0.0+abc1234");
  assert.equal(res.ok, false);
  assert.equal(res.missing.length, REQUIRED.length);
});

// No expectedVersion available (e.g. a dev checkout with no bundled payload
// to compare against) -- falls back to the pre-versioning 4-file-only check,
// so a plain dev kit still works and the dev loop isn't broken.
test("complete kit passes when no expected version is available (null)", () => {
  const dir = makeKit(REQUIRED); // no KIT_VERSION at all
  assert.deepEqual(checkKit(dir, null), { ok: true, missing: [] });
});

test("complete kit passes when no expected version is available (undefined)", () => {
  const dir = makeKit(REQUIRED);
  assert.deepEqual(checkKit(dir), { ok: true, missing: [] });
});

test("file-presence-only fallback ignores a KIT_VERSION already on the kit", () => {
  const dir = makeKit(REQUIRED, { version: "1.0.0+abc1234" });
  assert.deepEqual(checkKit(dir, null), { ok: true, missing: [] });
});

test("file-presence-only fallback still reports missing files", () => {
  const dir = makeKit(["kit.env", "sidecar/server.py"]);
  const res = checkKit(dir, null);
  assert.equal(res.ok, false);
  const present = ["kit.env", "sidecar/server.py"];
  assert.deepEqual(res.missing.sort(), REQUIRED.filter((r) => !present.includes(r)).sort());
});

test("readKitVersion reads and trims the file", () => {
  const dir = makeKit([]);
  writeFileSync(join(dir, "KIT_VERSION"), "1.2.3+abcdef1\n");
  assert.equal(readKitVersion(dir), "1.2.3+abcdef1");
});

test("readKitVersion returns null when the file is missing", () => {
  const dir = makeKit([]);
  assert.equal(readKitVersion(dir), null);
});

// Important-1 fix: a payload cached by a pre-versioning collect-payload.mjs
// (or any other unreadable KIT_VERSION) must never throw -- an uncaught
// exception here happens before boot()'s try/catch and boot(win) has no
// .catch(), so it would be an unhandled rejection instead of error.html.
test("readKitVersion never throws for a nonexistent directory", () => {
  assert.doesNotThrow(() => readKitVersion("/nonexistent/payload/dir/for/sure"));
  assert.equal(readKitVersion("/nonexistent/payload/dir/for/sure"), null);
});
