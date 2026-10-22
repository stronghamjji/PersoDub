// The subtitles over the finished screen's player, and the style they are
// drawn in. One object mirrors the job's subtitle_style.json: how the
// subtitles look (style, size, position), whether they go on at all, and any
// lines the user retimed on the timeline. The overlay, the timeline lane and
// the Export dialog all read and write it; saves are debounced PUTs.
//
// The overlay measures its lines in the font the burn draws with, so the
// screen and the exported video break them alike (ui/src/subtitleLayout.mjs).
// The Captions tab draws the tools (ui/src/captionsTab.mjs); what they do is
// here, next to the style object they change. Lifted out of the page's script
// unchanged (2026-10-10).
//
// The elements this file touches: #subOverlay, #subOverlayText, #subMeasure,
// #subSaved, #subScopeAll, #subScopeOne, #subBigger, #subSmaller, #tlSubEye,
// #timeline (a press on its subtitle lane), #videoPane (a press beside the
// subtitle) and the Captions tab's own (ui/src/captionsTab.mjs).
import { layoutOf, pictureRect, SUB_FONT_CSS } from "./subtitleLayout.mjs";
import { initCaptionsTab, LOCKED_TIP as CAPTIONS_LOCKED_TIP } from "./captionsTab.mjs";
import { pendingSave } from "./pendingSave.mjs";
import { t } from "./i18n.mjs";

/**
 * @param {object} deps
 * @param {(id: string) => any} deps.$   the page's getElementById helper
 * @param {{job: object|null, jobId: string|null}} deps.state  the page's app
 *        state, read when the Captions tab paints (is a finished dub open?)
 * @param {any} deps.doneVideo  the finished screen's <video>
 * @param {{show: (name: string) => void,
 *          setLocked: (name: string, locked: boolean, tip: string) => void}} deps.leftTabs
 *        the left panel's tabs (ui/src/leftTabs.mjs)
 * @param {{getLines: () => object[], redraw: () => void, drawTimelineTrack: () => void}} deps.timeline
 *        the timeline's lines and its two redraws. The page wires the timeline
 *        after this, so these reach it only when they are called.
 * @param {() => string} deps.getDoneSource  which file the player is on,
 *        "dubbed" or "original": the subtitles go over the dubbed one only
 * @param {(which: string) => Promise<void>} deps.showVideoSource  put the
 *        player on that file; answers once it is showing it
 * @returns {{ getSubStyle: () => object, loadSubStyle: (jobId: string) => Promise<void>,
 *   saveSubStyle: () => void, subCueOf: (l: object, idx: number) => {start: number, end: number},
 *   updateSubtitleNow: () => void, subLinesChanged: () => void, syncVideoChrome: () => void,
 *   exportParams: () => {preset: string, query: string} }}
 *   getSubStyle answers the style object itself, which the timeline changes in
 *   place; exportParams, what the Export dialog asks the subtitled video for.
 */
export function initSubtitleOverlay({ $, state, doneVideo, leftTabs, timeline, getDoneSource,
                                      showVideoSource }) {
  let subStyle = { enabled: true, preset: "clean", pos: null, size: null, cues: {},
                   boxWidth: null, widths: {}, layout: {} };
  let subStyleLoaded = false;   // a save before the load answers would wipe the file
  let subScope = "all";     // what a width drag changes: every line, or this one
  let subNowIdx = 0;        // the line the overlay is showing right now
  let subStyleJobId = null;
  let subStyleRev = 0;   // bumped on save, busts the Export preview's image cache
  // The plugin's ten looks, mirrored from app/subtitle_ass.py: letter height as
  // a fraction of the video, and where each look sits when the user has not
  // dragged it (as a fraction up from the bottom edge).
  // The label is a getter, so it reads in the language of the moment it is drawn.
  const SUB_META = {
    "clean":       { get label() { return t("Clean"); },       frac: 0.032, bottom: 0.28 },
    "bold-punch":  { get label() { return t("Bold Punch"); },  frac: 0.052, bottom: 0.48 },
    "sticker":     { get label() { return t("Sticker"); },     frac: 0.029, bottom: 0.28 },
    "neon-yellow": { get label() { return t("Neon Yellow"); }, frac: 0.049, bottom: 0.28 },
    "soft-card":   { get label() { return t("Soft Card"); },   frac: 0.026, bottom: 0.64 },
    "rainbow":     { get label() { return t("Rainbow"); },     frac: 0.045, bottom: 0.28 },
    "broadcast":   { get label() { return t("Broadcast"); },   frac: 0.06,  bottom: 0.055 },
    "streaming":   { get label() { return t("Streaming"); },   frac: 0.06,  bottom: 0.055 },
    "lower-bar":   { get label() { return t("Lower Bar"); },   frac: 0.06,  bottom: 0.055 },
    "neon":        { get label() { return t("Neon"); },        frac: 0.06,  bottom: 0.055 },
    "black-box":   { get label() { return t("Black Box"); },   frac: 0.032, bottom: 0.28 },
    "white-box":   { get label() { return t("White Box"); },   frac: 0.03,  bottom: 0.28 },
  };
  // The first three shipped for a day under our own names.
  const SUB_LEGACY = { variety: "neon-yellow", box: "sticker" };
  // The looks that have a background box -- the only ones a width applies to.
  const SUB_BOXED = new Set(["sticker", "soft-card", "lower-bar", "black-box", "white-box"]);

  // The failure mark beside the Captions tab's "Styles". Saving and having
  // saved are quiet now (owner, 2026-09-30) -- only a failed save still says so,
  // since that is the one case leaving no trace on screen would hide a real
  // problem (the change did not actually stick).
  function subSaved(text) {
    $("subSaved").textContent = text || "";
  }

  // The save waits a moment for the last of a drag (ui/src/pendingSave.mjs),
  // holding the project and the style object the change was made on: opening
  // another project meanwhile sent this one's change there, or that one's
  // not-yet-loaded defaults over its saved style.
  const subSaver = pendingSave((jobId, style) => {
    const open = jobId === subStyleJobId;
    // What the player showed goes with the settings, so the burn draws that.
    // Only while that project is the one on the player.
    const lay = open ? subLayoutAll() : null;
    if (lay) style.layout = lay;
    // Which save this is: a later one overtaking this one owns the mark, so an
    // older answer must not write over a newer save's own result.
    const mine = subStyleRev;
    const failed = () => { if (mine === subStyleRev && jobId === subStyleJobId) subSaved(t("Not saved")); };
    fetch(`/api/dub/jobs/${jobId}/subtitle_style`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(style),
      // The next save tries again; until then the toolbar says so.
    }).then((r) => { if (!r.ok) failed(); }).catch(failed);
  });
  function saveSubStyle() {
    subStyleRev++;
    subSaved("");
    // Not before the style has loaded: that save would be the defaults.
    if (subStyleJobId && subStyleLoaded) subSaver.schedule(subStyleJobId, subStyle);
  }

  async function loadSubStyle(jobId) {
    if (subStyleJobId === jobId) return;
    subStyleJobId = jobId;
    subStyleLoaded = false;
    subStyle = { enabled: true, preset: "clean", pos: null, size: null, cues: {},
                 boxWidth: null, widths: {}, layout: {} };
    let answer = null;
    try {
      const r = await fetch(`/api/dub/jobs/${jobId}/subtitle_style`);
      if (r.ok) answer = await r.json();
    } catch { /* defaults stand */ }
    // Another job was opened meanwhile: its style is the one that stands. Taken
    // before this check, a late answer became that job's style and its next
    // save wrote it there (final review, 2026-10-12).
    if (subStyleJobId !== jobId) return;
    if (answer) subStyle = answer;
    subStyleLoaded = true;
    subStyle.preset = SUB_LEGACY[subStyle.preset] || subStyle.preset;
    if (!SUB_META[subStyle.preset]) subStyle.preset = "clean";
    if (!subStyle.layout) subStyle.layout = {};
    if (timeline.getLines().length) timeline.redraw();
    updateSubtitleNow();
    subLinesChanged();
  }

  // The user's retimed window for a line, else the line's own.
  function subCueOf(l, idx) {
    const o = subStyle.cues[String(idx + 1)];
    return o ? { start: +o.start, end: +o.end } : { start: l.start, end: l.end };
  }

  const subOverlay = $("subOverlay");
  const subOvText = $("subOverlayText");
  let subSelected = false;

  // The overlay box follows the video's own box, so text sits on the picture
  // rather than on the dark around it.
  function syncSubOverlayBox() {
    const pic = pictureRect({ left: doneVideo.offsetLeft, top: doneVideo.offsetTop,
                              width: doneVideo.offsetWidth, height: doneVideo.offsetHeight,
                              videoWidth: doneVideo.videoWidth, videoHeight: doneVideo.videoHeight });
    subOverlay.style.left = pic.left + "px";
    subOverlay.style.top = pic.top + "px";
    subOverlay.style.width = pic.width + "px";
    subOverlay.style.height = pic.height + "px";
    return pic;
  }

  /** Everything that hangs off the picture, after the picture has moved. */
  function syncVideoChrome() {
    if (!subOverlay.hidden) updateSubtitleNow();
  }

  // ---- The ruler: the burn's font, measured by the browser ----
  // One canvas measures text in the font ffmpeg will draw with, at 100 px, so
  // every number is em x 100. The padding, weight and line height are read off
  // the hidden measuring span wearing the look's own class -- the CSS is the one
  // place that says what each look is.
  const SUB_MAX_WIDTH = 0.92;   // .sub-ov-text's max-width
  const subRulerCtx = document.createElement("canvas").getContext("2d");
  const subMeasure = $("subMeasure");
  const subRulers = {};
  function subRulerFor(preset) {
    if (subRulers[preset]) return subRulers[preset];
    subMeasure.className = "sub-ov-text sub-ov-" + preset;
    subMeasure.textContent = "가A";
    const cs = getComputedStyle(subMeasure);
    const padX = parseFloat(cs.paddingLeft) || 0, padY = parseFloat(cs.paddingTop) || 0;
    const lineHeight = subMeasure.offsetHeight - 2 * padY;
    if (!(lineHeight > 0)) return null;   // not on screen: nothing to measure by
    const upper = cs.textTransform === "uppercase";
    const font = `${cs.fontWeight} 100px ${SUB_FONT_CSS}`;
    const ruler = (t) => {
      subRulerCtx.font = font;
      return subRulerCtx.measureText(upper ? t.toUpperCase() : t).width;
    };
    // The weight goes with the layout: the burn's presets know only bold or
    // not, and White Box (600) came out thin in the video.
    const weight = parseInt(cs.fontWeight, 10) || 400;
    return (subRulers[preset] = { ruler, padX, padY, lineHeight, weight });
  }

  // What the player shows for line idx, in em of the font: the lines the words
  // break into and the box around them -- the same numbers the burn draws from.
  // null while there is nothing to measure by (no video size yet, screen down).
  function subLayoutFor(idx, lines = timeline.getLines()) {
    const l = lines[idx];
    const vw = doneVideo.videoWidth, vh = doneVideo.videoHeight;
    if (!l || !vw || !vh) return null;
    const r = subRulerFor(subStyle.preset);
    if (!r) return null;
    const meta = SUB_META[subStyle.preset] || SUB_META.clean;
    const k = 100 / (vh * meta.frac * ((subStyle.size == null ? 100 : subStyle.size) / 100));
    let pct = null;
    if (SUB_BOXED.has(subStyle.preset)) {
      const linePct = subStyle.widths[String(idx + 1)];
      pct = linePct != null ? linePct : subStyle.boxWidth;
    }
    const words = l.text || "";
    const lay = layoutOf({ text: words, ruler: r.ruler,
                           boxWidth: pct == null ? null : pct / 100 * vw * k,
                           cap: SUB_MAX_WIDTH * vw * k,
                           padX: r.padX, padY: r.padY, lineHeight: r.lineHeight });
    return { text: words, lines: lay.lines,
             w: Math.round(lay.w) / 100, h: Math.round(lay.h) / 100, weight: r.weight };
  }

  function subLayoutAll() {
    const lines = timeline.getLines();
    if (!lines.length) return null;
    const out = {};
    for (let i = 0; i < lines.length; i++) {
      const lay = subLayoutFor(i, lines);
      if (!lay) return null;
      // A line with no words ("Not translated") has nothing to draw, and its
      // 0-wide box made the whole style unsaveable (Windows D12, 2026-10-07).
      if (!lay.text.trim()) continue;
      out[String(i + 1)] = lay;
    }
    return out;
  }

  // The words changed (a job opened, a line edited or rewritten) or the video's
  // size just became known: measure again, and save when the answer moved.
  function subLinesChanged() {
    // Whether there are lines at all opens the Captions tab and its button
    // in the video panel; the overlay alone draws nothing for a wordless one.
    paintSubToolbar();
    if (!subStyleJobId || !subStyleLoaded) return;
    const lay = subLayoutAll();
    if (!lay || JSON.stringify(lay) === JSON.stringify(subStyle.layout)) return;
    subStyle.layout = lay;
    saveSubStyle();
  }
  doneVideo.addEventListener("loadedmetadata", subLinesChanged);

  function updateSubtitleNow() {
    // The lines the timeline is drawing, by reference -- the same array this used
    // to hold itself, back when the timeline lived on this page.
    const lines = timeline.getLines();
    if (!subStyle.enabled || getDoneSource() !== "dubbed" || !lines.length
        || document.body.dataset.screen !== "done") {
      subOverlay.hidden = true; subSelect(false); return;
    }
    const t = doneVideo.currentTime || 0;
    let idx = lines.findIndex((l, i) => {
      const c = subCueOf(l, i); return t >= c.start && t < c.end;
    });
    // Paused before anything has been said: show the first line, so there is
    // a subtitle to click and style. Only there -- at the END of the video the
    // same trick made the first line reappear, which read as a bug (user,
    // 2026-09-01 evening).
    if (idx < 0 && doneVideo.paused && t <= subCueOf(lines[0], 0).start) idx = 0;
    // A line left untranslated has no words, and the burn draws nothing for it
    // (app/subtitle_ass.py) -- nor does the screen, not even a box preset's box.
    const subWords = idx < 0 ? "" : lines[idx].text || "";
    if (!subWords.trim()) { subOverlay.hidden = true; return; }
    subNowIdx = idx;
    const pic = syncSubOverlayBox();
    // The lines as measured, so the screen and the burn break them alike; the
    // words as they are until there is a video size to measure against.
    const lay = subLayoutFor(idx, lines);
    subOvText.textContent = lay ? lay.lines.join("\n") : subWords;
    const boxed = SUB_BOXED.has(subStyle.preset);
    const linePct = subStyle.widths[String(idx + 1)];
    const pct = linePct != null ? linePct : subStyle.boxWidth;
    if (boxed && pct != null) {
      subOvText.style.width = pct + "%";
      subOvText.style.whiteSpace = "normal";
    } else {
      subOvText.style.width = "";
      subOvText.style.whiteSpace = "";
    }
    if (subSelected && boxed) {
      for (const side of ["l", "r"]) {
        const h = document.createElement("span");
        h.className = "sub-wh " + side;
        subOvText.appendChild(h);
      }
    }
    subOvText.className = "sub-ov-text sub-ov-" + subStyle.preset
      + (subSelected ? " sel" : "");
    const h = pic.height || 1;
    const meta = SUB_META[subStyle.preset] || SUB_META.clean;
    const scale = (subStyle.size == null ? 100 : subStyle.size) / 100;
    subOvText.style.fontSize = (h * meta.frac * scale) + "px";
    const bottomFrac = subStyle.pos == null ? meta.bottom : (100 - subStyle.pos) / 100;
    subOvText.style.bottom = (h * Math.max(0, bottomFrac)) + "px";
    subOverlay.hidden = false;
    paintSubToolbar();
  }

  // ---- The Captions tab: the subtitle tools ----
  // They floated over the video until the new layout (mockup editorc, user
  // 2026-09-29); now they are the left panel's Captions tab and the video stays
  // clean. ui/src/captionsTab.mjs draws the tab from getView; the work stays
  // here, next to the style object it changes.
  const captions = initCaptionsTab({
    $,
    // [id, label] with the label read each time the tab draws its grid, not
    // once here: a language changed later still reaches the names.
    styles: Object.entries(SUB_META).map(([id, m]) => Object.defineProperty([id], 1, { get: () => m.label, enumerable: true })),
    getView: () => ({
      screen: document.body.dataset.screen,
      lines: timeline.getLines(),
      jobId: subStyleJobId,
      preset: subStyle.preset,
      size: subStyle.size == null ? 100 : subStyle.size,
      boxed: SUB_BOXED.has(subStyle.preset),
      scope: subScope,
      line: subSelected ? subNowIdx + 1 : 0,
      enabled: subStyle.enabled !== false,
      // A finished dub is open: the one thing the tab has anything for.
      dubbed: !!state.job && state.job.id === state.jobId && state.job.status === "done"
        && state.job.kind !== "erase",
    }),
    // Before a dub exists the tab itself is dimmed and cannot be opened.
    setLocked: (locked) => leftTabs.setLocked("captions", locked, t(CAPTIONS_LOCKED_TIP)),
    onPick: (preset) => { subStyle.preset = preset; saveSubStyle(); updateSubtitleNow(); paintSubToolbar(); },
    // The timeline's eye is the one switch; this presses it, so the two can
    // never disagree.
    onShow: () => $("tlSubEye")?.click(),
  });
  function paintSubToolbar() { captions.paint(); }
  // A screen change (a dub starts, a draft opens, a job finishes) can empty or
  // fill the tab without the player saying a word.
  new MutationObserver(paintSubToolbar).observe(document.body, { attributeFilter: ["data-screen"] });

  // A subtitle selected on the video or in the timeline brings up this tab
  // rather than anything floating over the picture.
  function subSelect(on) {
    subSelected = on;
    subOvText.classList.toggle("sel", on);
    if (on) {
      updateSubtitleNow();   // redraws the text WITH its width handles
      leftTabs.show("captions");
    }
    paintSubToolbar();
  }
  $("subScopeAll").addEventListener("click", () => { subScope = "all"; paintSubToolbar(); });
  $("subScopeOne").addEventListener("click", () => { subScope = "one"; paintSubToolbar(); });

  $("subBigger").addEventListener("click", () => {
    subStyle.size = Math.min(300, (subStyle.size == null ? 100 : subStyle.size) + 10);
    saveSubStyle(); updateSubtitleNow(); paintSubToolbar();
  });
  $("subSmaller").addEventListener("click", () => {
    subStyle.size = Math.max(50, (subStyle.size == null ? 100 : subStyle.size) - 10);
    saveSubStyle(); updateSubtitleNow(); paintSubToolbar();
  });
  // A block in the timeline's subtitle lane selects that subtitle: the dubbed
  // video goes to its start, where the overlay shows it. Its trim handles and
  // the width mark stay the timeline's own.
  $("timeline").addEventListener("click", (e) => {
    const cap = e.target.closest(".tl-cap");
    if (!cap || e.target.closest(".tl-hdl, .tl-exdot")) return;
    const idx = +cap.dataset.idx;
    const line = timeline.getLines()[idx];
    if (!line) return;
    showVideoSource("dubbed").then(() => {
      doneVideo.currentTime = subCueOf(line, idx).start;
      subSelect(true);
    }).catch(() => {});
  });

  // The side handles: drag to set the box's width -- every line, or (with
  // "This line") just this one, which then keeps its own width.
  // The drag is captured on the text box, not the handle: every move redraws
  // the box, and the redraw throws the handles away and makes new ones. A
  // capture on the handle went with it, so the box widened one notch per click.
  subOvText.addEventListener("pointerdown", (e) => {
    if (!e.target.closest?.(".sub-wh")) return;
    e.preventDefault(); e.stopPropagation();
    let dragged = false;
    const move = (ev) => {
      const vr = doneVideo.getBoundingClientRect();
      if (!vr.width) return;
      const pct = Math.round(Math.min(100, Math.max(10,
        Math.abs(ev.clientX - (vr.left + vr.width / 2)) * 2 / vr.width * 100)));
      if (subScope === "all") subStyle.boxWidth = pct;
      else subStyle.widths[String(subNowIdx + 1)] = pct;
      dragged = true;
      updateSubtitleNow();
    };
    const up = () => {
      subOvText.removeEventListener("pointermove", move);
      subOvText.removeEventListener("pointerup", up);
      subOvText.removeEventListener("pointercancel", up);
      if (dragged) { saveSubStyle(); timeline.drawTimelineTrack(); }
    };
    subOvText.addEventListener("pointermove", move);
    subOvText.addEventListener("pointerup", up);
    subOvText.addEventListener("pointercancel", up);
    subOvText.setPointerCapture(e.pointerId);
  }, true);

  // Click the subtitles to select them; drag to move them up and down.
  subOvText.addEventListener("pointerdown", (e) => {
    if (e.target.closest?.(".sub-wh")) return;
    e.preventDefault(); e.stopPropagation();
    subSelect(true);
    let dragged = false;
    const move = (ev) => {
      const vr = doneVideo.getBoundingClientRect();
      if (!vr.height) return;
      subStyle.pos = Math.round(Math.min(97, Math.max(3,
        (ev.clientY - vr.top) / vr.height * 100)));
      dragged = true;
      updateSubtitleNow();
    };
    const up = () => {
      subOvText.removeEventListener("pointermove", move);
      subOvText.removeEventListener("pointerup", up);
      subOvText.removeEventListener("pointercancel", up);
      if (dragged) saveSubStyle();
      // A plain click, not a drag: this line is the one being styled now.
      else { subScope = "one"; paintSubToolbar(); }
    };
    subOvText.addEventListener("pointermove", move);
    subOvText.addEventListener("pointerup", up);
    subOvText.addEventListener("pointercancel", up);
    subOvText.setPointerCapture(e.pointerId);
  });
  // A click anywhere else on the picture lets the subtitle go.
  $("videoPane").addEventListener("click", (e) => {
    if (!e.target.closest(".sub-ov-text")) subSelect(false);
  });
  for (const e of ["timeupdate", "seeked", "loadedmetadata", "play", "pause"]) {
    doneVideo.addEventListener(e, updateSubtitleNow);
  }
  window.addEventListener("resize", syncVideoChrome);

  // What the Export dialog asks the subtitled video for: the look, and where
  // and how big it is drawn. The save count rides along, so a style changed
  // since the last preview is fetched afresh.
  function exportParams() {
    const preset = SUB_LEGACY[subStyle.preset] || subStyle.preset;
    const query = (subStyle.pos == null ? "" : `&pos=${subStyle.pos}`)
      + (subStyle.size == null ? "" : `&size=${subStyle.size}`) + `&r=${subStyleRev}`;
    return { preset, query };
  }

  return { getSubStyle: () => subStyle, loadSubStyle, saveSubStyle, subCueOf, updateSubtitleNow,
           subLinesChanged, syncVideoChrome, exportParams };
}
