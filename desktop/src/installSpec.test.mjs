import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildSteps, writeKitEnv, PYTHON_URL, PYTHON_SHA256, CAMPPLUS_SHA256,
  OLLAMA_TGZ_SHA256, bytesStillNeeded, STEP_IDS, MODEL_MARKERS,
  OPTIONAL_MODEL_MARKERS,
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
  if (campplus) writeFileSync(join(payloadDir, "campplus.onnx"), "onnx");
  writeFileSync(join(payloadDir, "KIT_VERSION"), version);
}

const byId = (ctx) => Object.fromEntries(buildSteps(ctx).map((s) => [s.id, s]));

test("returns the 10 steps in install order", () => {
  const ids = buildSteps(freshCtx()).map((s) => s.id);
  assert.deepEqual(ids, [
    "payload", "python", "venv-app", "ffmpeg", "venv-engines", "cleanup-qwen-venv",
    "models", "ollama-runtime", "nonverbal-weights", "kit-env",
  ]);
  assert.deepEqual(ids, STEP_IDS);
});

test("ollama-runtime step downloads and extracts the runtime, never pulls a model", async () => {
  // The Gemma pull moved to the in-app model catalog (the Python server
  // downloads it on first use); the installer lays down the runtime only.
  const calls = { download: [], pull: [] };
  const ctx = freshCtx({
    download: async (url, dest, opts) => { calls.download.push([url, opts.sha256]); writeFileSync(dest, "tgz"); },
    extract: async (_file, dest) => { mkdirSync(dest, { recursive: true }); writeFileSync(join(dest, exeName("ollama")), "bin"); },
    pullOllama: async (args) => calls.pull.push(args),
  });
  const step = byId(ctx)["ollama-runtime"];
  assert.equal(step.isDone(), false);
  await step.run(() => {});
  assert.equal(calls.download.length, 1);
  assert.equal(calls.download[0][1], OLLAMA_TGZ_SHA256);
  assert.equal(calls.pull.length, 0, "the installer must not pull any model");
  assert.equal(step.isDone(), true);
  // Second run: runtime already extracted -- no re-download, still no pull.
  await step.run(() => {});
  assert.equal(calls.download.length, 1);
  assert.equal(calls.pull.length, 0);
});

test("ollama-runtime step is done once the ollama binary exists, no manifest needed", () => {
  const ctx = freshCtx();
  assert.equal(byId(ctx)["ollama-runtime"].isDone(), false);
  mkdirSync(join(ctx.kitDir, "ollama"), { recursive: true });
  writeFileSync(join(ctx.kitDir, "ollama", exeName("ollama")), "");
  assert.equal(byId(ctx)["ollama-runtime"].isDone(), true);
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
  assert.equal(existsSync(join(ctx.kitDir, `requirements_qwen_${REQ_SUFFIX}.txt`)), false,
    "the voice environment's own list is gone -- one engines list now");
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
  assert.ok(argvs.some((a) => a.includes("install --no-cache-dir -r") && a.includes("requirements.txt")));
  assert.equal(await step.isDone(), true);
});

// The 0.4.0 update added `mcp` to requirements.txt and no updated machine ever
// installed it: the venv steps skipped on a bare .ok marker while the payload
// step had just replaced the requirements files, and the script assistant's
// tool server could not start anywhere the app had updated rather than been
// freshly installed. A venv step is only done when its marker records the same
// installs it would run today.
test("venv-app re-runs when its requirements change", async () => {
  const argvs = [];
  const ctx = freshCtx({ run: async (argv) => { argvs.push(argv.join(" ")); } });
  mkdirSync(join(ctx.kitDir, "app"), { recursive: true });
  writeFileSync(join(ctx.kitDir, "app", "requirements.txt"), "fastapi\n");
  const step = byId(ctx)["venv-app"];
  await step.run(() => {});
  assert.equal(await step.isDone(), true);
  const before = argvs.length;
  // An app update rewrites the requirements file -- the step must come back.
  writeFileSync(join(ctx.kitDir, "app", "requirements.txt"), "fastapi\nmcp\n");
  assert.equal(await step.isDone(), false);
  await step.run(() => {});
  assert.ok(argvs.length > before, "the second run never installed anything");
  assert.equal(await step.isDone(), true);
});

test("a bare marker from before the fingerprint counts as not done", async () => {
  const ctx = freshCtx({ run: async () => {} });
  mkdirSync(join(ctx.kitDir, ".install"), { recursive: true });
  writeFileSync(join(ctx.kitDir, ".install", "venv-app.ok"), "");
  assert.equal(await byId(ctx)["venv-app"].isDone(), false);
});

// One engines venv now carries the voice engine too. The hf CLI and
// static-ffmpeg moved to app_venv (requirements.txt), so this step installs
// the engines list and, on Windows, the CUDA torch first -- nothing else.
test("venv-engines installs only the merged engines list", async () => {
  const argvs = [];
  const ctx = freshCtx({ run: async (argv) => { argvs.push(argv.join(" ")); } });
  await byId(ctx)["venv-engines"].run(() => {});
  const installs = argvs.filter((a) => a.includes(" install ") && !a.includes("--upgrade pip"));
  assert.ok(installs.some((a) => a.includes(`requirements_engines_${REQ_SUFFIX}.txt`)));
  assert.ok(!installs.some((a) => a.includes("static-ffmpeg")), "static-ffmpeg belongs to app_venv now");
  assert.ok(!installs.some((a) => a.includes("huggingface_hub")), "hf CLI belongs to app_venv now");
  assert.ok(!argvs.some((a) => a.includes("qwen_venv")), "no second venv is created");
});

test("every pip install runs without the pip cache", async () => {
  // Windows kept a second copy of the 3 GB CUDA torch wheel in %LOCALAPPDATA%\pip
  // -- outside the kit, so no size report ever showed it.
  for (const id of ["venv-app", "venv-engines"]) {
    const argvs = [];
    const ctx = freshCtx({ run: async (argv) => { argvs.push(argv); } });
    await byId(ctx)[id].run(() => {});
    const installs = argvs.filter((a) => a.includes("install") && !a.includes("--upgrade"));
    assert.ok(installs.length > 0, id);
    for (const a of installs) assert.ok(a.includes("--no-cache-dir"), `${id}: ${a.join(" ")}`);
  }
});

test("cleanup-qwen-venv removes the old voice environment and is done once it is gone", async () => {
  const ctx = freshCtx();
  const step = byId(ctx)["cleanup-qwen-venv"];
  assert.equal(await step.isDone(), true, "a fresh kit never had one");
  mkdirSync(join(ctx.kitDir, "qwen_venv", "bin"), { recursive: true });
  writeFileSync(join(ctx.kitDir, "qwen_venv", "bin", "uvicorn"), "");
  assert.equal(await step.isDone(), false);
  await step.run(() => {});
  assert.equal(existsSync(join(ctx.kitDir, "qwen_venv")), false);
  assert.equal(await step.isDone(), true);
});

// The locked-file branch (rmSync throwing EBUSY/EPERM under an antivirus or
// indexer holding a file open, on Windows) is covered by the try/catch below
// but is not portably reproducible in a unit test -- it is exercised
// manually on Windows as part of Task 7's follow-up. This test covers the
// other half of the same contract: run() must be safe to call again and
// again, never throwing, whether or not there is anything left to remove.
test("cleanup-qwen-venv run is a no-op and never throws when qwen_venv is already absent", async () => {
  const ctx = freshCtx();
  const step = byId(ctx)["cleanup-qwen-venv"];
  assert.equal(await step.isDone(), true);
  await assert.doesNotReject(step.run(() => {}));
  assert.equal(await step.isDone(), true);
});

test("python and ollama-runtime steps delete their archives after extracting", async () => {
  const ctx = freshCtx({
    download: async (_url, dest) => writeFileSync(dest, "bytes"),
    extract: async (_file, dest) => {
      mkdirSync(dest, { recursive: true });
      if (dest.endsWith("ollama")) writeFileSync(join(dest, exeName("ollama")), "bin");
    },
  });
  await byId(ctx).python.run(() => {});
  assert.equal(existsSync(join(ctx.kitDir, "downloads", "python.tar.gz")), false);
  await byId(ctx)["ollama-runtime"].run(() => {});
  assert.equal(existsSync(join(ctx.kitDir, "downloads", IS_WIN ? "ollama.zip" : "ollama.tgz")), false);
});

// An antivirus/indexer can hold the archive open (EBUSY/EPERM), which
// { force: true } alone does not swallow (it only ignores ENOENT). The
// step's real work -- extracting -- already succeeded, so a leftover archive
// must never fail the step or force a re-download on the next launch.
test("python step still marks done when the archive delete fails", async () => {
  const ctx = freshCtx({
    download: async (_url, dest) => writeFileSync(dest, "bytes"),
    extract: async (tarball, destDir) => {
      mkdirSync(destDir, { recursive: true });
      // Simulate a locked file: replace the tarball with a non-empty
      // directory, which a non-recursive rmSync cannot remove (EISDIR),
      // even with { force: true }.
      rmSync(tarball, { force: true });
      mkdirSync(tarball, { recursive: true });
      writeFileSync(join(tarball, "locked"), "");
    },
  });
  const step = byId(ctx).python;
  await step.run(() => {});
  assert.equal(await step.isDone(), true, "extract succeeded -- the step must still complete");
  assert.ok(existsSync(join(ctx.kitDir, "downloads", "python.tar.gz")), "left behind since it could not be removed");
});

test("ollama-runtime step still completes when the archive delete fails", async () => {
  const ctx = freshCtx({
    download: async (_url, dest) => writeFileSync(dest, "bytes"),
    extract: async (archive, dest) => {
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, exeName("ollama")), "bin");
      rmSync(archive, { force: true });
      mkdirSync(archive, { recursive: true });
      writeFileSync(join(archive, "locked"), "");
    },
  });
  const step = byId(ctx)["ollama-runtime"];
  await step.run(() => {});
  assert.equal(step.isDone(), true, "extract succeeded -- the step must still complete");
  assert.ok(
    existsSync(join(ctx.kitDir, "downloads", IS_WIN ? "ollama.zip" : "ollama.tgz")),
    "left behind since it could not be removed",
  );
});

test("ffmpeg step copies binaries reported by static-ffmpeg", async () => {
  const ctx = freshCtx();
  const f1 = join(ctx.base, "real-ffmpeg");
  const f2 = join(ctx.base, "real-ffprobe");
  writeFileSync(f1, "ffmpeg-bytes");
  writeFileSync(f2, "ffprobe-bytes");
  let argv0;
  ctx.run = async (argv, { onLine } = {}) => { argv0 = argv[0]; onLine?.(JSON.stringify([f1, f2])); };
  const step = byId(ctx).ffmpeg;
  assert.equal(await step.isDone(), false);
  await step.run(() => {});
  assert.equal(argv0, venvBin(join(ctx.kitDir, "app_venv"), "python"), "ffmpeg is fetched by app_venv, which always exists");
  // Copied (not symlinked -- Windows needs admin for symlinks) into the kit's
  // bin/ under the platform's executable name (.exe suffix on Windows).
  assert.equal(readFileSync(join(ctx.kitDir, "bin", exeName("ffmpeg")), "utf8"), "ffmpeg-bytes");
  assert.equal(readFileSync(join(ctx.kitDir, "bin", exeName("ffprobe")), "utf8"), "ffprobe-bytes");
  assert.equal(await step.isDone(), true);
});

test("models step downloads nothing when the Demucs marker exists", async () => {
  const ctx = freshCtx();
  mkdirSync(join(ctx.kitDir, "models", "demucs", "HTDemucs"), { recursive: true });
  writeFileSync(join(ctx.kitDir, "models", "demucs", "HTDemucs", "955717e8.safetensors"), "done");
  const hfCalls = [];
  ctx.run = async (argv) => { hfCalls.push(argv); };
  const step = byId(ctx).models;
  assert.equal(await step.isDone(), true);
  await step.run(() => {});
  assert.equal(hfCalls.length, 0);
});

test("models step downloads only Demucs and ignores the optional models", async () => {
  // Whisper and Qwen3-TTS moved to the in-app model catalog (the Python
  // server downloads them on first use); the install fetches only the small
  // always-installed model.
  const ctx = freshCtx();
  const hfCalls = [];
  ctx.run = async (argv) => {
    hfCalls.push(argv);
    const dir = argv[argv.indexOf("--local-dir") + 1];
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "955717e8.safetensors"), "");
  };
  const step = byId(ctx).models;
  assert.equal(await step.isDone(), false);
  await step.run(() => {});
  assert.equal(hfCalls.length, 1, "only Demucs is downloaded");
  assert.ok(hfCalls[0].join(" ").includes("HTDemucs"), hfCalls[0].join(" "));
  assert.equal(hfCalls[0][0], venvBin(join(ctx.kitDir, "app_venv"), "hf"), "hf runs from app_venv");
  assert.equal(await step.isDone(), true);
});

test("the boot markers carry only the always-installed model; the optional ones stay exported", () => {
  // engineCheck consumes MODEL_MARKERS as the boot requirement, so it must
  // list only what the install itself lays down (Demucs); the big optional
  // models live in OPTIONAL_MODEL_MARKERS, downloaded in-app by the server.
  assert.deepEqual(MODEL_MARKERS, [["models", "demucs", "HTDemucs", "955717e8.safetensors"]]);
  assert.deepEqual(OPTIONAL_MODEL_MARKERS, [
    ["models", "whisper", "faster-whisper-large-v3", "model.bin"],
    ["models", "qwen3-tts", "model.safetensors"],
    ["models", "qwen3-tts", "speech_tokenizer", "model.safetensors"],
  ]);
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

// --- how much room the remaining steps need -------------------------------

test("every step declares how much room it takes", () => {
  // The free-space preflight sums these. A step with no figure would silently
  // count as free and let an install start that cannot finish.
  for (const s of buildSteps(freshCtx())) {
    assert.equal(typeof s.bytes, "number", `${s.id} has no bytes`);
    assert.ok(s.bytes >= 0, `${s.id} is negative`);
  }
});

test("the whole kit adds up to roughly what the installing screen promises", () => {
  // The screen says "about 3 GB" (runtime with one engines venv + the small
  // always-installed models; Windows runs larger for its CUDA torch wheels).
  // If this drifts back toward the old 18 GB, a big model crept back in.
  const total = buildSteps(freshCtx()).reduce((n, s) => n + s.bytes, 0) / 1024 ** 3;
  assert.ok(total > 2 && total < 12, `total is ${total.toFixed(1)} GB`);
});

test("only the steps still missing are counted", async () => {
  // The whole point: a machine that already has most of the kit needs the
  // remainder, not the full download again.
  const steps = [
    { id: "a", bytes: 5, isDone: () => true },
    { id: "b", bytes: 7, isDone: () => false },
    { id: "c", bytes: 11, isDone: async () => false },
  ];
  assert.equal(await bytesStillNeeded(steps), 18);
});

test("nothing is needed once every step is done", async () => {
  const steps = [{ id: "a", bytes: 5, isDone: () => true }];
  assert.equal(await bytesStillNeeded(steps), 0);
});
