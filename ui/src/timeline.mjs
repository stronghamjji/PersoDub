// The timeline under the three panels (the mockup's, mockup 2026-09-29). Two
// states:
//
// A finished job: a ruler, then four lanes -- the video itself (its name, a
// film strip of its frames and the loudness of its sound), the original line,
// the dubbed voice of each line over the slot it has to fit inside, and the
// subtitles -- with the playhead across all of them. A click on a line plays
// it; the playhead, the ruler, an empty stretch of a lane and the video clip
// move the video there; the subtitle blocks are dragged by their ends to keep
// a subtitle up longer or take it down sooner.
//
// A new project before it is dubbed (the draft, ui/src/draft.mjs): the video
// lane alone, one clip per part kept, laid end to end. The cut tools split at
// the playhead, delete a clip or what lies left or right of the playhead, and
// undo and redo; every change goes to the draft as its ranges. Playback plays
// only the kept parts, and the clock counts kept time. The sums are
// ui/src/cutTools.mjs's. Before a video is imported there is one empty row,
// which takes a dropped video file (ui/src/draftImport.mjs).
//
// The Erase tab (showErase): the same strip, the same tools and keys, on the
// erase screen's own video, with one more lane under the video that says what
// is erased and how far along. Before an erase the clips are the draft's, so
// what is cut here is what is erased; once there is an erase job the strip is
// that job's video, one clip, and the cuts are locked.
//
// The pane grips come with it (the "drag handles" below). Only one of the
// four sizes the timeline itself, but all four are one mechanism -- a
// remembered size, clamped to the window as it stands -- and the timeline's
// ceiling is read off what the others leave, so splitting them would put one
// half of an agreement in a file that cannot see the other half.
//
// What is NOT here: the player and its transport (ui/src/donePlayer.mjs), the
// subtitle overlay on the picture, its toolbar and style menu, and
// subtitle_style.json itself (ui/src/subtitleOverlay.mjs) -- the overlay and
// this lane read the same object, and one of them had to own it. This file is
// handed it (getSubStyle), told when to save it (saveSubStyle) and when the
// overlay must be redrawn (updateSubtitleNow).
//
// lineVerdict is imported rather than passed: the table colours its lines by
// the same verdict, and one rule for "too long" or "much shorter" said in two
// places is how the two would come to disagree. numberSpeakers arrives the
// same way, so a line that is Speaker 2 in the table wears Speaker 2's colour
// here.
//
// The elements this file touches: #timeline and everything it draws inside
// itself, the four grips and the panes they size, and -- while a draft is on
// the timeline -- the player's clock (#videoTime), which then counts the kept
// time the way the timeline does. It never reaches the script table or
// `state`.
import { escapeHtml, fmtClockTenths, fmtLength, modKey } from "./format.mjs";
import { lucide } from "./icons.mjs";
import { lineVerdict } from "./scriptTable.mjs";
import { numberSpeakers } from "./speakers.mjs";
import { getDraft, setRanges, normalizeRanges, onDraftChange } from "./draft.mjs";
import { t } from "./i18n.mjs";
import {
  totalOf, keptToSource, sourceToKept, playableFrom,
  split, removeClip, removeLeft, removeRight, sameRanges, createHistory,
} from "./cutTools.mjs";

// Roughly the room one time label needs. Exported because the New project
// dialog's trim bar rules its own ruler by it -- one answer to "how much room
// does a time need", in one place.
export const TL_LABEL_PX = 58;

// A second at zoom 1: the mockup's 77px (the mockup's at its middle zoom).
export const TL_PPS = 77;

// The ruler's time, the way the mockup writes it: 00:03, and 1:02:03 past an hour.
export function fmtRuler(sec) {
  const t = Math.max(0, Math.round(sec));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const two = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

// How many seconds apart the labels stand at this scale: the first step that
// leaves at least 200px between two -- 3s at zoom 1, as in the mockup.
const LABEL_STEPS = [1, 2, 3, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
export function labelEvery(pps) {
  return LABEL_STEPS.find((s) => s * pps >= 200) || 3600;
}

// A film strip frame, as app/media_preview.py cuts them.
const FRAME_W = 69, FRAME_H = 39;
// However long a video, a clip draws at most this many frames; past it each
// frame box is widened and its frame stretched to fill it.
const MAX_TILES = 400;
// Six speaker colours, then round again (the first two are the mockup's).
const SPEAKER_COLOURS = 6;

/**
 * Wire the timeline, and the grips that size the panes around it, to a page.
 *
 * @param {object} deps
 * @param {(id: string) => any} deps.$  the page's getElementById helper
 * @param {() => any} deps.getVideo  the player, read late: the strip asks it
 *        where it is, seeks it, and plays a line in it
 * @param {() => string} deps.getClock  the clock as the player last painted it
 * @param {() => ({kind: string, id: string, name: string}|null)} [deps.getMedia]
 *        the finished job's own video, for the video lane's name, film strip
 *        and waveform (GET /api/media/{kind}/{id}/...)
 * @param {() => object} deps.getSubStyle  the job's subtitle_style.json as the
 *        page holds it -- read late, because the page replaces the whole object
 *        when a job is opened
 * @param {(line: object, idx: number) => {start: number, end: number}} deps.subCueOf
 *        the user's retimed window for a line, else the line's own
 * @param {() => void} deps.saveSubStyle  remember a retimed or re-widened subtitle
 * @param {() => void} deps.updateSubtitleNow  redraw the subtitle on the picture
 * @param {(t: number, el: any) => boolean} deps.isNowLine  is the video inside
 *        this line right now -- the table's highlighted row asks the same
 * @param {(which: string) => Promise} deps.showVideoSource  swap the player to
 *        the dub or the original; the original lane plays the film as it came in
 * @param {(video: any, start: number, end: number) => Promise} deps.playRange
 *        the page's shared "play only this much and stop" helper
 * @param {(video: any) => void} deps.cancelRange  forget a stopping point
 * @param {() => void} deps.paintPlayhead  the page's one reader of the video's time
 * @param {() => void} deps.toggleDonePlay  the space bar's play/pause
 * @param {() => void} deps.markClippedNames  the projects list re-measures its
 *        names when the sidebar grip changes their column's width
 * @param {(url: string) => Promise<{width: number}>} [deps.loadImage]
 * @param {(url: string) => Promise<object>} [deps.fetchJson]
 *        how the film strip and the waveform are fetched; the tests hand fakes
 * @param {() => any} [deps.getPlayerClock]  the clock under the player, which
 *        a draft makes count kept time too
 * @param {() => any[]} [deps.videos]  every video getVideo can answer with, so
 *        each one plays a draft's kept parts only
 * @returns the operations the rest of the page calls.
 */
export function initTimelineUi({ $, getVideo, getClock, getMedia = () => null, getSubStyle,
                                 subCueOf, saveSubStyle, updateSubtitleNow, isNowLine,
                                 showVideoSource, playRange, cancelRange, paintPlayhead,
                                 toggleDonePlay, markClippedNames,
                                 getPlayerClock = () => $("videoTime"),
                                 videos = () => [getVideo()],
                                 // A video with the user's own subtitles (kind
                                 // "captions"): no voices, so no voice lanes
                                 // and no voice legend, only the video and captions.
                                 ownSubtitles = () => false,
                                 loadImage = defaultLoadImage, fetchJson = defaultFetchJson }) {
  // There is no floor under the scale: Fit has to show the whole video at
  // once however long it is. A floor of 10px a second kept a 26-minute job
  // from ever fitting (owner, 2026-10-14); past Fit the lines are slivers, but
  // the zoom buttons bring them back.
  // The room left past the end of the strip, so the last clip's edge is not
  // flush with the scrollbar's.
  const TL_TAIL_PX = 80;

  // "job", "draft" or "" (nothing drawn).
  let mode = "";
  // The page asked for the draft state (a new project's screen is up), even
  // before any video was imported: the empty row says what to do.
  let draftWanted = false;
  // What is drawn right now: the lines, the length they were drawn to, the scale
  // (pixels per second) and the room that scale was measured from.
  let timelineLines = [];
  let timelineDuration = 0;
  let timelinePps = 0;
  let timelineRoom = 0;
  // How far the track is scrolled, kept in SECONDS rather than pixels: the strip
  // is rebuilt whenever a line changes, and at a new scale when the window is
  // resized, and the viewer should find the same moment at the left edge either
  // way instead of being thrown back to the start.
  let timelineAt = 0;
  // How far in the viewer has zoomed: 1 is 77px a second, steps of 1.5 up to
  // 8, and down as far as fitting the whole video.
  let timelineZoom = 1;
  const TL_ZOOM_STEP = 1.5, TL_ZOOM_MAX = 8;

  // The draft's clips on the timeline. The draft keeps its ranges joined; this
  // keeps a split a split (ui/src/cutTools.mjs).
  let clips = null;
  let clipsFor = "";        // the draft download these clips belong to
  let history = null;
  let selected = -1;

  // The Erase tab's say over the strip, or null anywhere else (showErase):
  //   strip   "draft" (the draft's clips), {media, duration} (an erase job's
  //           own video, one clip), or null (no video yet: the empty row)
  //   lane    {text, cls, pct} for the Erase lane, or null for none
  //   locked  the cuts cannot change
  let erase = null;
  const jobClip = () => (erase && erase.strip && erase.strip !== "draft" ? erase.strip : null);
  const locked = () => !!erase && !!erase.locked;

  // ---- The pictures of the video: film strip and waveform ---------------------
  // Fetched once per URL and kept for the session; the strip is drawn in the
  // plain clip colour until they arrive, then drawn again.
  const pictures = new Map();   // url -> "loading" | "failed" | loaded value
  function picture(url, load) {
    if (!pictures.has(url)) {
      pictures.set(url, "loading");
      load(url).then((v) => { pictures.set(url, v); drawTimelineTrack(); },
                     () => { pictures.set(url, "failed"); });
    }
    const v = pictures.get(url);
    return v === "loading" || v === "failed" ? null : v;
  }

  function mediaNow() {
    if (mode === "draft") {
      if (jobClip()) return jobClip().media;
      const d = getDraft();
      return d ? { kind: "download", id: d.downloadId, name: d.name } : null;
    }
    return getMedia();
  }

  // The film strips on the track right now, so a scroll can draw the frames
  // that came into view (drawFilms) without drawing the whole track again.
  let films = [];

  // The film strip for [a, b] of the video, drawn `w` pixels wide and `h`
  // tall, standing `x` pixels into the track. Every frame box is a frame's own
  // size: a 26-minute job at zoom 1 is 1,800 boxes, so only the ones within a
  // screen of the part on show are in the page, and a scroll draws the rest as
  // they come. (Widening the boxes to fit a cap of 400 stretched every frame
  // sideways on a long video -- owner, 2026-10-14.)
  function filmHtml(media, a, b, w, h, x) {
    const url = `/api/media/${media.kind}/${encodeURIComponent(media.id)}/filmstrip`;
    const strip = picture(url, (u) => loadImage(u).then((img) => ({ n: Math.max(1, Math.round(img.width / FRAME_W)) })));
    if (!strip || !(b > a)) return '<div class="tl-film"></div>';
    const fw = FRAME_W * h / FRAME_H;
    const f = { strip, a, w, x, fw, k0: -1, k1: -1 };
    const i = films.push(f) - 1;
    const [k0, k1] = filmRange(f);
    return `<div class="tl-film" data-film="${i}" style="--strip:url('${url}');--strip-w:${(strip.n * fw).toFixed(1)}px">${filmTiles(f, k0, k1)}</div>`;
  }

  // The frame boxes of a strip worth drawing: the part on show and a screen
  // either side of it, as box numbers [k0, k1).
  function filmRange(f) {
    const viewL = timelineAt * timelinePps - f.x;
    const k0 = Math.max(0, Math.floor((viewL - timelineRoom) / f.fw));
    const k1 = Math.min(Math.ceil(f.w / f.fw), Math.ceil((viewL + 2 * timelineRoom) / f.fw), k0 + MAX_TILES);
    return [k0, Math.max(k0, k1)];
  }

  function filmTiles(f, k0, k1) {
    const full = videoLength();
    f.k0 = k0; f.k1 = k1;
    let tiles = "";
    for (let k = k0; k < k1; k++) {
      const mid = f.a + ((k + 0.5) * f.fw) / timelinePps;
      const idx = Math.min(f.strip.n - 1, Math.max(0, Math.floor((mid / full) * f.strip.n)));
      tiles += `<i style="left:${(k * f.fw).toFixed(1)}px;width:${f.fw.toFixed(1)}px;background-position:-${(idx * f.fw).toFixed(1)}px 0"></i>`;
    }
    return tiles;
  }

  // After a scroll: every strip whose boxes on show have changed gets them again.
  function drawFilms() {
    const track = $("timelineTrack");
    if (!track || !track.querySelectorAll) return;
    for (const el of track.querySelectorAll(".tl-film[data-film]")) {
      const f = films[+el.dataset.film];
      if (!f) continue;
      const [k0, k1] = filmRange(f);
      if (k0 !== f.k0 || k1 !== f.k1) el.innerHTML = filmTiles(f, k0, k1);
    }
  }
  let filmsQueued = false;
  function scheduleFilms() {
    if (filmsQueued) return;
    filmsQueued = true;
    const run = () => { filmsQueued = false; drawFilms(); };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run); else run();
  }

  // The loudness of [a, b] of the video as bars, one per value.
  function waveHtml(media, a, b) {
    const url = `/api/media/${media.kind}/${encodeURIComponent(media.id)}/waveform`;
    return waveSvg(picture(url, fetchJson), a, b);
  }

  // The length the video lane stands for: the whole video, or its metadata.
  function videoLength() {
    if (mode === "draft") return jobClip() ? jobClip().duration : (getDraft() || {}).duration || totalOf(clips || []);
    return timelineDuration;
  }

  // ---- Drawing -----------------------------------------------------------------

  // A styled tooltip, not the browser's slow native one: data-tip (and
  // data-tip-key, the shortcut) drive a pure-CSS tooltip that shows on hover
  // and on keyboard focus alike (see [data-tip] in the stylesheet).
  // aria-label stays -- that is what a screen reader reads.
  const tool = (id, icon, size, label, key = "") =>
    `<button class="tl-tool" id="${id}" type="button" data-tip="${label}"${key ? ` data-tip-key="${key}"` : ""} aria-label="${label}">${lucide(icon, size)}</button>`;

  function headHtml() {
    const left = mode === "draft"
      ? `<span class="tl-tools">${tool("tlUndo", "undo-2", 15, t("Undo"), `${modKey()}+Z`)}${tool("tlRedo", "redo-2", 15, t("Redo"), `Shift+${modKey()}+Z`)}<span class="tl-sep"></span>`
        + `${tool("tlSplit", "gap-horizontal", 13.8, t("Split at playhead"), `${modKey()}+B`)}${tool("tlDelLeft", "split-left", 13.8, t("Delete left of playhead"))}`
        + `${tool("tlDelRight", "split-right", 13.8, t("Delete right of playhead"))}${tool("tlDelete", "trash", 16.2, t("Delete selected"), "Delete")}</span>`
      : ownSubtitles() ? '<span class="tl-legend"></span>' : `<span class="tl-legend">
        <span><i class="tl-sw-voice"></i>${t("Voice length")}</span>
        <span><i class="tl-sw-slot"></i>${t("Time available")}</span>
        <span><i class="tl-sw-over"></i>${t("Over time")}</span>
        <span><i class="tl-sw-short"></i>${t("Much shorter")}</span>
      </span>`;
    return `
    <div class="tl-head">
      ${left}
      <span class="tl-clock" id="timelineClock">${getClock()}</span>
      <span class="tl-zoom">
        <button class="tl-zbtn" id="tlZoomFit" type="button" data-tip="${t("Fit the whole video")}" data-tip-key="0" aria-label="${t("Fit the whole video")}">${lucide("scan-eye", 16.8)}</button>
        <button class="tl-zbtn" id="tlZoomOut" type="button" data-tip="${t("Zoom out")}" data-tip-key="-" aria-label="${t("Zoom out")}">${lucide("zoom-out", 16.8)}</button>
        <input class="tl-zslider" id="tlZoomLevel" type="range" step="0.01" aria-label="${t("Zoom")}">
        <button class="tl-zbtn" id="tlZoomIn" type="button" data-tip="${t("Zoom in")}" data-tip-key="+" aria-label="${t("Zoom in")}">${lucide("zoom-in", 16.8)}</button>
      </span>
      <button class="tl-fold" id="timelineFold" type="button" aria-label="${t("Fold the timeline")}">
        ${lucide("chevron-down", 14)}
      </button>
    </div>`;
  }

  function namesHtml() {
    // The lane's word is put in the language here, where it is drawn: one
    // call below is pinned by its source (indexHtml.test.mjs).
    const name = (cls, icon, size, text, lead = "") => `<div class="tl-name ${cls}">${lead || lucide(icon, size)}<span>${t(text)}</span></div>`;
    if (mode === "draft") {
      if (!clips) return "";
      return name("tl-name-video", "square-play", 12.3, "Video")
        + (erase && erase.lane ? name("tl-name-erase", "eraser", 12, "Erase") : "");
    }
    const on = getSubStyle().enabled;
    const eye = `<button class="tl-eye${on ? " on" : ""}" id="tlSubEye" type="button"
            title="${t("Captions on or off")}" aria-label="${t("Captions on or off")}">${lucide(on ? "eye" : "eye-off", 12)}</button>`;
    return name("tl-name-video", "square-play", 12.3, "Video")
      + (ownSubtitles() ? "" : name("tl-name-org", "volume-2", 11, "Original")
        + name("tl-name-dub", "volume-2", 11, "Translated"))
      + name(`tl-name-caps${on ? "" : " off"}`, "", 0, "Captions", eye);
  }

  // The whole strip: the toolbar, the lane names and the (still empty) track.
  function renderShell() {
    const box = $("timeline");
    box.classList.toggle("tl-draftmode", mode === "draft");
    box.innerHTML = headHtml() + `
    <div class="tl-body">
      <div class="tl-names"><div class="tl-corner"></div>${namesHtml()}</div>
      <div class="tl-track" id="timelineTrack"></div>
    </div>`;
    // The head is built fresh here, so the fold button it carries has to be told
    // again which way it is pointing.
    paintTimelineFold();
    drawTimelineTrack();
  }

  // Draws a finished job's strip. Empty lines (or no length yet) leave it blank,
  // which CSS collapses to nothing -- unless a new project's draft is up, which
  // then has the timeline to itself.
  function renderTimeline(lines, duration) {
    timelineLines = lines || [];
    timelineDuration = duration > 0 ? duration : 0;
    // The Erase tab has the strip. The lines are kept for when it gives it back.
    if (erase) return;
    if (timelineLines.length && timelineDuration) {
      mode = "job";
      renderShell();
      return;
    }
    timelineAt = 0;   // the next job starts at its own beginning
    draftWanted = false;
    if (getDraft()) { renderDraft(); return; }
    mode = "";
    $("timeline").classList.remove("tl-draftmode");
    $("timeline").innerHTML = "";
  }

  // A new project's screen: the draft on the timeline, or the empty row that
  // asks for it.
  function showDraft() {
    draftWanted = true;
    timelineLines = [];
    renderDraft();
  }

  function renderDraft() {
    // The Erase tab with no video yet draws what an empty draft draws: the
    // tools, the ruler and the row that asks for a video.
    mode = "draft";
    syncClips();
    renderShell();
    // The clocks count kept time from the first moment, not from the next
    // time the video moves.
    const v = getVideo();
    paintTimeline(v.currentTime || 0, 0, getClock());
  }

  /**
   * The Erase tab takes the strip (info, see `erase` above) or gives it back
   * (null) to whatever it was showing: a finished job, the draft, or nothing.
   * Called on every repaint of that tab, so the same answer twice draws
   * nothing, and an erase counting up redraws the track alone.
   */
  function showErase(info) {
    const before = erase;
    erase = info;
    if (!info) {
      if (!before) return;
      if (timelineLines.length && timelineDuration) { mode = "job"; renderShell(); }
      else if (getDraft() || draftWanted) renderDraft();
      else renderTimeline([], 0);
      return;
    }
    if (JSON.stringify(before) === JSON.stringify(info)) return;
    if (before && mode === "draft" && before.locked === info.locked && !before.lane === !info.lane
        && JSON.stringify(before.strip) === JSON.stringify(info.strip)) {
      drawTimelineTrack();
      return;
    }
    renderDraft();
  }

  // The clips follow the draft: a new video (or ranges changed from elsewhere)
  // starts a fresh list and a fresh history; the draft echoing back our own
  // change keeps the list as it is, splits and all. An erase job's video is
  // one clip of its own, with nothing to undo.
  function syncClips() {
    const own = jobClip();
    if (own) {
      const key = `${own.media.kind}:${own.media.id}`;
      if (clips && clipsFor === key && clips[0][1] === own.duration) return;
      clips = own.duration > 0 ? [[0, own.duration]] : null;
      clipsFor = key; history = null; selected = -1;
      return;
    }
    const d = getDraft();
    // The Erase tab asking for a video has none, whatever draft was left behind.
    if (!d || !d.onTimeline || (erase && !erase.strip)) { clips = null; clipsFor = ""; history = null; selected = -1; return; }
    if (clips && clipsFor === d.downloadId
        && sameRanges(normalizeRanges(clips, d.duration), d.ranges)) return;
    // Another video is another project: its own beginning, the usual scale.
    if (clipsFor !== d.downloadId) resetView();
    clips = d.ranges.map(([a, b]) => [a, b]);
    clipsFor = d.downloadId;
    history = createHistory(clips);
    selected = -1;
    // A video that has just come onto the strip is shown whole: the next
    // draw fits it (drawTimelineTrack, which is where the room is measured).
    fitDraftNext = true;
  }
  let fitDraftNext = false;

  // ---- Folded away to its heading row -----------------------------------------
  // Folded, the head stays -- so the clock still says where the video is.
  const TIMELINE_OPEN_KEY = "persodub.layout.timelineOpen";
  let timelineOpen = true;
  try { timelineOpen = localStorage.getItem(TIMELINE_OPEN_KEY) !== "0"; } catch { /* private window */ }

  function paintTimelineFold() {
    const box = $("timeline");
    box.classList.toggle("folded", !timelineOpen);
    const btn = $("timelineFold");
    if (btn) {
      btn.setAttribute("aria-expanded", String(timelineOpen));
      const what = timelineOpen ? t("Fold the timeline away") : t("Show the timeline");
      btn.setAttribute("aria-label", what);
      btn.title = what;
    }
    // The remembered height is left alone: the drag handle writes it as an inline
    // style, the folded rule overrides it while it applies, and unfolding hands
    // the strip back the height it had.
  }

  function setTimelineOpen(open) {
    timelineOpen = open;
    try { localStorage.setItem(TIMELINE_OPEN_KEY, open ? "1" : "0"); } catch { /* private window */ }
    paintTimelineFold();
    // The scale is measured off the track's width, and a folded track has none.
    if (open) drawTimelineTrack();
  }

  // One line's block in a lane: a button, so the keyboard reaches the lines too.
  // Its start and end are the LINE's -- clicking the part of a voice that pokes
  // past its slot still plays the line it belongs to. Only the Translated block
  // is a tab stop: three per line would bury the rest of the screen behind
  // hundreds of presses of the Tab key. `inner` is markup, built and escaped by
  // the caller; the title is text and is escaped here.
  function timelineBlock(l, cls, text, inner, stop = false) {
    const left = l.start * timelinePps;
    const width = Math.max(3, (l.end - l.start) * timelinePps);
    return `<button type="button" class="tl-blk ${cls}"${stop ? "" : ' tabindex="-1"'}
    data-start="${l.start}" data-end="${l.end}"
    style="left:${left.toFixed(1)}px;width:${width.toFixed(1)}px"
    title="${escapeHtml(text || t("Line {n}", { n: l.line }))}">${inner}</button>`;
  }

  // The scale for the room there is: 77px a second times the zoom. Fit is the
  // zoom that shows the whole length at once, the tail past the end included,
  // so there is nothing left to scroll.
  function fitZoom() {
    const len = mode === "draft" ? totalOf(clips || []) : timelineDuration;
    const room = Math.max(1, timelineRoom - TL_TAIL_PX);
    return len > 0 ? Math.min(TL_ZOOM_MAX, room / len / TL_PPS) : 1;
  }
  // Fit starts the strip at 00:00. Zooming around the playhead as the other
  // zoom buttons do left it scrolled, and the first seconds cut off.
  function fitTimeline() {
    timelineZoom = fitZoom();
    timelineAt = 0;
    drawTimelineTrack();
  }
  // As far out as fitting the whole video, and for a short one that already
  // fits at zoom 1, out to half of it still.
  const minZoom = () => Math.min(0.5, fitZoom());

  // The ruler: a label every few seconds and ten small ticks between two.
  function rulerHtml(width) {
    const every = labelEvery(timelinePps);
    let labels = "";
    for (let s = 0; s * timelinePps <= width - TL_LABEL_PX / 2; s += every) {
      labels += `<span style="left:${(s * timelinePps).toFixed(1)}px">${fmtRuler(s)}</span>`;
    }
    return `<div class="tl-ruler" style="--tl-step:${(every * timelinePps / 10).toFixed(2)}px">${labels}</div>`;
  }

  // Everything right of the lane names. Split out because the scale depends on
  // how wide the track is, which can only be measured once it is on screen --
  // and has to be measured again whenever that width changes.
  function drawTimelineTrack() {
    const track = $("timelineTrack");
    if (!track || !mode) return;
    timelineRoom = track.clientWidth;
    if (fitDraftNext && mode === "draft" && clips && timelineRoom > 0) {
      fitDraftNext = false;
      timelineZoom = fitZoom();
      timelineAt = 0;
    }
    timelineZoom = Math.min(TL_ZOOM_MAX, Math.max(minZoom(), timelineZoom));
    timelinePps = TL_PPS * timelineZoom;
    films = [];
    const lanes = mode === "draft" ? draftLanesHtml() : jobLanesHtml();
    const len = mode === "draft" ? totalOf(clips || []) : timelineDuration;
    // At least the room, so the ruler runs the whole way across; a bit past the
    // end, so the last clip's edge is not flush with the scrollbar's.
    const width = Math.max(timelineRoom, len * timelinePps + (len ? TL_TAIL_PX : 0));
    track.innerHTML = `<div class="tl-inner" style="width:${width.toFixed(0)}px">
    ${rulerHtml(width)}
    ${lanes}
    ${len || mode === "job" ? '<div class="tl-playhead" id="timelinePlayhead"><i></i></div>' : ""}
  </div>`;
    track.scrollLeft = timelineAt * timelinePps;
    // A brand new strip knows nothing about where the video is, and a paused
    // video sends no event to tell it. Put the moment back on it straight away.
    paintTimelineAt(getVideo().currentTime || 0);
    paintTimelineZoom();
  }

  function jobLanesHtml() {
    const media = getMedia();
    const w = timelineDuration * timelinePps;
    const name = media ? escapeHtml(media.name || "") : "";
    const video = `<div class="tl-lane tl-lane-video"><div class="tl-vclip" style="left:0;width:${w.toFixed(1)}px">
      <div class="tl-vcap">${name}<b>${fmtLength(timelineDuration)}</b></div>
      ${media ? filmHtml(media, 0, timelineDuration, w, 39, 0) : ""}
      <div class="tl-wave">${media ? waveHtml(media, 0, timelineDuration) : ""}</div></div></div>`;

    // Each speaker wears a colour on the top edge of their lines.
    const speakers = numberSpeakers(timelineLines);
    let voices = "";
    let originals = "";
    for (const l of timelineLines) {
      const who = speakers.get(l.speaker) || 1;
      const spk = ` tl-s${((who - 1) % SPEAKER_COLOURS) + 1}`;
      // The words alone: the line's number lives in the script table, not here (user, 2026-09-30).
      const label = escapeHtml(l.text || "");
      if (l.audio_sec == null) {
        // No voice on disk yet: the slot alone, dashed, is the whole truth.
        voices += timelineBlock(l, `tl-voice tl-novoice${spk}`, l.text, label, true);
      } else {
        // The table's verdict, in its colours: red past the slot, orange much
        // shorter than it, green between. The strip is not handed the cut
        // list, so a line the assembly cut is red here by its own numbers --
        // as nearly every one is: only what still runs over sped up is cut.
        const { kind, by } = lineVerdict(l);
        const over = kind === "over" ? by : 0;
        const slot = Math.max(l.end - l.start, 0.001);
        const fill = over ? 100 : Math.min(100, (l.audio_sec / slot) * 100);
        voices += timelineBlock(l, `tl-voice${over ? " tl-over" : kind === "short" ? " tl-short" : ""}${spk}`, l.text,
          `${label}<i class="tl-vlen" style="width:${fill.toFixed(1)}%"></i>`, true);
        // A long voice: past its slot, a red tint over whatever follows, so the
        // next line's block still reads while the red says how far this runs.
        if (over) {
          const tip = t("Line {n} runs {secs}s past its time", { n: l.line, secs: over.toFixed(1) });
          voices += `<span class="tl-spill" style="left:${(l.end * timelinePps).toFixed(1)}px;`
            + `width:${(over * timelinePps).toFixed(1)}px" title="${escapeHtml(tip)}"></span>`;
        }
      }
      originals += timelineBlock(l, "tl-org", l.source || "", escapeHtml(l.source || ""));
    }

    // The subtitle lane: when each line's words are on screen. The user drags
    // a block's ends to keep a subtitle up longer or take it down sooner; the
    // voices above never move.
    let caps = "";
    timelineLines.forEach((l, idx) => {
      const c = subCueOf(l, idx);
      const words = escapeHtml(l.text || "");
      const exdot = getSubStyle().widths[String(idx + 1)] != null
        ? `<span class="tl-exdot" title="${t("Back to the all-lines width")}">✱</span>` : "";
      caps += `<div class="tl-cap" data-idx="${idx}"
      style="left:${(c.start * timelinePps).toFixed(1)}px;width:${Math.max(8, (c.end - c.start) * timelinePps).toFixed(1)}px"
      title="${words}"><span class="tl-hdl l"></span><span
      class="tl-cap-txt">${words}</span><span class="tl-hdl r"></span>${exdot}</div>`;
    });
    const voiceLanes = ownSubtitles() ? "" : `
    <div class="tl-lane tl-lane-org">${originals}</div>
    <div class="tl-lane tl-lane-dub">${voices}</div>`;
    return `<div class="tl-lanes">${video}${voiceLanes}
    <div class="tl-lane tl-lane-caps${getSubStyle().enabled ? "" : " off"}">${caps}</div></div>`;
  }

  function draftLanesHtml() {
    if (!clips) {
      return `<div class="tl-empty" id="tlDrop">${lucide("film", 15)}<span>${t("Drop videos here")}</span></div>`;
    }
    const media = mediaNow();
    let x = 0;
    let html = "";
    clips.forEach(([a, b], i) => {
      const w = (b - a) * timelinePps;
      html += `<div class="tl-vclip tl-cut${i === selected ? " sel" : ""}" data-i="${i}"
      style="left:${x.toFixed(1)}px;width:${Math.max(1, w - 2).toFixed(1)}px">${media ? filmHtml(media, a, b, w, 55, x) : ""}<div class="tl-wave">${media ? waveHtml(media, a, b) : ""}</div></div>`;
      x += w;
      // Where this piece meets the next: the 2px gap above is otherwise too
      // faint to read as a cut (two near-identical video frames either side
      // of it), so a thin accent line marks the seam. Not after the last piece.
      if (i < clips.length - 1) html += `<div class="tl-seam" style="left:${(x - 2).toFixed(1)}px;width:2px"></div>`;
    });
    return `<div class="tl-lanes"><div class="tl-lane tl-lane-video">${html}</div>${eraseLaneHtml(x)}</div>`;
  }

  // The Erase lane: one block the length of everything kept, which is exactly
  // what the erase works on, and how far along it is.
  function eraseLaneHtml(width) {
    const lane = erase && erase.lane;
    if (!lane) return "";
    return `<div class="tl-lane tl-lane-erase"><div class="et-seg${lane.cls ? ` ${lane.cls}` : ""}"
      style="left:0;width:${Math.max(1, width - 2).toFixed(1)}px;--pct:${lane.pct || 0}%">${escapeHtml(lane.text)}</div></div>`;
  }

  function paintTimelineZoom() {
    const slider = $("tlZoomLevel");
    if (!slider) return;
    const lo = minZoom();
    slider.min = String(Math.log(lo));
    slider.max = String(Math.log(TL_ZOOM_MAX));
    slider.value = String(Math.log(timelineZoom));
    const said = "×" + (Math.round(timelineZoom * 10) / 10 + "").replace(/\.0$/, "");
    slider.setAttribute("aria-valuetext", said);
    slider.title = t("Zoom {level}", { level: said });
    $("tlZoomOut").disabled = timelineZoom <= lo + 1e-9;
    $("tlZoomIn").disabled = timelineZoom >= TL_ZOOM_MAX;
  }

  // Zooms around the playhead, the way an editor's timeline does: the moment
  // under the playhead stays put on screen, and the strip stretches or shrinks
  // around it. Off-screen playhead: the middle of the view holds instead.
  function setTimelineZoom(zoom) {
    zoom = Math.min(TL_ZOOM_MAX, Math.max(minZoom(), zoom));
    if (Math.abs(zoom - timelineZoom) < 1e-9) return;
    const track = $("timelineTrack");
    const t = timeOnStrip(getVideo().currentTime || 0);
    let frac = 0.5;
    if (track && track.clientWidth) {
      const f = (t * timelinePps - track.scrollLeft) / track.clientWidth;
      if (f >= 0 && f <= 1) frac = f;
    }
    timelineZoom = zoom;
    drawTimelineTrack();
    if (track && track.clientWidth) {
      track.scrollLeft = Math.max(0, t * timelinePps - frac * track.clientWidth);
      timelineAt = track.scrollLeft / timelinePps;
    }
  }

  // The video's time as the strip draws it: itself on a finished job, the kept
  // time (the clips laid end to end) on a draft.
  function timeOnStrip(t) {
    return mode === "draft" && clips ? sourceToKept(clips, t) : t;
  }

  // Everything on the strip that stands for one moment: the playhead, the bars
  // of the line that moment is inside, and (on a draft) which tools apply.
  function paintTimelineAt(t) {
    if (mode === "draft") paintTools(t);
    const head = $("timelinePlayhead");
    if (!head) return;
    const x = timeOnStrip(t) * timelinePps;
    head.style.left = `${x.toFixed(1)}px`;
    if (mode === "job") {
      for (const blk of $("timeline").querySelectorAll(".tl-voice, .tl-org")) {
        blk.classList.toggle("tl-now", isNowLine(t, blk));
      }
    }
    followPlayhead(x);
  }

  function paintTools(secs) {
    const lock = locked();
    // A tool that cannot be used says why on its tip, in place of its name.
    const set = (id, name, off, why) => {
      const b = $(id);
      if (!b) return;
      b.disabled = lock || off;
      b.dataset.tip = off && !lock && clips ? why : name;
    };
    const c = clips || [];
    const noPlayhead = t("Move the playhead into the video");
    set("tlUndo", t("Undo"), !history || !history.canUndo(), t("Nothing to undo"));
    set("tlRedo", t("Redo"), !history || !history.canRedo(), t("Nothing to redo"));
    set("tlSplit", t("Split at playhead"), !clips || !split(c, secs), noPlayhead);
    set("tlDelLeft", t("Delete left of playhead"), !clips || !removeLeft(c, secs), noPlayhead);
    set("tlDelRight", t("Delete right of playhead"), !clips || !removeRight(c, secs), noPlayhead);
    set("tlDelete", t("Delete selected"), !clips || selected < 0 || !removeClip(c, selected),
        selected < 0 ? t("Select a part first") : t("The last part stays"));
  }

  // A strip longer than the window is a strip the playhead walks off the end of.
  // While the video plays, the moment it leaves the part on show, scroll it back
  // into view a third of the way in. Only while it plays: a paused strip belongs
  // to whoever is reading it. Scroll it by hand and following stops for three
  // seconds, so a look back at an earlier line is not yanked away mid-read.
  const FOLLOW_PAUSE_MS = 3000;
  let followUntil = 0;      // do not follow before this moment
  let followedTo = -1;      // the last scroll position WE set, so the strip's
                            // scroll listener can tell our scrolling from theirs
  function followPlayhead(x) {
    const track = $("timelineTrack");
    if (!track || getVideo().paused || getVideo().seeking || Date.now() < followUntil) return;
    const room = track.clientWidth;
    if (x < track.scrollLeft || x > track.scrollLeft + room) {
      track.scrollLeft = Math.max(0, x - room / 3);
      // Read back rather than remembering what was asked for: the browser clamps
      // it to what the strip actually has room to scroll.
      followedTo = track.scrollLeft;
    }
  }

  // The moving parts, from the moment paintPlayhead already read. Nothing here
  // asks the video anything -- that would be the same sum done twice.
  function paintTimeline(t, total, clock) {
    if (!mode) return;   // nothing drawn
    if (mode === "draft") {
      // The kept time, on the timeline's clock and the player's alike. With
      // no video the player's says the clock handed in: the last draft's
      // kept time stayed on an empty new project's player (2026-10-21).
      if (clips) {
        clock = `${fmtClockTenths(sourceToKept(clips, t))} / ${fmtClockTenths(totalOf(clips))}`;
      }
      const player = getPlayerClock();
      if (player) player.textContent = clock;
    } else if (total > 0 && Math.abs(total - timelineDuration) > 0.05) {
      // The video's real length only arrives with its metadata; the strip was
      // drawn to the last line's end until then, so draw it again for the true one.
      renderTimeline(timelineLines, total);
    }
    $("timelineClock").textContent = clock;
    paintTimelineAt(t);
  }

  // ---- The cut tools (a draft) ------------------------------------------------
  function applyClips(next) {
    if (!next || locked()) return;
    history.push(next);
    commitClips(next);
  }

  // What every change ends in: the list drawn, and the draft told its ranges.
  function commitClips(next) {
    clips = next;
    if (selected >= clips.length) selected = -1;
    setRanges(clips);        // echoes back through onDraftChange, which keeps these
    // Where playback stands has to be somewhere still kept.
    const v = getVideo();
    const at = playableFrom(clips, v.currentTime || 0);
    if (at === null) v.currentTime = clips[clips.length - 1][1];
    else if (at !== v.currentTime) v.currentTime = at;
    drawTimelineTrack();
  }

  function undo() { const c = !locked() && history && history.undo(); if (c) { selected = -1; commitClips(c); } }
  function redo() { const c = !locked() && history && history.redo(); if (c) { selected = -1; commitClips(c); } }
  function splitAtPlayhead() { if (!locked()) applyClips(clips && split(clips, getVideo().currentTime || 0)); }
  function deleteSelected() {
    if (!clips || selected < 0 || locked()) return;
    const next = removeClip(clips, selected);
    if (!next) return;
    selected = -1;
    applyClips(next);
  }

  // Playing a draft plays the kept parts only: a cut-away gap is jumped over
  // the frame it is reached, and the end of the last clip is the end.
  function keepToKeptParts() {
    const v = getVideo();
    if (mode !== "draft" || !clips || v.paused) return;
    const at = playableFrom(clips, v.currentTime || 0);
    if (at === null) {
      v.pause();
      v.currentTime = clips[clips.length - 1][1];
      return;
    }
    if (at !== v.currentTime) v.currentTime = at;
    requestAnimationFrame(keepToKeptParts);
  }

  function onVideoPlay(e) {
    const v = getVideo();
    if (mode !== "draft" || !clips || (e && e.target && e.target !== v)) return;
    // Pressed at the very end: from the top again, as a player does.
    if (playableFrom(clips, v.currentTime || 0) === null) v.currentTime = clips[0][0];
    requestAnimationFrame(keepToKeptParts);
  }

  // Remember where the viewer scrolled to. The track itself is thrown away and
  // built again on every redraw, so the listener sits on the strip around it --
  // and catches the event on the way down, because scrolling does not bubble.
  $("timeline").addEventListener("scroll", (e) => {
    if (e.target.id === "timelineTrack" && timelinePps) {
      timelineAt = e.target.scrollLeft / timelinePps;
      scheduleFilms();
      // Anything that did not come from followPlayhead is the viewer scrolling,
      // and following gets out of the way for a while.
      if (Math.abs(e.target.scrollLeft - followedTo) >= 1) followUntil = Date.now() + FOLLOW_PAUSE_MS;
    }
  }, true);

  // The slider: the zoom, on a log scale so every step feels the same size.
  $("timeline").addEventListener("input", (e) => {
    if (e.target.id === "tlZoomLevel") setTimelineZoom(Math.exp(+e.target.value));
  });

  // A bar is a way into the video: play the line it stands for. Which video is
  // the row's to say -- the original lane is the film as it came in, so it
  // plays the original, and the translated lane is the dub. The switch has to
  // finish before the seek, hence the wait.
  $("timeline").addEventListener("click", (e) => {
    if (e.target.closest(".tl-exdot")) {
      const idx = +e.target.closest(".tl-cap").dataset.idx;
      delete getSubStyle().widths[String(idx + 1)];
      saveSubStyle(); updateSubtitleNow();
      renderTimeline(timelineLines, timelineDuration);
      return;
    }
    if (e.target.closest("#tlSubEye")) {
      getSubStyle().enabled = !getSubStyle().enabled;
      saveSubStyle(); updateSubtitleNow(); renderTimeline(timelineLines, timelineDuration);
      return;
    }
    if (e.target.closest(".tl-hdl")) return;   // a trim, not a click-to-play
    if (e.target.closest(".tl-fold")) { setTimelineOpen(!timelineOpen); return; }
    if (e.target.closest("#tlZoomIn")) { setTimelineZoom(timelineZoom * TL_ZOOM_STEP); return; }
    if (e.target.closest("#tlZoomOut")) { setTimelineZoom(timelineZoom / TL_ZOOM_STEP); return; }
    if (e.target.closest("#tlZoomFit")) { fitTimeline(); return; }
    if (mode === "draft") { onDraftClick(e); return; }
    const blk = e.target.closest(".tl-blk");
    if (!blk) return;
    const which = blk.classList.contains("tl-org") ? "original" : "dubbed";
    const start = +blk.dataset.start;
    const end = +blk.dataset.end;
    showVideoSource(which)
      .then(() => playRange(getVideo(), start, end))
      .catch(() => {});
  });

  function onDraftClick(e) {
    const t = getVideo().currentTime || 0;
    if (locked()) return;
    if (e.target.closest("#tlUndo")) { undo(); return; }
    if (e.target.closest("#tlRedo")) { redo(); return; }
    if (e.target.closest("#tlSplit")) { splitAtPlayhead(); return; }
    if (e.target.closest("#tlDelLeft")) { applyClips(clips && removeLeft(clips, t)); return; }
    if (e.target.closest("#tlDelRight")) { applyClips(clips && removeRight(clips, t)); return; }
    if (e.target.closest("#tlDelete")) { deleteSelected(); return; }
    if (e.target.closest(".tl-head")) return;
    // A clip is chosen by a click on it; a click anywhere else lets go.
    const clip = e.target.closest(".tl-cut");
    const next = clip ? +clip.dataset.i : -1;
    if (next !== selected) { selected = next; drawTimelineTrack(); }
  }

  // ---- The keyboard ---------------------------------------------------------
  // Space plays from where the playhead stands (and pauses again); Enter plays
  // from the very start; + - 0 zoom the timeline. On a draft, Delete takes the
  // chosen clip out and Cmd/Ctrl+Z (Shift for redo) walks the cuts back and
  // forth. Only on the finished screen or a draft that is on show, and never
  // while the user is typing or pressing an actual control -- a space in the
  // middle of a sentence must stay a space (user, 2026-09-01).
  // Attached by attach(), not here: nothing about importing this file may put
  // a listener on the document.
  // A tool pressed with the mouse does not keep the focus: a button that has it
  // takes the space bar for itself, and the next Space split the clip again
  // instead of playing (user, 2026-09-30).
  $("timeline").addEventListener("mousedown", (e) => {
    if (e.target.closest(".tl-head button")) e.preventDefault();
  });
  function onDoneKeydown(e) {
    const draftOn = mode === "draft" && $("timeline").offsetWidth > 0;
    if (document.body.dataset.screen !== "done" && !draftOn) return;
    if (e.isComposing) return;
    if (e.target.closest("input, textarea, select, button, a, [contenteditable]")) return;
    if (document.querySelector(".modal-overlay.open")) return;
    if (draftOn && (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (draftOn && (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "b") {
      e.preventDefault();
      splitAtPlayhead();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (draftOn && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      deleteSelected();
    } else if (e.key === " ") {
      e.preventDefault();   // space scrolls the page otherwise
      toggleDonePlay();
    } else if (e.key === "Enter") {
      cancelRange(getVideo());
      getVideo().currentTime = draftOn && clips ? clips[0][0] : 0;
      getVideo().play().catch(() => {});
    } else if (e.key === "+" || e.key === "=") {
      setTimelineZoom(timelineZoom * TL_ZOOM_STEP);
    } else if (e.key === "-") {
      setTimelineZoom(timelineZoom / TL_ZOOM_STEP);
    } else if (e.key === "0") {
      fitTimeline();
    }
  }

  // ---- Trimming the subtitle lane ---------------------------------------------
  // Grab a subtitle block's end and pull: the block follows, a tip says the new
  // times, and letting go remembers them (and the Export burn uses them).
  $("timeline").addEventListener("pointerdown", (e) => {
    const hdl = e.target.closest(".tl-hdl");
    if (!hdl) return;
    const blk = hdl.closest(".tl-cap");
    const idx = +blk.dataset.idx;
    const line = timelineLines[idx];
    if (!line) return;
    e.preventDefault(); e.stopPropagation();
    const isL = hdl.classList.contains("l");
    const c0 = subCueOf(line, idx);
    const x0 = e.clientX;
    let cue = { ...c0 };
    blk.classList.add("trimming");
    const tip = document.createElement("span");
    tip.className = "tl-trim-tip";
    blk.appendChild(tip);
    const move = (ev) => {
      const dSec = (ev.clientX - x0) / timelinePps;
      if (isL) cue.start = Math.min(c0.end - 0.2, Math.max(0, c0.start + dSec));
      else cue.end = Math.max(c0.start + 0.2, Math.min(timelineDuration, c0.end + dSec));
      blk.style.left = (cue.start * timelinePps).toFixed(1) + "px";
      blk.style.width = Math.max(8, (cue.end - cue.start) * timelinePps).toFixed(1) + "px";
      tip.textContent = t("{start}s – {end}s", { start: cue.start.toFixed(1), end: cue.end.toFixed(1) });
    };
    const up = () => {
      hdl.removeEventListener("pointermove", move);
      hdl.removeEventListener("pointerup", up);
      hdl.removeEventListener("pointercancel", up);
      blk.classList.remove("trimming");
      tip.remove();
      // Only the end that was dragged goes to a tenth: the other stays where
      // it was, or a line starting at 4.49 s would start its subtitle at 4.5 s
      // and the line's own time would show none (sweep V7, 2026-10-24).
      const tenth = (s) => Math.round(s * 10) / 10;
      getSubStyle().cues[String(idx + 1)] = isL ? { start: tenth(cue.start), end: c0.end }
                                                : { start: c0.start, end: tenth(cue.end) };
      saveSubStyle(); updateSubtitleNow();
    };
    hdl.addEventListener("pointermove", move);
    hdl.addEventListener("pointerup", up);
    hdl.addEventListener("pointercancel", up);
    hdl.setPointerCapture(e.pointerId);
  });

  // ---- The playhead as a control ----------------------------------------------
  // Drag the head, or press anywhere on the ruler (on a finished job, an empty
  // stretch of a lane or the video clip too), and the video goes there. The
  // moment is read off the strip's own scale, so it lands where the pointer is
  // however far the track has been scrolled -- and on a draft, the strip's time
  // is the kept time, turned back into the video's own.
  function timelineTimeAt(clientX) {
    const inner = $("timeline").querySelector(".tl-inner");
    if (!inner || !timelinePps) return null;
    const x = clientX - inner.getBoundingClientRect().left;
    if (mode === "draft") {
      if (!clips) return null;
      return keptToSource(clips, Math.min(Math.max(x / timelinePps, 0), totalOf(clips)));
    }
    return Math.min(Math.max(x / timelinePps, 0), timelineDuration);
  }

  // Everything that moves is redrawn by paintPlayhead, the one place that reads
  // the video's time -- so the row the table highlights, the strip's clock, its
  // bars and the head itself all come from the same answer.
  function seekDoneVideo(t) {
    if (t == null || !Number.isFinite(t)) return;
    cancelRange(getVideo());   // playing on from here means no stopping point
    getVideo().currentTime = t;
    paintPlayhead();
  }

  // The strip brought to a moment the page moved the video to from outside it
  // (a line pressed in the script table): the video is still, so following
  // would not move it, and the playhead could sit off the part on show. Off
  // it, it scrolls there a third of the way in, as following does.
  function revealTime(t) {
    const track = $("timelineTrack");
    if (!track || !timelinePps) return;
    const x = timeOnStrip(t) * timelinePps;
    if (x >= track.scrollLeft && x <= track.scrollLeft + track.clientWidth) return;
    track.scrollLeft = Math.max(0, x - track.clientWidth / 3);
    followedTo = track.scrollLeft;   // ours, so the scroll listener does not take it for the viewer's
  }

  $("timeline").addEventListener("pointerdown", (e) => {
    const onHead = e.target.closest(".tl-playhead");
    // Before dubbing a press on a lane goes there too, the way an editor's
    // timeline does -- and the click that follows still picks the clip.
    if (!onHead && mode === "draft" && e.target.closest(".tl-lanes")) {
      followUntil = Date.now() + FOLLOW_PAUSE_MS;
      seekDoneVideo(timelineTimeAt(e.clientX));
      return;
    }
    // On a finished job too, wherever the press has nothing else to do -- an
    // empty stretch of a lane, the video clip -- it moves the playhead, and
    // Space plays (owner, 2026-10-11: move only, as CapCut does). A line's bar
    // keeps its click, which plays that line; a subtitle block keeps its ends.
    if (!onHead && mode === "job" && e.target.closest(".tl-lanes") && !e.target.closest(".tl-blk")
        && !e.target.closest(".tl-cap")) {
      followUntil = Date.now() + FOLLOW_PAUSE_MS;
      seekDoneVideo(timelineTimeAt(e.clientX));
      return;
    }
    if (!onHead && !e.target.closest(".tl-ruler")) return;
    e.preventDefault();
    // Before the seek, and before the drag/press fork: a press on the ruler moves
    // the playing video too, and following it would scroll the strip out from
    // under the hand that is about to press again.
    followUntil = Date.now() + FOLLOW_PAUSE_MS;
    seekDoneVideo(timelineTimeAt(e.clientX));
    if (!onHead) return;   // a press on the ruler is one jump, not a drag

    // Captured on the strip rather than the head: the head is redrawn as the
    // video moves, and a capture on an element that goes away ends the drag.
    const box = $("timeline");
    const move = (ev) => {
      // Following would pull the strip out from under the hand that is dragging.
      followUntil = Date.now() + FOLLOW_PAUSE_MS;
      seekDoneVideo(timelineTimeAt(ev.clientX));
    };
    const up = () => {
      box.classList.remove("scrubbing");
      box.removeEventListener("pointermove", move);
      box.removeEventListener("pointerup", up);
      box.removeEventListener("pointercancel", up);
    };
    box.classList.add("scrubbing");
    box.addEventListener("pointermove", move);
    box.addEventListener("pointerup", up);
    box.addEventListener("pointercancel", up);
    // Last, so a capture that throws (a stale or synthetic pointer id) cannot
    // leave the strip stuck mid-drag with nothing to end it.
    box.setPointerCapture(e.pointerId);
  });

  // ---------------- The drag handles ----------------
  // Each handle lies on the line between two panes and sizes the one BELOW or
  // RIGHT of it, which is why every drag is `start - moved`: pull the line up (or
  // left) and that pane grows. `read` measures the pane now, `limits` gives its
  // floor and ceiling for the window as it stands this second, and `apply` puts a
  // size on it. The size is remembered in the browser under `key` and put back
  // next time -- clamped, so a size saved on a big window cannot break a small
  // one. Returns the "put it back" step for fitLayout() below.
  // `before: true` is for a handle that sizes the pane on the OTHER side -- the
  // one above or left of it, as the projects list is. Pulling that line right
  // grows its pane, so its drag counts the other way round.
  function makeGrip({ el, axis, read, limits, apply, key, before = false }) {
    const clamp = (v) => {
      const range = limits();   // null: nothing on screen to measure yet
      return range ? Math.round(Math.min(Math.max(v, range[0]), range[1])) : null;
    };
    el.addEventListener("pointerdown", (e) => {
      if (!limits()) return;   // nothing on screen to measure yet
      e.preventDefault();
      const start = read();
      const from = axis === "x" ? e.clientX : e.clientY;
      let dragged = false;
      el.classList.add("dragging");
      const move = (ev) => {
        const moved = (axis === "x" ? ev.clientX : ev.clientY) - from;
        if (!moved) return;   // a press that has not gone anywhere yet
        const size = clamp(before ? start + moved : start - moved);
        if (size === null) return;
        apply(size);
        dragged = true;
      };
      const up = () => {
        el.classList.remove("dragging");
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        // Once, at the end, and measured off the box itself: a stylesheet rule can
        // clamp a pane tighter than `limits` does (the agent strip's max-height
        // does), and what comes back next time has to be what was on the screen,
        // not what the pointer asked for. A press that never moved changes
        // nothing and so remembers nothing; neither does a pane that ended the
        // drag with no size at all, which means it left the screen halfway.
        const size = read();
        if (dragged && size > 0) localStorage.setItem(key, String(size));
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
      // Last, so a capture that throws (a stale or synthetic pointer id) cannot
      // leave the handle stuck in its dragging state with nothing to end it.
      el.setPointerCapture(e.pointerId);
    });
    return () => {
      const saved = Number(localStorage.getItem(key));
      const size = saved > 0 ? clamp(saved) : null;   // nothing saved: the stylesheet's size stands
      if (size !== null) apply(size);
    };
  }

  const layoutFits = [
    makeGrip({
      el: $("gripSidebar"), axis: "x", key: "persodub.layout.sidebarW", before: true,
      read: () => $("historySidebar").offsetWidth,
      // A plain pair, not read off the window: the list is beside the work rather
      // than part of it, and 480px of project names is as much as anyone wants.
      // The floor is the width at which a name still has room to say anything.
      limits: () => [220, 480],
      // A variable, not a width: see the stylesheet. Setting a width here would
      // outrank the rule that closes the sidebar, and it would never close again.
      apply: (w) => {
        $("historySidebar").style.setProperty("--sidebar-w", `${w}px`);
        markClippedNames();
      },
    }),
    // Before the video/script grip on purpose: that one measures its room off
    // what the timeline leaves, so the timeline has to be settled first. The
    // other order let a remembered tall timeline push a remembered tall video
    // pane's share of the room out from under the table, which then slid under
    // the timeline (13-inch screen, user, 2026-09-02).
    makeGrip({
      el: $("gripTimeline"), axis: "y", key: "persodub.layout.timelineHeight",
      read: () => $("timeline").offsetHeight,
      // At most 40% of the window, and never so tall that the top bar (52), the
      // gutters (18), the script pane's name (30), the table's own header (40)
      // and a few rows of script cannot share what is left -- about 340px above
      // it. (Stacked it is the video that also has to fit up there, but there
      // the strip is as tall as its lanes and this ceiling is not reached.)
      limits: () => [110, Math.max(110, Math.min(window.innerHeight * 0.4, window.innerHeight - 340))],
      apply: (h) => { $("timeline").style.height = `${h}px`; },
    }),
    // Layout G (user, 2026-09-08): the video is RIGHT of the table, so this
    // handle sizes a width, not a height. A new key, because a height saved by
    // the old stacked screen would come back as a width here and hand the video
    // whatever the window used to be tall.
    // A flex basis, not a width: the panels share the row by flex (866 : 861 :
    // 801, mockup 2026-09-29), and a width under a share is ignored. Stacked,
    // a basis would be a height, so none is written there.
    // The center panel is one of three -- the finished video, the running
    // one, the Erase tab's -- and only one is up at a time. Each carries the
    // same grip, and the width is written on the row they share, so it is one
    // size whichever is up.
    ...["gripPanes", "gripPanesRun", "gripPanesErase"].map((grip) => makeGrip({
      el: $(grip), axis: "x", key: "persodub.layout.videoWidth",
      read: () => (["videoPane", "runPane", "erasePane"].map($).find((p) => p.offsetWidth)
        || $("videoPane")).offsetWidth,
      // The video keeps at least 320px of the row and the panel beside it
      // 380: that is the script table at its narrowest, and under it the
      // translation slid beneath the row's own buttons (2026-09-30).
      limits: () => {
        const room = $("doneMain").offsetWidth;
        return room ? [320, Math.max(320, room - 7 - 380)] : null;
      },
      // Stacked, the stylesheet's own rule for the band outranks this.
      apply: (w) => { $("doneMain").style.setProperty("--video-flex", `0 0 ${w}px`); },
    })),
    makeGrip({
      el: $("gripAgent"), axis: "x", key: "persodub.layout.agentWidth",
      read: () => $("agentStrip").offsetWidth,
      // Never so wide the work beside it stops being usable. Up to 45% of the
      // window: the mockup's own share is 801 of 2560, about a third.
      limits: () => [260, Math.max(260, Math.min(Math.round(window.innerWidth * 0.45), window.innerWidth - 560))],
      apply: (w) => { $("agentStrip").style.flex = `0 0 ${w}px`; },
    }),
  ];

  // Remembered sizes: now, again when the finished screen is put on show (a
  // hidden pane has no width to measure, so the script/video one can only be set
  // there), and whenever the window itself changes size -- two of the three
  // ceilings are read off the window, and a size that no longer fits inside it
  // has to come back in.
  function fitLayout() { for (const put of layoutFits) put(); }
  // A window being dragged sends resize events faster than the screen is redrawn,
  // and every one of them would read three sizes and write three styles. One pass
  // per frame is all a redraw can show.
  let fitQueued = false;

  // Everything that listens outside the strip: the keyboard, the observer that
  // re-measures the track, the window resize that puts the remembered pane
  // sizes back, the draft, and the player (so a draft plays its kept parts
  // only). The page calls this once.
  function attach() {
    document.addEventListener("keydown", onDoneKeydown);
    // The scale is measured from the track's width, so a window resized (or, later,
    // a pane dragged) has to be measured again -- otherwise the drawing keeps the
    // old width's scale.
    // A width of zero is not a width: the strip can be measured while it is hidden,
    // and drawing to it would freeze the scale at its floor for good.
    new ResizeObserver(() => {
      const track = $("timelineTrack");
      if (track && track.clientWidth && track.clientWidth !== timelineRoom) drawTimelineTrack();
    }).observe($("timeline"));
    fitLayout();
    window.addEventListener("resize", () => {
      if (fitQueued) return;
      fitQueued = true;
      requestAnimationFrame(() => { fitQueued = false; fitLayout(); });
    });
    // A finished job owns the strip; otherwise a draft coming, changing or
    // going redraws it.
    onDraftChange(() => {
      if (mode === "job") return;
      if (getDraft() || draftWanted || erase) renderDraft();
      else renderTimeline([], 0);
    });
    for (const v of videos()) v.addEventListener("play", onVideoPlay);
  }

  // What the page reaches in for. The lines are handed back by reference, the
  // way the page held them itself: the subtitle overlay walks them to find the
  // line the video is inside.
  function getLines() { return timelineLines; }
  // The lines have not changed but how they are drawn has -- a style loaded, the
  // eye pressed. Same lines, same length, drawn again.
  function redraw() { renderTimeline(timelineLines, timelineDuration); }
  // A new job starts at its own beginning and at the usual scale, rather than
  // where the last one was scrolled and zoomed to.
  function resetView() { timelineAt = 0; timelineZoom = 1; }

  return { renderTimeline, redraw, drawTimelineTrack, paintTimeline, getLines,
           revealTime,
           resetView, fitLayout, attach, showDraft, showErase };
}

/**
 * The loudness of [a, b] seconds of a sound as bars, one per value: `wave` is
 * {rate, peaks} as app/media_preview.py answers. "" when there is nothing to
 * draw.
 */
export function waveSvg(wave, a, b) {
  if (!wave || !wave.peaks || !wave.peaks.length) return "";
  const i0 = Math.max(0, Math.floor(a * wave.rate));
  const i1 = Math.min(wave.peaks.length, Math.ceil(b * wave.rate));
  if (i1 <= i0) return "";
  let d = "";
  for (let i = i0; i < i1; i++) {
    const v = Math.max(4, wave.peaks[i] * 100);
    d += `M${i - i0} 100V${(100 - v).toFixed(1)}h0.6V100z`;
  }
  return `<svg viewBox="0 0 ${i1 - i0} 100" preserveAspectRatio="none" aria-hidden="true"><path d="${d}"/></svg>`;
}

function defaultLoadImage(url) {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => ok({ width: img.naturalWidth });
    img.onerror = fail;
    img.src = url;
  });
}

function defaultFetchJson(url) {
  return fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));
}
