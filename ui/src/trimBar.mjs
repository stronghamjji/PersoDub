// The trim bar: a play button, a readout, a bar with a handle at each end and a
// ruler under it -- the one control that says which part of a video the app is
// to work on. Two screens ask that question, so one implementation answers it:
// the New project dialog (which part to dub, or to save as a clip) and the
// Erase subtitles screen (which part to clean). Before this file the second had
// no answer at all and erased whole videos the user had already cut down.
//
// It draws itself into a box the page provides and reads nothing else off the
// page: the video it scrubs, the clock it writes the position into, and what to
// do when the range changes all come in as parameters. Two bars can therefore
// live on one page -- `prefix` is what keeps their ids apart.
//
// What is NOT here: playRange/cancelRange, which belong to the page (the
// finished screen plays its lines with the same pair).
import { fmtClock, fmtClockTenths } from "./format.mjs";

// The shortest part worth working on; also what keeps the two handles from
// crossing over each other.
export const TRIM_MIN_SPAN = 0.5;
// What one nudge of a handle is worth -- the sliders' step, in seconds.
export const TRIM_STEP = 0.1;
// How far apart the ruler's ticks are, and the coarsest they may ever be read
// in: squeezed, they thin out to 10s, 15s, 20s rather than to 6s or 7s.
export const TRIM_TICK_SEC = 5;

/**
 * Wire a trim bar into a page.
 *
 * @param {object} deps
 * @param {(id: string) => any} deps.$  the page's getElementById helper
 * @param {string} [deps.prefix]  put in front of every id inside the bar, so a
 *        second bar on the same page does not answer to the first one's ids.
 *        "" (the New project dialog's) leaves them exactly as they were.
 * @param {() => any} deps.getVideo  the player this bar scrubs -- read late,
 *        because the page may not have it when the bar is wired
 * @param {() => any} [deps.getClock]  the element that says where the playhead
 *        is (the dialog's badge on the thumbnail), or null for a bar with none
 * @param {(video, start, end) => Promise} deps.playRange  play only [start, end]
 * @param {(video) => void} deps.cancelRange  stop that
 * @param {() => number} deps.labelPx  how much room a clock label needs on a
 *        ruler, so the ticks can be thinned until it has it
 * @param {(trim: {start, end} | null) => void} [deps.onChange]  the part the
 *        handles have chosen; null when they are parked at both ends
 * @returns render / clear / release.
 */
export function initTrimBar({ $, prefix = "", getVideo, getClock = null,
                              playRange, cancelRange, labelPx,
                              onChange = () => {} }) {
  // "trimStart" for the dialog's own bar, "eraseTrimStart" for a second one.
  const id = (name) => (prefix ? prefix + name[0].toUpperCase() + name.slice(1) : name);
  const sayClock = (text) => { const el = getClock && getClock(); if (el) el.textContent = text; };
  // The one listener the bar leaves on the video, and the video it is on, kept
  // so it can be taken off again -- otherwise it keeps toggling a class on a
  // button that has left the page.
  let playState = null;
  let playOn = null;

  /**
   * Draws the trim box: play button, readout, and a bar with a handle at each
   * end. Called once a local file's length is known (a link has none to scrub).
   * `start` -- a part chosen elsewhere, {start, end} -- opens the handles on
   * that part instead of on the whole video.
   */
  function render(duration, start = null) {
    const box = $(id("trimBox"));
    // No usable length (metadata still loading, or a stream): draw nothing
    // rather than a bar that lies. The loadedmetadata handler calls back.
    if (!Number.isFinite(duration) || duration < 1) { box.innerHTML = ""; return; }

    // Every line below the first is HTML the browser receives, so its
    // indentation is output, not layout: it is deliberately NOT stepped in with
    // the rest of this file, and reads byte for byte as it did when this lived
    // inline in static/index.html (pinned by newProject.test.mjs).
    box.innerHTML = `
    <div class="trim-row">
      <button class="trim-play" id="${id("trimPlay")}" type="button" title="Play the selected part" aria-label="Play the selected part">
        <svg class="ico-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 5.5v13l10.5-6.5z"/></svg>
        <svg class="ico-pause" viewBox="0 0 18 18" aria-hidden="true"><rect x="5" y="3" width="3" height="12" rx="1"/><rect x="10" y="3" width="3" height="12" rx="1"/></svg>
      </button>
      <span class="trim-label">Trim</span>
      <span class="trim-read" id="${id("trimRead")}"></span>
    </div>
    <div class="trim-scale" id="${id("trimScale")}">
      <div class="trim-bar">
        <div class="trim-hatch" id="${id("trimHatchStart")}" style="left: 0"></div>
        <div class="trim-hatch" id="${id("trimHatchEnd")}" style="right: 0"></div>
        <div class="trim-sel" id="${id("trimSel")}"></div>
        <input type="range" class="trim-range" id="${id("trimStart")}" min="0" step="${TRIM_STEP}" aria-label="Trim start">
        <input type="range" class="trim-range" id="${id("trimEnd")}" min="0" step="${TRIM_STEP}" aria-label="Trim end">
        <div class="trim-head" id="${id("trimHead")}" hidden><i></i></div>
      </div>
      <div class="trim-ruler" id="${id("trimRuler")}"></div>
    </div>`;

    const startInput = $(id("trimStart")), endInput = $(id("trimEnd"));
    startInput.max = endInput.max = String(duration);
    // The whole video, or the part that came in with it -- kept inside the
    // video either way, and never so short that the two handles cross.
    const from = start ? Math.min(Math.max(start.start, 0), duration - TRIM_MIN_SPAN) : 0;
    const to = start ? Math.min(Math.max(start.end, from + TRIM_MIN_SPAN), duration) : duration;
    startInput.value = String(from);
    endInput.value = String(to);

    // Where a slider's thumb centre sits: half a thumb in from each edge, which
    // is exactly how the browser lays a range out. The painted layers use the
    // same formula so bar and handles never drift apart.
    const at = (sec) => `calc(5px + (100% - 10px) * ${sec / duration})`;

    // The ruler under the bar, ticked on that same mapping. Every 5 seconds
    // where they fit; where they do not, the timeline's rule -- a label needs
    // labelPx of room, so thin the ticks until it has it -- rounded up to
    // whole fives. Settled once, from the width the bar has now.
    const room = Math.max(1, $(id("trimScale")).clientWidth - 10);
    const every = TRIM_TICK_SEC *
      Math.max(1, Math.ceil((labelPx() * duration) / (room * TRIM_TICK_SEC)));
    let ticks = "";
    for (let s = 0; s <= Math.floor(duration); s += every) {
      // The label hangs to the RIGHT of its tick, so the last one would run off
      // the end and be cut in half. A tick with no room keeps the line and
      // drops the label.
      const label = 5 + room * (s / duration) + labelPx() <= room + 10
        ? `<span>${fmtClock(s)}</span>` : "";
      ticks += `<div class="trim-tick" style="left:${at(s)}">${label}</div>`;
    }
    $(id("trimRuler")).innerHTML = ticks;

    function paint() {
      const start = Number(startInput.value), end = Number(endInput.value);
      $(id("trimHatchStart")).style.width = at(start);
      $(id("trimHatchEnd")).style.left = at(end);
      $(id("trimSel")).style.left = at(start);
      $(id("trimSel")).style.width = `calc((100% - 10px) * ${(end - start) / duration})`;
      // Both handles parked at the ends is not a trim -- send no range at all,
      // so the server keeps the file exactly as uploaded. Within one step of the
      // end counts as the end: a slider snaps to its 0.1 s grid, so a length like
      // 22.08s can only ever be dragged back to 22.0.
      const whole = start <= 0 && end >= duration - TRIM_STEP;
      // Which is also why the readout counts a full range against the real
      // length: otherwise an untrimmed 22.085s video reads "22.0s of 22.1s", as
      // if a tenth had been shaved off it.
      const shownEnd = whole ? duration : end;
      $(id("trimRead")).textContent =
        `${fmtClockTenths(start)} – ${fmtClockTenths(shownEnd)} · ${(shownEnd - start).toFixed(1)}s of ${duration.toFixed(1)}s`;
      onChange(whole ? null : { start, end });
      // A handle dragged past the playhead leaves it outside the part being
      // dubbed, where it means nothing: put it away.
      if (headAt !== null && (headAt < start || headAt > end)) {
        headAt = null;
        $(id("trimHead")).hidden = true;
      }
    }

    startInput.addEventListener("input", () => {
      startInput.value = String(Math.min(Number(startInput.value), Number(endInput.value) - TRIM_MIN_SPAN));
      paint();
    });
    endInput.addEventListener("input", () => {
      endInput.value = String(Math.max(Number(endInput.value), Number(startInput.value) + TRIM_MIN_SPAN));
      paint();
    });

    const video = getVideo(), playBtn = $(id("trimPlay"));
    // Where the playhead stands when nothing is playing: null means "nowhere",
    // and the line is not drawn at all. Set by a drag, a click on the selection,
    // or by playback stopping partway.
    let headAt = null;
    // The reverse of at(): a pointer's x turned back into a second of the video,
    // never outside the part that is actually going to be dubbed.
    const secAt = (clientX) => {
      const box = $(id("trimSel")).parentElement.getBoundingClientRect();
      const sec = ((clientX - box.left - 5) / Math.max(1, box.width - 10)) * duration;
      return Math.min(Math.max(sec, Number(startInput.value)), Number(endInput.value));
    };
    const head = $(id("trimHead"));
    // Moving the playhead moves the preview with it: the video seeks, the line
    // follows the pointer and the badge counts along.
    function seekTo(sec) {
      headAt = sec;
      video.currentTime = sec;
      head.style.left = at(sec);
      head.hidden = false;
      sayClock(fmtClockTenths(sec));
    }

    // Dragging the head. The video is stopped for the duration of the drag so
    // playRange's stop-listener cannot fire on a seek, and started again on drop
    // if it had been playing -- from where it was dropped, still stopping at the
    // end of the selection.
    let wasPlaying = false;
    head.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      head.setPointerCapture(e.pointerId);
      wasPlaying = !video.paused;
      if (wasPlaying) cancelRange(video);
      seekTo(secAt(e.clientX));
    });
    head.addEventListener("pointermove", (e) => {
      if (head.hasPointerCapture(e.pointerId)) seekTo(secAt(e.clientX));
    });
    head.addEventListener("pointerup", (e) => {
      if (!head.hasPointerCapture(e.pointerId)) return;
      head.releasePointerCapture(e.pointerId);
      if (wasPlaying) playRange(video, headAt, Number(endInput.value)).catch(() => {});
      wasPlaying = false;
    });
    // A click anywhere on the chosen part puts the playhead there too. The
    // handles sit on top of their own ends, so they still grab first.
    $(id("trimSel")).addEventListener("pointerdown", (e) => { seekTo(secAt(e.clientX)); });

    // The thumbnail is muted so it can sit quietly; a press on the play
    // button is the user asking to hear the part they picked, so unmute then.
    // A second press pauses -- the same button, the same place.
    playBtn.addEventListener("click", () => {
      if (!video.paused) { cancelRange(video); return; }
      video.muted = false;
      // Play from where the playhead was left standing, not from the start.
      const from = headAt === null ? Number(startInput.value) : headAt;
      playRange(video, from, Number(endInput.value)).catch(() => {});
    });
    release();
    playOn = video;
    // One handler for play / pause / ended / timeupdate: the button's look, the
    // badge on the thumbnail (the running clock while it plays, the length
    // when it stops) and the playhead line walking the bar.
    playState = () => {
      const playing = !video.paused && !video.ended;
      playBtn.classList.toggle("playing", playing);
      const label = playing ? "Pause" : "Play the selected part";
      playBtn.title = label; playBtn.setAttribute("aria-label", label);
      if (playing) {
        headAt = video.currentTime;
        sayClock(fmtClockTenths(headAt));
        head.style.left = at(headAt);
        head.hidden = false;
      } else if (headAt !== null && headAt < Number(endInput.value) - TRIM_STEP) {
        // Stopped partway -- by the pause button or by a drag. The line stays
        // where it stopped, and the next press picks up from there.
        sayClock(fmtClockTenths(headAt));
        head.style.left = at(headAt);
        head.hidden = false;
      } else {
        // Played to the end of the selection: back to a bare bar and the length.
        headAt = null;
        sayClock(fmtClock(duration));
        head.hidden = true;
      }
    };
    for (const e of ["play", "pause", "ended", "timeupdate"]) video.addEventListener(e, playState);

    paint();
  }

  /** Nothing to trim (no usable length, or the video has gone): draw nothing. */
  function clear() { release(); $(id("trimBox")).innerHTML = ""; }

  /** The video is going away: take the bar's listener off it. */
  function release() {
    if (!playState) return;
    for (const e of ["play", "pause", "ended", "timeupdate"]) playOn.removeEventListener(e, playState);
    playState = null;
    playOn = null;
  }

  return { render, clear, release };
}
