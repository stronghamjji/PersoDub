// Integration dry run of the installer: real payload copy + local-http
// downloads + fake heavy commands, then proves checkKit passes and a re-run
// skips everything (resume).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { buildSteps } from "../src/installSpec.js";
import { runInstall } from "../src/installer.js";
import { checkKit } from "../src/engineCheck.js";
import { IS_WIN, venvBin, exeName } from "../src/platform.js";

const KIT_VERSION = "9.9.9+testsha1";
// Bundled dependency lists are platform-specific (see buildSteps' reqSuffix).
const REQ_SUFFIX = IS_WIN ? "win" : "mac";

function makePayload(payloadDir) {
  mkdirSync(join(payloadDir, "app-repo", "app"), { recursive: true });
  writeFileSync(join(payloadDir, "app-repo", "app", "main.py"), "# app");
  writeFileSync(join(payloadDir, "app-repo", "requirements.txt"), "fastapi");
  mkdirSync(join(payloadDir, "kit-src", "sidecar"), { recursive: true });
  writeFileSync(join(payloadDir, "kit-src", "sidecar", "server.py"), "# sidecar");
  writeFileSync(join(payloadDir, "kit-src", `requirements_engines_${REQ_SUFFIX}.txt`), "torch");
  writeFileSync(join(payloadDir, "kit-src", `requirements_qwen_${REQ_SUFFIX}.txt`), "uvicorn");
  writeFileSync(join(payloadDir, "campplus.onnx"), "onnx");
  writeFileSync(join(payloadDir, "KIT_VERSION"), KIT_VERSION);
}

test("full install dry run completes, satisfies checkKit, and resumes as all-skipped", async () => {
  const base = mkdtempSync(join(tmpdir(), "oddry2-"));
  const kitDir = join(base, "kit");
  const payloadDir = join(base, "payload");
  const cacheDir = join(base, "cache");
  makePayload(payloadDir);

  const ffmpegReal = join(base, "real-ffmpeg");
  const ffprobeReal = join(base, "real-ffprobe");
  writeFileSync(ffmpegReal, "");
  writeFileSync(ffprobeReal, "");

  const ctx = {
    kitDir,
    payloadDir,
    download: async (_url, dest) => writeFileSync(dest, "tarball"),
    extract: async (_file, destDir) => {
      // The ollama tarball unpacks to a bare `ollama` binary, not a python
      // tree -- checkKit now requires it, so the fake has to produce it too.
      if (destDir.endsWith("ollama")) {
        mkdirSync(destDir, { recursive: true });
        writeFileSync(join(destDir, exeName("ollama")), "");
        return;
      }
      mkdirSync(join(destDir, "python", "bin"), { recursive: true });
      writeFileSync(join(destDir, "python", "bin", "python3.11"), "");
    },
    run: async (argv, { onLine } = {}) => {
      const joined = argv.join(" ");
      if (joined.includes("-m venv")) {
        const venvDir = argv[argv.length - 1];
        // Lay the venv out the way the real platform does (POSIX bin/<x> vs
        // Windows Scripts\<x>.exe) so checkKit's REQUIRED entries resolve.
        for (const b of ["python", "pip", "uvicorn", "hf"]) {
          const p = venvBin(venvDir, b);
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, "");
        }
      }
      if (joined.includes("static_ffmpeg")) onLine?.(JSON.stringify([ffmpegReal, ffprobeReal]));
      if (joined.includes(" download ")) {
        const dir = argv[argv.indexOf("--local-dir") + 1];
        mkdirSync(dir, { recursive: true });
        if (dir.includes("HTDemucs")) writeFileSync(join(dir, "955717e8.safetensors"), "");
        if (dir.includes("whisper")) writeFileSync(join(dir, "model.bin"), "");
        if (dir.includes("qwen3-tts")) writeFileSync(join(dir, "config.json"), "");
      }
      if (joined.includes("whisper.load_model")) {
        mkdirSync(join(cacheDir, "whisper"), { recursive: true });
        writeFileSync(join(cacheDir, "whisper", "base.pt"), "weights");
      }
    },
    pullOllama: async ({ modelsDir }) => {
      // Real pull writes blobs then the manifest; the manifest is the
      // done-marker the gemma step's isDone checks on resume.
      const manifestDir = join(modelsDir, "manifests", "registry.ollama.ai", "library", "gemma3");
      mkdirSync(manifestDir, { recursive: true });
      writeFileSync(join(manifestDir, "12b"), "{}");
    },
  };

  const prevXdg = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cacheDir;
  try {
    const events1 = [];
    await runInstall(buildSteps(ctx), { onProgress: (e) => events1.push(e) });
    assert.equal(checkKit(kitDir, KIT_VERSION).ok, true, "installed kit must satisfy Phase-1 checkKit");
    assert.ok(existsSync(join(kitDir, "bin", exeName("ffmpeg"))));
    assert.ok(existsSync(join(kitDir, "mac.env")));

    const events2 = [];
    await runInstall(buildSteps(ctx), { onProgress: (e) => events2.push(e) });
    assert.ok(events2.every((e) => e.state === "skipped"), "second run must skip every step");
    assert.equal(events2.length, 10);
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = prevXdg;
  }
});
