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
// The same looks open from the finished video panel too, at the dub's last
// step: Subtitle style, left of Download (owner, 2026-10-22). Its grid is
// drawn and ringed with the tab's, a press on either is the same pick, and
// the button is dim whenever the tab has no looks to show.
//
// With no project open the tab works on its own (owner, 2026-10-22): a video
// (the shared Import block) and a subtitle file (.srt) brought in, then the
// two made a finished project of kind "captions" (POST /api/captions/import)
// that the page opens like a finished dub. The looks stay on show, dim, until
// both are there; once open, a row above them names the two files.
//
// The elements this file touches: #capEmpty, #capMain, #capHint, #subSizeLv,
// #subScopeSep, #subScopeSeg, #subScopeAll, #subScopeOne, #subShow, the grid
// of looks, #subStyleMenu, and the video panel's #videoStyleBtn,
// #videoStylePop and its grid, #videoStyleGrid; on its own, #capAlone,
// #capImportSlot, #capVideoInput, #capVideoCard, #capSrtZone, #capSrtSub,
// #capSrtInput, #capImportStatus, #capFiles, #capFileVideo, #capFileSrtName
// and #capFileSrtLines.
import { getDraft, onDraftChange } from "./draft.mjs";
import { errorText, videoCardHtml } from "./format.mjs";
import { emptyTabHtml, wireImportBlock, wireImportInput } from "./importBlock.mjs";
import { t } from "./i18n.mjs";

// The English sentences, compared by the tests; each is drawn through t()
// where it lands on screen (its key is added to the tables by hand).
export const AFTER_DUB = "Captions come after dubbing";
// The tip the tab itself wears while it is locked.
export const LOCKED_TIP = "After dubbing";
export const NO_SUBTITLES = "No captions for this project";
export const PICK_A_LINE = "Select a caption on the video";
// The subtitle file's drop area, on its own.
export const SRT_HEAD = "Subtitle file (.srt)";
export const SRT_SUB = "Drop a subtitle file here or press to choose one";
export const NOT_SRT = "Choose a subtitle file that ends in .srt";

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
 * With no project open at all it is the tab's own way in, so never shut.
 *
 * @param {{dubbed: boolean, alone?: boolean}} v
 */
export function captionsLocked({ dubbed, alone = false }) {
  return !alone && !dubbed;
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
 * @param {any} [deps.doc]  the page: a press anywhere else on it, or Escape,
 *   shuts the video panel's looks
 * @param {object} [deps.alone]  the tab on its own; the view then says
 *   alone (no project open: the video is the draft, ui/src/draft.mjs) and
 *   files ({name, duration, srt} of an open "captions" project, or null)
 * @param {(source: object) => Promise<void>} deps.alone.importSource  bring a
 *   video in as the draft (ui/src/draftImport.mjs)
 * @param {(text: string, isError?: boolean) => void} deps.alone.say  the line
 *   under the blocks
 * @param {(downloadId: string, file: File) => Promise<string>} deps.alone.upload
 *   make the two a project (ui/src/dubApi.mjs importCaptions); its job id
 * @param {(jobId: string) => Promise<void>} deps.alone.openJob  open it
 * @returns {{ paint: () => void, takeSrt: (file: File) => Promise<void> }}
 *   takeSrt is what a subtitle file dropped on the tab's drop area does
 */
export function initCaptionsTab({ $, styles, getView, onPick, onShow, setLocked = () => {},
                                  doc = globalThis.document, alone = null }) {
  const grids = [$("subStyleMenu"), $("videoStyleGrid")];
  const styleBtn = $("videoStyleBtn");
  const pop = $("videoStylePop");
  let drawn = null;   // the sample and frame the grids were last built with

  // The video panel's looks open and shut the way the Ratio menu beside them
  // does (ui/src/ratio.mjs): their button, a press anywhere else, Escape. A
  // pick shuts them as well, so the look is seen on the whole picture.
  function shut() {
    pop.hidden = true;
    styleBtn.setAttribute("aria-expanded", "false");
  }
  styleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = pop.hidden;
    pop.hidden = !open;
    styleBtn.setAttribute("aria-expanded", String(open));
  });
  pop.addEventListener("click", (e) => e.stopPropagation());
  doc.addEventListener("click", shut);
  doc.addEventListener("keydown", (e) => { if (e.key === "Escape") shut(); });

  for (const grid of grids) {
    grid.addEventListener("click", (e) => {
      const card = e.target.closest?.("[data-preset]");
      if (!card) return;
      onPick(card.dataset.preset);
      shut();
    });
  }
  $("subShow").addEventListener("click", () => onShow());

  // ---- On its own: a video and a subtitle file ----
  let srtFile = null;   // the .srt brought in before its video, waiting for it
  let sending = false;
  if (alone) {
    $("capImportSlot").outerHTML = emptyTabHtml("captions", "capZone", "capLink");
    const input = $("capVideoInput");
    wireImportInput(input, (files) => alone.importSource({ file: files[0] }));
    wireImportBlock($, { id: "capZone", linkId: "capLink", input,
      onFiles: (files) => alone.importSource({ file: files[0] }),
      onLink: (url) => alone.importSource({ link: url }),
      onNotLink: (message) => alone.say(message, true) });
    const zone = $("capSrtZone");
    const srtInput = $("capSrtInput");
    zone.addEventListener("click", () => srtInput.click());
    zone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); srtInput.click(); }
    });
    for (const ev of ["dragenter", "dragover"]) {
      zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("drag-over"); });
    }
    zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("drag-over");
      const file = ((e.dataTransfer && e.dataTransfer.files) || [])[0];
      if (file) takeSrt(file);
    });
    wireImportInput(srtInput, (files) => takeSrt(files[0]));
    // The video coming in after its subtitle file sends the two.
    onDraftChange(() => { send(); paint(); });
  }

  /** A subtitle file brought in: kept until there is a video, then the two sent. */
  async function takeSrt(file) {
    if (!/\.srt$/i.test(file.name || "")) { alone.say(t(NOT_SRT), true); return; }
    srtFile = file;
    alone.say("");
    paint();
    await send();
  }

  /** Both files here: make them a project and open it. Called again when the video arrives. */
  async function send() {
    const id = (getDraft() || {}).downloadId;
    if (!srtFile || !id || sending) return;
    sending = true;
    alone.say(t("Importing…"));
    try {
      const jid = await alone.upload(id, srtFile);
      srtFile = null;
      alone.say("");
      await alone.openJob(jid);
    } catch (e) {
      srtFile = null;
      alone.say(errorText(e), true);
    } finally {
      sending = false;
      paint();
    }
  }

  function paintAlone(v, on) {
    $("capAlone").hidden = !on;
    // The looks stay on show, dim, until the two files are there.
    $("capMain").inert = on;
    $("capMain").classList.toggle("cap-off", on);
    const files = !on && v.files;
    $("capFiles").hidden = !files;
    if (files) {
      $("capFileVideo").innerHTML = videoCardHtml({ name: files.name, kept: files.duration, total: files.duration });
      $("capFileSrtName").textContent = files.srt;
      $("capFileSrtName").title = files.srt;
      $("capFileSrtLines").textContent = t("{n} lines", { n: v.lines.length });
    }
    if (!on) return;
    const d = getDraft();
    $("capZone").hidden = !!d;
    $("capVideoCard").hidden = !d;
    $("capVideoCard").innerHTML = d ? videoCardHtml({ name: d.name, kept: d.duration, total: d.duration }) : "";
    $("capSrtSub").textContent = srtFile ? srtFile.name : t(SRT_SUB);
  }

  function paint() {
    const v = getView();
    // On its own only where the page wired it so.
    const lone = !!alone && !!v.alone;
    const locked = captionsLocked({ dubbed: !!v.dubbed, alone: lone });
    setLocked(locked);
    const empty = lone ? "" : captionsEmpty({ screen: v.screen, lines: v.lines.length });
    // The video panel's button opens onto these same looks: dim whenever the
    // tab has none to show, with the tab's reason on its tip.
    styleBtn.disabled = locked || lone || !!empty;
    styleBtn.title = locked || lone ? t(LOCKED_TIP) : empty && t(empty);
    if (styleBtn.disabled) shut();
    $("capEmpty").textContent = empty && t(empty);
    $("capEmpty").hidden = !empty;
    $("capMain").hidden = !!empty;
    if (alone) paintAlone(v, lone);
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
    // On its own there is no project yet: plain tiles, none ringed.
    const sample = lone ? "Aa" : sampleWord(v.lines);
    const jobId = lone ? "" : v.jobId;
    const key = JSON.stringify([sample, jobId, styles.map((s) => s[1])]);
    if (key !== drawn) {
      drawn = key;
      const thumb = jobId ? `/api/dub/jobs/${encodeURIComponent(jobId)}/thumb` : "";
      for (const grid of grids) grid.innerHTML = styleCardsHtml(styles, sample, thumb);
    }
    for (const grid of grids) {
      for (const card of grid.querySelectorAll("[data-preset]")) {
        const on = !lone && card.dataset.preset === v.preset;
        card.classList.toggle("on", on);
        card.setAttribute("aria-pressed", String(on));
      }
    }
  }

  return { paint, takeSrt };
}
