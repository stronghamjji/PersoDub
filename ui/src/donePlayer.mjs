// The finished screen's player: the dubbed video (or the original, by its
// tab), the big play button and the small one under the picture, the clock,
// the script row and timeline bars the video is on, and the pane's size. The
// running dub's player and the Erase tab's are ui/src/playerFoot.mjs's rows;
// this one is tied to the script and the timeline, so it is a file of its own.
// Lifted out of the page's script unchanged (2026-10-10).
//
// The elements this file touches: #doneVideo, #bigPlay, #playToggle,
// #videoTime, #fullscreenBtn, #videoWrap, #videoPane and its .vtab buttons,
// #vtabDubbed, #doneMain, and the rows in #scriptBox.
import { resultUrl } from "./dubApi.mjs";
import { fmtClockTenths } from "./format.mjs";
import { lucide } from "./icons.mjs";
import { cancelRange } from "./playRange.mjs";
import { t } from "./i18n.mjs";

/**
 * @param {object} deps
 * @param {(id: string) => any} deps.$   the page's getElementById helper
 * @param {{job: object|null, jobId: string|null}} deps.state  the page's app
 *        state: which job is open, read when the player needs it
 * @param {any} deps.doneVideo  the finished screen's <video>
 * @param {{paintTimeline: (t: number, total: number, clock: string) => void}} deps.timeline
 *        where the timeline is told the moment. The page wires the timeline
 *        after this, so it is reached only when called.
 * @returns {{ openJob: (jobId: string) => boolean,
 *   doneVideoSrc: (job: object, which: string) => string,
 *   getDoneSource: () => string, getDoneVersion: () => number, getDoneClock: () => string,
 *   toggleDonePlay: () => void, sizeVideoPane: () => void,
 *   isNowLine: (t: number, el: any) => boolean, paintPlayhead: () => void,
 *   showVideoSource: (which: string) => Promise<void>,
 *   releaseDoneVideo: () => void, reloadDoneVideo: () => void }}
 */
export function initDonePlayer({ $, state, doneVideo, timeline }) {
  // Which of the two files the player is showing. The tabs swap it in place.
  let doneSource = "dubbed";
  // Bumped when a remade line changes the finished video under the player, so the
  // next src is a different string and the browser fetches it again. The URL is
  // otherwise stable, which is what lets renderDone tell "same video" from "new".
  // Counted per job -- job B must not inherit job A's marks.
  let doneVersion = 0;
  let doneJobId = null;

  function doneVideoSrc(job, which) {
    const mark = doneVersion ? `?v=${doneVersion}` : "";
    return which === "original"
      ? `/api/dub/result/${job.id}/original${mark}`
      : `${resultUrl(job.id)}${mark}`;
  }

  // A different job starts its own count of remade-line changes: the URL of a
  // video nobody has remade carries no mark at all. Answers whether `jobId` is
  // another job than the one the player was showing; if it is, the rest of the
  // previous job's transient state goes too, which nothing else clears: which
  // of the two files the player was showing, and any "stop at the end of this
  // line" listener still armed on the player from a line never played out.
  function openJob(jobId) {
    if (doneJobId === jobId) return false;
    doneJobId = jobId;
    doneVersion = 0;
    cancelRange(doneVideo);
    doneSource = "dubbed";
    paintVideoTabs();
    return true;
  }

  // The frame is the whole transport: there are no player controls, so the big
  // round button and the picture itself both start and stop it.
  function toggleDonePlay() {
    if (!doneVideo.paused) { doneVideo.pause(); return; }
    // Playing on from here means the line's stopping point no longer applies.
    cancelRange(doneVideo);
    doneVideo.play().catch(() => {});
  }
  $("bigPlay").addEventListener("click", toggleDonePlay);
  $("playToggle").addEventListener("click", toggleDonePlay);
  doneVideo.addEventListener("click", toggleDonePlay);

  // The small button under the picture says what pressing it will do, so it is
  // the pause sign while the video plays and the play sign the rest of the time.
  // Drawn, like every other mark in the app.
  // A triangle has two centres and they are 1.75 units apart in a box this size: the middle of its box (6.75) and the middle of its weight (8.5). Neither alone looks right -- box-centred it leans left, weight-centred it leans right -- so it is drawn halfway between them, which is where it always was. What was wrong was the margin-left beside it, worth another 3.2 units at this size and pushing it well past both (user, 2026-09-11).
  const SMALL_PLAY = lucide("play", 12.8, true);
  const SMALL_PAUSE = lucide("pause", 12.8, true);
  function paintPlayToggle() {
    const btn = $("playToggle");
    const playing = !doneVideo.paused && !doneVideo.ended;
    btn.innerHTML = playing ? SMALL_PAUSE : SMALL_PLAY;
    btn.classList.toggle("playing", playing);
    btn.setAttribute("aria-label", playing ? t("Pause") : t("Play"));
    btn.title = playing ? t("Pause") : t("Play");
    // Nothing to play until there is a video.
    btn.disabled = !doneVideo.getAttribute("src");
  }
  paintPlayToggle();
  doneVideo.addEventListener("loadstart", paintPlayToggle);

  // The big button is the "it is stopped" sign as much as it is the control, so it
  // comes back the moment the video stops, however it stopped -- and the small one
  // changes face at the same moment.
  for (const e of ["play", "playing"]) doneVideo.addEventListener(e, () => { $("bigPlay").hidden = true; paintPlayToggle(); });
  for (const e of ["pause", "ended", "emptied"]) doneVideo.addEventListener(e, () => { $("bigPlay").hidden = false; paintPlayToggle(); });
  for (const e of ["timeupdate", "loadedmetadata", "seeked", "emptied"]) doneVideo.addEventListener(e, paintPlayhead);
  // The left and center panels share the row the way the mockup does (866 : 861,
  // in the stylesheet) until the grip between them is dragged; a dragged width
  // is remembered and timeline.fitLayout() puts it back. The clip's own shape
  // used to set the width (layout G); the new-layout frame gives both panels
  // the same share instead (user, 2026-09-29).
  // Below 820px there is not enough room for both (the video's floor is 320),
  // so the pane goes back to being a band above the table and is sized by its
  // height again -- taller for a portrait clip (user, 2026-09-02).
  function sizeVideoPane() {
    const pane = $("videoPane"), main = $("doneMain");
    const room = main.clientWidth;
    if (!room) return;   // the screen is not on show, so there is nothing to measure
    const stacked = room < 820;
    main.classList.toggle("stacked", stacked);
    pane.classList.toggle("portrait", doneVideo.videoHeight > doneVideo.videoWidth);
  }
  doneVideo.addEventListener("loadedmetadata", sizeVideoPane);
  // Full screen is the picture with its subtitles, not the bare video element:
  // the overlay is drawn over the video, and it has to come along.
  $("fullscreenBtn").addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else $("videoWrap").requestFullscreen().catch(() => {});
  });
  // The row itself, not the window: opening or closing the Dub Agent column and
  // dragging the projects list both change how much room the two panes have with
  // the window standing still. Writing the video pane's width does not change
  // this box's, so there is no loop to fall into.
  new ResizeObserver(sizeVideoPane).observe($("doneMain"));

  // Is the video inside this line right now? The table's highlighted row and the
  // timeline's highlighted bars are the same answer, so they ask it the same way.
  function isNowLine(t, el) {
    return t > +el.dataset.start && t <= +el.dataset.end;
  }

  // The clock as it was last painted, kept so a part of the screen drawn between
  // two of the video's signals can start out saying the same thing as the rest.
  let doneClock = `${fmtClockTenths(0)} / ${fmtClockTenths(0)}`;

  // Where the video is, everywhere that shows it: the clock under the player, the
  // row the table highlights, and (through paintTimeline) the timeline's clock,
  // playhead and bars. The video's own listeners are the only thing that knows
  // the moment changed, so this is the one place that reads currentTime.
  function paintPlayhead() {
    const t = doneVideo.currentTime || 0;
    const total = Number.isFinite(doneVideo.duration) ? doneVideo.duration : 0;
    const clock = `${fmtClockTenths(t)} / ${fmtClockTenths(total)}`;
    doneClock = clock;
    $("videoTime").textContent = clock;
    for (const row of $("scriptBox").querySelectorAll(".sc-row[data-start]")) {
      row.classList.toggle("sc-now", isNowLine(t, row));
    }
    // On the Erase tab the timeline follows that tab's own video instead.
    if (document.body.dataset.screen !== "erase") timeline.paintTimeline(t, total, clock);
  }

  // Original / Dubbed. The same moment in the same video, so the position and
  // whether it was playing both survive the swap. Only this pane's tabs: the
  // erase screen has a pair of its own, wired by its own module.
  for (const tab of document.querySelectorAll("#videoPane .vtab")) {
    tab.addEventListener("click", () => showVideoSource(tab.dataset.src));
  }

  // A video with the user's own subtitles (kind "captions") is one file:
  // only the Original tab, lit, and the subtitles stay over it (the player
  // keeps the "dubbed" source, the one they are drawn over).
  const ownSubtitles = () => !!state.job && state.job.id === state.jobId && state.job.kind === "captions";

  // Which of the two tabs is lit. Three places change doneSource, and every one
  // of them has to say so on screen.
  function paintVideoTabs() {
    const one = ownSubtitles();
    for (const tab of document.querySelectorAll("#videoPane .vtab")) {
      tab.classList.toggle("active", tab.dataset.src === (one ? "original" : doneSource));
    }
    $("vtabDubbed").hidden = one;
    // Before dubbing there is nothing behind the Dubbing tab: pressed, it did
    // nothing at all and said nothing. Off until there is a dubbed video, with
    // the same words the Captions tab uses (2026-09-30).
    const noDub = !state.jobId;
    $("vtabDubbed").disabled = noDub;
    $("vtabDubbed").title = noDub ? t("After dubbing") : "";
  }

  // Answers when the player is actually showing that file, so a caller that wants
  // to seek straight afterwards can wait: the browser has opened nothing yet the
  // moment the src is set, and a seek into a file that is not there lands nowhere.
  // Already on that source, there is nothing to wait for.
  function showVideoSource(which) {
    if (ownSubtitles()) which = "dubbed";
    if (!state.job || which === doneSource) return Promise.resolve();
    const at = doneVideo.currentTime;
    const wasPlaying = !doneVideo.paused;
    // The range being played belongs to the file that is leaving.
    cancelRange(doneVideo);
    doneSource = which;
    paintVideoTabs();
    doneVideo.setAttribute("src", doneVideoSrc(state.job, which));
    return new Promise((resolve) => {
      doneVideo.addEventListener("loadeddata", () => {
        doneVideo.currentTime = at;
        if (wasPlaying) doneVideo.play().catch(() => {});
        resolve();
      }, { once: true });
    });
  }

  // Put the player back to nothing at all: the next job's video has to start from
  // its own first frame, not the last one of the job before it.
  function releaseDoneVideo() {
    cancelRange(doneVideo);
    doneSource = "dubbed";
    doneJobId = null;
    doneVersion = 0;
    paintVideoTabs();
    doneVideo.removeAttribute("src");
    doneVideo.load();
  }

  // The finished video changed under the player (a line was made again), so it
  // has to be fetched afresh -- from the same moment the viewer was watching. The
  // version mark is what makes the browser go back for it.
  function reloadDoneVideo() {
    const at = doneVideo.currentTime;
    doneVersion += 1;
    if (state.job) doneVideo.setAttribute("src", doneVideoSrc(state.job, doneSource));
    doneVideo.load();
    doneVideo.addEventListener("loadeddata", () => { doneVideo.currentTime = at; }, { once: true });
  }

  return {
    openJob, doneVideoSrc, toggleDonePlay, sizeVideoPane, isNowLine, paintPlayhead, showVideoSource,
    releaseDoneVideo, reloadDoneVideo,
    // Read by the subtitles (only the dubbed file has them), the Export dialog
    // (the remake mark) and the timeline (the clock it starts out showing).
    getDoneSource: () => doneSource,
    getDoneVersion: () => doneVersion,
    getDoneClock: () => doneClock,
  };
}
