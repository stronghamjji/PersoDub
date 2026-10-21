// Pure decision logic for the model-download UI: what the status line under
// each engine dropdown says, and what the "Download N GB of AI models to
// dub?" dialog (dub_start's 409) renders. No DOM, no fetch -- index.html does
// the wiring, ui/src/modelsUi.test.mjs pins the words.
import { t } from "./i18n.mjs";

// Decimal, like the catalog's own numbers, the docs and the Mac's Finder. Divided
// by 1024³ the eraser's 9.3 GB read "8.7 GB" beside the 9.3 measured on disk
// (Windows full test, 2026-09-25), and Gemma's 7.6 read 7.1.
const GB = 1e9;

/** "7.6" -- bytes as one-decimal gigabytes, the unit every screen uses. */
export function gb(bytes) {
  return (bytes / GB).toFixed(1);
}

/** Which catalog model a dropdown choice needs, or null when it needs none
 * (API engines, and separation's always-installed local Demucs). */
export function neededModelId(role, value) {
  if (role === "stt") return value === "perso" ? null : "whisper";
  if (role === "translate") return value === "gemma" ? "gemma" : value === "hunyuan" ? "hunyuan" : null;
  if (role === "voice") return "qwen3-tts";
  return null;
}

/** The status line for one /api/models row (or null when nothing is needed):
 * {cls, text, button} where button is "download" | "resume" | "cancel" | null. */
export function modelStatusLine(row) {
  if (!row) return { cls: "", text: "", button: null };
  if (row.state === "ready") return { cls: "model-ok", text: t("Ready"), button: null };
  if (row.state === "downloading") {
    // progress null = queued behind another download, or no byte in yet: a
    // download says Getting ready… until its first byte, never 0% (Windows C2,
    // 2026-10-21). A pack never queues; null is its set-up.
    const text = row.progress == null
      ? (row.queued ? t("Waiting to download {name}…", { name: row.name }) : t("Getting ready…"))
      : t("Downloading {name}… {pct}%", { name: row.name, pct: row.progress });
    return { cls: "model-busy", text, button: "cancel" };
  }
  if (row.state === "paused") {
    // The server's reason in plain words ("Connection lost."), then what to do.
    const text = row.error ? t("{reason} Press Resume to continue.", { reason: row.error }) : t("Paused");
    return { cls: "model-busy", text, button: "resume" };
  }
  return { cls: "", text: `${gb(row.bytes)} GB`, button: "download" };
}

/** The topbar chip's words for the download it stands for: the name and its
 * percent, or no number while it has none -- the 0% it showed through a pack's
 * set-up read as stuck (Windows C2). */
export function downloadChipText(row) {
  return `${row.name} · ${row.progress == null ? t("Getting ready…") : `${row.progress}%`}`;
}

/** What the dub-start warning dialog shows, from the 409's detail. ramOk is
 * GET /api/engines' ram_ok: false when the computer has too little memory to
 * dub on it. */
export function dubStartDialog(detail, ramOk = true) {
  const missing = detail.missing || [];
  const total = detail.total_bytes ?? missing.reduce((n, m) => n + m.bytes, 0);
  // The desktop app installs packs (kind "pack": the AI engine, the
  // translation runtime); this page downloads models. The 409 lists packs
  // first, and Download and Start takes them in that order.
  const packs = missing.filter((m) => m.kind === "pack").map((m) => m.id);
  const models = missing.filter((m) => m.kind !== "pack").map((m) => m.id);
  const ids = missing.map((m) => m.id);
  // Only the size and what it is for: which files they are is nobody's
  // question (user, 2026-09-28). The voice parts are the ones Perso dubbing
  // does instead, so they are the ones that point there.
  const voice = ids.includes("engine") || ids.includes("qwen3-tts");
  // A start that is not a dubbing's says what the download is for itself
  // (Separate audio), and Perso dubbing is no way round that one.
  const purpose = detail.purpose
    || (voice ? "making voices" : ids.includes("whisper") ? "transcribing" : "translating");
  return {
    title: t("Download {size} GB?", { size: gb(total) }),
    line: downloadLine(purpose),
    perso: voice && !detail.purpose,
    // The memory a dub on this computer needs, said before the download, and
    // in its place, on a computer without it, why the download is off
    // (owner, 2026-10-20). Only for the dub's own download: Separate audio
    // and a translator alone are not held to it.
    ram: voice && !detail.purpose
      ? (ramOk ? t("Needs 8 GB of memory (16 GB recommended).")
        : t("This computer does not have enough memory to dub on this computer. Try the Perso API."))
      : "",
    ramLow: voice && !detail.purpose && !ramOk,
    ids: missing.map((m) => m.id),
    packs,
    models,
    totalBytes: total,
  };
}

// The dialog's line as one whole sentence for each purpose; "separating
// audio" is the engine's own word for Separate audio (app/api/separate.py).
function downloadLine(purpose) {
  if (purpose === "making voices") return t("One-time download for making voices.");
  if (purpose === "transcribing") return t("One-time download for transcribing.");
  if (purpose === "translating") return t("One-time download for translating.");
  if (purpose === "separating audio") return t("One-time download for separating audio.");
  return t("One-time download for {purpose}.", { purpose });
}

/** The packs a dropdown choice needs, alongside the model neededModelId
 * names: local STT and the voice run in the engine pack; Gemma and Hunyuan
 * run in the translation runtime. */
export function neededPackIds(role, value) {
  if (role === "stt") return value === "perso" ? [] : ["engine"];
  if (role === "translate") return value === "gemma" || value === "hunyuan" ? ["ollama-runtime"] : [];
  if (role === "voice") return ["engine"];
  return [];
}

/** One number for the dialog's single progress bar: byte-weighted percent
 * across the models being fetched (a ready model counts as 100), or null
 * while none on its way has a figure yet and none is ready. */
export function overallProgress(rows, ids) {
  const wanted = rows.filter((r) => ids.includes(r.id));
  if (!wanted.length) return 0;
  // A pack setting itself up, or a model before its first byte, has no figure:
  // 0% held for seconds read as stuck, so the dialog says "Getting ready…"
  // instead (Windows C2). Only while nothing is in: a ready one's share is a
  // figure, and the bar does not drop back to 0 between two downloads.
  const going = wanted.filter((r) => r.state === "downloading");
  if (going.length && going.every((r) => r.progress == null) && !wanted.some((r) => r.state === "ready")) return null;
  let got = 0, total = 0;
  for (const r of wanted) {
    total += r.bytes;
    const pct = r.state === "ready" ? 100 : r.state === "downloading" ? (r.progress ?? 0) : 0;
    got += r.bytes * (pct / 100);
  }
  return total ? Math.round((100 * got) / total) : 0;
}

/** Nothing in `ids` is on its way and one of them stopped (paused, or failed
 * before it began): a failed row is not a download at 0%. */
export function downloadStopped(rows, ids) {
  const wanted = rows.filter((r) => ids.includes(r.id));
  return !wanted.some((r) => r.state === "downloading")
    && wanted.some((r) => r.state === "paused" || (r.state === "not_downloaded" && !!r.error));
}

/** Every id in `ids` is ready -- the dialog's cue to resubmit the dub. */
export function allReady(rows, ids) {
  return ids.every((id) => rows.some((r) => r.id === id && r.state === "ready"));
}

// Settings' Models tab, in the order a dub uses them. The titles are English
// sentences, said in the page's language only where they are drawn
// (ui/src/modelsDialog.mjs). The tables' check finds only sentences written
// inside t() itself, so ui/src/modelsUi.test.mjs holds these to the tables.
const MODEL_GROUPS = [
  { key: "sep", title: "Audio separation" },
  { key: "stt", title: "Speech-to-text" },
  { key: "translate", title: "Translation" },
  { key: "tts", title: "Text-to-speech" },
  { key: "eraser", title: "Erase subtitles" },
  { key: "base", title: "Base programs" },
];

/** The /api/models rows under their purpose, in MODEL_GROUPS' order: each
 * group's rows as they came, and bytes as what its ready rows take on this
 * computer (the summary line's rule). A group with no rows is left out. */
export function groupModels(rows) {
  const keyOf = (r) => {
    if (r.id === "subtitle-eraser") return "eraser";
    if (["sep", "stt", "translate", "tts"].includes(r.role)) return r.role;
    // The other packs (Python + PyTorch, Ollama) are what the rest runs on. A
    // role the catalog adds later has no group of its own yet, so it lands
    // here too rather than vanishing from the list.
    return "base";
  };
  return MODEL_GROUPS
    .map((g) => {
      const mine = rows.filter((r) => keyOf(r) === g.key);
      const bytes = mine.reduce((n, r) => n + (r.state === "ready" ? r.bytes : 0), 0);
      return { key: g.key, title: g.title, rows: mine, bytes };
    })
    .filter((g) => g.rows.length);
}
