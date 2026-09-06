// The strip under the script table on the finished screen: the same lines drawn
// in time. A ruler along the top, the dubbed voice of each line over the slot it
// has to fit inside, the original line under that, the subtitles' own lane at
// the bottom, and the playhead across all four. A click on a bar plays that
// line; the playhead and the ruler scrub the video; the subtitle blocks are
// dragged by their ends to keep a subtitle up longer or take it down sooner.
//
// The pane grips come with it (the "three drag handles" below). Only one of the
// four sizes the timeline itself, but all four are one mechanism -- a remembered
// size, clamped to the window as it stands -- and the timeline's ceiling is read
// off what the others leave, so splitting them would put one half of an
// agreement in a file that cannot see the other half.
//
// What is NOT here: the player and its transport, the subtitle overlay on the
// picture, its toolbar and style menu, and subtitle_style.json itself all stay
// on the page -- the overlay and this lane read the same object, and one of them
// had to own it. This file is handed it (getSubStyle), told when to save it
// (saveSubStyle) and when the overlay must be redrawn (updateSubtitleNow).
// subEyeSvg came along because the lane's eye is the only place that draws it.
//
// lineOverBy is imported rather than passed: the table colours its lines by the
// same rule, and one rule for "too long" said in two places is how the two would
// come to disagree.
//
// The elements this file touches: #timeline and everything it draws inside
// itself, plus the four grips and the panes they size. It never reaches the top
// bar, the script table or `state`.
import { escapeHtml, fmtClock } from "./format.mjs";
import { lineOverBy } from "./scriptTable.mjs";

// Roughly the room one 00:00:00 label needs. When a second is narrower than
// this, only every Nth tick is labelled, so the labels never overlap. Exported
// because the New project dialog's trim bar rules its own ruler by the same
// measure -- one answer to "how much room does a time need", in one place.
export const TL_LABEL_PX = 58;

// The eye on the subtitle lane's name, open or shut. It lived beside the
// overlay's own code until this file existed; the lane is the only thing that
// ever drew it.
function subEyeSvg(on) {
  return on
    ? '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-6 10-6c2 0 3.7.6 5.2 1.4M22 12s-3.5 6-10 6c-2 0-3.7-.6-5.2-1.4"/><line x1="4" y1="20" x2="20" y2="4"/></svg>';
}

/**
 * Wire the timeline, and the grips that size the panes around it, to a page.
 *
 * @param {object} deps
 * @param {(id: string) => any} deps.$  the page's getElementById helper
 * @param {() => {source: string, target: string}} deps.scriptLangNames  the two
 *        language names the lanes are labelled with -- the page's own, because
 *        the script table heads its columns with the same pair
 * @param {() => any} deps.getVideo  the finished screen's player, read late: the
 *        strip asks it where it is, seeks it, and plays a line in it
 * @param {() => string} deps.getClock  the clock as the player last painted it,
 *        so a strip drawn between two of the video's signals starts out saying
 *        the same thing as the rest of the screen
 * @param {() => object} deps.getSubStyle  the job's subtitle_style.json as the
 *        page holds it -- read late, because the page replaces the whole object
 *        when a job is opened
 * @param {(line: object, idx: number) => {start: number, end: number}} deps.subCueOf
 *        the user's retimed window for a line, else the line's own; the overlay
 *        on the picture reads it the same way
 * @param {() => void} deps.saveSubStyle  remember a retimed or re-widened
 *        subtitle (a debounced PUT on the page)
 * @param {() => void} deps.updateSubtitleNow  redraw the subtitle on the picture,
 *        which has just been retimed or switched off
 * @param {(t: number, el: any) => boolean} deps.isNowLine  is the video inside
 *        this line right now -- the table's highlighted row and the strip's
 *        highlighted bars are the same answer
 * @param {(which: string) => Promise} deps.showVideoSource  swap the player to
 *        the dub or the original; the bottom lane plays the film as it came in
 * @param {(video: any, start: number, end: number) => Promise} deps.playRange
 *        the page's shared "play only this much and stop" helper
 * @param {(video: any) => void} deps.cancelRange  forget a stopping point: a
 *        scrub or a play-from-here means the line's end no longer applies
 * @param {() => void} deps.paintPlayhead  the page's one reader of the video's
 *        time; a seek from the strip asks it to repaint everything at once
 * @param {() => void} deps.toggleDonePlay  the space bar's play/pause
 * @param {() => void} deps.markClippedNames  the projects list re-measures its
 *        names when the sidebar grip changes their column's width
 * @returns the operations the rest of the page calls.
 */
export function initTimelineUi({ $, scriptLangNames, getVideo, getClock, getSubStyle,
                                 subCueOf, saveSubStyle, updateSubtitleNow, isNowLine,
                                 showVideoSource, playRange, cancelRange, paintPlayhead,
                                 toggleDonePlay, markClippedNames }) {
  // ---------------- Done: the timeline ----------------
  // The script again, drawn in time: the dubbed voice of each line over the slot
  // it has to fit inside, the original line under it, a ruler above and the
  // playhead across all three. Read-only -- the one thing a click does is play
  // that line, the same way the table's play button does.

  // The smallest a second of video may be drawn. Without a floor a long job
  // squeezes into slivers nobody can read; with it the track scrolls instead.
  const TL_MIN_PPS = 10;

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
  // How far in the viewer has zoomed: 1 is fit-the-whole-video, steps of 1.5 up
  // to 8. A factor on the fit scale rather than a scale of its own, so a window
  // resize keeps the same zoom rather than the same now-meaningless pixel count.
  let timelineZoom = 1;
  const TL_ZOOM_STEP = 1.5, TL_ZOOM_MAX = 8;

  // Draws the whole strip. Empty lines (or no length yet) leave it blank, which
  // CSS collapses to nothing.
  function renderTimeline(lines, duration) {
    const box = $("timeline");
    timelineLines = lines || [];
    timelineDuration = duration > 0 ? duration : 0;
    if (!timelineLines.length || !timelineDuration) {
      box.innerHTML = "";
      timelineAt = 0;   // the next job starts at its own beginning
      return;
    }
    const { source, target } = scriptLangNames();
    box.innerHTML = `
    <div class="tl-head">
      <span class="tl-title">Timeline</span>
      <span class="tl-clock" id="timelineClock">${getClock()}</span>
      <span class="tl-zoom">
        <button class="tl-zbtn" id="tlZoomOut" type="button" title="Zoom out (-)">−</button>
        <span class="tl-zlv" id="tlZoomLevel">×1</span>
        <button class="tl-zbtn" id="tlZoomIn" type="button" title="Zoom in (+)">＋</button>
        <button class="tl-zbtn tl-zfit" id="tlZoomFit" type="button" title="Fit the whole video (0)">Fit</button>
      </span>
      <span class="tl-legend">
        <span><i class="tl-sw-voice"></i>Voice length</span>
        <span><i class="tl-sw-slot"></i>Time available</span>
        <span><i class="tl-sw-over"></i>Over time</span>
      </span>
      <button class="tl-fold" id="timelineFold" type="button" aria-label="Fold the timeline">
        <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M6 9.5l6 6 6-6"/></svg>
      </button>
    </div>
    <div class="tl-body">
      <div class="tl-names">
        <div class="tl-corner"></div>
        <div class="tl-name strong">${escapeHtml(target)}</div>
        <div class="tl-name">${escapeHtml(source)}</div>
        <div class="tl-name strong tl-name-caps${getSubStyle().enabled ? "" : " off"}">
          <button class="tl-eye${getSubStyle().enabled ? " on" : ""}" id="tlSubEye" type="button"
            title="Subtitles on or off" aria-label="Subtitles on or off">${subEyeSvg(getSubStyle().enabled)}</button>Subtitles</div>
      </div>
      <div class="tl-track" id="timelineTrack"></div>
    </div>`;
    // The head is built fresh here, so the fold button it carries has to be told
    // again which way it is pointing.
    paintTimelineFold();
    drawTimelineTrack();
  }

  // ---- Folded away to its heading row -----------------------------------------
  // A finished job is mostly read in the table; the strip is for checking timing,
  // and the rest of the time it is 150px of screen the script could have. Folded,
  // the head stays -- so the clock still says where the video is.
  const TIMELINE_OPEN_KEY = "persodub.layout.timelineOpen";
  let timelineOpen = true;
  try { timelineOpen = localStorage.getItem(TIMELINE_OPEN_KEY) !== "0"; } catch { /* private window */ }

  function paintTimelineFold() {
    const box = $("timeline");
    box.classList.toggle("folded", !timelineOpen);
    const btn = $("timelineFold");
    if (btn) {
      btn.setAttribute("aria-expanded", String(timelineOpen));
      const what = timelineOpen ? "Fold the timeline away" : "Show the timeline";
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

  // One block: a button, so the keyboard reaches the lines too. Its own start and
  // end are the LINE's, not the block's -- clicking the part of a voice bar that
  // pokes past its slot still plays the line it belongs to.
  // A line draws up to three blocks and every one of them does the same thing, so
  // only one of them (`stop`) is a tab stop: three per line would bury the rest of
  // the screen behind hundreds of presses of the Tab key.
  function timelineBlock(l, cls, from, to, text, stop = false) {
    const left = from * timelinePps;
    const width = Math.max(3, (to - from) * timelinePps);
    return `<button type="button" class="tl-blk ${cls}"${stop ? "" : ' tabindex="-1"'}
    data-start="${l.start}" data-end="${l.end}"
    style="left:${left.toFixed(1)}px;width:${width.toFixed(1)}px"
    title="${escapeHtml(text || `Line ${l.line}`)}">${escapeHtml(text)}</button>`;
  }

  // Everything right of the language names. Split out because the scale depends
  // on how wide the track is, which can only be measured once it is on screen --
  // and has to be measured again whenever that width changes.
  function drawTimelineTrack() {
    const track = $("timelineTrack");
    if (!track || !timelineDuration) return;
    timelineRoom = track.clientWidth;
    timelinePps = Math.max(timelineRoom / timelineDuration, TL_MIN_PPS) * timelineZoom;
    const width = timelineDuration * timelinePps;

    // One tick every `every` seconds, labelled. Close together, that is every
    // second; squeezed, the ticks thin out with their labels rather than turning
    // the ruler into a comb of grey lines nobody can read a time off.
    const every = Math.max(1, Math.ceil(TL_LABEL_PX / timelinePps));
    let ticks = "";
    for (let s = 0; s <= Math.floor(timelineDuration); s += every) {
      const at = s * timelinePps;
      // The label hangs to the RIGHT of its tick, so the last one would hang off
      // the end of the strip and be cut in half. A tick with no room keeps the
      // line and drops the label.
      const label = at + TL_LABEL_PX <= width ? `<span>${fmtClock(s)}</span>` : "";
      ticks += `<div class="tl-tick" style="left:${at.toFixed(1)}px">${label}</div>`;
    }

    let voices = "";
    let originals = "";
    for (const l of timelineLines) {
      const hasVoice = l.audio_sec != null;
      // The slot first, so the voice bar lies on top of it.
      voices += timelineBlock(l, "tl-slot", l.start, l.end, "", !hasVoice);
      // No voice on disk yet: the slot alone is the whole truth about that line.
      if (hasVoice) {
        const over = lineOverBy(l);
        const voiceEnd = l.start + l.audio_sec;
        // A long voice stops its solid bar at the slot; the part past it is a
        // tint (see .tl-spill) over whatever follows, so the next line's bar --
        // drawn after this one -- still reads, and the red still says how far
        // the voice runs. (A solid red bar on top used to hide the next line.)
        voices += timelineBlock(l, `tl-voice${over ? " tl-over" : ""}`, l.start,
                                over ? l.end : voiceEnd, l.text, true);
        if (over) {
          const tip = `Line ${l.line} runs ${over.toFixed(1)}s past its time`;
          voices += `<span class="tl-spill" style="left:${(l.end * timelinePps).toFixed(1)}px;`
            + `width:${((voiceEnd - l.end) * timelinePps).toFixed(1)}px" title="${escapeHtml(tip)}"></span>`;
        }
      }
      originals += timelineBlock(l, "tl-org", l.start, l.end, l.source || "");
    }

    // The subtitle lane: when each line's words are on screen. The user drags
    // a block's ends to keep a subtitle up longer or take it down sooner; the
    // voices above never move.
    let caps = "";
    timelineLines.forEach((l, idx) => {
      const c = subCueOf(l, idx);
      const exdot = getSubStyle().widths[String(idx + 1)] != null
        ? '<span class="tl-exdot" title="Back to the all-lines width">✱</span>' : "";
      caps += `<div class="tl-cap" data-idx="${idx}"
      style="left:${(c.start * timelinePps).toFixed(1)}px;width:${Math.max(8, (c.end - c.start) * timelinePps).toFixed(1)}px"
      title="${escapeHtml(l.text || "")}"><span class="tl-hdl l"></span><span
      class="tl-cap-txt">${escapeHtml(l.text || "")}</span><span class="tl-hdl r"></span>${exdot}</div>`;
    });
    track.innerHTML = `<div class="tl-inner" style="width:${width.toFixed(0)}px">
    <div class="tl-ruler">${ticks}</div>
    <div class="tl-lane">${voices}</div>
    <div class="tl-lane">${originals}</div>
    <div class="tl-lane tl-lane-caps${getSubStyle().enabled ? "" : " off"}">${caps}</div>
    <div class="tl-playhead" id="timelinePlayhead"><i></i></div>
  </div>`;
    track.scrollLeft = timelineAt * timelinePps;
    // A brand new strip knows nothing about where the video is, and a paused
    // video sends no event to tell it. Put the moment back on it straight away.
    paintTimelineAt(getVideo().currentTime || 0);
    paintTimelineZoom();
  }

  function paintTimelineZoom() {
    const lv = $("tlZoomLevel");
    if (!lv) return;
    lv.textContent = "\u00d7" + (Math.round(timelineZoom * 10) / 10 + "").replace(/\.0$/, "");
    $("tlZoomOut").disabled = timelineZoom <= 1;
    $("tlZoomIn").disabled = timelineZoom >= TL_ZOOM_MAX;
  }

  // Zooms around the playhead, the way an editor's timeline does: the moment
  // under the playhead stays put on screen, and the strip stretches or shrinks
  // around it. Off-screen playhead: the middle of the view holds instead.
  function setTimelineZoom(zoom) {
    zoom = Math.min(TL_ZOOM_MAX, Math.max(1, zoom));
    if (zoom === timelineZoom) return;
    const track = $("timelineTrack");
    const t = getVideo().currentTime || 0;
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

  // Everything on the strip that stands for one moment: the playhead, and the
  // bars of the line that moment is inside.
  function paintTimelineAt(t) {
    const head = $("timelinePlayhead");
    if (!head) return;
    const x = t * timelinePps;
    head.style.left = `${x.toFixed(1)}px`;
    for (const blk of $("timeline").querySelectorAll(".tl-voice, .tl-org")) {
      blk.classList.toggle("tl-now", isNowLine(t, blk));
    }
    followPlayhead(x);
  }

  // A strip longer than the window is a strip the playhead walks off the end of.
  // While the video plays, the moment it leaves the part on show, scroll it back
  // into view a third of the way in -- far enough left that the next stretch of
  // script is what fills the strip. Only while it plays: a paused strip belongs to
  // whoever is reading it.
  // Scroll the strip by hand and following stops for three seconds, so a look back
  // at an earlier line is not yanked away mid-read; after that it only steps in
  // again once the playhead has left the visible part for itself.
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
    const box = $("timeline");
    if (!box.firstChild) return;
    // The video's real length only arrives with its metadata; the strip was drawn
    // to the last line's end until then, so draw it again for the true one.
    if (total > 0 && Math.abs(total - timelineDuration) > 0.05) {
      renderTimeline(timelineLines, total);
    }
    $("timelineClock").textContent = clock;
    paintTimelineAt(t);
  }

  // Remember where the viewer scrolled to. The track itself is thrown away and
  // built again on every redraw, so the listener sits on the strip around it --
  // and catches the event on the way down, because scrolling does not bubble.
  $("timeline").addEventListener("scroll", (e) => {
    if (e.target.id === "timelineTrack" && timelinePps) {
      timelineAt = e.target.scrollLeft / timelinePps;
      // Anything that did not come from followPlayhead is the viewer scrolling,
      // and following gets out of the way for a while.
      if (Math.abs(e.target.scrollLeft - followedTo) >= 1) followUntil = Date.now() + FOLLOW_PAUSE_MS;
    }
  }, true);

  // A bar is a way into the video: play the line it stands for. Which video is
  // the row's to say -- the bottom row is the film as it came in, so it plays the
  // original, and the top row is the dub. The tabs move with it, because the
  // player is now showing something other than what they said it was. The switch
  // has to finish before the seek, hence the wait.
  // The head's own button folds the strip away.
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
    if (e.target.closest("#tlZoomFit")) { setTimelineZoom(1); return; }
    const blk = e.target.closest(".tl-blk");
    if (!blk) return;
    const which = blk.classList.contains("tl-org") ? "original" : "dubbed";
    const start = +blk.dataset.start;
    const end = +blk.dataset.end;
    showVideoSource(which)
      .then(() => playRange(getVideo(), start, end))
      .catch(() => {});
  });

  // ---- The keyboard on the finished screen -------------------------------------
  // Space plays from where the playhead stands (and pauses again); Enter plays
  // from the very start; + - 0 zoom the timeline. Only on the finished screen,
  // and never while the user is typing or pressing an actual control -- a space
  // in the middle of a sentence must stay a space (user, 2026-09-01).
  // Attached by attach(), not here: nothing about importing this file may
  // put a listener on the document.
  function onDoneKeydown(e) {
    if (document.body.dataset.screen !== "done") return;
    if (e.isComposing) return;
    if (e.target.closest("input, textarea, select, button, a, [contenteditable]")) return;
    if (document.querySelector(".modal-overlay.open")) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === " ") {
      e.preventDefault();   // space scrolls the page otherwise
      toggleDonePlay();
    } else if (e.key === "Enter") {
      cancelRange(getVideo());
      getVideo().currentTime = 0;
      getVideo().play().catch(() => {});
    } else if (e.key === "+" || e.key === "=") {
      setTimelineZoom(timelineZoom * TL_ZOOM_STEP);
    } else if (e.key === "-") {
      setTimelineZoom(timelineZoom / TL_ZOOM_STEP);
    } else if (e.key === "0") {
      setTimelineZoom(1);
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
      tip.textContent = cue.start.toFixed(1) + "s – " + cue.end.toFixed(1) + "s";
    };
    const up = () => {
      hdl.removeEventListener("pointermove", move);
      hdl.removeEventListener("pointerup", up);
      hdl.removeEventListener("pointercancel", up);
      blk.classList.remove("trimming");
      tip.remove();
      getSubStyle().cues[String(idx + 1)] = { start: Math.round(cue.start * 10) / 10,
                                              end: Math.round(cue.end * 10) / 10 };
      saveSubStyle(); updateSubtitleNow();
    };
    hdl.addEventListener("pointermove", move);
    hdl.addEventListener("pointerup", up);
    hdl.addEventListener("pointercancel", up);
    hdl.setPointerCapture(e.pointerId);
  });

  // ---- The playhead as a control ----------------------------------------------
  // Drag the head, or press anywhere on the ruler, and the video goes there. The
  // moment is read off the strip's own scale, so it lands where the pointer is
  // however far the track has been scrolled.
  function timelineTimeAt(clientX) {
    const inner = $("timeline").querySelector(".tl-inner");
    if (!inner || !timelinePps) return null;
    const x = clientX - inner.getBoundingClientRect().left;
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

  $("timeline").addEventListener("pointerdown", (e) => {
    const onHead = e.target.closest(".tl-playhead");
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

  // ---------------- The three drag handles ----------------
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
      // At most 40% of the window, and never so tall that the top bar (44), the
      // video tabs (40), the smallest video pane (180) and a readable table
      // (240) cannot share what is left -- about 480px above it.
      limits: () => [110, Math.max(110, Math.min(window.innerHeight * 0.4, window.innerHeight - 480))],
      apply: (h) => { $("timeline").style.height = `${h}px`; },
    }),
    makeGrip({
      el: $("gripPanes"), axis: "y", key: "persodub.layout.videoHeight", before: true,
      read: () => $("videoPane").offsetHeight,
      // The table is the point of the screen, so it keeps the room: the video
      // only grows while 240px is left for the script under it.
      limits: () => {
        const room = $("doneMain").offsetHeight;
        return room ? [180, Math.max(180, room - 240)] : null;
      },
      apply: (h) => { $("videoPane").style.flex = `0 0 ${h}px`; },
    }),
    makeGrip({
      el: $("gripAgent"), axis: "x", key: "persodub.layout.agentWidth",
      read: () => $("agentStrip").offsetWidth,
      // Never so wide the work beside it stops being usable.
      limits: () => [260, Math.max(260, Math.min(560, window.innerWidth - 560))],
      apply: (w) => { $("agentStrip").style.width = `${w}px`; },
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

  // Everything that listens outside the strip: the finished screen's keyboard,
  // the observer that re-measures the track, and the window resize that puts the
  // remembered pane sizes back inside a window that changed size. The page calls
  // this once, in the order the listeners were attached when this lived inline.
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
  }

  // What the page reaches in for. The lines are handed back by reference, the
  // way the page held them itself: the subtitle overlay walks them to find the
  // line the video is inside.
  function getLines() { return timelineLines; }
  // The lines have not changed but how they are drawn has -- a style loaded, the
  // eye pressed. Same lines, same length, drawn again.
  function redraw() { renderTimeline(timelineLines, timelineDuration); }
  // A new job starts at its own beginning rather than where the last one was
  // scrolled to.
  function resetScroll() { timelineAt = 0; }

  return { renderTimeline, redraw, drawTimelineTrack, paintTimeline, getLines,
           resetScroll, fitLayout, attach };
}
