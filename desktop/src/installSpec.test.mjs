import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildSteps, writeKitEnv, PYTHON_URL, PYTHON_SHA256, CAMPPLUS_SHA256,
  OLLAMA_TGZ_SHA256, bytesStillNeeded, STEP_IDS, MODEL_MARKERS,
  OPTIONAL_MODEL_MARKERS, baseSteps, packSteps, packInstalled, bootSteps, PACK_DIRS,
  ERASER_SRC_URL, ERASER_SRC_SHA256, syncEraserKitEnv, WHISPER_BASE_PT_BYTES,
} from "./installSpec.js";
import { runInstall } from "./installer.js";
import { IS_WIN, venvBin, exeName, TTS_DEVICE, TORCH_VARIANT } from "./platform.js";
import { torchVariantFor, withMissingKitEnvKeys } from "./installSpec.js";

// Bundled dependency lists are platform-specific (see buildSteps' reqSuffix).
const REQ_SUFFIX = IS_WIN ? "win" : "mac";

function freshCtx(extra = {}) {
  const base = mkdtempSync(join(tmpdir(), "odspec-"));
  const kitDir = join(base, "kit");
  const payloadDir = join(base, "payload");
  mkdirSync(kitDir, { recursive: true });
  // Every venv step copies the OS trust hook out of the payload.
  mkdirSync(join(payloadDir, "kit-src", "truststore"), { recursive: true });
  writeFileSync(join(payloadDir, "kit-src", "truststore", "persodub_truststore.py"), "# hook");
  return { base, kitDir, payloadDir, download: async () => {}, extract: async () => {}, run: async () => {}, ...extra };
}

function makePayload(payloadDir, { campplus = true, version = "1.0.0+abc1234" } = {}) {
  mkdirSync(join(payloadDir, "app-repo", "app"), { recursive: true });
  writeFileSync(join(payloadDir, "app-repo", "app", "main.py"), "# app");
  writeFileSync(join(payloadDir, "app-repo", "requirements.txt"), "fastapi");
  mkdirSync(join(payloadDir, "kit-src", "sidecar"), { recursive: true });
  writeFileSync(join(payloadDir, "kit-src", "sidecar", "server.py"), "# sidecar");
  writeFileSync(join(payloadDir, "kit-src", `requirements_engines_${REQ_SUFFIX}.txt`), "torch");
  writeFileSync(join(payloadDir, "kit-src", "requirements_eraser.txt"), "paddleocr");
  if (campplus) writeFileSync(join(payloadDir, "campplus.onnx"), "onnx");
  writeFileSync(join(payloadDir, "KIT_VERSION"), version);
}

const byId = (ctx) => Object.fromEntries(buildSteps(ctx).map((s) => [s.id, s]));

test("returns the 12 steps in install order", () => {
  const ids = buildSteps(freshCtx()).map((s) => s.id);
  assert.deepEqual(ids, [
    "payload", "python", "venv-app", "ffmpeg", "venv-engines", "cleanup",
    "models", "ollama-runtime", "nonverbal-weights",
    "eraser-src", "venv-eraser", "kit-env",
  ]);
  assert.deepEqual(ids, STEP_IDS);
});

test("PACKS names the steps that leave the base install", () => {
  const steps = buildSteps(freshCtx());
  const tagged = Object.fromEntries(steps.map((s) => [s.id, s.pack]));
  assert.deepEqual(baseSteps(steps).map((s) => s.id), ["payload", "python", "venv-app", "ffmpeg", "cleanup", "kit-env"]);
  assert.deepEqual(packSteps(steps, "engine").map((s) => s.id), ["venv-engines", "models", "nonverbal-weights"]);
  assert.deepEqual(packSteps(steps, "ollama-runtime").map((s) => s.id), ["ollama-runtime"]);
  assert.deepEqual(packSteps(steps, "subtitle-eraser").map((s) => s.id), ["eraser-src", "venv-eraser"]);
  assert.equal(tagged.payload, undefined);
});

// What shell:remove-pack deletes. The eraser owns two folders (its source
// tree and its venv) where the other packs own one apiece.
test("every pack names the folders removing it takes", () => {
  assert.deepEqual(Object.keys(PACK_DIRS), ["engine", "ollama-runtime", "subtitle-eraser"]);
  assert.deepEqual(PACK_DIRS["subtitle-eraser"], ["eraser", "venv-eraser"]);
});
test("the base install adds up to under a gigabyte", () => {
  const total = baseSteps(buildSteps(freshCtx())).reduce((n, s) => n + s.bytes, 0) / 1024 ** 3;
  assert.ok(total < 1.0, `base is ${total.toFixed(2)} GB`);
});
test("packInstalled means the pack's stamp: a folder without it is a paused pack, not an installed one", () => {
  const ctx = freshCtx();
  assert.equal(packInstalled(ctx.kitDir, "engine"), false);
  mkdirSync(join(ctx.kitDir, "engines_venv"), { recursive: true });
  assert.equal(packInstalled(ctx.kitDir, "engine"), false, "cancelled halfway: not installed");
  mkdirSync(join(ctx.kitDir, ".install"), { recursive: true });
  writeFileSync(join(ctx.kitDir, ".install", "venv-engines.ok"), "fp");
  assert.equal(packInstalled(ctx.kitDir, "engine"), true);
});

test("the boot install is the base steps plus only the packs already on the kit's disk", () => {
  const ctx = freshCtx();
  const steps = buildSteps(ctx);
  assert.deepEqual(bootSteps(steps, ctx.kitDir).map((s) => s.id), baseSteps(steps).map((s) => s.id));
  mkdirSync(join(ctx.kitDir, ".install"), { recursive: true });
  writeFileSync(join(ctx.kitDir, ".install", "venv-eraser.ok"), "fp");
  assert.deepEqual(bootSteps(steps, ctx.kitDir).map((s) => s.id),
    ["payload", "python", "venv-app", "ffmpeg", "cleanup", "kit-env", "eraser-src", "venv-eraser"]);
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

// Windows measured 1.5-1.9 GB on disk once unpacked; the old flat 0.5 GB
// budget let a Windows install start this step without enough room left.
test("ollama-runtime budget follows the platform (Windows needs more room)", () => {
  const GB = 1024 ** 3;
  const expected = IS_WIN ? 2.0 * GB : 0.5 * GB;
  assert.equal(byId(freshCtx())["ollama-runtime"].bytes, expected);
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
  // One list for both platforms -- the subtitle-eraser pack installs from it.
  assert.ok(existsSync(join(ctx.kitDir, "requirements_eraser.txt")));
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
  // --progress-bar raw for a byte-based percent, --retries/--timeout for a flaky line (2026-09-07).
  const cache = join(ctx.kitDir, "downloads", "pip-app_venv");
  assert.ok(argvs.some((a) => a.includes(`install --cache-dir ${cache} --progress-bar raw --retries 10 --timeout 60 -r`) && a.includes("requirements.txt")));
  assert.equal(await step.isDone(), true);
});

test("venv-app falls back to no progress bar when an old pip refuses raw (issue #111)", async () => {
  const argvs = [];
  const ctx = freshCtx({ run: async (argv) => {
    const line = argv.join(" ");
    argvs.push(line);
    if (line.includes("--progress-bar raw")) {
      throw new Error("option --progress-bar: invalid choice: 'raw' (choose from 'on', 'off')");
    }
  } });
  const step = byId(ctx).venvApp ?? byId(ctx)["venv-app"];
  await step.run(() => {});
  assert.ok(argvs.some((a) => a.includes(`--cache-dir ${join(ctx.kitDir, "downloads", "pip-app_venv")} --progress-bar off --retries 10`)));
  assert.equal(await step.isDone(), true);
});

test("venv-app does not hide any other pip failure behind the fallback", async () => {
  const ctx = freshCtx({ run: async (argv) => {
    if (argv.join(" ").includes("--progress-bar")) throw new Error("No matching distribution found for torch");
  } });
  const step = byId(ctx).venvApp ?? byId(ctx)["venv-app"];
  await assert.rejects(step.run(() => {}), /No matching distribution/);
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

test("every venv gets the OS trust hook before its first download", async () => {
  // Company security software that inspects HTTPS hands Python a certificate
  // only the OS knows (2026-10-15): truststore goes in from the payload, with
  // no network, before pip's own upgrade, and a .pth loads it in every
  // interpreter of the venv.
  for (const id of ["venv-app", "venv-engines", "venv-eraser"]) {
    const argvs = [];
    const ctx = freshCtx({ run: async (argv) => { argvs.push(argv.join(" ")); } });
    await byId(ctx)[id].run(() => {});
    const venv = argvs.findIndex((a) => a.includes("-m venv"));
    const trust = argvs.findIndex((a) => a.includes("--no-index --find-links") && a.endsWith(" truststore"));
    const upgrade = argvs.findIndex((a) => a.includes("--upgrade pip"));
    assert.ok(venv >= 0 && trust === venv + 1 && upgrade === trust + 1, `${id}: ${argvs.join("\n")}`);
    assert.ok(argvs[trust].includes(join(ctx.payloadDir, "kit-src", "truststore")), argvs[trust]);
    const venvDir = argvs[venv].split(" ").pop();
    const site = IS_WIN ? join(venvDir, "Lib", "site-packages") : join(venvDir, "lib", "python3.11", "site-packages");
    assert.equal(readFileSync(join(site, "persodub_truststore.py"), "utf8"), "# hook");
    assert.equal(readFileSync(join(site, "persodub_truststore.pth"), "utf8"), "import persodub_truststore\n");
  }
});

test("a changed trust hook re-opens a venv step that was done", async () => {
  const ctx = freshCtx();
  const step = byId(ctx)["venv-app"];
  await step.run(() => {});
  assert.equal(await step.isDone(), true);
  writeFileSync(join(ctx.payloadDir, "kit-src", "truststore", "persodub_truststore.py"), "# hook v2");
  assert.equal(await step.isDone(), false);
});

test("every pip install of a list keeps what it fetched in the kit until its step is done, never in pip's own cache", async () => {
  // Windows kept a second copy of the 3 GB CUDA torch wheel in %LOCALAPPDATA%\pip
  // -- outside the kit, so no size report ever showed it. And with no cache at
  // all, a Resume after a cut line fetched every wheel again, the 2 GB of
  // Python + PyTorch from the first byte (owner, 2026-10-22, 1-3).
  for (const [id, venvName] of [["venv-app", "app_venv"], ["venv-engines", "engines_venv"], ["venv-eraser", "venv-eraser"]]) {
    const argvs = [];
    let cut = true;
    const ctx = freshCtx({ run: async (argv) => {
      argvs.push(argv);
      const at = argv.indexOf("--cache-dir");
      if (at < 0) return;
      // pip leaves each wheel it finished in the cache; the line is cut after the first.
      mkdirSync(join(argv[at + 1], "http-v2"), { recursive: true });
      writeFileSync(join(argv[at + 1], "http-v2", "wheel.body"), "torch");
      if (cut) { cut = false; throw new Error("ReadTimeoutError: HTTPSConnectionPool: Read timed out."); }
    } });
    const cache = join(ctx.kitDir, "downloads", `pip-${venvName}`);
    const step = byId(ctx)[id];
    await assert.rejects(step.run(() => {}), /Read timed out/);
    assert.ok(existsSync(join(cache, "http-v2", "wheel.body")), `${id}: the cut install keeps what came`);
    await step.run(() => {});
    const installs = argvs.filter((a) => a.includes("install") && !a.includes("--upgrade") && !a.includes("--no-index"));
    assert.ok(installs.length > 1, id);
    for (const a of installs) assert.equal(a[a.indexOf("--cache-dir") + 1], cache, `${id}: ${a.join(" ")}`);
    assert.ok(!argvs.some((a) => a.includes("install") && !a.includes("--cache-dir") && !a.includes("--no-cache-dir")
                                 && !a.includes("--upgrade")), `${id}: nothing goes to pip's own cache`);
    assert.equal(await step.isDone(), true);
    assert.equal(existsSync(cache), false, `${id}: installed, the second copy goes`);
  }
});

test("cleanup removes the old voice environment and is done once it is gone", async () => {
  const ctx = freshCtx();
  const step = byId(ctx)["cleanup"];
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
test("cleanup run is a no-op and never throws when there is nothing left to remove", async () => {
  const ctx = freshCtx();
  const step = byId(ctx)["cleanup"];
  assert.equal(await step.isDone(), true);
  await assert.doesNotReject(step.run(() => {}));
  assert.equal(await step.isDone(), true);
});

test("a leftover that cannot be removed does not fail the install", async () => {
  const ctx = freshCtx();
  mkdirSync(join(ctx.kitDir, "qwen_venv"), { recursive: true });
  const step = byId(ctx)["cleanup"];
  step.run = async () => {};            // stands in for rmSync losing to a lock
  await assert.doesNotReject(runInstall([step], {}));
  assert.equal(await step.isDone(), false, "still open, so the next launch retries");
});

// Real-device check (2026-09-03): an upgraded kit left more than qwen_venv
// behind -- the archives that step's own extraction should have deleted, the
// retired venv's requirements lists, and the retired step's .ok marker. This
// step is where all of it goes, not only the venv.
test("cleanup removes every leftover of the two-venv kit, not only qwen_venv", async () => {
  const ctx = freshCtx();
  mkdirSync(join(ctx.kitDir, "qwen_venv", "bin"), { recursive: true });
  writeFileSync(join(ctx.kitDir, "qwen_venv", "bin", "uvicorn"), "");
  mkdirSync(join(ctx.kitDir, "downloads"), { recursive: true });
  writeFileSync(join(ctx.kitDir, "downloads", "python.tar.gz"), "");
  writeFileSync(join(ctx.kitDir, "downloads", "ollama.tgz"), "");
  writeFileSync(join(ctx.kitDir, "downloads", "ollama.zip"), "");
  writeFileSync(join(ctx.kitDir, "requirements_qwen_mac.txt"), "");
  writeFileSync(join(ctx.kitDir, "requirements_qwen_win.txt"), "");
  mkdirSync(join(ctx.kitDir, ".install"), { recursive: true });
  writeFileSync(join(ctx.kitDir, ".install", "venv-qwen.ok"), "");

  const step = byId(ctx)["cleanup"];
  assert.equal(await step.isDone(), false);
  await step.run(() => {});

  for (const rel of [
    ["qwen_venv"],
    ["downloads", "python.tar.gz"],
    ["downloads", "ollama.tgz"],
    ["downloads", "ollama.zip"],
    ["requirements_qwen_mac.txt"],
    ["requirements_qwen_win.txt"],
    [".install", "venv-qwen.ok"],
  ]) {
    assert.equal(existsSync(join(ctx.kitDir, ...rel)), false, rel.join("/"));
  }
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
  assert.equal(await step.isDone(), true, "extract succeeded -- the step must still complete");
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
  let argv0;   // the fetch's; the step's last command asks the copied ffmpeg its version
  ctx.run = async (argv, { onLine } = {}) => { argv0 ??= argv[0]; onLine?.(JSON.stringify([f1, f2])); };
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
  // python -m huggingface_hub.cli.hf, not the hf.exe shim (issue #48: an
  // unsigned launcher pip creates on install can get "spawn UNKNOWN" from
  // Smart App Control or an antivirus on Windows).
  assert.equal(hfCalls[0][0], venvBin(join(ctx.kitDir, "app_venv"), "python"), "hf runs via app_venv's python");
  assert.deepEqual(hfCalls[0].slice(1, 4), ["-m", "huggingface_hub.cli.hf", "download"]);
  assert.equal(await step.isDone(), true);
});

test("models step never regresses to running the hf executable directly", async () => {
  // A future edit could accidentally restore `venvBin(k("app_venv"), "hf")`
  // as argv[0] -- that is exactly the unsigned-launcher path issue #48 moved
  // away from, so guard it on its own.
  const ctx = freshCtx();
  const hfCalls = [];
  ctx.run = async (argv) => {
    hfCalls.push(argv);
    const dir = argv[argv.indexOf("--local-dir") + 1];
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "955717e8.safetensors"), "");
  };
  await byId(ctx).models.run(() => {});
  const hfExePath = venvBin(join(ctx.kitDir, "app_venv"), "hf");
  assert.ok(!hfCalls.some((argv) => argv[0] === hfExePath), "must not spawn the hf launcher executable");
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

test("nonverbal-weights step is skipped when the whisper cache already has a full base.pt", async () => {
  const ctx = freshCtx();
  const cacheDir = mkdtempSync(join(tmpdir(), "odcache-"));
  await withXdgCache(cacheDir, async () => {
    mkdirSync(join(cacheDir, "whisper"), { recursive: true });
    const path = join(cacheDir, "whisper", "base.pt");
    writeFileSync(path, "");
    truncateSync(path, WHISPER_BASE_PT_BYTES);   // sparse -- same size, no real bytes
    const step = byId(ctx)["nonverbal-weights"];
    assert.equal(await step.isDone(), true);
  });
});

// A death mid-download (a force-quit installer, a killed app) can leave a
// base.pt of any size short of the real one -- existsSync alone read that as
// done and this step's python call never ran to notice (the 2026-08-14
// "install died halfway = broken forever" shape, this time for a file that
// step's own python step, not the app, downloads).
test("nonverbal-weights step is not skipped for a partial base.pt, and clears it before redownloading", async () => {
  const ctx = freshCtx();
  const cacheDir = mkdtempSync(join(tmpdir(), "odcache-"));
  const calls = [];
  ctx.run = async (argv) => { calls.push(argv); };
  await withXdgCache(cacheDir, async () => {
    mkdirSync(join(cacheDir, "whisper"), { recursive: true });
    const path = join(cacheDir, "whisper", "base.pt");
    writeFileSync(path, "weights");   // far short of WHISPER_BASE_PT_BYTES
    const step = byId(ctx)["nonverbal-weights"];
    assert.equal(await step.isDone(), false);
    await step.run(() => {});
    assert.equal(existsSync(path), false, "the stale partial file is removed before redownloading");
    assert.equal(calls.length, 1);
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
    "PERSODUB_LEAKAGE_GATE", "PERSODUB_SCORER_ASR_TIMEOUT", "PERSODUB_DIAR_TIMEOUT",
    // Which torch build this machine's venv-engines installed; app/models.py's
    // platform_key() reads it back to size GPU-only packs correctly.
    "PERSODUB_TORCH_VARIANT",
  ]) assert.ok(env.includes(key), `missing ${key}`);
  // Deliberately absent: the backend resolves the workspace id from the API
  // key itself and the media host has a public default (app/perso_client.py),
  // so the installer must not pin another account's values into kit.env.
  assert.ok(!env.includes("PERSO_SPACE_SEQ"), "PERSO_SPACE_SEQ must not be written by the installer");
  assert.ok(!env.includes("PERSO_MEDIA_HOST"), "PERSO_MEDIA_HOST must not be written by the installer");
  assert.ok(env.includes(ctx.kitDir));
  assert.ok(env.includes(`QWEN_TTS_DEVICE=${TTS_DEVICE}`));
  assert.ok(env.includes(`PERSODUB_TORCH_VARIANT=${TORCH_VARIANT}`));
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
  for (const key of ["PERSODUB_LEAKAGE_GATE=on", "PERSODUB_SCORER_ASR_TIMEOUT=60",
                      "PERSODUB_DIAR_TIMEOUT=1800",
                      // A kit.env without the key predates the CPU wheel: its venv has
                      // the build there was (CUDA on Windows, MPS on Mac), whatever this
                      // machine's GPU -- see LEGACY_TORCH_VARIANT in installSpec.js.
                      `PERSODUB_TORCH_VARIANT=${IS_WIN ? "cu128" : "mps"}`]) {
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

// gate=on: the leakage check fixes what it finds in the finished dub (the
// owner heard the difference on a 35.7 s spot, 2026-10-06).
// Timeouts are Mac-CPU-calibrated versions of backend defaults 15/300/600.
test("writeKitEnv includes the leakage-gate and worker-timeout additions", () => {
  const s = writeKitEnv({ kitDir: "/K" });
  assert.ok(s.includes("PERSODUB_LEAKAGE_GATE=on"));
  assert.ok(s.includes("PERSODUB_SCORER_ASR_TIMEOUT=60"));
  assert.ok(s.includes("PERSODUB_DIAR_TIMEOUT=1800"));
});

// app/models.py's platform_key() reads this key back to size GPU-only packs
// per machine; absent (an old kit that predates it) it treats Windows as GPU.
test("writeKitEnv records which torch build this machine's venv-engines will install", () => {
  const s = writeKitEnv({ kitDir: "/K" });
  assert.ok(s.includes(`PERSODUB_TORCH_VARIANT=${TORCH_VARIANT}`));
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
  // Every step there is: the base install plus all three packs (engines,
  // translation runtime, subtitle eraser), which is what a machine that asks
  // for everything downloads. Windows runs larger for its CUDA torch wheels,
  // twice over now that the eraser has a torch of its own.
  // If this drifts far past that, something big crept into a step.
  // Windows comes to 21.5 GB and macOS to 8.5 GB (2026-10-03): the old ceiling
  // of 21 failed on every Windows run, so it now sits a little above Windows.
  const total = buildSteps(freshCtx()).reduce((n, s) => n + s.bytes, 0) / 1024 ** 3;
  assert.ok(total > 2 && total < 24, `total is ${total.toFixed(1)} GB`);
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

// On an update the engines venv already holds torch; the step only adds what
// the new list brings. Quoting the full 2-9 GB budget in the install title
// made a Windows user close a one-minute update (2026-09-04).
test("venv-engines counts a small figure when the venv already exists", () => {
  const ctx = freshCtx();
  const fresh = byId(ctx)["venv-engines"].bytes;
  mkdirSync(join(ctx.kitDir, "engines_venv"), { recursive: true });
  const update = byId(ctx)["venv-engines"].bytes;
  assert.ok(update < fresh, `update ${update} should be below fresh ${fresh}`);
  assert.ok(update <= 0.5 * 1024 ** 3);
});

// A Windows machine with no NVIDIA GPU installs the small CPU-only torch
// wheel instead of the 8+ GB CUDA build, so its budget follows TORCH_VARIANT
// too -- macOS is unaffected (it always gets the MPS wheel automatically).
test("venv-engines budget follows the platform's torch variant", () => {
  const GB = 1024 ** 3;
  const expected = IS_WIN ? (TORCH_VARIANT === "cpu" ? 1.5 * GB : 9 * GB) : 2 * GB;
  assert.equal(byId(freshCtx())["venv-engines"].bytes, expected);
});


// An installed kit keeps the torch build it has. The hardware guess is for a
// fresh install only: a Windows machine without an NVIDIA GPU that installed
// the CUDA build under 0.5.2 must not have its engines venv reinstalled on
// update because the guess now says "cpu".
test("an installed kit's recorded torch variant wins over the hardware guess", () => {
  const ctx = freshCtx();
  assert.equal(torchVariantFor(ctx.kitDir), TORCH_VARIANT, "no kit.env: the hardware guess");
  mkdirSync(ctx.kitDir, { recursive: true });
  writeFileSync(join(ctx.kitDir, "kit.env"), "PERSODUB_KIT_DIR=x\nPERSODUB_TORCH_VARIANT=cpu\n");
  assert.equal(torchVariantFor(ctx.kitDir), "cpu");
  // The kit-env step writes the same value back, not the guess.
  assert.match(writeKitEnv({ kitDir: ctx.kitDir }), /PERSODUB_TORCH_VARIANT=cpu/);
  // A kit.env from before the key existed gets the build those kits had.
  const patched = withMissingKitEnvKeys("PERSODUB_KIT_DIR=x\n");
  assert.match(patched, new RegExp(`PERSODUB_TORCH_VARIANT=${IS_WIN ? "cu128" : "mps"}`));
  // ...and is read as that build from the first boot after the update, before
  // the kit-env step has recorded it -- never as the hardware guess (which on
  // a GPU-less Windows machine says "cpu" and would reinstall the venv twice).
  writeFileSync(join(ctx.kitDir, "kit.env"), "PERSODUB_KIT_DIR=x\n");
  assert.equal(torchVariantFor(ctx.kitDir), IS_WIN ? "cu128" : "mps");
});

// ── the subtitle-eraser pack ───────────────────────────────────────────────
// Two steps: the tool's own source tree (OCR weights included, so nothing
// else is fetched) and a venv with the torch pair that tree was verified
// against. The app finds both through two kit.env keys that exist only while
// the pack does.
test("the eraser pack is installed exactly when its venv stamp is there", () => {
  const ctx = freshCtx();
  assert.equal(packInstalled(ctx.kitDir, "subtitle-eraser"), false);
  mkdirSync(join(ctx.kitDir, "eraser", "vsr"), { recursive: true });
  assert.equal(packInstalled(ctx.kitDir, "subtitle-eraser"), false, "source tree alone: still installing");
  mkdirSync(join(ctx.kitDir, ".install"), { recursive: true });
  writeFileSync(join(ctx.kitDir, ".install", "venv-eraser.ok"), "fp");
  assert.equal(packInstalled(ctx.kitDir, "subtitle-eraser"), true);
});

test("eraser-src downloads the pinned archive and unpacks it without its top folder", async () => {
  const calls = [];
  const ctx = freshCtx({
    download: async (url, dest, opts) => { calls.push([url, opts.sha256]); writeFileSync(dest, "zip"); },
    // The real archive wraps everything in video-subtitle-remover-<sha>/;
    // strip:1 is what puts backend/ directly under eraser/vsr.
    extract: async (_file, dest, opts) => {
      calls.push(["extract", dest, opts && opts.strip]);
      mkdirSync(join(dest, "backend"), { recursive: true });
      writeFileSync(join(dest, "backend", "main.py"), "# vsr");
    },
  });
  const step = byId(ctx)["eraser-src"];
  assert.equal(await step.isDone(), false);
  await step.run(() => {});
  assert.deepEqual(calls[0], [ERASER_SRC_URL, ERASER_SRC_SHA256]);
  assert.deepEqual(calls[1], ["extract", join(ctx.kitDir, "eraser", "vsr"), 1]);
  assert.ok(existsSync(join(ctx.kitDir, "eraser", "vsr", "backend", "main.py")));
  assert.equal(existsSync(join(ctx.kitDir, "downloads", "eraser-src.zip")), false, "790 MB the kit never reads again");
  assert.equal(await step.isDone(), true);
});

// The marker records which archive is unpacked, the way the venv steps record
// what they installed: re-pinning the commit must re-open the step instead of
// leaving last version's tree in place behind a bare .ok.
test("eraser-src is open again when the tree on disk came from another commit", async () => {
  const ctx = freshCtx();
  mkdirSync(join(ctx.kitDir, "eraser", "vsr", "backend"), { recursive: true });
  writeFileSync(join(ctx.kitDir, "eraser", "vsr", "backend", "main.py"), "# vsr");
  mkdirSync(join(ctx.kitDir, ".install"), { recursive: true });
  const step = byId(ctx)["eraser-src"];
  writeFileSync(join(ctx.kitDir, ".install", "eraser-src.ok"), "an older archive's sha");
  assert.equal(await step.isDone(), false);
  writeFileSync(join(ctx.kitDir, ".install", "eraser-src.ok"), ERASER_SRC_SHA256);
  assert.equal(await step.isDone(), true);
});

// The kit's Python is 3.11 and one file of the tool is 3.12-only (PEP 701's
// f-string quoting), on backend.main's import path -- so before this, every
// erase failed with a SyntaxError while detection passed (2026-09-09).
test("eraser-src rewrites the one 3.12-only f-string as it unpacks", async () => {
  const ctx = freshCtx({
    download: async (_url, dest) => writeFileSync(dest, "zip"),
    extract: async (_file, dest) => {
      mkdirSync(join(dest, "backend", "inpaint"), { recursive: true });
      writeFileSync(join(dest, "backend", "main.py"), "# vsr");
      writeFileSync(join(dest, "backend", "inpaint", "sttn_auto_inpaint.py"),
                    "print(f\"len {frame_info['len']} of {n}\")\n");
    },
  });
  await byId(ctx)["eraser-src"].run(() => {});
  const fixed = readFileSync(join(ctx.kitDir, "eraser", "vsr", "backend", "inpaint", "sttn_auto_inpaint.py"), "utf8");
  assert.ok(fixed.includes('{frame_info["len"]}'), fixed);
  assert.ok(!fixed.includes("{frame_info['len']}"), fixed);
  assert.ok(fixed.includes("of {n}"), "nothing else in the file changes");
});

test("eraser-src leaves a file that already parses on 3.11 exactly as it is", async () => {
  const already = 'print(f"len {frame_info[\'x\']}")\n';
  const ctx = freshCtx({
    download: async (_url, dest) => writeFileSync(dest, "zip"),
    extract: async (_file, dest) => {
      mkdirSync(join(dest, "backend", "inpaint"), { recursive: true });
      writeFileSync(join(dest, "backend", "main.py"), "# vsr");
      writeFileSync(join(dest, "backend", "inpaint", "sttn_auto_inpaint.py"), already);
    },
  });
  await byId(ctx)["eraser-src"].run(() => {});
  assert.equal(
    readFileSync(join(ctx.kitDir, "eraser", "vsr", "backend", "inpaint", "sttn_auto_inpaint.py"), "utf8"),
    already,
  );
});

// pip finishing is not the same as the eraser working: the step imports the
// tool's entry module with the venv it just built, and only then stamps
// itself done. Without that, a pack that can never erase reported "Installed".
test("venv-eraser is done only once the eraser can be imported", async () => {
  const argvs = [];
  const ctx = freshCtx({ run: async (argv) => { argvs.push(argv); } });
  const step = byId(ctx)["venv-eraser"];
  await step.run(() => {});
  const check = argvs.find((a) => a.join(" ").includes("import backend.main"));
  assert.ok(check, argvs.map((a) => a.join(" ")).join("\n"));
  assert.equal(check[0], venvBin(join(ctx.kitDir, "venv-eraser"), "python"));
  // The path travels inside a Python snippet, so it is JSON-quoted: on Windows
  // every separator in it is doubled and a plain includes() of the real path
  // cannot match (CI found it, 2026-09-11). Compare what was quoted, not how.
  assert.ok(check[2].includes(JSON.stringify(join(ctx.kitDir, "eraser", "vsr")).slice(1, -1)),
            check[2]);
  assert.equal(await step.isDone(), true);
});

test("an eraser that cannot be imported fails the step and leaves no stamp", async () => {
  const ctx = freshCtx({
    run: async (argv) => {
      if (argv.join(" ").includes("import backend.main")) throw new Error("python exit 1");
    },
  });
  const step = byId(ctx)["venv-eraser"];
  await assert.rejects(step.run(() => {}), /could not be loaded/);
  assert.equal(existsSync(join(ctx.kitDir, ".install", "venv-eraser.ok")), false);
  assert.equal(await step.isDone(), false, "the step stays open, so the next attempt runs it again");
});

test("venv-eraser installs its own torch pair first, then the eraser's list", async () => {
  const argvs = [];
  const ctx = freshCtx({ run: async (argv) => { argvs.push(argv.join(" ")); } });
  await byId(ctx)["venv-eraser"].run(() => {});
  assert.ok(argvs.some((a) => a.includes("-m venv") && a.includes("venv-eraser")));
  // Not pip's own upgrade, nor the offline OS trust hook (--no-index).
  const installs = argvs.filter((a) => a.includes(" install ") && !a.includes("--upgrade pip") && !a.includes("--no-index"));
  // torch 2.7.0/torchvision 0.22.0 -- older than the engines venv's pair,
  // which is why the eraser gets an environment of its own.
  assert.ok(installs[0].includes("torch==2.7.0") && installs[0].includes("torchvision==0.22.0"), installs[0]);
  // Windows takes torch from the pytorch.org index (CUDA, or CPU on a machine
  // with no NVIDIA GPU); macOS gets the MPS wheel from PyPI, no index.
  assert.equal(installs[0].includes("--index-url"), IS_WIN);
  if (IS_WIN) assert.ok(installs[0].includes(TORCH_VARIANT === "cpu" ? "/whl/cpu" : "/whl/cu128"), installs[0]);
  assert.ok(installs[1].includes("requirements_eraser.txt"), installs[1]);
});

// The two packages that are the difference between a working eraser and one
// that dies in its OCR step (Windows, 2026-09-09), plus the torch pair that
// must be installed per platform rather than resolved from the list.
test("the eraser's bundled list keeps out the runtimes that break it", () => {
  const list = readFileSync(new URL("../vendor/requirements_eraser.txt", import.meta.url), "utf8");
  const pins = list.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  assert.ok(!pins.some((l) => l.startsWith("onnxruntime")), "onnxruntime-directml/-gpu kill the OCR step");
  assert.ok(!pins.some((l) => l.startsWith("torch")), "torch is installed before this list, from a per-platform index");
  assert.ok(pins.includes("paddlepaddle==3.0.0"), "the CPU build: the GPU one is on a China-only index");
});

// The app reads these two keys' presence as "the eraser is installed", so
// they must never outlive the pack -- nor arrive before it.
test("kit.env carries the eraser's keys only while the pack is on disk", async () => {
  const ctx = freshCtx({ run: async () => {} });
  await byId(ctx)["kit-env"].run(() => {});
  const envPath = join(ctx.kitDir, "kit.env");
  assert.ok(!readFileSync(envPath, "utf8").includes("ERASER_PYTHON"), "no pack, no keys");

  await byId(ctx)["venv-eraser"].run(() => {});   // its stamp, then its keys
  const withPack = readFileSync(envPath, "utf8");
  assert.ok(withPack.includes(`ERASER_PYTHON=${venvBin(join(ctx.kitDir, "venv-eraser"), "python")}`), withPack);
  assert.ok(withPack.includes(`ERASER_VSR_DIR=${join(ctx.kitDir, "eraser", "vsr")}`), withPack);

  // What shell:remove-pack does: the stamp goes, then kit.env is squared up.
  rmSync(join(ctx.kitDir, ".install", "venv-eraser.ok"), { force: true });
  syncEraserKitEnv(ctx.kitDir);
  assert.equal(readFileSync(envPath, "utf8"), writeKitEnv({ kitDir: ctx.kitDir }));
});

test("squaring up the eraser's keys leaves every other line of kit.env alone", () => {
  const ctx = freshCtx();
  writeFileSync(join(ctx.kitDir, "kit.env"), "PERSODUB_KIT_DIR=/old/kit\nGEMINI_API_KEY=sk-legacy-key\n");
  mkdirSync(join(ctx.kitDir, ".install"), { recursive: true });
  writeFileSync(join(ctx.kitDir, ".install", "venv-eraser.ok"), "fp");
  syncEraserKitEnv(ctx.kitDir);
  const env = readFileSync(join(ctx.kitDir, "kit.env"), "utf8");
  assert.ok(env.includes("GEMINI_API_KEY=sk-legacy-key"), "a user's API key must survive");
  assert.ok(env.includes("ERASER_VSR_DIR="));
  rmSync(join(ctx.kitDir, ".install", "venv-eraser.ok"));
  syncEraserKitEnv(ctx.kitDir);
  assert.equal(readFileSync(join(ctx.kitDir, "kit.env"), "utf8"),
               "PERSODUB_KIT_DIR=/old/kit\nGEMINI_API_KEY=sk-legacy-key\n");
});

import { pipProgress } from "./installSpec.js";

test("pipProgress turns pip's raw progress lines into a percent of the step's budget", () => {
  const p = pipProgress(1000);
  assert.deepEqual(p("Collecting torch"), [0, "Collecting torch"]);
  assert.deepEqual(p("Progress 250 of 500"), [25, "Collecting torch"]);
  assert.deepEqual(p("Progress 500 of 500"), [50, "Collecting torch"]);
  assert.deepEqual(p("Progress 100 of 300"), [60, "Collecting torch"]);   // next file: the first counts in full
  assert.deepEqual(p("Installing collected packages"), [60, "Installing collected packages"]);
  assert.deepEqual(p("Progress 900 of 900"), [99, "Installing collected packages"], "never 100 from here");
  assert.deepEqual(pipProgress(0)("Progress 1 of 2"), [null, ""], "no budget, no figure");
});

import { packInstallingMarker } from "./installSpec.js";

test("the installing stamp sits beside the install's own stamps, named for the pack", () => {
  assert.equal(packInstallingMarker("/kit", "engine"), join("/kit", ".install", "engine.installing"));
});

test("cleanup removes the kit abandoned on the path move once its models were carried over (issue #6)", async () => {
  const ctx = freshCtx();
  const old = join(ctx.kitDir, "..", "old-kit");
  mkdirSync(join(old, "python"), { recursive: true });
  writeFileSync(join(old, "python", "bin"), "x");
  const step = byId({ ...ctx, abandonedKitDir: old })["cleanup"];
  assert.equal(await step.isDone(), false);
  await step.run(() => {});
  assert.equal(existsSync(old), false);
  assert.equal(await step.isDone(), true);
});

test("cleanup keeps an abandoned kit that still holds its models", async () => {
  const ctx = freshCtx();
  const old = join(ctx.kitDir, "..", "old-kit-with-models");
  mkdirSync(join(old, "models", "whisper"), { recursive: true });
  const step = byId({ ...ctx, abandonedKitDir: old })["cleanup"];
  await step.run(() => {});
  assert.equal(existsSync(join(old, "models", "whisper")), true, "models never deleted by cleanup");
});


// The installer wrote PERSODUB_LEAKAGE_GATE=measure into every kit.env from
// 0.7.0 on ("log only until validated on Mac"). Validated by ear 2026-10-06:
// an existing kit is moved to "on" the same way a missing key is added, with
// every other line untouched.
test("kit-env step turns the dark-launch measure setting into on and leaves the rest alone", async () => {
  const ctx = freshCtx();
  mkdirSync(ctx.kitDir, { recursive: true });
  const before = "PERSODUB_KIT_DIR=/old/kit\nGEMINI_API_KEY=sk-legacy-key\n"
    + "# Stage-5/6 leakage gate: log-only dark launch until validated on Mac.\nPERSODUB_LEAKAGE_GATE=measure\n"
    + "PERSODUB_SCORER_ASR_TIMEOUT=60\nPERSODUB_DIAR_TIMEOUT=1800\n"
    + `PERSODUB_TORCH_VARIANT=${IS_WIN ? "cu128" : "mps"}\n`;
  writeFileSync(join(ctx.kitDir, "kit.env"), before);
  const step = byId(ctx)["kit-env"];
  assert.equal(await step.isDone(), false);
  await step.run(() => {});
  const env = readFileSync(join(ctx.kitDir, "kit.env"), "utf8");
  assert.ok(env.includes("PERSODUB_LEAKAGE_GATE=on"));
  assert.ok(!env.includes("PERSODUB_LEAKAGE_GATE=measure"));
  assert.ok(env.includes("GEMINI_API_KEY=sk-legacy-key"));
  assert.equal(await step.isDone(), true);
  assert.equal(withMissingKitEnvKeys(env), env, "a second pass changes nothing");
});

// --- shell.log's DOWNLOAD lines -------------------------------------------
// Every file a step fetches, or has a tool fetch, is named in shell.log: START
// with where from and where to, a FILE line for each file a tool fetched,
// then DONE, or FAILED at ERROR. ctx.log gets each line and its level (left
// out for INFO); bootFlow.js hands it shellLog.
import { pipStartLine, pipDoneLines, hfDoneLines, pipRetryLine } from "./installSpec.js";

const logInto = (lines) => (line, level = "INFO") => lines.push(`${level} ${line}`);

// urllib3's retry warning as pip 26.2.1 prints it (captured against a closed
// port and a server that never answers, then pointed at PyPI): the reason
// holds quotes of its own.
const RETRY_REFUSED = "WARNING: Retrying (Retry(total=9, connect=None, read=None, redirect=None, status=None)) after connection broken by "
  + "'NewConnectionError(\"HTTPSConnection(host='pypi.org', port=443): Failed to establish a new connection: [Errno 61] Connection refused\")': /simple/fastapi/";
const RETRY_TIMEOUT = "WARNING: Retrying (Retry(total=0, connect=None, read=None, redirect=None, status=None)) after connection broken by "
  + "'ReadTimeoutError(\"HTTPSConnectionPool(host='files.pythonhosted.org', port=443): Read timed out. (read timeout=60.0)\")': "
  + "/packages/1a/2b/torch-2.8.0-cp311-none-macosx_11_0_arm64.whl";

test("pip's own retry warning is a RETRY line: which try out of all, the reason in its quotes, and the path", () => {
  assert.equal(pipRetryLine("pip app_venv", RETRY_REFUSED, 10, "3.1"),
    "DOWNLOAD RETRY pip app_venv (2/11) after 3.1s: NewConnectionError(\"HTTPSConnection(host='pypi.org', port=443): "
      + "Failed to establish a new connection: [Errno 61] Connection refused\") (/simple/fastapi/)");
  assert.equal(pipRetryLine("pip engines_venv", RETRY_TIMEOUT, 10, "612.0"),
    "DOWNLOAD RETRY pip engines_venv (11/11) after 612.0s: ReadTimeoutError(\"HTTPSConnectionPool(host='files.pythonhosted.org', "
      + "port=443): Read timed out. (read timeout=60.0)\") (/packages/1a/2b/torch-2.8.0-cp311-none-macosx_11_0_arm64.whl)");
  // Any other line is none; a long reason is cut at 200 characters.
  assert.equal(pipRetryLine("pip app_venv", "  Downloading fastapi-0.115.0-py3-none-any.whl (94 kB)", 10, "1.0"), null);
  const long = RETRY_REFUSED.replace("Connection refused", "x".repeat(300));
  assert.equal(pipRetryLine("pip app_venv", long, 10, "1.0").split(": ").slice(1).join(": ").split(" (/simple/")[0].length, 200);
});

test("a retry pip makes inside an install is a RETRY line between its START and DONE, counted out of the command's --retries", async () => {
  const lines = [];
  // Each pip command warns once, as its first retry: total is one short of
  // the --retries it runs with (pip's default 5 when it names none).
  const ctx = freshCtx({
    log: logInto(lines),
    run: async (argv, { onLine } = {}) => {
      const retries = argv.includes("--retries") ? Number(argv[argv.indexOf("--retries") + 1]) : 5;
      onLine?.(RETRY_REFUSED.replace("total=9", `total=${retries - 1}`));
    },
  });
  await withoutIndexVars(() => byId(ctx)["venv-app"].run(() => {}));
  const retries = lines.filter((l) => l.includes("DOWNLOAD RETRY"));
  // The pip upgrade names no --retries; the install names 10.
  assert.equal(retries.length, 2, lines.join("\n"));
  assert.match(retries[0], /^INFO DOWNLOAD RETRY pip app_venv \(2\/6\) after \d+\.\ds: NewConnectionError\(/);
  assert.match(retries[1], /^INFO DOWNLOAD RETRY pip app_venv \(2\/11\) after \d+\.\ds: NewConnectionError\(/);
  const start = lines.indexOf("INFO DOWNLOAD START pip app_venv from https://pypi.org/simple (requirements.txt)");
  assert.ok(start >= 0 && lines.indexOf(retries[1]) === start + 1, lines.join("\n"));
  assert.match(lines[start + 2], /^INFO DOWNLOAD DONE pip app_venv: \? packages in \d+\.\ds$/);
});

// The variables that change where pip and hf fetch from, cleared for a test
// that reads the default address.
async function withoutIndexVars(fn) {
  const saved = { PIP_INDEX_URL: process.env.PIP_INDEX_URL, HF_ENDPOINT: process.env.HF_ENDPOINT };
  delete process.env.PIP_INDEX_URL;
  delete process.env.HF_ENDPOINT;
  try { return await fn(); } finally {
    for (const [name, value] of Object.entries(saved)) if (value !== undefined) process.env[name] = value;
  }
}

test("each file a step downloads itself goes by its own name, and its lines go to the install's log", async () => {
  const log = () => {};
  const named = [];
  const ctx = freshCtx({
    log,
    download: async (_url, dest, opts) => { named.push(opts.what); assert.equal(opts.log, log); writeFileSync(dest, "x"); },
  });
  makePayload(ctx.payloadDir, { campplus: false });
  for (const id of ["payload", "python", "ollama-runtime", "eraser-src"]) await byId(ctx)[id].run(() => {});
  assert.deepEqual(named, ["campplus", "python", "ollama-runtime", "eraser-src"]);
});

test("a pip install says where it fetches from, then each package it installed with its size and address", async () => {
  const lines = [];
  const argvs = [];
  const ctx = freshCtx({
    log: logInto(lines),
    run: async (argv, { onLine } = {}) => {
      argvs.push(argv);
      const at = argv.indexOf("--report");
      if (at < 0) return;
      // pip's own upgrade finds nothing newer; the app's list fetches one wheel.
      const install = argv.includes("-r") ? [{
        download_info: { url: "https://files.pythonhosted.org/packages/1a/2b/fastapi-0.115.0-py3-none-any.whl" },
        metadata: { name: "fastapi", version: "0.115.0" },
      }] : [];
      if (install.length) onLine?.("  Downloading fastapi-0.115.0-py3-none-any.whl (94 kB)");
      writeFileSync(argv[at + 1], JSON.stringify({ version: "1", install }));
    },
  });
  await withoutIndexVars(() => byId(ctx)["venv-app"].run(() => {}));
  assert.equal(lines.length, 5, lines.join("\n"));
  assert.equal(lines[0], "INFO DOWNLOAD START pip app_venv from https://pypi.org/simple (--upgrade pip)");
  assert.match(lines[1], /^INFO DOWNLOAD DONE pip app_venv: 0 packages in \d+\.\ds$/);
  assert.equal(lines[2], "INFO DOWNLOAD START pip app_venv from https://pypi.org/simple (requirements.txt)");
  assert.equal(lines[3], "INFO DOWNLOAD FILE pip app_venv: fastapi 0.115.0 94 kB from https://files.pythonhosted.org/packages/1a/2b/fastapi-0.115.0-py3-none-any.whl");
  assert.match(lines[4], /^INFO DOWNLOAD DONE pip app_venv: 1 packages in \d+\.\ds$/);
  // The report is a file in the kit's downloads folder, gone once read.
  const install = argvs.find((a) => a.includes("-r"));
  const reportFile = install[install.indexOf("--report") + 1];
  assert.equal(reportFile, join(ctx.kitDir, "downloads", "pip-report-app_venv.json"));
  assert.equal(existsSync(reportFile), false);
});

test("a pip too old for --report installs without it, and its count is then unknown", async () => {
  const lines = [];
  const argvs = [];
  const ctx = freshCtx({
    log: logInto(lines),
    run: async (argv) => {
      argvs.push(argv.join(" "));
      if (argv.includes("--report")) throw new Error("python exit 2\nUsage: pip install [options]\n\nno such option: --report");
    },
  });
  const step = byId(ctx)["venv-app"];
  await step.run(() => {});
  assert.ok(argvs.some((a) => a.includes("--progress-bar raw --retries 10 --timeout 60 -r") && !a.includes("--report")),
    argvs.join("\n"));
  assert.match(lines.at(-1), /^INFO DOWNLOAD DONE pip app_venv: \? packages in \d+\.\ds$/);
  assert.equal(await step.isDone(), true);
});

test("a pip install that fails is a FAILED line at ERROR, with pip's own reason", async () => {
  const lines = [];
  const ctx = freshCtx({
    log: logInto(lines),
    run: async (argv) => {
      if (argv.includes("-r")) throw new Error("python exit 1\nERROR: No matching distribution found for fastapi");
    },
  });
  await assert.rejects(byId(ctx)["venv-app"].run(() => {}), /No matching distribution/);
  assert.match(lines.at(-1), /^ERROR DOWNLOAD FAILED pip app_venv after \d+\.\ds: ERROR: No matching distribution found for fastapi$/);
});

test("a pip install's START line names the index its arguments give, else pip's default and PIP_INDEX_URL", () => {
  assert.equal(
    pipStartLine("pip engines_venv", ["torch==2.8.0", "torchaudio==2.8.0", "--index-url", "https://download.pytorch.org/whl/cu128"], {}),
    "DOWNLOAD START pip engines_venv from https://download.pytorch.org/whl/cu128 (torch==2.8.0 torchaudio==2.8.0)");
  assert.equal(pipStartLine("pip app_venv", ["-r", join("kit", "app", "requirements.txt")], {}),
    "DOWNLOAD START pip app_venv from https://pypi.org/simple (requirements.txt)");
  // A password in the variable's address stays out of the log.
  assert.equal(
    pipStartLine("pip app_venv", ["-r", "req.txt", "--extra-index-url", "https://extra.example/simple"],
                 { PIP_INDEX_URL: "https://me:pw@mirror.example/simple" }),
    "DOWNLOAD START pip app_venv from https://pypi.org/simple (PIP_INDEX_URL=https://…@mirror.example/simple)"
      + " + https://extra.example/simple (req.txt)");
});

test("pip's report becomes a FILE line a package, sized from pip's own Downloading lines, then the count", () => {
  const report = { version: "1", install: [
    { download_info: { url: "https://files.pythonhosted.org/packages/1a/2b/fastapi-0.115.0-py3-none-any.whl" },
      metadata: { name: "fastapi", version: "0.115.0" } },
    { download_info: { url: "https://download.pytorch.org/whl/cu128/torch-2.8.0%2Bcu128-cp311-cp311-win_amd64.whl" },
      metadata: { name: "torch", version: "2.8.0+cu128" } },
    { download_info: { url: "https://files.pythonhosted.org/packages/3c/4d/six-1.16.0-py2.py3-none-any.whl" },
      metadata: { name: "six", version: "1.16.0" } },
    { download_info: { url: "https://files.pythonhosted.org/packages/5e/6f/pip-26.2.1-py3-none-any.whl" },
      metadata: { name: "pip", version: "26.2.1" } },
  ] };
  // pip 26 names the file; an older pip, the whole address off PyPI. The
  // metadata file beside a wheel is not the wheel, and a file out of pip's
  // own cache was not downloaded this time.
  const output = [
    "Collecting fastapi (from -r requirements.txt (line 1))",
    "  Downloading fastapi-0.115.0-py3-none-any.whl.metadata (27 kB)",
    "  Downloading fastapi-0.115.0-py3-none-any.whl (94 kB)",
    "  Downloading https://download.pytorch.org/whl/cu128/torch-2.8.0%2Bcu128-cp311-cp311-win_amd64.whl (3460.2 MB)",
    "Using cached pip-26.2.1-py3-none-any.whl (1.8 MB)",
  ];
  assert.deepEqual(pipDoneLines("pip engines_venv", report, output, "12.3"), [
    "DOWNLOAD FILE pip engines_venv: fastapi 0.115.0 94 kB from https://files.pythonhosted.org/packages/1a/2b/fastapi-0.115.0-py3-none-any.whl",
    "DOWNLOAD FILE pip engines_venv: torch 2.8.0+cu128 3.5 GB from https://download.pytorch.org/whl/cu128/torch-2.8.0%2Bcu128-cp311-cp311-win_amd64.whl",
    "DOWNLOAD FILE pip engines_venv: six 1.16.0 from https://files.pythonhosted.org/packages/3c/4d/six-1.16.0-py2.py3-none-any.whl",
    "DOWNLOAD FILE pip engines_venv: pip 26.2.1 1.8 MB (cached) from https://files.pythonhosted.org/packages/5e/6f/pip-26.2.1-py3-none-any.whl",
    "DOWNLOAD DONE pip engines_venv: 4 packages in 12.3s",
  ]);
  assert.deepEqual(pipDoneLines("pip app_venv", null, output, "1.0"), ["DOWNLOAD DONE pip app_venv: ? packages in 1.0s"]);
});

test("an hf download's FILE lines give each file's size and the pinned revision's address, and DONE the total", () => {
  const rev = "bf35a81b663819a8255c8fefee17f9d812b786b5";
  const base = `https://huggingface.co/adefossez/HTDemucs/resolve/${rev}`;
  assert.deepEqual(hfDoneLines("hf adefossez/HTDemucs@bf35a81", "https://huggingface.co", "adefossez/HTDemucs", rev,
    [{ name: "htdemucs.yaml", bytes: 1234 }, { name: "955717e8.safetensors", bytes: 84_132_000 }, { name: "gone.bin", bytes: null }], "9.8"), [
    `DOWNLOAD FILE hf adefossez/HTDemucs@bf35a81: htdemucs.yaml 1.2 kB from ${base}/htdemucs.yaml`,
    `DOWNLOAD FILE hf adefossez/HTDemucs@bf35a81: 955717e8.safetensors 84.1 MB from ${base}/955717e8.safetensors`,
    `DOWNLOAD FILE hf adefossez/HTDemucs@bf35a81: gone.bin from ${base}/gone.bin`,
    "DOWNLOAD DONE hf adefossez/HTDemucs@bf35a81: 3 files, 84.1 MB in 9.8s, size checked by hf",
  ]);
});

test("the models step names the repository, the pinned revision and the folder, then each file it fetched", async () => {
  const lines = [];
  const ctx = freshCtx({
    log: logInto(lines),
    run: async (argv) => {
      const dir = argv[argv.indexOf("--local-dir") + 1];
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "htdemucs.yaml"), "y".repeat(1234));
      writeFileSync(join(dir, "955717e8.safetensors"), "w".repeat(2000));
    },
  });
  await withoutIndexVars(() => byId(ctx).models.run(() => {}));
  const at = "https://huggingface.co/adefossez/HTDemucs/resolve/bf35a81b663819a8255c8fefee17f9d812b786b5";
  assert.equal(lines.length, 4, lines.join("\n"));
  assert.equal(lines[0], `INFO DOWNLOAD START hf adefossez/HTDemucs@bf35a81 from https://huggingface.co/adefossez/HTDemucs to ${join(ctx.kitDir, "models", "demucs", "HTDemucs")}`);
  assert.equal(lines[1], `INFO DOWNLOAD FILE hf adefossez/HTDemucs@bf35a81: htdemucs.yaml 1.2 kB from ${at}/htdemucs.yaml`);
  assert.equal(lines[2], `INFO DOWNLOAD FILE hf adefossez/HTDemucs@bf35a81: 955717e8.safetensors 2.0 kB from ${at}/955717e8.safetensors`);
  assert.match(lines[3], /^INFO DOWNLOAD DONE hf adefossez\/HTDemucs@bf35a81: 2 files, 3\.2 kB in \d+\.\ds, size checked by hf$/);
});

test("an hf download that fails is a FAILED line at ERROR, its signed address cut at the query", async () => {
  const lines = [];
  const ctx = freshCtx({
    log: logInto(lines),
    run: async () => {
      throw new Error("python exit 1\nrequests.exceptions.HTTPError: 403 Client Error: Forbidden for url: https://cas-bridge.xethub.hf.co/x?X-Amz-Signature=abc");
    },
  });
  await assert.rejects(byId(ctx).models.run(() => {}), /403/);
  assert.equal(lines.length, 2, lines.join("\n"));
  assert.match(lines[1], /^ERROR DOWNLOAD FAILED hf adefossez\/HTDemucs@bf35a81 after \d+\.\ds: requests\.exceptions\.HTTPError: 403 Client Error: Forbidden for url: https:\/\/cas-bridge\.xethub\.hf\.co\/x\?…$/);
});

test("the ffmpeg step names static-ffmpeg's address and folder, the two binaries, and the build it copied", async () => {
  const lines = [];
  const ctx = freshCtx({ log: logInto(lines) });
  const f1 = join(ctx.base, "real-ffmpeg");
  const f2 = join(ctx.base, "real-ffprobe");
  writeFileSync(f1, "f".repeat(2000));
  writeFileSync(f2, "p".repeat(1000));
  const zip = "https://example.invalid/ffmpeg_bins/raw/main/v8.0/darwin_arm64.zip";
  const fetches = [];
  ctx.run = async (argv, { onLine } = {}) => {
    if (argv[1] === "-version") {
      onLine?.("ffmpeg version 8.0 Copyright (c) 2000-2025 the FFmpeg developers");
      onLine?.("built with Apple clang version 16.0.0");
      return;
    }
    fetches.push(argv[2]);
    onLine?.(JSON.stringify({ url: zip, dir: join(ctx.base, "bin"), cached: false }));
    onLine?.(JSON.stringify([f1, f2]));
  };
  await byId(ctx).ffmpeg.run(() => {});
  // The address and folder are printed, and flushed, before the fetch begins.
  assert.ok(fetches[0].indexOf("get_platform_http_zip") >= 0 && fetches[0].indexOf("flush=True") < fetches[0].indexOf("print(json.dumps(list(g())))"), fetches[0]);
  assert.equal(lines.length, 3, lines.join("\n"));
  assert.equal(lines[0], `INFO DOWNLOAD START ffmpeg from ${zip} to ${join(ctx.base, "bin")}`);
  assert.match(lines[1], /^INFO DOWNLOAD DONE ffmpeg: 2 files, 3\.0 kB in \d+\.\ds, not checked$/);
  assert.equal(lines[2], "INFO DOWNLOAD FILE ffmpeg: ffmpeg version 8.0 Copyright (c) 2000-2025 the FFmpeg developers");
});

test("an ffmpeg that cannot tell its version is an ERROR line, and the step still finishes", async () => {
  const lines = [];
  const ctx = freshCtx({ log: logInto(lines) });
  const f1 = join(ctx.base, "real-ffmpeg");
  const f2 = join(ctx.base, "real-ffprobe");
  writeFileSync(f1, "");
  writeFileSync(f2, "");
  ctx.run = async (argv, { onLine } = {}) => {
    if (argv[1] === "-version") throw new Error("spawn EACCES");
    onLine?.(JSON.stringify({ url: "https://example.invalid/a.zip", dir: ctx.base, cached: true }));
    onLine?.(JSON.stringify([f1, f2]));
  };
  const step = byId(ctx).ffmpeg;
  await step.run(() => {});
  assert.match(lines[1], /^INFO DOWNLOAD DONE ffmpeg: 2 files, 0 B in \d+\.\ds \(already on disk\), not checked$/);
  assert.equal(lines[2], "ERROR DOWNLOAD FILE ffmpeg: -version failed: spawn EACCES");
  assert.equal(await step.isDone(), true);
});

test("the whisper step names openai-whisper's own address and file, and its size once whisper has checked it", async () => {
  const lines = [];
  const ctx = freshCtx({ log: logInto(lines) });
  const cacheDir = mkdtempSync(join(tmpdir(), "odcache-"));
  const path = join(cacheDir, "whisper", "base.pt");
  const url = "https://openaipublic.azureedge.net/main/whisper/models/ed3a0b6b1c0edf879ad9b11b1af5a0e6ab5db9205f891f668f8b0e6c6326e34e/base.pt";
  let code;
  ctx.run = async (argv, { onLine } = {}) => {
    code = argv[2];
    onLine?.(JSON.stringify({ url, path }));
    mkdirSync(join(cacheDir, "whisper"), { recursive: true });
    writeFileSync(path, "w".repeat(1500));
  };
  await withXdgCache(cacheDir, () => byId(ctx)["nonverbal-weights"].run(() => {}));
  // Printed, and flushed, before load_model fetches.
  assert.ok(code.indexOf("whisper._MODELS['base']") >= 0 && code.indexOf("flush=True") < code.indexOf("whisper.load_model('base')"), code);
  assert.equal(lines.length, 2, lines.join("\n"));
  assert.equal(lines[0], `INFO DOWNLOAD START whisper base from ${url} to ${path}`);
  assert.match(lines[1], /^INFO DOWNLOAD DONE whisper base: 1\.5 kB in \d+\.\ds, sha256 checked by whisper$/);
});

test("a whisper download that fails is a FAILED line at ERROR, with whisper's own reason", async () => {
  const lines = [];
  const ctx = freshCtx({ log: logInto(lines) });
  const cacheDir = mkdtempSync(join(tmpdir(), "odcache-"));
  ctx.run = async () => {
    throw new Error("python exit 1\nRuntimeError: Model has been downloaded but the SHA256 checksum does not not match. Please retry loading the model.");
  };
  await withXdgCache(cacheDir, () => assert.rejects(byId(ctx)["nonverbal-weights"].run(() => {}), /SHA256/));
  assert.match(lines.at(-1), /^ERROR DOWNLOAD FAILED whisper base after \d+\.\ds: RuntimeError: Model has been downloaded but the SHA256 checksum does not not match\. Please retry loading the model\.$/);
});
