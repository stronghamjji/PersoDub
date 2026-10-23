// Drafts that were left before they were dubbed: a video brought in for a new
// project, with the parts its cuts kept, remembered so that Home shows a
// "Draft" card that opens it again (owner, 2026-09-30). Kept in the browser's
// own storage, newest first: what a draft is (ui/src/draft.mjs) less the
// address its video plays from, which is made again from the id, plus the
// tab it was left on. The video itself stays in the app's holding folder; the
// app holds it again under the same id when the draft is reopened
// (POST /api/downloads/{id}/hold).
//
// Nothing here touches the page or the network.
import { normalizeRanges } from "./draft.mjs";

const KEY = "persodub.drafts";
// More than a screen of cards is a pile nobody goes back to: the oldest go.
const MAX_KEPT = 12;
// The tabs a draft can be left on (2026-10-21): its card says what it was
// being made into, and opens there again. A draft kept before then, or with
// anything else, was on Dubbing.
const TABS = ["dubbing", "erase"];

function clean(row) {
  if (!row || typeof row.downloadId !== "string" || !/^[0-9a-f]{8}$/.test(row.downloadId)) return null;
  const duration = Number(row.duration) || 0;
  const given = Array.isArray(row.ranges) ? row.ranges.filter((r) => Array.isArray(r) && r.length === 2) : [];
  const ranges = normalizeRanges(given.map(([a, b]) => [Number(a) || 0, Number(b) || 0]), duration);
  return { downloadId: row.downloadId, name: String(row.name || ""), duration,
           ranges: ranges.length ? ranges : [[0, duration]],
           ratio: typeof row.ratio === "string" ? row.ratio : "original",
           tab: TABS.includes(row.tab) ? row.tab : "dubbing" };
}

/** The drafts that were kept, newest first. [] when there are none, or the
    storage cannot be read. */
export function readKept(storage) {
  try {
    const rows = JSON.parse(storage.getItem(KEY) || "[]");
    return Array.isArray(rows) ? rows.map(clean).filter(Boolean).slice(0, MAX_KEPT) : [];
  } catch { return []; }
}

function write(storage, rows) {
  try { storage.setItem(KEY, JSON.stringify(rows)); } catch { /* private window: kept for this run only */ }
  return rows;
}

/** Keep this draft, as it stands now, at the front. Returns the new list. */
export function keepDraft(storage, draft, kept = readKept(storage)) {
  const row = clean(draft);
  if (!row) return kept;
  return write(storage, [row, ...kept.filter((k) => k.downloadId !== row.downloadId)].slice(0, MAX_KEPT));
}

/** What a draft's cuts and canvas are, as one string: two drafts with the
    same mark have had nothing changed between them. "" for no draft. */
export function draftMark(draft) {
  const row = clean(draft);
  return row ? JSON.stringify([row.ranges, row.ratio]) : "";
}

/** Let one go: it was dubbed, deleted, or its video is gone. Returns the new list. */
export function dropKept(storage, downloadId, kept = readKept(storage)) {
  return write(storage, kept.filter((k) => k.downloadId !== downloadId));
}
