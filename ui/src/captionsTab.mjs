// The Captions tab of the work screen's left panel (new-layout mockup,
// editorc, user 2026-09-29): the subtitle tools that used to float over the
// video. A− / size / A＋, All lines / This line (box looks only), the Show
// switch, and every look drawn as a small tile over a frame of the video.
//
// The page keeps the subtitle style itself (subtitle_style.json, the overlay,
// the layout maths shared with the export); this file only draws the tab from
// what the page tells it (getView) and hands the two presses that are the
// tab's own back to the page: a look picked (onPick) and the Show switch
// (onShow, which is the timeline's eye). A− / A＋ and the scope buttons are
// wired by the page, as they were on the floating bar.
//
// The elements this file touches: #capEmpty, #capMain, #capHint, #subSizeLv,
// #subScopeSep, #subScopeSeg, #subScopeAll, #subScopeOne, #subShow and the
// grid of looks, #subStyleMenu.
import { t } from "./i18n.mjs";

// The English sentences, compared by the tests; each is drawn through t()
// where it lands on screen (its key is added to the tables by hand).
export const AFTER_DUB = "Captions come after dubbing";
// The tip the tab itself wears while it is locked.
export const LOCKED_TIP = "After dubbing";
export const NO_SUBTITLES = "No captions for this project";
export const PICK_A_LINE = "Select a caption on the video";

/**
 * Why the tab has nothing to show, or "" when it has. Only a finished dub on
 * screen has captions; the page's draft does not count, because the Erase
 * tab holds a finished dub's own video as a draft beside it (ui/src/
 * eraseScreen.mjs keep), and that must not empty the tab (owner, 2026-10-14).
 *
 * @param {{screen: string, lines: number}} v
 */
export function captionsEmpty({ screen, lines }) {
  if (screen !== "done") return AFTER_DUB;
  if (!lines) return NO_SUBTITLES;
  return "";
}

/**
 * Whether the tab is shut: before a dub exists there is nothing in it, so it
 * is dimmed rather than opened onto an empty panel (owner, 2026-09-30). A
 * job that is not finished has no dub; a draft on its own has none open
 * either (the page clears the job when a draft starts), so dubbed says it all.
 *
 * @param {{dubbed: boolean}} v
 */
export function captionsLocked({ dubbed }) {
  return !dubbed;
}

/** The word each tile shows: the first one the subtitles say, else "Aa". */
export function sampleWord(lines) {
  for (const l of lines || []) {
    const w = String(l.text || "").trim().split(/\s+/)[0];
    if (w) return w.length > 8 ? w.slice(0, 7) + "…" : w;
  }
  return "Aa";
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * The grid of looks. Each sample wears the overlay's own class for its look
 * (sub-ov-<id>), so a tile is what the video will show.
 *
 * @param {Array<[string, string]>} styles  [id, label] in menu order
 * @param {string} sample  the word drawn on every tile
 * @param {string} thumb   the frame behind the words ("" for a plain tile)
 */
export function styleCardsHtml(styles, sample, thumb) {
  const bg = thumb ? ` style="background-image:url('${escapeHtml(thumb)}')"` : "";
  return styles.map(([id, label]) => `<button class="cap-card" type="button" data-preset="${escapeHtml(id)}"`
    + ` aria-pressed="false"><span class="cap-pv"${bg}><span class="cap-sample sub-ov-${escapeHtml(id)}">`
    + `${escapeHtml(sample)}</span></span><span class="cap-nm">${escapeHtml(label)}</span></button>`).join("");
}

/**
 * @param {object} deps
 * @param {(id: string) => any} deps.$   the page's getElementById helper
 * @param {Array<[string, string]>} deps.styles  the looks, [id, label]
 * @param {() => {screen: string, lines: Array<{text: string}>, jobId: string|null,
 *   preset: string, size: number, boxed: boolean, scope: "all"|"one",
 *   line: number, enabled: boolean, dubbed: boolean}} deps.getView
 *   the subtitle state as it is now; line is the selected subtitle's number
 *   (1-based), 0 when none is selected; dubbed is whether a finished dub is open
 * @param {(locked: boolean) => void} [deps.setLocked]  dim the tab itself, or
 *   open it again (ui/src/leftTabs.mjs)
 * @param {(preset: string) => void} deps.onPick  a look was pressed
 * @param {() => void} deps.onShow  the Show switch was pressed
 * @returns {{ paint: () => void }}
 */
export function initCaptionsTab({ $, styles, getView, onPick, onShow, setLocked = () => {} }) {
  const grid = $("subStyleMenu");
  let drawn = null;   // the sample and frame the grid was last built with

  grid.addEventListener("click", (e) => {
    const card = e.target.closest?.("[data-preset]");
    if (card) onPick(card.dataset.preset);
  });
  $("subShow").addEventListener("click", () => onShow());

  function paint() {
    const v = getView();
    setLocked(captionsLocked({ dubbed: !!v.dubbed }));
    const empty = captionsEmpty({ screen: v.screen, lines: v.lines.length });
    $("capEmpty").textContent = empty && t(empty);
    $("capEmpty").hidden = !empty;
    $("capMain").hidden = !!empty;
    if (empty) return;

    $("subSizeLv").textContent = v.size + "%";
    $("subScopeSep").hidden = !v.boxed;
    $("subScopeSeg").hidden = !v.boxed;
    $("subScopeAll").classList.toggle("on", v.scope === "all");
    $("subScopeOne").classList.toggle("on", v.scope === "one");
    // "This line" changes the selected subtitle; with none selected it says
    // where to get one.
    const hint = $("capHint");
    hint.hidden = !(v.boxed && v.scope === "one");
    hint.textContent = v.line ? t("Line {n}", { n: v.line }) : t(PICK_A_LINE);
    const show = $("subShow");
    show.classList.toggle("on", v.enabled);
    show.setAttribute("aria-checked", String(v.enabled));

    // The looks' names too: they change with the language.
    const key = JSON.stringify([sampleWord(v.lines), v.jobId, styles.map((s) => s[1])]);
    if (key !== drawn) {
      drawn = key;
      const thumb = v.jobId ? `/api/dub/jobs/${encodeURIComponent(v.jobId)}/thumb` : "";
      grid.innerHTML = styleCardsHtml(styles, sampleWord(v.lines), thumb);
    }
    for (const card of grid.querySelectorAll("[data-preset]")) {
      const on = card.dataset.preset === v.preset;
      card.classList.toggle("on", on);
      card.setAttribute("aria-pressed", String(on));
    }
  }

  return { paint };
}
