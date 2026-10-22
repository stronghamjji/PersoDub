// Install step definitions. Replicates the setup_mac.sh kit layout inside
// ctx.kitDir so Phase-1 checkKit/startEngines work unchanged.
// All external effects (download/extract/run) come from ctx so tests and
// PERSODUB_FAKE mode can substitute them.
import { existsSync, mkdirSync, cpSync, writeFileSync, rmSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { KIT_ENV } from "./kitEnv.js";
import { IS_WIN, venvBin, standalonePython, exeName, TTS_DEVICE, TORCH_VARIANT } from "./platform.js";
import { errorText } from "./errorText.js";
import { t } from "./i18n.js";
import { lastReason } from "./installer.js";
import { secondsSince, sizeText, urlText } from "./logLine.js";

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
// for this exact tag when the user picks Gemma. The installer no longer pulls
// it (the pull moved to the in-app model catalog, served by the Python
// backend); the constant stays exported for the server and engineCheck history.
export const GEMMA_MODEL = "gemma3:12b";
// Ollama's registry layout: a pulled model is complete exactly when its
// manifest file exists (blobs are written before the manifest).
export const GEMMA_MANIFEST = [
  "models", "ollama", "manifests", "registry.ollama.ai", "library", "gemma3", "12b",
];

// The subtitle eraser's source tree (YaoFANGUK/video-subtitle-remover),
// pinned to one commit and that archive's SHA-256 the way the Python and
// Ollama downloads are pinned. codeload serves the tree as a zip with the OCR
// weights already inside it (backend/models), so nothing else is fetched:
// 791 MB down, 1.01 GB unpacked, all of it under one top folder.
export const ERASER_SRC_URL =
  "https://codeload.github.com/YaoFANGUK/video-subtitle-remover/zip/e109b9ddc1d0";
export const ERASER_SRC_SHA256 =
  "a541953b41399e019803e421c0a74be299994d859a6396eeb047e313061ce27f";

// The twelve step ids in install order, exported as the one place they live --
// analytics.js publishes exactly this list, and a rename here that never
// reached its copy used to make a failing step travel as "unknown".
export const STEP_IDS = [
  "payload", "python", "venv-app", "ffmpeg", "venv-engines", "cleanup",
  "models", "ollama-runtime", "nonverbal-weights",
  "eraser-src", "venv-eraser", "kit-env",
];

// The steps that leave the base install (payload, python, venv-app, ffmpeg,
// cleanup, kit-env) add up to under a gigabyte; everything else belongs to a
// pack, installed later on demand (src/packIpc.js). The
// boot flow (bootFlow.js) only refreshes a pack that is already on disk.
export const PACKS = [
  { id: "engine", steps: ["venv-engines", "models", "nonverbal-weights"] },
  { id: "ollama-runtime", steps: ["ollama-runtime"] },
  { id: "subtitle-eraser", steps: ["eraser-src", "venv-eraser"] },
];

// The kit folders a pack owns, taken with it by shell:remove-pack. Models
// pulled through Ollama are deliberately absent: they are listed and removed
// as models, one at a time, out of a blob store the runtime shares.
export const PACK_DIRS = {
  engine: ["engines_venv", join("models", "demucs")],
  "ollama-runtime": ["ollama"],
  "subtitle-eraser": ["eraser", "venv-eraser"],
};

/** The steps with no pack tag -- what the first install downloads. */
export function baseSteps(steps) {
  return steps.filter((s) => s.pack === undefined);
}

/** The steps belonging to one pack, in buildSteps' order. */
export function packSteps(steps, id) {
  return steps.filter((s) => s.pack === id);
}

// Whether a pack is on disk -- read from the filesystem, never a marker, so
// this agrees with isDone()/checkKit() about what "installed" means.
export function packInstalled(kitDir, id) {
  // The venv step's own stamp, not the folder: a folder is there from the
  // first second of an install, so on the folder rule a pack cancelled
  // halfway counted as installed, and the next launch finished it in the
  // installer with no Cancel. The stamp is what the catalog checks too
  // (app/models_catalog.json), so the shell and the backend agree.
  if (id === "engine") return existsSync(join(kitDir, ".install", "venv-engines.ok"));
  if (id === "ollama-runtime") return existsSync(join(kitDir, "ollama", exeName("ollama")));
  if (id === "subtitle-eraser") return existsSync(join(kitDir, ".install", "venv-eraser.ok"));
  return false;
}

/** What the boot install runs: the base steps, plus the steps of only the
 *  packs already on this kit's disk. A pack never installed is left alone
 *  until the page asks for it (packIpc.js, shell:install-pack). */
export function bootSteps(steps, kitDir) {
  return [
    ...baseSteps(steps),
    ...PACKS.filter((p) => packInstalled(kitDir, p.id)).flatMap((p) => packSteps(steps, p.id)),
  ];
}

// The two kit.env keys the subtitle-eraser pack owns. The app reads their
// absence as "the pack is not installed", so they are never written empty:
// they land when the pack's venv does and go when the pack is removed.
export function eraserKitEnvLines(kitDir) {
  const k = (...p) => join(kitDir, ...p);
  return [
    "# The subtitle-eraser pack -- absent unless the pack is installed.",
    `ERASER_PYTHON=${venvBin(k("venv-eraser"), "python")}`,
    `ERASER_VSR_DIR=${k("eraser", "vsr")}`,
  ];
}

const ERASER_KIT_ENV_LINE = /^(# The subtitle-eraser pack|ERASER_PYTHON=|ERASER_VSR_DIR=)/;

/** kit.env text with the eraser's keys as the disk says: present when the
 *  pack is installed, gone when it is not. Every other line is untouched --
 *  app/settings_env.py writes user API keys into this same file. */
export function withEraserKitEnvKeys(text, kitDir) {
  const kept = text.split("\n").filter((l) => !ERASER_KIT_ENV_LINE.test(l));
  while (kept.length && kept[kept.length - 1] === "") kept.pop();
  const lines = packInstalled(kitDir, "subtitle-eraser") ? eraserKitEnvLines(kitDir) : [];
  return [...kept, ...lines, ""].join("\n");
}

/** Bring an existing kit.env's eraser keys back in step with the disk --
 *  called when the pack's venv lands and when the pack is removed. */
export function syncEraserKitEnv(kitDir) {
  const path = join(kitDir, KIT_ENV);
  if (!existsSync(path)) return;   // no kit.env yet: the kit-env step writes the keys in
  writeFileSync(path, withEraserKitEnvKeys(readFileSync(path, "utf8"), kitDir));
}

// Each model is pinned to a HuggingFace commit (--revision) the way the
// Python/CAM++/Ollama downloads are pinned by SHA-256: an upstream repo
// takeover or force-push must not change what lands on user machines.
// markers list every weight file a model needs, never the small config files
// beside them: hf writes each download to a temp name and renames it only
// once complete, so a weight present at its real path is a finished file --
// while a config.json arrives seconds in and proves nothing about the rest.
// Only the always-installed models download here: small enough to ride along
// with the runtime. The big optional ones (below) moved to the in-app model
// catalog, downloaded by the Python server when first used.
const MODELS = [
  {
    name: "Demucs (81 MB)",
    dir: ["models", "demucs", "HTDemucs"],
    markers: [["models", "demucs", "HTDemucs", "955717e8.safetensors"]],
    args: ["adefossez/HTDemucs", "htdemucs.yaml", "955717e8.safetensors"],
    revision: "bf35a81b663819a8255c8fefee17f9d812b786b5",
  },
];

// The optional models the installer used to download (Whisper 2.9 GB,
// Qwen3-TTS 4.3 GB). Kept so their marker paths stay documented in one place;
// the server's catalog downloads them into these same kit-relative dirs.
const OPTIONAL_MODELS = [
  {
    name: "Whisper large-v3 (2.9 GB)",
    dir: ["models", "whisper", "faster-whisper-large-v3"],
    markers: [["models", "whisper", "faster-whisper-large-v3", "model.bin"]],
    args: ["Systran/faster-whisper-large-v3"],
    revision: "edaa852ec7e145841d8ffdb056a99866b5f0a478",
  },
  {
    name: "Qwen3-TTS (4.3 GB)",
    dir: ["models", "qwen3-tts"],
    markers: [
      ["models", "qwen3-tts", "model.safetensors"],
      ["models", "qwen3-tts", "speech_tokenizer", "model.safetensors"],
    ],
    args: ["Qwen/Qwen3-TTS-12Hz-1.7B-Base"],
    revision: "fd4b254389122332181a7c3db7f27e918eec64e3",
  },
];

// The same paths engineCheck requires at boot -- one list, so "the install is
// done" and "the kit is usable" can never disagree the way they did when only
// this file knew about the models. Always-installed models only: requiring an
// optional model here would bounce every light install back to the installer.
export const MODEL_MARKERS = MODELS.flatMap((m) => m.markers);
// The optional models' completion markers, exported for tests/documentation
// (the server judges Ready/Paused/Not-downloaded by these same files).
export const OPTIONAL_MODEL_MARKERS = OPTIONAL_MODELS.flatMap((m) => m.markers);

// Mirrors openai-whisper's own load_model() default: XDG_CACHE_HOME (if set)
// joined with "whisper", else ~/.cache/whisper -- verified against the
// library's source, not guessed.
function whisperCachePath() {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "whisper", "base.pt");
}

// openai-whisper's own base.pt (its azureedge URL, content-length HEAD-checked
// 2026-09-29): a finished download is exactly this many bytes. existsSync
// alone let a partial file from an install that died mid-download count as
// done -- this step's python call never ran to notice, and every laugh,
// breath and sigh silently vanished from every dub instead (the same
// "install died halfway = broken forever" shape as the 2026-08-14 bug).
export const WHISPER_BASE_PT_BYTES = 145262807;

function whisperCacheDone() {
  try {
    return statSync(whisperCachePath()).size === WHISPER_BASE_PT_BYTES;
  } catch {
    return false;
  }
}

// Knobs added to kit.env after the initial template (writeKitEnv) landed --
// listed here (with a real "#" comment each, for the file itself) so the
// upgrade-merge path (the "kit-env" step below) can append them to an
// existing kit.env. The step's old isDone only sniffed for PERSODUB_KIT_DIR,
// so any kit installed before these existed satisfied it forever and never
// received them.
// The torch build every kit from before PERSODUB_TORCH_VARIANT existed has.
const LEGACY_TORCH_VARIANT = IS_WIN ? "cu128" : "mps";

const KIT_ENV_MANAGED_ADDITIONS = [
  {
    key: "PERSODUB_LEAKAGE_GATE",
    comment: "# Stage-5/6 leakage check: cancels the original voice it finds in the finished dub.",
    line: "PERSODUB_LEAKAGE_GATE=on",
  },
  {
    key: "PERSODUB_SCORER_ASR_TIMEOUT",
    comment: "# Mac-CPU-calibrated take-scorer ASR timeout (backend default: 15s).",
    line: "PERSODUB_SCORER_ASR_TIMEOUT=60",
  },
  {
    key: "PERSODUB_DIAR_TIMEOUT",
    comment: "# Mac-CPU-calibrated diarization timeout (backend default: 600s).",
    line: "PERSODUB_DIAR_TIMEOUT=1800",
  },
  {
    key: "PERSODUB_TORCH_VARIANT",
    comment: "# Which torch build venv-engines installed (cpu/cu128/mps) -- read by app/models.py's platform_key().",
    // The value for a kit.env from before this key existed: those kits
    // installed the only build there was (CUDA on Windows, MPS on macOS),
    // whatever the machine's GPU -- recording the hardware guess instead
    // would reopen the engines step and reinstall gigabytes on update.
    line: `PERSODUB_TORCH_VARIANT=${LEGACY_TORCH_VARIANT}`,
  },
];

// The torch build this kit's engines venv has, or should get: what its
// kit.env records if it has one (an installed kit keeps its build -- see the
// managed addition above), else the hardware guess for a fresh install.
// What a pip too old for "--progress-bar raw" says (issue #111):
// "option --progress-bar: invalid choice: 'raw' (choose from 'on', 'off')".
export const RAW_BAR_REFUSED = /invalid choice: '?raw'?/i;
// What a pip too old for --report (before 22.2) says: "no such option: --report".
export const REPORT_REFUSED = /no such option: --report/i;

// Turns pip's "--progress-bar raw" lines ("Progress <got> of <total>", one
// file at a time) into a percent of `budget` bytes, keeping the last ordinary
// line as the detail. Files finish when their total changes; the percent
// never claims 100 -- the step's own done stamp says that.
export function pipProgress(budget) {
  let done = 0, curTotal = 0, curGot = 0, last = "";
  return (line) => {
    const m = /^Progress (\d+) of (\d+)$/.exec(line.trim());
    if (!m) {
      last = line.slice(0, 120);
      return [budget ? Math.min(99, Math.round((100 * (done + curGot)) / budget)) : null, last];
    }
    const got = Number(m[1]), total = Number(m[2]);
    if (total !== curTotal) { done += curTotal; curTotal = total; }
    curGot = got;
    return [budget ? Math.min(99, Math.round((100 * (done + curGot)) / budget)) : null, last];
  };
}

// What one pip install fetches from and asks for, as its START line: the
// index its arguments name, else pip's default with PIP_INDEX_URL beside it
// when that is set (pip then reads that one instead), and the requirement
// files by name or the packages as written.
export function pipStartLine(what, args, env = process.env) {
  let index = null;
  const extra = [], wants = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--index-url") index = urlText(args[++i]);
    else if (args[i] === "--extra-index-url") extra.push(urlText(args[++i]));
    else if (args[i] === "-r") wants.push(basename(args[++i]));
    else wants.push(args[i]);
  }
  index ??= `https://pypi.org/simple${env.PIP_INDEX_URL ? ` (PIP_INDEX_URL=${urlText(env.PIP_INDEX_URL)})` : ""}`;
  return `DOWNLOAD START ${what} from ${[index, ...extra].join(" + ")} (${wants.join(" ")})`;
}

// pip's "Downloading fastapi-0.115.0-py3-none-any.whl (94 kB)": the file it
// fetched (pip 26 names the file, an older pip the whole address off PyPI)
// and the size in pip's own units -- or "Using cached ...", a file that came
// out of pip's own cache instead (the pip upgrade runs with it).
const PIP_FETCHED = /(Downloading|Using cached) (\S+) \(([\d.]+) (bytes|kB|MB)\)/;
const PIP_UNIT = { bytes: 1, kB: 1e3, MB: 1e6 };

// The lines that close one pip install: a FILE line for each package pip's
// --report lists as installed, with the size pip printed as it fetched that
// file (matched by file name), then DONE with the count -- unknown when there
// is no report, from a pip older than the flag.
export function pipDoneLines(what, report, fetched, secs) {
  const sizes = new Map();
  for (const line of fetched) {
    const m = PIP_FETCHED.exec(line);
    if (m) sizes.set(m[2].split("/").pop(), `${sizeText(Number(m[3]) * PIP_UNIT[m[4]])}${m[1] === "Using cached" ? " (cached)" : ""}`);
  }
  const installs = report?.install;
  return [
    ...(installs ?? []).map(({ metadata, download_info: info }) => {
      const size = sizes.get(info.url.split("/").pop());
      return `DOWNLOAD FILE ${what}: ${metadata.name} ${metadata.version}${size ? ` ${size}` : ""} from ${urlText(info.url)}`;
    }),
    `DOWNLOAD DONE ${what}: ${installs ? installs.length : "?"} packages in ${secs}s`,
  ];
}

// urllib3's warning inside pip each time it tries a request again: "WARNING:
// Retrying (Retry(total=9, connect=None, read=None, redirect=None,
// status=None)) after connection broken by 'ReadTimeoutError(...)':
// /simple/fastapi/". total is how many tries are left after this one. The
// reason can hold quotes of its own, so it runs to the last "': ".
const PIP_RETRYING = /Retrying \(Retry\(total=(\d+)\b.*?\)\) after connection broken by '(.*)': (\S+)\s*$/;
// How often pip tries a request again when its arguments name no --retries.
export const PIP_DEFAULT_RETRIES = 5;

// That warning as a RETRY line: which try this is out of all of them (the
// first plus `retries`), the seconds since the install's START, urllib3's
// reason cut at 200, and the path it was fetching. null for any other line.
export function pipRetryLine(what, line, retries, secs) {
  const m = PIP_RETRYING.exec(line);
  if (!m) return null;
  return `DOWNLOAD RETRY ${what} (${retries - Number(m[1]) + 1}/${retries + 1}) after ${secs}s: `
    + `${urlText(m[2]).slice(0, 200)} (${m[3].replace(/\?.*/, "?…")})`;
}

// The lines that close one hf download: a FILE line for each file the model
// names, with its size on disk and the address hf fetched it from (the
// pinned revision's resolve URL), then DONE with the count and the total.
// files: [{name, bytes}], bytes null for a file that is not there.
export function hfDoneLines(what, base, repo, revision, files, secs) {
  const total = files.reduce((n, f) => n + (f.bytes ?? 0), 0);
  return [
    ...files.map((f) => `DOWNLOAD FILE ${what}: ${f.name}${f.bytes == null ? "" : ` ${sizeText(f.bytes)}`} from ${base}/${repo}/resolve/${revision}/${f.name}`),
    // hf compares each file's size with the one the server announced.
    `DOWNLOAD DONE ${what}: ${files.length} files, ${sizeText(total)} in ${secs}s, size checked by hf`,
  ];
}

// A file's size, or null when it is not there.
const sizeOf = (path) => (existsSync(path) ? statSync(path).size : null);

// While the desktop app installs a pack it leaves this stamp, so the backend
// (which cannot see the shell's work) answers "downloading" for the pack
// instead of "paused" -- the folder alone looked half-done (2026-09-08).
export function packInstallingMarker(kitDir, id) {
  return join(kitDir, ".install", `${id}.installing`);
}

export function torchVariantFor(kitDir) {
  const envPath = join(kitDir, KIT_ENV);
  if (!existsSync(envPath)) return TORCH_VARIANT;   // a fresh install: the hardware guess
  try {
    const m = /^PERSODUB_TORCH_VARIANT=(\S+)/m.exec(readFileSync(envPath, "utf8"));
    if (m && ["cpu", "cu128", "mps"].includes(m[1])) return m[1];
  } catch { /* unreadable: treated as a legacy kit below */ }
  // A kit.env from before the key existed: that kit installed the only build
  // there was, whatever the GPU. Guessing from the hardware here would reopen
  // the engines step on update (the pip index is in its fingerprint) and swap
  // a working torch for another -- twice, once the legacy value is recorded.
  return LEGACY_TORCH_VARIANT;
}

export function writeKitEnv({ kitDir, torchVariant = torchVariantFor(kitDir) }) {
  const k = (...p) => join(kitDir, ...p);
  const enginesPy = venvBin(k("engines_venv"), "python");
  // Through withEraserKitEnvKeys: a kit that already has the subtitle-eraser
  // pack keeps its two keys when this template is written fresh.
  return withEraserKitEnvKeys([
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
    // Stage-5/6 leakage check: cancels the original voice it finds in the
    // finished dub. Shipped log-only ("measure") until the owner heard the
    // fix make a difference (2026-10-06).
    "PERSODUB_LEAKAGE_GATE=on",
    // Mac-CPU-calibrated take-scorer ASR timeout (backend default: 15s).
    "PERSODUB_SCORER_ASR_TIMEOUT=60",
    // Mac-CPU-calibrated diarization timeout (backend default: 600s).
    "PERSODUB_DIAR_TIMEOUT=1800",
    // Which torch build venv-engines installed (cpu/cu128/mps) -- read by
    // app/models.py's platform_key().
    `PERSODUB_TORCH_VARIANT=${torchVariant}`,
    // No PERSO_SPACE_SEQ / PERSO_MEDIA_HOST here: the backend resolves the
    // workspace id from the API key itself (app/perso_client.py, the way the
    // official perso-dubbing-plugin does) and the media host has a public
    // default -- pinning this Mac's values would break every other account.
    "# Optional API keys — fill in to enable:",
    "# TRANSLATE_ENGINE=gemini",
    "# GEMINI_API_KEY=",
    "# PERSO_API_KEY=",
    "",
  ].join("\n"), kitDir);
}

// The log-only value every kit.env carried from 0.7.0 until the leakage check
// was validated by ear (2026-10-06); an existing kit is moved to "on".
const LEAKAGE_GATE_DARK_LAUNCH = /^PERSODUB_LEAKAGE_GATE=measure$/m;

// Adds any of KIT_ENV_MANAGED_ADDITIONS missing from an existing kit.env and
// turns the leakage check's dark-launch value on, preserving every other line
// untouched -- app/settings_env.py writes user API keys into this same file
// and they must survive an upgrade. A no-op (returns text unchanged) once all
// managed keys are already present.
export function withMissingKitEnvKeys(text) {
  text = text.replace(LEAKAGE_GATE_DARK_LAUNCH, "PERSODUB_LEAKAGE_GATE=on");
  const missing = KIT_ENV_MANAGED_ADDITIONS.filter((a) => !text.includes(`${a.key}=`));
  if (missing.length === 0) return text;
  const sep = text.endsWith("\n") ? "" : "\n";
  return text + sep + missing.flatMap((a) => [a.comment, a.line]).join("\n") + "\n";
}

const GB = 1024 ** 3;

// What the one engines venv leaves on disk. macOS measured 2026-09-03 on the
// merged list (MPS torch 0.4 GB + the rest); Windows measured 2026-09-02 on
// the CUDA torch alone (8.4 GB per venv) plus the voice packages that now
// share it. Re-measure after the first Windows install of the merged venv.
// A Windows machine with no NVIDIA GPU (torch variant "cpu") installs the
// much smaller CPU-only wheel instead, budgeted here as 1.5 GB.
const venvEnginesBytes = (variant) => (IS_WIN ? (variant === "cpu" ? 1.5 * GB : 9 * GB) : 2 * GB);

// What the subtitle eraser's own venv leaves on disk. Measured 2026-09-09:
// 2.83 GB on macOS, 7.45 GB on Windows with the cu128 torch. A Windows
// machine with no NVIDIA GPU installs the CPU wheel instead; that one has not
// been measured, so it is budgeted at the Mac figure plus half a gigabyte.
const venvEraserBytes = (variant) => (IS_WIN ? (variant === "cpu" ? 3.5 * GB : 7.5 * GB) : 3 * GB);

// The translation runtime's archive is 139 MB on macOS but ~1.5 GB on
// Windows; unpacked, Windows measured 1.5-1.9 GB on disk (audit, 2026-09-29).
// A flat 0.5 GB budget let a Windows install start this step without enough
// room left and fail partway through.
const ollamaRuntimeBytes = IS_WIN ? 2.0 * GB : 0.5 * GB;

/** How much room the steps that have not run yet still need. */
export async function bytesStillNeeded(steps) {
  let total = 0;
  for (const s of steps) {
    if (!(await s.isDone())) total += s.bytes;
  }
  return total;
}

// What an older kit leaves behind and this version no longer reads. Each is
// removed once venv-engines succeeded (this step sits right after it), and
// the step stays open until every one is gone -- a locked file on Windows
// just means it is retried next launch.
// ctx.abandonedKitDir: the kit at the pre-0.3.0 path (Electron's userData)
// that bootFlow.js redirected away from, carrying its models/ over. It stayed
// behind holding ~3 GB with nothing telling the user it was safe to delete
// (issue #6). Removed only once models/ is gone from it, so a failed carry-over
// never costs the models.
const LEFTOVERS = (k, ctx = {}) => [
  ...(ctx.abandonedKitDir && !existsSync(join(ctx.abandonedKitDir, "models"))
    ? [{ path: ctx.abandonedKitDir, recursive: true }] : []),
  { path: k("qwen_venv"), recursive: true },                       // the retired voice venv
  { path: k("downloads", "python.tar.gz") },                         // archives, already extracted
  { path: k("downloads", "ollama.tgz") },
  { path: k("downloads", "ollama.zip") },
  { path: k("downloads", "eraser-src.zip") },
  { path: k("requirements_qwen_mac.txt") },                          // the retired venv's lists
  { path: k("requirements_qwen_win.txt") },
  { path: k(".install", "venv-qwen.ok") },                          // the retired step's marker
];

export function buildSteps(ctx) {
  const k = (...p) => join(ctx.kitDir, ...p);
  // log(line, level): shell.log, for the DOWNLOAD lines of every file the
  // steps fetch or have a tool fetch (bootFlow.js hands it shellLog).
  const log = ctx.log ?? (() => {});
  const modelDone = (m) => m.markers.every((rel) => existsSync(k(...rel)));
  const py = standalonePython(k("python"));
  // Per-platform pinned dependency list (bundled by collect-payload.mjs).
  const reqSuffix = IS_WIN ? "win" : "mac";
  const reqEngines = `requirements_engines_${reqSuffix}.txt`;
  // One list for both platforms: the eraser's pinned packages, with torch
  // installed ahead of them (per platform) the way the engines venv does it.
  const reqEraser = "requirements_eraser.txt";
  // On Windows, torch/torchaudio come from a dedicated index: the CUDA build
  // when an NVIDIA GPU is present, else PyPI's own CPU-only wheel -- either
  // way installed before the rest of the engines list. macOS gets the MPS
  // wheel automatically, so no extra install. This index URL is part of the
  // venv step's pip-argument fingerprint (see pipFingerprint below), so a
  // machine that gains a GPU later re-opens the step on its own.
  // An installed kit keeps the build it has (torchVariantFor): only a fresh
  // install follows the hardware guess.
  const torchVariant = ctx.torchVariant ?? torchVariantFor(ctx.kitDir);
  const torchIndex = torchVariant === "cpu"
    ? "https://download.pytorch.org/whl/cpu"
    : "https://download.pytorch.org/whl/cu128";
  const torchCuda = IS_WIN
    ? [["torch==2.8.0", "torchaudio==2.8.0", "--index-url", torchIndex]]
    : [];
  // The eraser's own torch pair, the versions its OCR/inpainting code was
  // verified against (2026-09-09) -- older than the engines venv's, which is
  // why it gets a venv of its own rather than sharing that one. Same index
  // choice on Windows; macOS takes the MPS wheel from PyPI.
  const torchEraser = IS_WIN
    ? ["torch==2.7.0", "torchvision==0.22.0", "--index-url", torchIndex]
    : ["torch==2.7.0", "torchvision==0.22.0"];
  const okPath = (id) => k(".install", `${id}.ok`);
  // Trust what this computer trusts (vendor/truststore/persodub_truststore.py):
  // company security software that inspects HTTPS hands Python a certificate
  // only the OS knows, and pip, hf and the Perso API calls all stopped on
  // CERTIFICATE_VERIFY_FAILED (2026-10-15). The wheel ships in the payload,
  // so installing it needs no network; the .pth loads the hook in every
  // interpreter of the venv.
  const trustDir = join(ctx.payloadDir, "kit-src", "truststore");
  const trustHook = join(trustDir, "persodub_truststore.py");
  // The venv's site-packages: Windows keeps one path, POSIX names the Python
  // (the kit's python3.11, standalonePython).
  const sitePackages = (venvDir) => IS_WIN
    ? join(venvDir, "Lib", "site-packages")
    : join(venvDir, "lib", basename(py), "site-packages");
  const markOk = (id, note = "") => {
    mkdirSync(k(".install"), { recursive: true });
    writeFileSync(okPath(id), note);
  };

  // Everything a venv step would install, as one fingerprint. The pip
  // arguments alone are not enough: ["-r", file] means the FILE's contents,
  // and an app update rewrites those files (payload step above) while the
  // arguments stay word-for-word the same. The 0.4.0 update added `mcp` to
  // requirements.txt and no updated machine ever installed it -- the venv
  // steps skipped on their bare .ok markers, and the script assistant's tool
  // server could not start. The marker now records this fingerprint, so a
  // requirements change is what re-opens the step; an update that changes no
  // requirements still skips it in full.
  const pipFingerprint = (pipInstalls) => {
    const words = [];
    for (const args of pipInstalls) {
      for (let i = 0; i < args.length; i++) {
        words.push(args[i]);
        if (args[i] === "-r") {
          // The missing-file marker never matches a recorded hash, so a kit
          // whose requirements file vanished re-runs rather than skips.
          words.push(existsSync(args[i + 1]) ? readFileSync(args[i + 1], "utf8") : "(missing)");
          i++;
        }
      }
    }
    // The hook's text too, so a changed hook reaches kits already installed.
    words.push(existsSync(trustHook) ? readFileSync(trustHook, "utf8") : "(missing)");
    return createHash("sha256").update(JSON.stringify(words)).digest("hex");
  };

  // One pip install between its DOWNLOAD lines: START with the index and what
  // it asks for, then a FILE line a package off pip's own --report and DONE,
  // or FAILED with pip's last reason. `venvPy -m pip`, not the bin/pip shim:
  // the shim carries an absolute shebang, so it is the one file in a venv
  // that a moved or repaired environment can no longer run.
  // `progress` (pipProgress) is for an install that counts its bytes: with
  // --progress-bar raw pip prints "Progress <got> of <total>" per file even
  // without a terminal, and the sum against the step's budget is the percent
  // the page shows -- the pip step used to sit at 0% through a 3.5 GB torch
  // (Windows, 2026-09-07). --retries/--timeout go with it: a flaky line
  // dropped a 3.5 GB wheel five times in one pip run; pip resumes the same
  // download, so more patience is cheap.
  // A flag an older pip refuses is dropped and the same install runs again.
  // "raw" arrived in pip 24.1: when the pip upgrade could not reach the
  // index, the venv keeps the Python's own older pip, which refuses the flag
  // outright (issue #111), and the install only loses the byte count.
  // --report arrived in 22.2, and without it only the FILE lines are lost.
  // pip's own tries of a request again are RETRY lines (pipRetryLine),
  // counted out of the --retries the command names, else pip's default.
  // The files pip fetches are kept in the kit (pipCache) until the venv step
  // is done, so a Resume after a cut line or a Cancel takes the wheels that
  // were already in from there: with --no-cache-dir every one of them came
  // down again, PyTorch's 3.5 GB Windows wheel too (owner, 2026-10-22, 1-3).
  // Not pip's own cache: that one kept a 3 GB torch wheel outside the kit
  // for good (Windows, %LOCALAPPDATA%\pip).
  const pipCache = (venvName) => k("downloads", `pip-${venvName}`);
  const pipInstall = async (venvPy, venvName, args, report, progress = null) => {
    const what = `pip ${venvName}`;
    const reportFile = k("downloads", `pip-report-${venvName}.json`);
    const fetched = [];   // pip's lines naming a file and its size (PIP_FETCHED), for pipDoneLines
    let bar = progress ? "raw" : null;
    let listed = true;
    mkdirSync(k("downloads"), { recursive: true });
    log(pipStartLine(what, args));
    const from = Date.now();
    try {
      for (;;) {
        const flags = bar ? ["--cache-dir", pipCache(venvName), "--progress-bar", bar, "--retries", "10", "--timeout", "60"] : [];
        const argv = [venvPy, "-m", "pip", "install", ...flags, ...args, ...(listed ? ["--report", reportFile] : [])];
        const retries = argv.includes("--retries") ? Number(argv[argv.indexOf("--retries") + 1]) : PIP_DEFAULT_RETRIES;
        try {
          await ctx.run(argv, {
            onLine: (l) => {
              if (PIP_FETCHED.test(l)) fetched.push(l);
              const retry = pipRetryLine(what, l, retries, secondsSince(from));
              if (retry) log(retry);
              report(...(bar === "raw" ? progress(l) : [null, l.slice(0, 120)]));
            },
          });
          break;
        } catch (e) {
          const said = String(e && e.message);
          if (bar === "raw" && RAW_BAR_REFUSED.test(said)) {
            log(`${what}: pip is older than expected, installing without the progress count`);
            bar = "off";
          } else if (listed && REPORT_REFUSED.test(said)) {
            listed = false;
          } else {
            throw e;
          }
        }
      }
      const parsed = listed && existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, "utf8")) : null;
      for (const line of pipDoneLines(what, parsed, fetched, secondsSince(from))) log(line);
    } catch (e) {
      log(`DOWNLOAD FAILED ${what} after ${secondsSince(from)}s: ${urlText(lastReason(errorText(e)))}`, "ERROR");
      throw e;
    } finally {
      rmSync(reportFile, { force: true });
    }
  };

  // proveItWorks: an optional last word before the step stamps itself done --
  // pip can finish and still leave an environment the tool cannot be loaded
  // from. It runs with the fresh venv's python and may throw, in which case
  // no stamp is written and the step is open again next time.
  const venvStep = (id, title, bytes, venvName, pipInstalls, proveItWorks = null) => ({
    id,
    title,
    // A venv that already exists is being updated: pip adds what the new list
    // brings (hundreds of MB), not the full budget that includes torch. The
    // budget is what the free-space preflight and the install title show.
    bytes: existsSync(k(venvName)) ? Math.min(bytes, 0.5 * GB) : bytes,
    isDone: () => existsSync(okPath(id))
      && readFileSync(okPath(id), "utf8").trim() === pipFingerprint(pipInstalls),
    run: async (report) => {
      const venvDir = k(venvName);
      const budget = existsSync(venvDir) ? Math.min(bytes, 0.5 * GB) : bytes;
      report(null, t("Creating {name}", { name: venvName }));
      await ctx.run([py, "-m", "venv", venvDir]);
      const venvPy = venvBin(venvDir, "python");
      // The OS trust hook goes in before the first download (trustDir above).
      await ctx.run([venvPy, "-m", "pip", "install", "--no-cache-dir", "--no-index", "--find-links", trustDir, "truststore"],
                    { onLine: (l) => report(null, l.slice(0, 120)) });
      const site = sitePackages(venvDir);
      mkdirSync(site, { recursive: true });
      cpSync(trustHook, join(site, "persodub_truststore.py"));
      writeFileSync(join(site, "persodub_truststore.pth"), "import persodub_truststore\n");
      // Upgrade pip via `python -m pip`, not `pip.exe`: on Windows pip.exe is
      // locked while running and cannot rewrite itself ("To modify pip, please
      // run: python -m pip install --upgrade pip"). `python -m pip` is safe on
      // both platforms.
      await pipInstall(venvPy, venvName, ["--upgrade", "pip"], report);
      const progress = pipProgress(budget);
      for (const args of pipInstalls) await pipInstall(venvPy, venvName, args, report, progress);
      if (proveItWorks) await proveItWorks(venvPy, report);
      markOk(id, pipFingerprint(pipInstalls));
      // Installed: the kept wheels are a second copy now. Best-effort, as the
      // archives below: a file Windows will not let go of fails no install.
      try {
        rmSync(pipCache(venvName), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        console.warn(`PERSODUB_INSTALL could not remove ${pipCache(venvName)}`);
      }
    },
  });

  // The kit's Python is 3.11.15, and the tool's README asks for 3.12+. One
  // file needs it: backend/inpaint/sttn_auto_inpaint.py:245 writes an f-string
  // with the same quote inside the braces ({frame_info['len']}), which is
  // PEP 701 and only parses from 3.12. That file sits on backend.main's import
  // path, so every erase died on a SyntaxError while detection -- which never
  // imports backend.main -- passed (measured 2026-09-09). Parsing all of
  // backend/ with 3.11 found this one file and no other, and the app runs only
  // this module's STTN_DET path, so swapping the two quotes changes the syntax
  // and nothing else.
  // Root fix, next time this commit is re-pinned: give venv-eraser a CPython
  // 3.12 standalone of its own and put the interpreter version into
  // pipFingerprint, so a Python change re-opens the step instead of leaving a
  // venv built for another one.
  const PY312_FSTRING = "{frame_info['len']}";
  const makeReadableToPython311 = (report) => {
    const path = k("eraser", "vsr", "backend", "inpaint", "sttn_auto_inpaint.py");
    if (!existsSync(path)) return;   // upstream moved it: the import check below is what judges
    const text = readFileSync(path, "utf8");
    if (!text.includes(PY312_FSTRING)) return;   // already plain 3.11 syntax
    report(null, t("Preparing the subtitle eraser"));
    writeFileSync(path, text.replaceAll(PY312_FSTRING, '{frame_info["len"]}'));
  };

  // The one second that turns "pip finished" into "the eraser works": the
  // tool's own entry module is imported with the venv that just installed it.
  // A 3.11 kit against a 3.12-only source, or a wheel that resolved but does
  // not load, is a SyntaxError/ImportError here -- instead of a dead Erase
  // button on a pack the user was told was installed (measured 2026-09-09:
  // every erase failed while detection, which never imports this module,
  // passed). PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: paddlex otherwise reaches
  // out to a model registry on import.
  const eraserImports = async (venvPy, report) => {
    report(null, t("Checking the subtitle eraser"));
    const vsr = k("eraser", "vsr");
    const recent = [];
    try {
      await ctx.run(
        [venvPy, "-c", `import sys; sys.path.insert(0, ${JSON.stringify(vsr)}); import backend.main`],
        { cwd: vsr,
          env: { ...process.env, PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: "True" },
          onLine: (l) => { recent.push(l); if (recent.length > 3) recent.shift(); } },
      );
    } catch (err) {
      // The tool's own last line, not the whole traceback: that is the
      // sentence naming the file and the reason.
      const why = recent[recent.length - 1] || errorText(err);
      throw new Error(`The subtitle eraser installed but could not be loaded: ${why.slice(0, 200)}`);
    }
  };

  // The eraser's venv, proved by that import, plus the two kit.env keys that
  // follow it: the app reads their presence as "the pack is here", so they
  // are written from the same place the stamp saying the venv is complete
  // comes from.
  // "2 of 2" with its own size: the pack's banner says the whole (7.9 GB on a
  // Windows GPU machine) and the first step said 790 MB, which read as a
  // tenfold contradiction until the second step named its share (2026-09-10).
  const eraserVenv = venvStep("venv-eraser",
                              t("Installing its Python parts (2 of 2, about {size} GB)", { size: (venvEraserBytes(torchVariant) / GB).toFixed(1) }),
                              venvEraserBytes(torchVariant), "venv-eraser",
                              [torchEraser, ["-r", k(reqEraser)]], eraserImports);

  const steps = [
    {
      id: "payload",
      title: t("Copying bundled files"),
      bytes: 0.3 * GB,
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
        report(null, t("Copying app code"));
        cpSync(join(ctx.payloadDir, "app-repo"), k("app"), { recursive: true });
        cpSync(join(ctx.payloadDir, "kit-src", "sidecar"), k("sidecar"), { recursive: true });
        cpSync(join(ctx.payloadDir, "kit-src", reqEngines), k(reqEngines));
        cpSync(join(ctx.payloadDir, "kit-src", reqEraser), k(reqEraser));
        mkdirSync(k("models", "campplus"), { recursive: true });
        const cam = join(ctx.payloadDir, "campplus.onnx");
        if (existsSync(cam)) {
          cpSync(cam, k("models", "campplus", "campplus.onnx"));
        } else {
          report(null, t("Downloading speaker model (27 MB)"));
          await ctx.download(CAMPPLUS_URL, k("models", "campplus", "campplus.onnx"),
                             { sha256: CAMPPLUS_SHA256, what: "campplus", log });
        }
        cpSync(join(ctx.payloadDir, "KIT_VERSION"), k("KIT_VERSION"));
      },
    },
    {
      id: "python",
      title: t("Downloading Python runtime (~50 MB)"),
      bytes: 0.2 * GB,
      isDone: () => existsSync(okPath("python")),
      run: async (report) => {
        mkdirSync(k("downloads"), { recursive: true });
        const tarball = k("downloads", "python.tar.gz");
        await ctx.download(PYTHON_URL, tarball, {
          sha256: PYTHON_SHA256,
          what: "python",
          log,
          onProgress: (p) => report(p.total ? Math.round((100 * p.received) / p.total) : null, t("Downloading Python")),
        });
        report(null, t("Extracting Python"));
        await ctx.extract(tarball, ctx.kitDir);
        // Best-effort: the extract above is the real work, already done. An
        // antivirus/indexer holding the archive open (EBUSY/EPERM) must not
        // fail the step or force a re-download next launch -- { force: true }
        // alone only swallows ENOENT, not a locked file.
        try {
          rmSync(tarball, { force: true }); // 26 MB the kit never reads again
        } catch {
          console.warn(`PERSODUB_INSTALL could not remove ${tarball}; leaving it in downloads/`);
          report(null, t("Could not remove {file}; leaving it in downloads/", { file: "python.tar.gz" }));
        }
        markOk("python");
      },
    },
    venvStep("venv-app", t("Installing app environment"), 0.2 * GB, "app_venv", [["-r", k("app", "requirements.txt")]]),
    {
      id: "ffmpeg",
      title: t("Setting up ffmpeg"),
      bytes: 0.2 * GB,
      isDone: () => existsSync(k("bin", exeName("ffmpeg"))) && existsSync(k("bin", exeName("ffprobe"))),
      run: async (report) => {
        report(null, t("Downloading the video-processing program"));
        const lines = [];
        // static-ffmpeg lives in app_venv (requirements.txt): the one venv a
        // light install always has, so ffmpeg no longer waits on the engines.
        // It first says where it fetches from and to, and whether an earlier
        // run already did (its installed.crumb) -- flushed, so the START line
        // comes before the fetch. It checks no checksum.
        let from = Date.now();
        let fetch = null;
        try {
          await ctx.run(
            [
              venvBin(k("app_venv"), "python"),
              "-c",
              "import json, os; from static_ffmpeg.run import get_platform_http_zip as u, get_platform_dir as d, "
                + "get_or_fetch_platform_executables_else_raise as g; "
                + "print(json.dumps({'url': u(), 'dir': d(), 'cached': os.path.exists(os.path.join(d(), 'installed.crumb'))}), flush=True); "
                + "print(json.dumps(list(g())))",
            ],
            { onLine: (l) => {
              lines.push(l);
              if (fetch || !l.startsWith('{"url"')) return;
              fetch = JSON.parse(l);
              from = Date.now();
              log(`DOWNLOAD START ffmpeg from ${urlText(fetch.url)} to ${fetch.dir}`);
            } },
          );
        } catch (err) {
          log(`DOWNLOAD FAILED ffmpeg after ${secondsSince(from)}s: ${urlText(lastReason(errorText(err)))}`, "ERROR");
          throw err;
        }
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
        log(`DOWNLOAD DONE ffmpeg: 2 files, ${sizeText(statSync(ffmpeg).size + statSync(ffprobe).size)} in ${secondsSince(from)}s${fetch?.cached ? " (already on disk)" : ""}, not checked`);
        // The copied binary's own first line: which ffmpeg build this kit
        // runs. One that cannot even say that is an ERROR line, not a failed
        // step: the step's work, the copy, is done.
        const said = [];
        try {
          await ctx.run([k("bin", exeName("ffmpeg")), "-version"], { onLine: (l) => said.push(l) });
          log(`DOWNLOAD FILE ffmpeg: ${said[0] ?? "(no output)"}`);
        } catch (err) {
          log(`DOWNLOAD FILE ffmpeg: -version failed: ${lastReason(errorText(err))}`, "ERROR");
        }
      },
    },
    // One venv for every engine: separation, transcription, diarization, the
    // take scorer and the Qwen3-TTS sidecar. They used to be two (engines +
    // qwen) because the original Linux host had Python 3.8 for some of them;
    // on macOS/Windows with one 3.11 that split only bought a second copy of
    // torch (0.4 GB on macOS, 8 GB of CUDA wheels on Windows).
    venvStep("venv-engines", t("Installing AI engines"), venvEnginesBytes(torchVariant), "engines_venv", [
      ...torchCuda,
      ["-r", k(reqEngines)],
    ]),
    {
      // Kits installed before the merge carry the old voice venv and its
      // debris. Removing it is a step of its own so it runs only after
      // venv-engines succeeded (runInstall stops at the first failure), shows
      // on the install screen, and is skipped forever once everything is gone.
      id: "cleanup",
      title: t("Cleaning up"),
      bytes: 0,
      verify: false,   // a locked leftover is dead weight, never a failed install
      isDone: () => LEFTOVERS(k, ctx).every((l) => !existsSync(l.path)),
      run: async (report) => {
        for (const l of LEFTOVERS(k, ctx)) {
          if (!existsSync(l.path)) continue;
          report(null, t("Removing {file}", { file: basename(l.path) }));
          try {
            rmSync(l.path, { recursive: !!l.recursive, force: true, maxRetries: 5, retryDelay: 200 });
          } catch {
            console.warn(`PERSODUB_INSTALL could not remove ${l.path}; will retry next launch`);
            report(null, t("Could not remove {file} yet; will retry next launch", { file: basename(l.path) }));
          }
        }
      },
    },
    {
      id: "models",
      title: t("Downloading sound-separation model (~80 MB)"),
      bytes: 0.1 * GB,
      isDone: () => MODELS.every(modelDone),
      run: async (report) => {
        // `python -m huggingface_hub.cli.hf`, not the hf.exe shim: the same
        // reason the pip step above runs `venvPy -m pip` instead of pip.exe --
        // an unsigned launcher a venv creates on install can get "spawn UNKNOWN"
        // from Smart App Control or an antivirus that trusts the interpreter but
        // not a fresh .exe (issue #48, nine failures on one Windows machine).
        const venvPy = venvBin(k("app_venv"), "python");
        // Where hf fetches from: HF_ENDPOINT when set (hf reads the same
        // variable), else huggingface.co.
        const base = (process.env.HF_ENDPOINT || "https://huggingface.co").replace(/\/+$/, "");
        for (const m of MODELS) {
          if (modelDone(m)) continue;
          report(null, t("Downloading {name}", { name: m.name }));
          const dir = k(...m.dir);
          mkdirSync(dir, { recursive: true });
          const [repo, ...files] = m.args;
          const what = `hf ${repo}@${m.revision.slice(0, 7)}`;
          log(`DOWNLOAD START ${what} from ${base}/${repo} to ${dir}`);
          const from = Date.now();
          try {
            await ctx.run([venvPy, "-m", "huggingface_hub.cli.hf", "download", ...m.args, "--revision", m.revision, "--local-dir", dir], {
              onLine: (l) => report(null, l.slice(0, 120)),
            });
          } catch (err) {
            log(`DOWNLOAD FAILED ${what} after ${secondsSince(from)}s: ${urlText(lastReason(errorText(err)))}`, "ERROR");
            throw err;
          }
          const got = files.map((name) => ({ name, bytes: sizeOf(join(dir, name)) }));
          for (const line of hfDoneLines(what, base, repo, m.revision, got, secondsSince(from))) log(line);
        }
      },
    },
    {
      // Runtime binary only. The Gemma pull that used to follow it moved to
      // the in-app model catalog (downloaded by the Python server on first
      // use), which is what makes this a light install.
      id: "ollama-runtime",
      title: t("Downloading the translation runtime"),
      bytes: ollamaRuntimeBytes,
      isDone: () => existsSync(k("ollama", exeName("ollama"))),
      run: async (report) => {
        // Resume: an already-extracted binary needs no second download.
        if (existsSync(k("ollama", exeName("ollama")))) return;
        report(null, t("Downloading the translation runtime"));
        mkdirSync(k("downloads"), { recursive: true });
        const archive = k("downloads", IS_WIN ? "ollama.zip" : "ollama.tgz");
        await ctx.download(OLLAMA_TGZ_URL, archive, {
          sha256: OLLAMA_TGZ_SHA256,
          what: "ollama-runtime",
          log,
          onProgress: (p) => report(p.total ? Math.round((100 * p.received) / p.total) : null, t("Downloading the translation runtime")),
        });
        report(null, t("Unpacking the translation runtime"));
        await ctx.extract(archive, k("ollama"));
        // Best-effort, same reasoning as the python step above.
        try {
          rmSync(archive, { force: true }); // 139 MB (1.5 GB on Windows) the kit never reads again
        } catch {
          console.warn(`PERSODUB_INSTALL could not remove ${archive}; leaving it in downloads/`);
          report(null, t("Could not remove {file}; leaving it in downloads/", { file: IS_WIN ? "ollama.zip" : "ollama.tgz" }));
        }
      },
    },
    {
      // A missing "base" model makes nonverbal.py fail-closed, silently
      // deleting every laugh/breath/sigh from every dub -- so this step
      // fails the install loudly instead, same as any other step here.
      id: "nonverbal-weights",
      title: t("Downloading nonverbal-detection model (~140 MB)"),
      bytes: 0.2 * GB,
      isDone: () => whisperCacheDone(),
      run: async (report) => {
        report(null, t("Downloading nonverbal-detection model"));
        // Wrong size (or nothing there yet): a stale partial from a died
        // install does not fool whisper.load_model into skipping its own
        // download, so it never gets the chance to trust it either.
        rmSync(whisperCachePath(), { force: true });
        // openai-whisper first says which address and file it fetches "base"
        // from and to, worked out the way its load_model does -- flushed, so
        // the START line comes before the fetch. It checks the file against
        // the sha256 that is part of that address, and fails the load when
        // they differ.
        let from = Date.now();
        let fetch = null;
        try {
          await ctx.run([
            venvBin(k("engines_venv"), "python"),
            "-c",
            "import json, os, whisper; u = whisper._MODELS['base']; "
              + "root = os.path.join(os.getenv('XDG_CACHE_HOME', os.path.join(os.path.expanduser('~'), '.cache')), 'whisper'); "
              + "print(json.dumps({'url': u, 'path': os.path.join(root, os.path.basename(u))}), flush=True); "
              + "whisper.load_model('base')",
          ], { onLine: (l) => {
            if (fetch || !l.startsWith('{"url"')) return;
            fetch = JSON.parse(l);
            from = Date.now();
            log(`DOWNLOAD START whisper base from ${urlText(fetch.url)} to ${fetch.path}`);
          } });
        } catch (err) {
          log(`DOWNLOAD FAILED whisper base after ${secondsSince(from)}s: ${urlText(lastReason(errorText(err)))}`, "ERROR");
          throw err;
        }
        log(`DOWNLOAD DONE whisper base: ${sizeText(sizeOf(fetch?.path ?? whisperCachePath()) ?? 0)} in ${secondsSince(from)}s, sha256 checked by whisper`);
      },
    },
    {
      // The eraser's source tree, OCR weights and all, straight from the
      // pinned commit's zip. Its one top folder is stripped so backend/ sits
      // directly in eraser/vsr -- the path kit.env hands the app.
      id: "eraser-src",
      title: t("Downloading the eraser (1 of 2, 790 MB)"),
      // The archive and the unpacked tree are on disk at the same time
      // (0.79 + 1.01 GB); the archive goes at the end of the step.
      bytes: 1.8 * GB,
      isDone: () => existsSync(k("eraser", "vsr", "backend", "main.py"))
        && existsSync(okPath("eraser-src"))
        && readFileSync(okPath("eraser-src"), "utf8").trim() === ERASER_SRC_SHA256,
      run: async (report) => {
        mkdirSync(k("downloads"), { recursive: true });
        const archive = k("downloads", "eraser-src.zip");
        await ctx.download(ERASER_SRC_URL, archive, {
          sha256: ERASER_SRC_SHA256,
          what: "eraser-src",
          log,
          onProgress: (p) => report(p.total ? Math.round((100 * p.received) / p.total) : null, t("Downloading the subtitle eraser")),
        });
        report(null, t("Unpacking the subtitle eraser"));
        // Whatever an interrupted earlier try left half-unpacked: tar over a
        // stale tree would leave the two mixed, and the marker below would
        // then vouch for it.
        rmSync(k("eraser", "vsr"), { recursive: true, force: true });
        await ctx.extract(archive, k("eraser", "vsr"), { strip: 1 });
        makeReadableToPython311(report);
        // Best-effort, same reasoning as the python step above.
        try {
          rmSync(archive, { force: true }); // 790 MB the kit never reads again
        } catch {
          console.warn(`PERSODUB_INSTALL could not remove ${archive}; leaving it in downloads/`);
          report(null, t("Could not remove {file}; leaving it in downloads/", { file: "eraser-src.zip" }));
        }
        markOk("eraser-src", ERASER_SRC_SHA256);
      },
    },
    { ...eraserVenv,
      run: async (report) => {
        await eraserVenv.run(report);
        syncEraserKitEnv(ctx.kitDir);
      } },
    {
      id: "kit-env",
      title: t("Writing configuration"),
      bytes: 0,
      // Must also check the managed additions, not just the original sniff
      // key -- otherwise a kit installed before they existed would satisfy
      // this forever and never receive them (see run, below).
      isDone: () => {
        if (!existsSync(k(KIT_ENV))) return false;
        const text = readFileSync(k(KIT_ENV), "utf8");
        return text.includes("PERSODUB_KIT_DIR") && !LEAKAGE_GATE_DARK_LAUNCH.test(text)
          && KIT_ENV_MANAGED_ADDITIONS.every((a) => text.includes(`${a.key}=`));
      },
      run: async (report) => {
        const path = k(KIT_ENV);
        if (!existsSync(path)) {
          report(null, t("Writing the settings file"));
          writeFileSync(path, writeKitEnv({ kitDir: ctx.kitDir, torchVariant }));
          return;
        }
        // Existing kit (installed before these keys existed): merge, never
        // clobber -- app/settings_env.py writes user API keys into this same
        // file and they must survive.
        report(null, t("Updating the settings file"));
        writeFileSync(path, withMissingKitEnvKeys(readFileSync(path, "utf8")));
      },
    },
  ];
  for (const p of PACKS) {
    for (const s of steps) {
      if (p.steps.includes(s.id)) s.pack = p.id;
    }
  }
  return steps;
}
