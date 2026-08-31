// Pure decision logic for the model-download UI: what the status line under
// each engine dropdown says, and what the "Download N GB of AI models to
// dub?" dialog (dub_start's 409) renders. No DOM, no fetch -- index.html does
// the wiring, ui/src/modelsUi.test.mjs pins the words.

const GB = 1024 ** 3;

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
  if (row.state === "ready") return { cls: "model-ok", text: "Ready", button: null };
  if (row.state === "downloading") {
    // progress null = queued behind another download; say so instead of 0%.
    const text = row.progress == null
      ? `Waiting to download ${row.name}…`
      : `Downloading ${row.name}… ${row.progress}%`;
    return { cls: "model-busy", text, button: "cancel" };
  }
  if (row.state === "paused") {
    const why = row.error ? `: ${row.error}` : "";
    return { cls: "model-busy", text: `Paused${why}`, button: "resume" };
  }
  return { cls: "", text: `${gb(row.bytes)} GB`, button: "download" };
}

/** What the dub-start warning dialog shows, from the 409's detail. */
export function dubStartDialog(detail) {
  const missing = detail.missing || [];
  const total = detail.total_bytes ?? missing.reduce((n, m) => n + m.bytes, 0);
  const one = missing.length === 1 ? missing[0] : null;
  return {
    // One model gets its own name; several get the total (mockup rule).
    title: one
      ? `Download ${one.name} (${gb(one.bytes)} GB) to dub?`
      : `Download ${gb(total)} GB of AI models to dub?`,
    line: "They are saved on this computer and only download once.",
    ids: missing.map((m) => m.id),
    totalBytes: total,
  };
}

/** One number for the dialog's single progress bar: byte-weighted percent
 * across the models being fetched (a ready model counts as 100). */
export function overallProgress(rows, ids) {
  const wanted = rows.filter((r) => ids.includes(r.id));
  if (!wanted.length) return 0;
  let got = 0, total = 0;
  for (const r of wanted) {
    total += r.bytes;
    const pct = r.state === "ready" ? 100 : r.state === "downloading" ? (r.progress ?? 0) : 0;
    got += r.bytes * (pct / 100);
  }
  return total ? Math.round((100 * got) / total) : 0;
}

/** Every id in `ids` is ready -- the dialog's cue to resubmit the dub. */
export function allReady(rows, ids) {
  return ids.every((id) => rows.some((r) => r.id === id && r.state === "ready"));
}
