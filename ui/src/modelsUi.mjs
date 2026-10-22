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
 * (API engines, and separation's Demucs, which comes with Python + PyTorch). */
export function neededModelId(role, value) {
  if (role === "sep") return value === "roformer" ? "vocal-separator" : null;
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
    // The server's reason in plain words ("Connection lost."), then what to do
    // -- unless the reason already says to press Resume (a blocked connection,
    // the desktop app's interrupted pack), which said it twice.
    const text = !row.error ? t("Paused")
      : row.error.includes(t("Resume")) ? row.error
        : t("{reason} Press Resume to pick up where it stopped.", { reason: row.error });
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
  // Only the size and that it is a download of its own, once: which files
  // they are is nobody's question (user, 2026-09-28), and the app install
  // was under 1 GB, so the size said nothing of how the two differ (owner,
  // 2026-10-22, 1-3). The voice parts are the ones Perso dubbing does
  // instead, so they are the ones that point there.
  const voice = ids.includes("engine") || ids.includes("qwen3-tts");
  return {
    title: t("Download {size} GB?", { size: gb(total) }),
    line: t("A one-time download, separate from the app install."),
    // The room left where it goes (the 409's free_bytes); unknown is left unsaid.
    free: detail.free_bytes ? t("{size} GB free", { size: gb(detail.free_bytes) }) : "",
    // A start that is not a dubbing's (Separate audio, detail.purpose):
    // Perso dubbing is no way round that one.
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

/** The packs a dropdown choice needs, alongside the model neededModelId
 * names: the RoFormer, local STT and the voice run in the engine pack; Gemma
 * and Hunyuan run in the translation runtime. */
export function neededPackIds(role, value) {
  if (role === "sep") return value === "roformer" ? ["engine"] : [];
  if (role === "stt") return value === "perso" ? [] : ["engine"];
  if (role === "translate") return value === "gemma" || value === "hunyuan" ? ["ollama-runtime"] : [];
  if (role === "voice") return ["engine"];
  return [];
}

/** What the line under each stage field lists. `stages` is [[role, value],
 * ...] in the order the fields stand, `rowOf` a GET /api/models row by its
 * id. Everything a choice needs comes in the order it downloads, the pack it
 * runs in first (as in the dub's own 409), and only what is not here yet --
 * each thing once: a pack two choices run in (Python + PyTorch, for
 * Speech-to-text and Text-to-speech) is listed under the first of them only,
 * so the lines add up to what the dubbing downloads. They said 5.1 + 6.5 GB
 * for a 9.6 GB download (owner, 2026-10-22, 1-3). Returns [{needs, ready}]
 * in the same order; ready: the choice needs something, and all of it is here. */
export function stageNeeds(stages, rowOf) {
  const listed = new Set();
  return stages.map(([role, value]) => {
    const ids = [...neededPackIds(role, value), neededModelId(role, value)].filter(Boolean);
    const all = ids.map(rowOf).filter((r) => r && r.state !== "ready");
    const needs = all.filter((r) => !listed.has(r.id));
    for (const r of all) listed.add(r.id);
    return { needs, ready: ids.length > 0 && !all.length };
  });
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
// The programs' group says what it is there for under its name: "Base
// programs" alone told nobody why (owner, 2026-10-22).
const MODEL_GROUPS = [
  { key: "sep", title: "Audio separation" },
  { key: "stt", title: "Speech-to-text" },
  { key: "translate", title: "Translation" },
  { key: "tts", title: "Text-to-speech" },
  { key: "eraser", title: "Erase subtitles" },
  { key: "base", title: "Required programs", note: "Needed to run the models" },
];

/** The /api/models rows under their purpose, in MODEL_GROUPS' order: each
 * group's rows as they came, bytes as what its ready rows take on this
 * computer (the summary line's rule), and its note ("" for none). A group
 * with no rows is left out. */
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
      return { key: g.key, title: g.title, note: g.note || "", rows: mine, bytes };
    })
    .filter((g) => g.rows.length);
}
