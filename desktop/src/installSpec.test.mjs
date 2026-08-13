import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildSteps, writeKitEnv, PYTHON_URL, PYTHON_SHA256, CAMPPLUS_SHA256,
  OLLAMA_TGZ_SHA256, GEMMA_MODEL, GEMMA_MANIFEST,
} from "./installSpec.js";
import { IS_WIN, venvBin, exeName, TTS_DEVICE } from "./platform.js";

// Bundled dependency lists are platform-specific (see buildSteps' reqSuffix).
const REQ_SUFFIX = IS_WIN ? "win" : "mac";

function freshCtx(extra = {}) {
  const base = mkdtempSync(join(tmpdir(), "odspec-"));
  const kitDir = join(base, "kit");
  const payloadDir = join(base, "payload");
  mkdirSync(kitDir, { recursive: true });
  return { base, kitDir, payloadDir, download: async () => {}, extract: async () => {}, run: async () => {}, ...extra };
}

function makePayload(payloadDir, { campplus = true, version = "1.0.0+abc1234" } = {}) {
  mkdirSync(join(payloadDir, "app-repo", "app"), { recursive: true });
  writeFileSync(join(payloadDir, "app-repo", "app", "main.py"), "# app");
  writeFileSync(join(payloadDir, "app-repo", "requirements.txt"), "fastapi");
  mkdirSync(join(payloadDir, "kit-src", "sidecar"), { recursive: true });
  writeFileSync(join(payloadDir, "kit-src", "sidecar", "server.py"), "# sidecar");
  writeFileSync(join(payloadDir, "kit-src", `requirements_engines_${REQ_SUFFIX}.txt`), "torch");
  writeFileSync(join(payloadDir, "kit-src", `requirements_qwen_${REQ_SUFFIX}.txt`), "uvicorn");
  if (campplus) writeFileSync(join(payloadDir, "campplus.onnx"), "onnx");
  writeFileSync(join(payloadDir, "KIT_VERSION"), version);
}

const byId = (ctx) => Object.fromEntries(buildSteps(ctx).map((s) => [s.id, s]));

test("returns the 10 steps in install order", () => {
  const ids = buildSteps(freshCtx()).map((s) => s.id);
  assert.deepEqual(ids, [
    "payload", "python", "venv-app", "venv-engines", "ffmpeg", "venv-qwen",
    "models", "gemma", "nonverbal-weights", "kit-env",
  ]);
});

test("gemma step downloads the runtime once, then only pulls", async () => {
  const calls = { download: [], pull: [] };
  const ctx = freshCtx({
    download: async (url, dest, opts) => { calls.download.push([url, opts.sha256]); writeFileSync(dest, "tgz"); },
    extract: async (_file, dest) => { mkdirSync(dest, { recursive: true }); writeFileSync(join(dest, exeName("ollama")), "bin"); },
    pullOllama: async (args) => calls.pull.push(args),
  });
  const step = byId(ctx).gemma;
  assert.equal(step.isDone(), false);
  await step.run(() => {});
  assert.equal(calls.download.length, 1);
  assert.equal(calls.download[0][1], OLLAMA_TGZ_SHA256);
  assert.equal(calls.pull.length, 1);
  assert.equal(calls.pull[0].model, GEMMA_MODEL);
  assert.ok(calls.pull[0].bin.endsWith(exeName("ollama")));
  assert.ok(calls.pull[0].modelsDir.includes(join("models", "ollama")));
  // Second run: runtime already extracted -- no re-download, still pulls.
  await step.run(() => {});
  assert.equal(calls.download.length, 1);
  assert.equal(calls.pull.length, 2);
});

test("gemma step is done only when BOTH the manifest and the ollama binary exist", () => {
  // engineCheck requires ollama/ollama at boot, so a manifest-only isDone
  // marked a boot-failing install "done" and never re-downloaded the binary.
  const ctx = freshCtx();
  assert.equal(byId(ctx).gemma.isDone(), false);
  const manifest = join(ctx.kitDir, ...GEMMA_MANIFEST);
  mkdirSync(join(manifest, ".."), { recursive: true });
  writeFileSync(manifest, "{}");
  assert.equal(byId(ctx).gemma.isDone(), false);  // binary still missing
  mkdirSync(join(ctx.kitDir, "ollama"), { recursive: true });
  writeFileSync(join(ctx.kitDir, "ollama", exeName("ollama")), "");
  assert.equal(byId(ctx).gemma.isDone(), true);
});

test("payload step copies bundle including campplus and marks done", async () => {
  const ctx = freshCtx();
  makePayload(ctx.payloadDir);
  const step = byId(ctx).payload;
  assert.equal(await step.isDone(), false);
  await step.run(() => {});
  assert.ok(existsSync(join(ctx.kitDir, "app", "app", "main.py")));
  assert.ok(existsSync(join(ctx.kitDir, "sidecar", "server.py")));
  assert.ok(existsSync(join(ctx.kitDir, `requirements_engines_${REQ_SUFFIX}.txt`)));
  assert.ok(existsSync(join(ctx.kitDir, "models", "campplus", "campplus.onnx")));
  assert.equal(await step.isDone(), true);
});

test("payload step downloads campplus when the bundle lacks it", async () => {
  // The 27MB model is now on HF under Apache-2.0 (welcomyou export), so a
  // from-source build no longer silently loses speaker diarization.
  const calls = [];
  const ctx = freshCtx({ download: async (url, dest, opts) => { calls.push([url, opts.sha256]); writeFileSync(dest, "onnx"); } });
  makePayload(ctx.payloadDir, { campplus: false });
  await byId(ctx).payload.run(() => {});
  assert.equal(calls.length, 1);
  assert.ok(calls[0][0].includes("campplus"), calls[0][0]);
  assert.equal(calls[0][1], CAMPPLUS_SHA256);
  assert.ok(existsSync(join(ctx.kitDir, "models", "campplus", "campplus.onnx")));
});

test("payload step does not download campplus when bundled", async () => {
  const calls = [];
  const ctx = freshCtx({ download: async (...a) => { calls.push(a); } });
  makePayload(ctx.payloadDir);
  await byId(ctx).payload.run(() => {});
  assert.equal(calls.length, 0);
});

test("payload step copies KIT_VERSION into the kit root", async () => {
  const ctx = freshCtx();
  makePayload(ctx.payloadDir, { version: "2.3.4+deadbee" });
  const step = byId(ctx).payload;
  await step.run(() => {});
  assert.equal(readFileSync(join(ctx.kitDir, "KIT_VERSION"), "utf8"), "2.3.4+deadbee");
});

test("payload step is not done when the kit's KIT_VERSION is stale", async () => {
  const ctx = freshCtx();
  makePayload(ctx.payloadDir, { version: "2.0.0" });
  writeFileSync(join(ctx.kitDir, "KIT_VERSION"), "1.0.0"); // stale, from a previous install
  const step = byId(ctx).payload;
  assert.equal(await step.isDone(), false);
});

// engineCheck.js's readKitVersion trims; this isDone check must match it, or a
// trailing-newline difference between the two KIT_VERSION files (no change in
// the version itself) spuriously reports a matching version as stale.
test("payload step is done when KIT_VERSION matches except for surrounding whitespace", async () => {
  const ctx = freshCtx();
  makePayload(ctx.payloadDir, { version: "2.0.0" });
  writeFileSync(join(ctx.payloadDir, "KIT_VERSION"), "2.0.0\n");
  writeFileSync(join(ctx.kitDir, "KIT_VERSION"), "2.0.0");
  const step = byId(ctx).payload;
  assert.equal(await step.isDone(), true);
});

test("payload step overwrites stale app code and KIT_VERSION on re-run", async () => {
  const ctx = freshCtx();
  makePayload(ctx.payloadDir, { version: "2.0.0" });
  mkdirSync(join(ctx.kitDir, "app", "app"), { recursive: true });
  writeFileSync(join(ctx.kitDir, "app", "app", "main.py"), "# OLD stale code");
  writeFileSync(join(ctx.kitDir, "KIT_VERSION"), "1.0.0");
  const step = byId(ctx).payload;
  await step.run(() => {});
  assert.equal(readFileSync(join(ctx.kitDir, "app", "app", "main.py"), "utf8"), "# app");
  assert.equal(readFileSync(join(ctx.kitDir, "KIT_VERSION"), "utf8"), "2.0.0");
  assert.equal(await step.isDone(), true);
});

test("python step downloads pinned URL and extracts", async () => {
  const calls = [];
  const ctx = freshCtx({
    download: async (url, dest, opts) => { calls.push([url, opts.sha256]); writeFileSync(dest, "tar"); },
    extract: async (_file, destDir) => {
      mkdirSync(join(destDir, "python", "bin"), { recursive: true });
      writeFileSync(join(destDir, "python", "bin", "python3.11"), "");
    },
  });
  const step = byId(ctx).python;
  assert.equal(await step.isDone(), false);
  await step.run(() => {});
  assert.deepEqual(calls, [[PYTHON_URL, PYTHON_SHA256]]);
  assert.ok(existsSync(join(ctx.kitDir, "python", "bin", "python3.11")));
  assert.equal(await step.isDone(), true);
});

test("venv-app runs venv + pip installs and marks done", async () => {
  const argvs = [];
  const ctx = freshCtx({ run: async (argv) => { argvs.push(argv.join(" ")); } });
  const step = byId(ctx).venvApp ?? byId(ctx)["venv-app"];
  assert.equal(await step.isDone(), false);
  await step.run(() => {});
  assert.ok(argvs.some((a) => a.includes("-m venv") && a.includes("app_venv")));
  assert.ok(argvs.some((a) => a.includes("install -r") && a.includes("requirements.txt")));
  assert.equal(await step.isDone(), true);
});

// transformers pins huggingface-hub <1.0; an unbounded -U upgrade pulls 1.x and
// breaks the sidecar at import time. 0.34 is the first release with the hf CLI.
test("venv-qwen keeps huggingface_hub below 1.0", async () => {
  const argvs = [];
  const ctx = freshCtx({ run: async (argv) => { argvs.push(argv.join(" ")); } });
  await byId(ctx)["venv-qwen"].run(() => {});
  const hub = argvs.filter((a) => a.includes("huggingface_hub"));
  assert.equal(hub.length, 1);
  assert.ok(hub[0].includes("huggingface_hub>=0.34,<1.0"), `unpinned: ${hub[0]}`);
});

test("ffmpeg step copies binaries reported by static-ffmpeg", async () => {
  const ctx = freshCtx();
  const f1 = join(ctx.base, "real-ffmpeg");
  const f2 = join(ctx.base, "real-ffprobe");
  writeFileSync(f1, "ffmpeg-bytes");
  writeFileSync(f2, "ffprobe-bytes");
  ctx.run = async (_argv, { onLine } = {}) => { onLine?.(JSON.stringify([f1, f2])); };
  const step = byId(ctx).ffmpeg;
  assert.equal(await step.isDone(), false);
  await step.run(() => {});
  // Copied (not symlinked -- Windows needs admin for symlinks) into the kit's
  // bin/ under the platform's executable name (.exe suffix on Windows).
  assert.equal(readFileSync(join(ctx.kitDir, "bin", exeName("ffmpeg")), "utf8"), "ffmpeg-bytes");
  assert.equal(readFileSync(join(ctx.kitDir, "bin", exeName("ffprobe")), "utf8"), "ffprobe-bytes");
  assert.equal(await step.isDone(), true);
});

test("models step skips models whose marker exists", async () => {
  const ctx = freshCtx();
  mkdirSync(join(ctx.kitDir, "models", "demucs", "HTDemucs"), { recursive: true });
  writeFileSync(join(ctx.kitDir, "models", "demucs", "HTDemucs", "955717e8.safetensors"), "done");
  const hfCalls = [];
  ctx.run = async (argv) => {
    hfCalls.push(argv);
    const dirIdx = argv.indexOf("--local-dir") + 1;
    const dir = argv[dirIdx];
    mkdirSync(dir, { recursive: true });
    if (dir.includes("whisper")) writeFileSync(join(dir, "model.bin"), "");
    if (dir.includes("qwen3-tts")) writeFileSync(join(dir, "config.json"), "");
  };
  const step = byId(ctx).models;
  assert.equal(await step.isDone(), false);
  await step.run(() => {});
  assert.equal(hfCalls.length, 2, "demucs must be skipped");
  assert.ok(hfCalls.every((a) => !a.join(" ").includes("HTDemucs")));
  assert.equal(await step.isDone(), true);
});

// A missing "base" model means every laugh/breath in a dub gets silently
// deleted later (nonverbal.py fail-closes when whisper can't load) -- so
// this step must actually fail the install, not be skipped quietly.
function withXdgCache(dir, fn) {
  const prev = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = dir;
  return Promise.resolve(fn()).finally(() => {
    if (prev === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = prev;
  });
}

test("nonverbal-weights step is skipped when the whisper cache already has base.pt", async () => {
  const ctx = freshCtx();
  const cacheDir = mkdtempSync(join(tmpdir(), "odcache-"));
  await withXdgCache(cacheDir, async () => {
    mkdirSync(join(cacheDir, "whisper"), { recursive: true });
    writeFileSync(join(cacheDir, "whisper", "base.pt"), "weights");
    const step = byId(ctx)["nonverbal-weights"];
    assert.equal(await step.isDone(), true);
  });
});

test("nonverbal-weights step runs the prefetch when the cache is missing", async () => {
  const ctx = freshCtx();
  const cacheDir = mkdtempSync(join(tmpdir(), "odcache-"));
  const calls = [];
  ctx.run = async (argv) => { calls.push(argv); };
  await withXdgCache(cacheDir, async () => {
    const step = byId(ctx)["nonverbal-weights"];
    assert.equal(await step.isDone(), false);
    await step.run(() => {});
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], venvBin(join(ctx.kitDir, "engines_venv"), "python"));
    assert.ok(calls[0].join(" ").includes("whisper.load_model"), calls[0].join(" "));
  });
});

test("nonverbal-weights step failure fails the install, not silently skipped", async () => {
  const ctx = freshCtx();
  const cacheDir = mkdtempSync(join(tmpdir(), "odcache-"));
  ctx.run = async () => { throw new Error("python exit 1"); };
  await withXdgCache(cacheDir, async () => {
    const step = byId(ctx)["nonverbal-weights"];
    await assert.rejects(step.run(() => {}), /python exit 1/);
  });
});

test("kit-env step writes template with kit paths", async () => {
  const ctx = freshCtx();
  const step = byId(ctx)["kit-env"];
  assert.equal(await step.isDone(), false);
  await step.run(() => {});
  const env = readFileSync(join(ctx.kitDir, "kit.env"), "utf8");
  for (const key of [
    "SEP_PYTHON", "STT_PYTHON", "DIAR_PYTHON", "QWEN_SCORER_PYTHON",
    "SEP_MODEL_DIR", "WHISPER_MODEL_DIR", "PERSODUB_CAMPPLUS_MODEL", "QWEN_CAMPPLUS_MODEL",
    "QWEN_TTS_URL", "QWEN_TTS_MODEL", "QWEN_TTS_DEVICE", "PERSODUB_APP_REPO_DIR",
    "PERSODUB_KIT_DIR", "PERSODUB_BIN_DIR",
    // Without this the laughter/breath whitelist falls back to the system
    // python3, finds no openai-whisper, and fail-closes every candidate.
    "NONVERBAL_WHISPER_PYTHON",
    // Stage-5/6 dark-launch mode + Mac-CPU-calibrated worker timeouts.
    "PERSODUB_LEAKAGE_GATE", "PERSODUB_SCORER_ASR_TIMEOUT", "PERSODUB_TTS_TIMEOUT", "PERSODUB_DIAR_TIMEOUT",
  ]) assert.ok(env.includes(key), `missing ${key}`);
  // Deliberately absent: the backend resolves the workspace id from the API
  // key itself and the media host has a public default (app/perso_client.py),
  // so the installer must not pin another account's values into kit.env.
  assert.ok(!env.includes("PERSO_SPACE_SEQ"), "PERSO_SPACE_SEQ must not be written by the installer");
  assert.ok(!env.includes("PERSO_MEDIA_HOST"), "PERSO_MEDIA_HOST must not be written by the installer");
  assert.ok(env.includes(ctx.kitDir));
  assert.ok(env.includes(`QWEN_TTS_DEVICE=${TTS_DEVICE}`));
  assert.equal(await step.isDone(), true);
});

// I1: isDone used to sniff only PERSODUB_KIT_DIR, so any kit.env from before
// these keys existed satisfied it forever and the 4 new keys never reached
// upgraders. The fix must merge them in without disturbing anything else --
// app/settings_env.py writes user API keys into this same file.
test("kit-env step appends missing managed keys to a legacy kit.env, preserving existing lines", async () => {
  const ctx = freshCtx();
  mkdirSync(ctx.kitDir, { recursive: true });
  const legacy = "PERSODUB_KIT_DIR=/old/kit\nGEMINI_API_KEY=sk-legacy-key\n";
  writeFileSync(join(ctx.kitDir, "kit.env"), legacy);
  const step = byId(ctx)["kit-env"];
  assert.equal(await step.isDone(), false); // missing the 4 new keys

  await step.run(() => {});

  const env = readFileSync(join(ctx.kitDir, "kit.env"), "utf8");
  assert.ok(env.includes("PERSODUB_KIT_DIR=/old/kit"), "existing line must survive");
  assert.ok(env.includes("GEMINI_API_KEY=sk-legacy-key"), "user API key must survive");
  for (const key of ["PERSODUB_LEAKAGE_GATE=measure", "PERSODUB_SCORER_ASR_TIMEOUT=60",
                      "PERSODUB_TTS_TIMEOUT=900", "PERSODUB_DIAR_TIMEOUT=1800"]) {
    assert.ok(env.includes(key), `missing ${key}`);
  }
  assert.ok(!env.includes("PERSO_SPACE_SEQ"), "upgrade must not pin a workspace id");
  assert.equal(await step.isDone(), true);
});

test("kit-env step run is a no-op once a legacy kit.env already has all managed keys", async () => {
  const ctx = freshCtx();
  mkdirSync(ctx.kitDir, { recursive: true });
  writeFileSync(join(ctx.kitDir, "kit.env"), "PERSODUB_KIT_DIR=/old/kit\nGEMINI_API_KEY=sk-legacy-key\n");
  const step = byId(ctx)["kit-env"];
  await step.run(() => {});
  const afterFirstRun = readFileSync(join(ctx.kitDir, "kit.env"), "utf8");

  await step.run(() => {}); // second run: nothing left to add

  assert.equal(readFileSync(join(ctx.kitDir, "kit.env"), "utf8"), afterFirstRun);
});

test("kit-env step fresh-install path is unchanged (no existing file -> full template)", async () => {
  const ctx = freshCtx();
  const step = byId(ctx)["kit-env"];
  await step.run(() => {});
  assert.equal(readFileSync(join(ctx.kitDir, "kit.env"), "utf8"), writeKitEnv({ kitDir: ctx.kitDir }));
});

test("writeKitEnv substitutes kitDir everywhere", () => {
  const kitDir = "/K";
  const k = (...p) => join(kitDir, ...p);
  const s = writeKitEnv({ kitDir });
  // Expected paths carry each platform's venv layout and separators.
  assert.ok(s.includes(venvBin(k("engines_venv"), "python")));
  assert.ok(s.includes(`PERSODUB_APP_REPO_DIR=${k("app")}`));
  assert.ok(s.includes(`PERSODUB_BIN_DIR=${k("bin")}`));
});

// gate=measure: log leakage, never rewrite the mix, until validated on Mac.
// Timeouts are Mac-CPU-calibrated versions of backend defaults 15/300/600.
test("writeKitEnv includes the leakage-gate and worker-timeout additions", () => {
  const s = writeKitEnv({ kitDir: "/K" });
  assert.ok(s.includes("PERSODUB_LEAKAGE_GATE=measure"));
  assert.ok(s.includes("PERSODUB_SCORER_ASR_TIMEOUT=60"));
  assert.ok(s.includes("PERSODUB_TTS_TIMEOUT=900"));
  assert.ok(s.includes("PERSODUB_DIAR_TIMEOUT=1800"));
});
