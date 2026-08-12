// Install step definitions. Replicates the setup_mac.sh kit layout inside
// ctx.kitDir so Phase-1 checkKit/startEngines work unchanged.
// All external effects (download/extract/run) come from ctx so tests and
// PERSODUB_FAKE mode can substitute them.
import { existsSync, mkdirSync, cpSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { IS_WIN, venvBin, standalonePython, exeName, TTS_DEVICE } from "./platform.js";

// Standalone CPython, per platform. macOS uses the Apple Silicon build; Windows
// the x86_64 MSVC build (root layout python\python.exe, no bin/). Same upstream
// release (20260728) so the 3.11.15 version matches pyproject.toml.
const PYTHON_URL_MAC =
  "https://github.com/astral-sh/python-build-standalone/releases/download/20260728/cpython-3.11.15%2B20260728-aarch64-apple-darwin-install_only.tar.gz";
const PYTHON_SHA256_MAC =
  "7dc10e31eede05a6ab1ec9e0b961f521078b0959f838ed1d7452597d529ff802";
const PYTHON_URL_WIN =
  "https://github.com/astral-sh/python-build-standalone/releases/download/20260728/cpython-3.11.15%2B20260728-x86_64-pc-windows-msvc-install_only.tar.gz";
const PYTHON_SHA256_WIN =
  "b711f62a787476bc57b9d7d00e4bcccbe3bada78a1853f9143a112c0965ea347";
export const PYTHON_URL = IS_WIN ? PYTHON_URL_WIN : PYTHON_URL_MAC;
// Speaker-diarization model. Public Apache-2.0 export of the 3D-Speaker CAM++
// (welcomyou), verified byte-compatible with the app's worker on 2026-08-04 --
// so a from-source build no longer loses diarization when no bundle exists.
export const CAMPPLUS_URL =
  "https://huggingface.co/welcomyou/campplus-3dspeaker-200k-onnx/resolve/main/campplus_cn_en_common_200k.onnx";
export const CAMPPLUS_SHA256 =
  "dd1740aa1e1ffa3895f96aef2166b8af2bb2ad09c00769dd275ee36aef6a2a7f";

export const PYTHON_SHA256 = IS_WIN ? PYTHON_SHA256_WIN : PYTHON_SHA256_MAC;

// Standalone Ollama runtime (CLI + server in one binary, no .app install)
// used to serve the local Gemma translation model. Pinned like PYTHON_URL.
// macOS ships a .tgz; Windows a .zip of the same release.
const OLLAMA_URL_MAC =
  "https://github.com/ollama/ollama/releases/download/v0.32.5/ollama-darwin.tgz";
const OLLAMA_SHA256_MAC =
  "5789dd037a86adb328c72c11fc45e6c558452d07e5b50814a8bdb7b0fbdbcd81";
const OLLAMA_URL_WIN =
  "https://github.com/ollama/ollama/releases/download/v0.32.5/ollama-windows-amd64.zip";
const OLLAMA_SHA256_WIN =
  "7c941ae084569d298062d29f8139163a3187c76dbca0479c70d085e78fd8c7bb";
export const OLLAMA_TGZ_URL = IS_WIN ? OLLAMA_URL_WIN : OLLAMA_URL_MAC;
export const OLLAMA_TGZ_SHA256 = IS_WIN ? OLLAMA_SHA256_WIN : OLLAMA_SHA256_MAC;
// Must match app/config.py's OLLAMA_GEMMA_MODEL default -- the backend asks
// for this exact tag when the user picks Gemma.
export const GEMMA_MODEL = "gemma3:12b";
// Ollama's registry layout: a pulled model is complete exactly when its
// manifest file exists (blobs are written before the manifest).
export const GEMMA_MANIFEST = [
  "models", "ollama", "manifests", "registry.ollama.ai", "library", "gemma3", "12b",
];

// Each model is pinned to a HuggingFace commit (--revision) the way the
// Python/CAM++/Ollama downloads are pinned by SHA-256: an upstream repo
// takeover or force-push must not change what lands on user machines.
const MODELS = [
  {
    name: "Demucs (81 MB)",
    dir: ["models", "demucs", "HTDemucs"],
    marker: ["models", "demucs", "HTDemucs", "955717e8.safetensors"],
    args: ["adefossez/HTDemucs", "htdemucs.yaml", "955717e8.safetensors"],
    revision: "bf35a81b663819a8255c8fefee17f9d812b786b5",
  },
  {
    name: "Whisper large-v3 (2.9 GB)",
    dir: ["models", "whisper", "faster-whisper-large-v3"],
    marker: ["models", "whisper", "faster-whisper-large-v3", "model.bin"],
    args: ["Systran/faster-whisper-large-v3"],
    revision: "edaa852ec7e145841d8ffdb056a99866b5f0a478",
  },
  {
    name: "Qwen3-TTS (4.3 GB)",
    dir: ["models", "qwen3-tts"],
    marker: ["models", "qwen3-tts", "config.json"],
    args: ["Qwen/Qwen3-TTS-12Hz-1.7B-Base"],
    revision: "fd4b254389122332181a7c3db7f27e918eec64e3",
  },
];

// Mirrors openai-whisper's own load_model() default: XDG_CACHE_HOME (if set)
// joined with "whisper", else ~/.cache/whisper -- verified against the
// library's source, not guessed.
function whisperCachePath() {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "whisper", "base.pt");
}

// Knobs added to mac.env after the initial template (writeMacEnv) landed --
// listed here (with a real "#" comment each, for the file itself) so the
// upgrade-merge path (the "mac-env" step below) can append them to an
// existing mac.env. The step's old isDone only sniffed for PERSODUB_KIT_DIR,
// so any kit installed before these existed satisfied it forever and never
// received them.
const MAC_ENV_MANAGED_ADDITIONS = [
  {
    key: "PERSODUB_LEAKAGE_GATE",
    comment: "# Stage-5/6 leakage gate: log-only dark launch until validated on Mac.",
    line: "PERSODUB_LEAKAGE_GATE=measure",
  },
  {
    key: "PERSODUB_SCORER_ASR_TIMEOUT",
    comment: "# Mac-CPU-calibrated take-scorer ASR timeout (backend default: 15s).",
    line: "PERSODUB_SCORER_ASR_TIMEOUT=60",
  },
  {
    key: "PERSODUB_TTS_TIMEOUT",
    comment: "# Mac-CPU-calibrated TTS request timeout (backend default: 300s).",
    line: "PERSODUB_TTS_TIMEOUT=900",
  },
  {
    key: "PERSODUB_DIAR_TIMEOUT",
    comment: "# Mac-CPU-calibrated diarization timeout (backend default: 600s).",
    line: "PERSODUB_DIAR_TIMEOUT=1800",
  },
];

export function writeMacEnv({ kitDir }) {
  const k = (...p) => join(kitDir, ...p);
  const enginesPy = venvBin(k("engines_venv"), "python");
  return [
    "# Generated by the PersoDub desktop installer. May contain keys — do not share.",
    `SEP_PYTHON=${enginesPy}`,
    `STT_PYTHON=${enginesPy}`,
    `DIAR_PYTHON=${enginesPy}`,
    `QWEN_SCORER_PYTHON=${enginesPy}`,
    `SEP_MODEL_DIR=${k("models", "demucs")}`,
    `WHISPER_MODEL_DIR=${k("models", "whisper", "faster-whisper-large-v3")}`,
    `PERSODUB_CAMPPLUS_MODEL=${k("models", "campplus", "campplus.onnx")}`,
    `QWEN_CAMPPLUS_MODEL=${k("models", "campplus", "campplus.onnx")}`,
    "QWEN_TTS_URL=http://127.0.0.1:3901",
    `QWEN_TTS_MODEL=${k("models", "qwen3-tts")}`,
    `QWEN_TTS_DEVICE=${TTS_DEVICE}`,
    // The laughter/breath whitelist shells out to openai-whisper; left unset it
    // falls back to the system python3, finds no whisper, and fail-closes every
    // candidate (the dub loses all laughs, breaths and sighs).
    `NONVERBAL_WHISPER_PYTHON=${enginesPy}`,
    `PERSODUB_APP_REPO_DIR=${k("app")}`,
    `PERSODUB_KIT_DIR=${kitDir}`,
    `PERSODUB_BIN_DIR=${k("bin")}`,
    // Stage-5/6 leakage gate: log-only dark launch until validated on Mac.
    "PERSODUB_LEAKAGE_GATE=measure",
    // Mac-CPU-calibrated take-scorer ASR timeout (backend default: 15s).
    "PERSODUB_SCORER_ASR_TIMEOUT=60",
    // Mac-CPU-calibrated TTS request timeout (backend default: 300s).
    "PERSODUB_TTS_TIMEOUT=900",
    // Mac-CPU-calibrated diarization timeout (backend default: 600s).
    "PERSODUB_DIAR_TIMEOUT=1800",
    // No PERSO_SPACE_SEQ / PERSO_MEDIA_HOST here: the backend resolves the
    // workspace id from the API key itself (app/perso_client.py, the way the
    // official perso-dubbing-plugin does) and the media host has a public
    // default -- pinning this Mac's values would break every other account.
    "# Optional API keys — fill in to enable:",
    "# TRANSLATE_ENGINE=gemini",
    "# GEMINI_API_KEY=",
    "# PERSO_API_KEY=",
    "",
  ].join("\n");
}

// Adds any of MAC_ENV_MANAGED_ADDITIONS missing from an existing mac.env,
// preserving every existing line untouched -- app/settings_env.py writes user
// API keys into this same file and they must survive an upgrade. A no-op
// (returns text unchanged) once all managed keys are already present.
function withMissingMacEnvKeys(text) {
  const missing = MAC_ENV_MANAGED_ADDITIONS.filter((a) => !text.includes(`${a.key}=`));
  if (missing.length === 0) return text;
  const sep = text.endsWith("\n") ? "" : "\n";
  return text + sep + missing.flatMap((a) => [a.comment, a.line]).join("\n") + "\n";
}

export function buildSteps(ctx) {
  const k = (...p) => join(ctx.kitDir, ...p);
  const py = standalonePython(k("python"));
  // Per-platform pinned dependency lists (bundled by collect-payload.mjs).
  const reqSuffix = IS_WIN ? "win" : "mac";
  const reqEngines = `requirements_engines_${reqSuffix}.txt`;
  const reqQwen = `requirements_qwen_${reqSuffix}.txt`;
  // On Windows, torch/torchaudio come from PyPI as CPU-only wheels; the CUDA
  // build lives on a dedicated index, installed before the rest so the GPU is
  // usable. macOS gets the MPS wheel automatically, so no extra install.
  const torchCuda = IS_WIN
    ? [["torch==2.8.0", "torchaudio==2.8.0", "--index-url", "https://download.pytorch.org/whl/cu128"]]
    : [];
  const okPath = (id) => k(".install", `${id}.ok`);
  const markOk = (id) => {
    mkdirSync(k(".install"), { recursive: true });
    writeFileSync(okPath(id), "");
  };

  const venvStep = (id, title, venvName, pipInstalls) => ({
    id,
    title,
    isDone: () => existsSync(okPath(id)),
    run: async (report) => {
      const venvDir = k(venvName);
      report(null, `Creating ${venvName}`);
      await ctx.run([py, "-m", "venv", venvDir]);
      const pip = venvBin(venvDir, "pip");
      // Upgrade pip via `python -m pip`, not `pip.exe`: on Windows pip.exe is
      // locked while running and cannot rewrite itself ("To modify pip, please
      // run: python -m pip install --upgrade pip"). `python -m pip` is safe on
      // both platforms.
      const venvPy = venvBin(venvDir, "python");
      await ctx.run([venvPy, "-m", "pip", "install", "--upgrade", "pip"], { onLine: (l) => report(null, l.slice(0, 120)) });
      for (const args of pipInstalls) {
        await ctx.run([pip, "install", ...args], { onLine: (l) => report(null, l.slice(0, 120)) });
      }
      markOk(id);
    },
  });

  return [
    {
      id: "payload",
      title: "Copying bundled files",
      // Done only when the kit's KIT_VERSION matches the app's own bundled
      // payload -- so an app update always re-copies app code + KIT_VERSION,
      // instead of a stale .ok marker skipping this step forever (venv/model
      // steps below keep their own artifact-based skip-if-present checks).
      isDone: () => {
        const kitVersionPath = k("KIT_VERSION");
        const payloadVersionPath = join(ctx.payloadDir, "KIT_VERSION");
        if (!existsSync(kitVersionPath) || !existsSync(payloadVersionPath)) return false;
        // Trimmed, like engineCheck.js's readKitVersion -- an untrimmed compare
        // spuriously calls a matching version "stale" over a trailing newline.
        return readFileSync(kitVersionPath, "utf8").trim() === readFileSync(payloadVersionPath, "utf8").trim();
      },
      run: async (report) => {
        report(null, "Copying app code");
        cpSync(join(ctx.payloadDir, "app-repo"), k("app"), { recursive: true });
        cpSync(join(ctx.payloadDir, "kit-src", "sidecar"), k("sidecar"), { recursive: true });
        for (const f of [reqEngines, reqQwen]) {
          cpSync(join(ctx.payloadDir, "kit-src", f), k(f));
        }
        mkdirSync(k("models", "campplus"), { recursive: true });
        const cam = join(ctx.payloadDir, "campplus.onnx");
        if (existsSync(cam)) {
          cpSync(cam, k("models", "campplus", "campplus.onnx"));
        } else {
          report(null, "Downloading speaker model (27 MB)");
          await ctx.download(CAMPPLUS_URL, k("models", "campplus", "campplus.onnx"),
                             { sha256: CAMPPLUS_SHA256 });
        }
        cpSync(join(ctx.payloadDir, "KIT_VERSION"), k("KIT_VERSION"));
      },
    },
    {
      id: "python",
      title: "Downloading Python runtime (~50 MB)",
      isDone: () => existsSync(okPath("python")),
      run: async (report) => {
        mkdirSync(k("downloads"), { recursive: true });
        const tarball = k("downloads", "python.tar.gz");
        await ctx.download(PYTHON_URL, tarball, {
          sha256: PYTHON_SHA256,
          onProgress: (p) => report(p.total ? Math.round((100 * p.received) / p.total) : null, "Downloading Python"),
        });
        report(null, "Extracting Python");
        await ctx.extract(tarball, ctx.kitDir);
        markOk("python");
      },
    },
    venvStep("venv-app", "Installing app environment", "app_venv", [["-r", k("app", "requirements.txt")]]),
    venvStep("venv-engines", "Installing AI engines (~3 GB)", "engines_venv", [
      ...torchCuda,
      ["-r", k(reqEngines)],
      ["static-ffmpeg"],
    ]),
    {
      id: "ffmpeg",
      title: "Setting up ffmpeg",
      isDone: () => existsSync(k("bin", exeName("ffmpeg"))) && existsSync(k("bin", exeName("ffprobe"))),
      run: async (report) => {
        report(null, "Fetching ffmpeg binaries");
        const lines = [];
        await ctx.run(
          [
            venvBin(k("engines_venv"), "python"),
            "-c",
            "import json; from static_ffmpeg.run import get_or_fetch_platform_executables_else_raise as g; print(json.dumps(list(g())))",
          ],
          { onLine: (l) => lines.push(l) },
        );
        const jsonLine = [...lines].reverse().find((l) => l.trim().startsWith("["));
        if (!jsonLine) throw new Error("static-ffmpeg did not report binary paths");
        const [ffmpeg, ffprobe] = JSON.parse(jsonLine);
        mkdirSync(k("bin"), { recursive: true });
        // Copy, not symlink: Windows needs admin/developer mode for symlinks,
        // and static-ffmpeg already reports absolute .exe paths on Windows.
        for (const [name, src] of [[exeName("ffmpeg"), ffmpeg], [exeName("ffprobe"), ffprobe]]) {
          const dest = k("bin", name);
          rmSync(dest, { force: true });
          cpSync(src, dest);
        }
      },
    },
    venvStep("venv-qwen", "Installing voice engine", "qwen_venv", [
      ...torchCuda,
      ["-r", k(reqQwen)],
      // The hf CLI (used by the models step) landed in 0.34, but transformers
      // requires <1.0 — an unbounded -U pulls 1.x and breaks the sidecar.
      ["huggingface_hub>=0.34,<1.0"],
    ]),
    {
      id: "models",
      title: "Downloading AI models (~7 GB)",
      isDone: () => MODELS.every((m) => existsSync(k(...m.marker))),
      run: async (report) => {
        const hf = venvBin(k("qwen_venv"), "hf");
        for (const m of MODELS) {
          if (existsSync(k(...m.marker))) continue;
          report(null, `Downloading ${m.name}`);
          mkdirSync(k(...m.dir), { recursive: true });
          await ctx.run([hf, "download", ...m.args, "--revision", m.revision, "--local-dir", k(...m.dir)], {
            onLine: (l) => report(null, l.slice(0, 120)),
          });
        }
      },
    },
    {
      id: "gemma",
      title: "Downloading translation model Gemma (~8 GB)",
      // Both artifacts this step produces: engineCheck requires the ollama
      // binary too, so a manifest-only check marked a boot-failing install
      // "done" and never repaired it.
      isDone: () => existsSync(k(...GEMMA_MANIFEST)) && existsSync(k("ollama", exeName("ollama"))),
      run: async (report) => {
        const bin = k("ollama", exeName("ollama"));
        if (!existsSync(bin)) {
          report(null, "Downloading Ollama runtime (~120 MB)");
          mkdirSync(k("downloads"), { recursive: true });
          const archive = k("downloads", IS_WIN ? "ollama.zip" : "ollama.tgz");
          await ctx.download(OLLAMA_TGZ_URL, archive, {
            sha256: OLLAMA_TGZ_SHA256,
            onProgress: (p) => report(p.total ? Math.round((100 * p.received) / p.total) : null, "Downloading Ollama runtime"),
          });
          report(null, "Extracting Ollama runtime");
          await ctx.extract(archive, k("ollama"));
        }
        report(null, `Downloading ${GEMMA_MODEL}`);
        mkdirSync(k("models", "ollama"), { recursive: true });
        await ctx.pullOllama({
          bin, modelsDir: k("models", "ollama"), model: GEMMA_MODEL,
          onLine: (l) => report(null, l.slice(0, 120)),
        });
      },
    },
    {
      // A missing "base" model makes nonverbal.py fail-closed, silently
      // deleting every laugh/breath/sigh from every dub -- so this step
      // fails the install loudly instead, same as any other step here.
      id: "nonverbal-weights",
      title: "Downloading nonverbal-detection model (~140 MB)",
      isDone: () => existsSync(whisperCachePath()),
      run: async (report) => {
        report(null, "Downloading nonverbal-detection model");
        await ctx.run([venvBin(k("engines_venv"), "python"), "-c", "import whisper; whisper.load_model('base')"]);
      },
    },
    {
      id: "mac-env",
      title: "Writing configuration",
      // Must also check the managed additions, not just the original sniff
      // key -- otherwise a kit installed before they existed would satisfy
      // this forever and never receive them (see run, below).
      isDone: () => {
        if (!existsSync(k("mac.env"))) return false;
        const text = readFileSync(k("mac.env"), "utf8");
        return text.includes("PERSODUB_KIT_DIR") && MAC_ENV_MANAGED_ADDITIONS.every((a) => text.includes(`${a.key}=`));
      },
      run: async (report) => {
        const path = k("mac.env");
        if (!existsSync(path)) {
          report(null, "Writing mac.env");
          writeFileSync(path, writeMacEnv({ kitDir: ctx.kitDir }));
          return;
        }
        // Existing kit (installed before these keys existed): merge, never
        // clobber -- app/settings_env.py writes user API keys into this same
        // file and they must survive.
        report(null, "Updating mac.env");
        writeFileSync(path, withMissingMacEnvKeys(readFileSync(path, "utf8")));
      },
    },
  ];
}
