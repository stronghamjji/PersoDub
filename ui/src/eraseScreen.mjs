// Erase subtitles, inside the work screen: the left panel's Erase tab asks
// which video, then which area; the box is dragged on the video in the center
// panel. Which part is erased is what the timeline's cuts kept: the video here
// is the draft (ui/src/draft.mjs), the same one the Dubbing tab starts from,
// so a video cut first can be erased and dubbed after without coming in
// twice. The timeline itself is ui/src/timeline.mjs's, handed what to draw
// through showTimeline. The tab opens it, and so do the first screen's Erase
// subtitles card, a row in the Projects list, and the New project dialog's
// "Erase subtitles" button, which hands over the video the app is already
// holding rather than a second copy of it.
//
// What is NOT here: the geometry and every word with a number in it live in
// ui/src/eraseArea.mjs, and every request this screen makes is one of the erase
// helpers in ui/src/dubApi.mjs. This file is the wiring in between -- which
// face is up, what each button does, and the dragging of the box itself.
//
// Everything this file touches is #tabErase, #erasePane, the draft and the top
// bar, through setTopbar.
import { uploadDownload, downloadVideoUrl, suggestEraseArea, startErase,
         fetchErase, retryErase, cancelDubJob, eraseVideoUrl, saveErased,
         startDownload, fetchDownload, eraseToDub } from "./dubApi.mjs";
import { clampArea, defaultArea, dragArea, toScreen, videoPerScreen, isWhole,
         estimateSeconds, estimateLabel, progressLine, isPackMissing, noGpuNote, bigBoxNote, AREA_TIPS,
         packNeededLine, eraseView, workLength, trimNote, partRange, rangeLine, cropView } from "./eraseArea.mjs";
import { getDraft, setDraft, setRanges, onDraftChange,
         isWhole as keptWhole } from "./draft.mjs";
import { sourceToKept } from "./cutTools.mjs";
import { downloadsLabel, errorText, plainFailure, rawLogLines, fmtLength, fmtClockTenths, escapeHtml,
         videoCardHtml } from "./format.mjs";
import { emptyTabHtml, wireImportBlock, wireImportInput } from "./importBlock.mjs";
import { t } from "./i18n.mjs";
import { record as recordStep } from "./events.mjs";

// How often the erase is asked how far along it is. The same second the dub's
// queue card uses: the percentage moves in visible steps and the answer is small.
const POLL_MS = 1000;
// The pack that does the erasing, and the row in the catalog its size is read
// from (GET /api/models already answers with this platform's number).
export const PACK_ID = "subtitle-eraser";

/**
 * Wire the Erase subtitles screen to a page.
 *
 * @param {object} deps
 * @param {(id: string) => any} deps.$  the page's getElementById helper
 * @param {(name: string) => void} deps.showScreen  the page's one way to swap screens
 * @param {() => string} deps.getScreen  the screen that is up right now
 * @param {(opts: object) => void} deps.setTopbar   the page's one top bar
 * @param {(file: File) => string|null} deps.checkFile  the home screen's own
 *        "is this a video we can take?" -- one rule for both ways in
 * @param {(id: string) => Promise<boolean>} deps.installPack  the models
 *        controller's pack install, progress dialog and top-bar chip included
 * @param {(id: string) => object|null} deps.packRow  one catalog row, read
 *        for the pack's size on this computer
 * @param {() => void} deps.onJobsChanged  the Projects list has a new row
 * @param {(source: object) => void} deps.onDub  open a new project on the
 *        erased video, on its Dubbing tab
 * @param {(path: string) => void} deps.reveal  show a saved file in the
 *        computer's own file window, or null outside the desktop app
 * @param {() => Promise<string>} [deps.pickedFolder]  the folder the Download
 *        dialog's Change picked, "" for Downloads, so the saved line names it
 * @param {(info: object) => void} deps.showTimeline  what the timeline draws
 *        while this screen is up (ui/src/timeline.mjs showErase)
 * @param {() => boolean} [deps.projectOpen]  a dubbing project is open on the
 *        page, so this screen is its Erase tab
 * @param {(downloadId: string) => void} [deps.onEraseStarted]  an erase was
 *        started on this held video: its job is the video's card from now on
 * @returns the operations the rest of the page calls.
 */
export function initEraseScreenUi({ $, showScreen, getScreen, setTopbar, checkFile,
                                    installPack, packRow, onPackProgress, onJobsChanged,
                                    onDub, reveal, showTimeline, projectOpen = () => false,
                                    onEraseStarted = () => {}, pickedFolder = async () => "",
                                    record = recordStep }) {
  // The erases started here, whose end is a step in the charts (events.mjs):
  // one opened from Projects that ended long ago is not.
  const startedHere = new Set();
  const ended = (jid, status) => {
    if (startedHere.delete(jid)) record("tool_finished", { tool: "erase", outcome: status === "done" || status === "cancelled" ? status : "failed" });
  };
  // No video yet: the shared Import block (ui/src/importBlock.mjs), wired at
  // the end of this function.
  $("eraseImportSlot").outerHTML = emptyTabHtml("erase", "eraseZone", "eraseLink");
  // The video being worked on: the id the app holds it under, what to call it,
  // how long it is (the estimate is made from that length) and the parts the
  // timeline kept of it ([[start, end], ...], or null for all of it).
  let source = null;
  // The box, in the frame's own pixels, and the frame's size.
  let area = null;
  let frame = { w: 0, h: 0 };
  // The erase itself: {id, status, percent, done, error} as the app last said.
  let job = null;
  let timer = null;
  // The eraser is not part of the base install; until a request says otherwise
  // the screen assumes it is there.
  let packMissing = false;
  let installing = false;
  // Whether the app is still looking for the subtitles.
  let finding = false;
  // Whether a hand has placed the box. The suggestion, when it lands, moves
  // the box the screen opened with -- but never one the user already set.
  let touched = false;
  // The box the app itself put there, which is what Reset goes back to.
  let offered = null;
  // Which video the <video> is playing, so a repaint does not reload it.
  let playing = "";
  // Which of the two tabs is up once there is a result. Erased: it is the video
  // the user came here for, and Original is the one to check it against.
  let tab = "erased";
  // Where Export wrote the video, once it has. "" until then, which is what
  // keeps the "Saved to Downloads" line from claiming anything too early.
  let savedPath = "";

  // The part to erase is whatever the timeline's cuts kept of the draft. Read
  // off it whenever it changes -- but only before an erase: a running or
  // finished one keeps the parts it was started with.
  function takeDraftParts() {
    const d = getDraft();
    if (!source || job || !d || d.downloadId !== source.downloadId) return;
    source.duration = d.duration || source.duration;
    source.ranges = keptWhole(d) ? null : d.ranges.map(([a, b]) => [a, b]);
  }
  onDraftChange(() => {
    if (!source || job) return;
    takeDraftParts();
    paint();
  });

  // This computer's own speed. Windows machines here have a GPU doing the
  // work; a Mac does it on its own chip and takes longer per second of video.
  const onWindows = /^win/i.test(navigator.platform || "")
    || /Windows/.test(navigator.userAgent || "");
  // Which build this kit installed: "win-cpu" is a Windows machine with no
  // NVIDIA card, where the same erase takes about five times as long
  // (measured 2026-09-10). Asked once, and a failure leaves it unknown --
  // no warning is better than a wrong one.
  let platformKey = "";
  fetch("/api/models").then((r) => r.json()).then((d) => {
    platformKey = d.platform || "";
    paint();
  }).catch(() => {});

  // ---- Painting -------------------------------------------------------------

  function estSeconds() {
    if (!source) return 0;
    // The parts the cuts kept, not the whole file: erasing 10 seconds of a
    // minute takes a sixth of the minutes, and promising the sixty was a lie
    // the user only found out about by waiting.
    return estimateSeconds(workLength(source), {
      whole: !!area && isWhole(area, frame.w, frame.h), windows: onWindows,
      noGpu: platformKey === "win-cpu",
    });
  }

  function setVideo(url) {
    const v = $("eraseVideo");
    if (playing === url) return;
    playing = url;
    v.pause();
    if (url) v.src = url; else { v.removeAttribute("src"); v.load(); }
  }

  /** Draw the box where it stands, in the picture's own place on the screen. */
  function drawBox() {
    const stage = $("eraseStage").getBoundingClientRect();
    if (!area || !frame.w || !frame.h || !stage.width) return;
    const box = toScreen(area, stage, frame.w, frame.h);
    const el = $("eraseBox");
    el.style.left = `${box.left}px`;
    el.style.top = `${box.top}px`;
    el.style.width = `${box.width}px`;
    el.style.height = `${box.height}px`;
  }

  /**
   * The Area card's enlargement (design 5, owner 2026-10-22): the box's own
   * part of the frame at the playhead, the box's edge dotted over it, and the
   * time it shows. Writing that sticks out of the box shows here first.
   */
  function drawCrop() {
    if ($("eraseCrop").hidden || !area) return;
    const v = $("eraseVideo");
    const at = v.currentTime || 0;
    // The clock under the video counts the timeline's kept time; so does this.
    $("eraseCropTime").textContent = t("In the box · {time}",
      { time: fmtClockTenths(source.ranges ? sourceToKept(source.ranges, at) : at) });
    // Out of sight (another tab, the left panel hidden) there is nothing to
    // place: the observer below draws it again once it is back.
    const pic = $("eraseCropPic");
    const w = pic.clientWidth, h = pic.clientHeight;
    if (!w || !h) return;
    const crop = cropView(area, frame.w, frame.h, w / h);
    const edge = $("eraseCropBox").style;
    edge.left = `${crop.box.left * 100}%`;
    edge.top = `${crop.box.top * 100}%`;
    edge.width = `${crop.box.width * 100}%`;
    edge.height = `${crop.box.height * 100}%`;
    // The picture, once the video has a frame to give. Mid-seek it has none
    // and the last one stays up until "seeked" brings the next.
    if (!(v.readyState >= 2) || !pic.getContext) return;
    const scale = window.devicePixelRatio || 1;
    pic.width = Math.round(w * scale);
    pic.height = Math.round(h * scale);
    pic.getContext("2d").drawImage(v, crop.x, crop.y, crop.w, crop.h, 0, 0, pic.width, pic.height);
  }

  /** Everything on screen, from what is known right now. One place, one order. */
  function paint() {
    const view = eraseView({ source, job });
    const done = view === "done";
    const working = view === "working";
    $("eraseDrop").hidden = view !== "drop";
    $("eraseBody").hidden = view === "drop";
    $("eraseRow").hidden = view === "drop";
    $("erasePack").hidden = !packMissing || done;
    // The box stays where it was put while the erase runs, locked: it is the
    // area being erased. A result has nothing left to mark.
    $("eraseBox").hidden = !(view === "area" || working) || !area;
    $("eraseBox").classList.toggle("lock", working);
    // Two states, not three: red and "Finding subtitles…" while the app hunts
    // for the writing, green and "Subtitles" once it has stopped. A third --
    // back to yellow the moment a hand moved the box -- was never asked for
    // and read as the app having lost something (user, 2026-09-11).
    $("eraseBox").classList.toggle("finding", finding);
    $("eraseBox").classList.toggle("found", !finding);
    $("eraseBox").querySelector("b").textContent = t(finding ? "Finding subtitles…" : "Subtitles");

    // The first card names the video and how much of it is kept. The next
    // one is the erase itself: how far along, then that it is done, or why
    // it stopped. Before an erase there is nothing for it to say.
    // An erase opened out of the Projects list has no length on its record:
    // its own video says how long it is once it has loaded.
    const shown = job ? Number($("eraseVideo").duration) || 0 : 0;
    // Before an erase the card also says what it will erase, on one line with
    // the whole of it on the tip; from the start the erase's own card says so.
    const range = view === "area" ? rangeLine(source) : "";
    $("eraseVideoCard").innerHTML = (!source ? ""
      : source.duration ? videoCardHtml({ name: source.title, kept: workLength(source), total: source.duration })
      : videoCardHtml({ name: source.title, kept: shown, total: shown }))
      + (range ? `<div class="s erase-range" title="${escapeHtml(range)}">${escapeHtml(range)}</div>` : "");
    $("erasePartCard").hidden = view === "area";
    const pct = working ? Math.round(job.percent || 0) : 0;
    $("erasePartCard").classList.toggle("ok", done);
    $("erasePartKey").textContent = working ? t("Erasing") : done ? t("Erased") : t("Part to erase");
    $("erasePartRange").textContent = partRange(source);
    $("erasePct").textContent = `${pct}%`;
    $("erasePct").hidden = !working;
    $("eraseBarBox").hidden = !working;
    $("eraseFill").style.width = `${pct}%`;
    $("erasePartNote").textContent = done ? t("Compare in the Original and Erased tabs") : "";
    $("eraseDoneNote").textContent = done
      ? t("Send the erased video to Dubbing to add new subtitles in the dubbing language. The original subtitles are gone now.") : "";
    $("eraseState").classList.toggle("bad", view === "failed");
    if (working) {
      $("eraseState").textContent = job.status === "cancelling"
        ? t("Cancelling…") : progressLine(pct, estSeconds());
    } else if (view === "failed") {
      $("eraseState").textContent = job.status === "cancelled"
        ? t("Erasing was cancelled.")
        : (plainFailure(job.error_shown || job.error) || t("Erasing stopped. Raw log has the details."));
    } else {
      $("eraseState").textContent = "";
    }

    // The second card: the box. A job opened out of the Projects list has
    // none to show; a result names the area it was, and nothing more.
    $("eraseAreaCard").hidden = !area;
    // Before the erase starts: the two things to know about the box.
    $("eraseAreaNote").textContent = done ? "" : working ? t("Locked while erasing")
      : finding ? t("Finding subtitles…") : t(AREA_TIPS[0]);
    $("eraseAreaTip").textContent = t(AREA_TIPS[1]);
    $("eraseAreaTip").hidden = done || working;
    $("eraseResetBtn").hidden = view !== "area";
    // The enlargement is for placing the box, so it goes once the box is locked.
    $("eraseCrop").hidden = view !== "area" || !frame.w || !frame.h;
    $("eraseCropBox").classList.toggle("finding", finding);
    // The minutes hardly follow the box's size, so a box dragged out over half
    // the frame is warned about in words.
    const big = view === "area" ? bigBoxNote(area, frame.w, frame.h) : "";
    $("eraseBigBox").textContent = big;
    $("eraseBigBox").hidden = !big;
    // One line under the cards for the state the screen is in (design 5,
    // owner 2026-10-22). A stopped erase says why in its own card instead.
    // Placing the box, a card in its room says what the erase makes (owner,
    // 2026-10-22), and gives way to a warning -- the eraser to download, no
    // graphics card, a box this big -- as the column at 1280x800 has no room
    // for both.
    const warned = packMissing || !!noGpuNote(platformKey) || !!big;
    $("eraseResult").hidden = view !== "area" || warned;
    const tip = working ? t("Erasing carries on if you go to another screen. The Home card shows the progress.")
      : done ? t("Save it with Download, or carry on with Dubbing.") : "";
    $("eraseTipText").textContent = tip;
    $("eraseTip").hidden = !tip;

    // The foot.
    $("eraseWait").hidden = !working;
    $("eraseCancelBtn").hidden = !working;
    // Back is the way to the box that has to change -- which is only somewhere
    // to go while this screen still has the video that box was drawn on.
    $("eraseBackBtn").hidden = view !== "failed" || !area;
    // Try again and the log are the dub failure card's two, on this screen for
    // the same reasons: Back is nowhere to go when the job came out of the
    // Projects list, and the one sentence is all there was to read.
    $("eraseRetryBtn").hidden = view !== "failed";
    $("eraseLogDetails").hidden = view !== "failed";
    if (view === "failed") $("eraseLogBox").textContent = rawLogLines(job.logs, job.error).join("\n");
    // The way on from a result (mockup edit-flow): how much was erased and
    // Dub this video. Saving is the top bar's Export.
    const erased = done ? workLength(source) : 0;
    $("eraseDoneLabel").textContent = erased ? t("{length} erased", { length: fmtLength(erased) }) : "";
    $("eraseDoneLabel").hidden = !erased;
    $("eraseDubBtn").hidden = !done;
    // Another part of the same video: only while the app still holds it.
    $("eraseAgainBtn").hidden = !done || !source.downloadId;
    $("eraseSaved").hidden = !done || !savedPath;

    // Once there is an erase job the picture is that job's own video: the
    // part it works on while it runs or after it stopped, and whichever tab
    // is up once there is a result. A job picked up out of the Projects list
    // has nothing else to show.
    if (working || view === "failed") setVideo(eraseVideoUrl(job.id, "original"));
    // A finished erase is the thing the user came for, so it is a video they
    // can hear. Everywhere else the picture is a backdrop for the box being
    // drawn on it, where a burst of sound would be in the way (user,
    // 2026-09-11). The player row under it is there all along.
    $("eraseVideo").muted = !done;
    if (done) setVideo(eraseVideoUrl(job.id, tab));
    // Original / Erased. Until there is a result only the first has anything
    // behind it.
    for (const el of $("eraseTabs").querySelectorAll(".vtab")) {
      const which = el.dataset.erase;
      el.classList.toggle("active", which === (done ? tab : "original"));
      el.disabled = !done && which === "erased";
      if (which === "erased") el.title = done ? "" : t("After erasing");
    }
    // The top bar is the whole app's, not this screen's. An erase is followed
    // once a second whether or not the user stayed to watch it, and a tick
    // that ran while they were on the home screen used to put this video's
    // name and its back arrow up there over theirs. Every way back onto this
    // screen paints on arrival, so there is nothing to lose by leaving the
    // bar alone while the screen is away.
    if (getScreen() === "erase") setTopbar({
      // Without ".mp4": the same project is "cats" on every other tab.
      title: source ? ((source.title || "").replace(/\.[A-Za-z0-9]{2,4}$/, "") || t("Erase subtitles")) : t("Erase subtitles"),
      subtitle: done ? t("Erased") : view === "drop" ? "" : trimNote(source),
      back: true,
      estimate: view === "area" ? estimateLabel(estSeconds()) : "",
      erase: view === "area",
      // The top bar's Export saves the erased video; the page hands the press
      // to this screen while it is the screen that is up.
      done,
      // Before an erase it saves the draft's kept parts, and only when that
      // draft is the video on this screen: an empty tab lit it for whatever
      // draft was still held, and saved a video nowhere on screen (Windows, E9).
      exportable: done || exportsDraft(),
    });
    // The warning belongs to the screen where the box is placed, beside the
    // minutes it explains; a result or a drop zone has nothing to warn about.
    const gpuNote = view === "area" ? noGpuNote(platformKey) : "";
    $("eraseNoGpu").textContent = gpuNote;
    $("eraseNoGpu").hidden = !gpuNote;
    $("eraseRunBtn").disabled = !area || packMissing || finding;
    if (view === "area" || working) drawBox();
    drawCrop();
    if (getScreen() === "erase") showTimeline(timelineOf(view, pct));
  }

  // What the timeline shows under this screen: the empty row that asks for a
  // video before there is one; the draft's clips, to be cut, before an erase; the erase job's own
  // video, locked, once there is one. The Erase lane says what happens to it.
  function timelineOf(view, pct) {
    if (view === "drop") return { strip: null, lane: null, locked: true };
    if (view === "area") {
      const len = workLength(source);
      return { strip: "draft", locked: false,
               lane: { text: len ? t("Erase · {length}", { length: fmtLength(len) }) : t("Erase"), cls: "", pct: 0 } };
    }
    const v = $("eraseVideo");
    const lane = view === "working" ? { text: pct >= 100 ? t("Finishing up") : t("Erasing {pct}%", { pct }), cls: "now", pct }
      : view === "done" ? { text: t("Erased"), cls: "ok", pct: 0 } : null;
    return { strip: { media: { kind: "job", id: job.id, name: source.title || "" },
                      duration: Number.isFinite(v.duration) ? v.duration : 0 },
             lane, locked: true };
  }
  // The job's video only says how long it is once it has loaded.
  $("eraseVideo").addEventListener("loadedmetadata", () => { if (job) paint(); });

  // The box is placed against the picture, so it has to be redrawn whenever the
  // picture changes size -- the window, the agent column folding, anything.
  new ResizeObserver(() => { if (!$("eraseBox").hidden) drawBox(); })
    .observe($("eraseStage"));
  // The enlargement follows the playhead -- a seek, the frames as the video
  // plays, the first frame of one just loaded -- and its own size.
  for (const e of ["loadeddata", "seeked", "timeupdate"]) $("eraseVideo").addEventListener(e, drawCrop);
  new ResizeObserver(drawCrop).observe($("eraseCropPic"));

  // ---- Coming in ------------------------------------------------------------

  function reset() {
    stopWatching();
    source = null; area = null; job = null; frame = { w: 0, h: 0 };
    packMissing = false; finding = false; touched = false; savedPath = "";
    offered = null;
    tab = "erased";
    setVideo("");
    // The last video's frame goes with it.
    $("eraseCropPic").width = 0;
    $("eraseError").textContent = "";
    stopWatchingLink();
    $("eraseDlRow").hidden = true;
    $("eraseDropError").textContent = "";
    $("eraseLinkInput").value = "";
  }

  // The New project dialog this screen was reached from, or null when it was
  // reached from the tab, the first screen or the Projects list. Leaving the screen puts that
  // dialog back rather than dropping the user on the home screen with the
  // video they were in the middle of gone (user, 2026-09-09).
  let cameFrom = null;

  /** The New project dialog to reopen on the way out, or null. */
  function origin() {
    return cameFrom;
  }

  /** The first screen's card: the tab with nothing on it yet. */
  function openErase() {
    cameFrom = null;
    showScreen("erase");
    reset();
    paint();
  }

  /**
   * The Erase tab. A new project's video that is not dubbed yet is the video
   * to erase, with the parts its cuts kept. Otherwise the tab comes back as it
   * was left -- an erase that is running is still running -- or empty, asking
   * for a video.
   */
  function openEraseTab() {
    if (getScreen() === "erase") return;
    const d = getDraft();
    if (d && (!source || source.downloadId !== d.downloadId)) {
      cameFrom = null;
      showScreen("erase");
      reset();
      source = { downloadId: d.downloadId, title: d.name || "", duration: d.duration || 0, ranges: null };
      takeDraftParts();
      begin();
      return;
    }
    if (!source) { openErase(); return; }
    // The draft went meanwhile (a dub started from it): this video is the
    // draft again, cuts and all, so the timeline has something to cut.
    if (!d && !job && source.downloadId) keep(source);
    showScreen("erase");
    paint();
  }

  // Make this video the draft, on the timeline, with the parts it came with:
  // the Dubbing tab starts from the same video, cut the same way.
  function keep({ downloadId, title, duration, ranges }) {
    setDraft({ downloadId, name: title || "", duration: duration || 0,
               videoUrl: downloadVideoUrl(downloadId) });
    if (ranges) setRanges(ranges);
  }

  /** A video that came in on this screen: the draft, then this screen's. */
  function hold(held) {
    keep(held);
    source = { ...held };
    takeDraftParts();
    begin();
  }

  /**
   * A row in the Projects list, or the waiting line: an erase that is already
   * under way somewhere, or one that finished days ago. There is no held video
   * behind it any more -- the job's own two videos are what this screen shows,
   * and its length is not on the record, so no time is promised for it.
   */
  function openEraseJob(rec) {
    cameFrom = null;
    showScreen("erase");
    reset();
    source = { downloadId: "", title: rec.project || "", duration: 0, ranges: null };
    job = { id: rec.id, status: rec.status, percent: 0, done: false,
            error: rec.error || "", error_shown: rec.error_shown || "", logs: [] };
    paint();
    catchUp(rec.id);
  }

  // What that job looks like right now -- and, if it is still going, a watch
  // on it from here on.
  async function catchUp(jid) {
    let j;
    try {
      j = await fetchErase(jid);
    } catch (e) {
      $("eraseError").textContent = errorText(e);
      return;
    }
    if (!job || job.id !== jid) return;
    job = { id: jid, status: j.status, percent: j.percent || 0,
            done: !!j.done, error: j.error || "", error_shown: j.error_shown || "", logs: j.logs || [] };
    paint();
    if (["queued", "running", "cancelling"].includes(j.status)) watch(jid);
    else ended(jid, j.status);
  }

  /**
   * The New project dialog's Erase subtitles button: the app is already
   * holding this video, so there is nothing to upload and nothing to wait for.
   * `trim` is the part its handles kept, {start, end} in seconds, or null.
   */
  function openEraseWith({ downloadId, title, duration_sec, trim = null }) {
    if (!downloadId) return;
    // Everything the dialog needs to come back exactly as it was left: the
    // video is already held, so this is the whole of it.
    cameFrom = { downloadId, title: title || "", trim };
    showScreen("erase");
    reset();
    // The trim comes with the video: the dialog's handles chose a part of it,
    // and that part is what gets erased and handed back.
    hold({ downloadId, title: title || "", duration: duration_sec || 0,
           ranges: trim ? [[trim.start, trim.end]] : null });
  }

  /** A video the app already holds, with no dialog to go back to: an open
      project's own video, for its Erase tab. `ranges` are the parts to keep. */
  function openEraseOn({ downloadId, title, duration, ranges = null }) {
    if (!downloadId) return;
    cameFrom = null;
    showScreen("erase");
    reset();
    hold({ downloadId, title: title || "", duration: duration || 0, ranges });
  }

  /** The held video this tab is on, or "". */
  const sourceId = () => (source && source.downloadId) || "";

  // A dropped file goes into the same holding area a link lands in, so from
  // here on both ways in are one id. Its length is read from the file itself,
  // which is what the estimate is made of.
  async function takeFile(file) {
    // The drop view's own line: the format and size limits are said there
    // when a file breaks them, not printed on the block.
    const bad = checkFile(file);
    if (bad) { $("eraseDropError").textContent = bad; return; }
    $("eraseDropError").textContent = "";
    $("eraseError").textContent = "";
    // A file chosen while a link was still coming in: the file it is.
    stopWatchingLink();
    $("eraseDlRow").hidden = true;
    const duration = await lengthOf(file);
    let held;
    try {
      held = await uploadDownload(file, duration);
    } catch (e) {
      $("eraseError").textContent = errorText(e);
      return;
    }
    hold({ downloadId: held.id, title: held.title || file.name, duration, ranges: null });
  }

  // ---- A link ---------------------------------------------------------------
  // The app fetches it into the same holding area an upload lands in, so from
  // the id on this screen cannot tell the two apart (user, 2026-09-09). The
  // work is the New project dialog's, done again here in the six lines it
  // takes rather than by dragging that dialog onto this screen.
  let dlTimer = null;
  // Which fetch is the live one, and its link. A paste followed by Enter used
  // to start the same link twice, and the first one's watch was never
  // stopped: it went on saying "Fetching the video · 0%" over an empty tab.
  // A second link, a file, or the tab starting over makes a fetch stale, and
  // a stale one says nothing and brings nothing in.
  let dlSeq = 0;
  let dlUrl = "";

  function stopWatchingLink() {
    dlSeq += 1;
    dlUrl = "";
    if (dlTimer) { clearInterval(dlTimer); dlTimer = null; }
  }

  function linkFailed(message) {
    stopWatchingLink();
    $("eraseDlRow").hidden = true;
    $("eraseDropError").textContent = message;
  }

  // A percentage only once there is something to count: while the link is
  // still being read there is none, and "0%" read as stuck.
  function sayFetching(rec) {
    $("eraseDlRow").hidden = false;
    $("eraseDlRow").textContent = rec && rec.status === "downloading"
      ? t("Fetching the video · {pct}%", { pct: Math.round(rec.percent || 0) }) : t("Reading the link…");
  }

  async function takeLink(url) {
    if (url === dlUrl) return;   // already on its way
    stopWatchingLink();
    const seq = dlSeq;
    dlUrl = url;
    $("eraseDropError").textContent = "";
    sayFetching(null);
    let id;
    try {
      id = await startDownload(url);
    } catch (e) {
      if (seq === dlSeq) linkFailed(errorText(e));
      return;
    }
    record("media_added", { source: "link", kind: "video" });
    if (seq !== dlSeq) return;
    // Once a second, the same beat the New project dialog watches on.
    dlTimer = setInterval(async () => {
      let rec;
      try {
        rec = await fetchDownload(id);
      } catch (e) {
        if (seq === dlSeq) linkFailed(errorText(e));
        return;
      }
      if (seq !== dlSeq) return;
      if (rec.status === "failed") {
        linkFailed(rec.error || t("The video could not be fetched."));
        return;
      }
      if (rec.status !== "ready") { sayFetching(rec); return; }
      stopWatchingLink();
      $("eraseDlRow").hidden = true;
      $("eraseLinkInput").value = "";
      hold({ downloadId: id, title: rec.title || "", duration: rec.duration_sec || 0, ranges: null });
    }, 1000);
  }

  // How long a file is, read by the same <video> that will show it. 0 when the
  // browser cannot say -- the estimate then has nothing to promise, and says
  // nothing rather than a number it made up.
  function lengthOf(file) {
    return new Promise((resolve) => {
      const v = $("eraseVideo");
      const url = URL.createObjectURL(file);
      const done = (d) => { URL.revokeObjectURL(url); playing = ""; resolve(d); };
      v.addEventListener("loadedmetadata", () => done(Number.isFinite(v.duration) ? v.duration : 0), { once: true });
      v.addEventListener("error", () => done(0), { once: true });
      v.src = url;
    });
  }

  /** The video is in the app's hands: play it and go looking for the subtitles. */
  function begin() {
    setVideo(downloadVideoUrl(source.downloadId));
    finding = true;
    touched = false;
    paint();
    // A box to drag from the first moment. Reading the file for the writing
    // takes as long as the file is long, and the screen used to show nothing
    // at all until it came back (user, 2026-09-10). The suggestion replaces
    // this one when it lands, unless a hand got there first.
    offerDefaultBox();
    suggest();
  }

  /** The bottom band, placed as soon as the video knows its own size. */
  async function offerDefaultBox() {
    const mine = source;
    const f = await framePlayed();
    if (source !== mine || touched || area || !f.w || !f.h) return;
    frame = f;
    area = offered = defaultArea(f.w, f.h);
    paint();
  }

  // The frame's size. The suggestion carries it; before that (and if the
  // suggestion never comes) the video itself does, once it has loaded enough
  // of the file to know.
  function framePlayed() {
    const v = $("eraseVideo");
    if (v.videoWidth && v.videoHeight) return Promise.resolve({ w: v.videoWidth, h: v.videoHeight });
    return new Promise((resolve) => {
      v.addEventListener("loadedmetadata", () => resolve({ w: v.videoWidth, h: v.videoHeight }), { once: true });
      v.addEventListener("error", () => resolve({ w: 0, h: 0 }), { once: true });
    });
  }

  /**
   * Where the app thinks the subtitles are. Minutes of erasing follow this
   * box, so it is offered rather than assumed -- and when the eraser is not
   * installed, or the look failed, the bottom of the frame is offered instead
   * so there is always something to drag.
   *
   * The look is over the whole file even when a trim came in: POST
   * /api/erase/suggest takes no trim, and subtitles sit in the same band all
   * the way through a video, so the box it offers is the same box either way.
   * The box is dragged afterwards regardless.
   */
  async function suggest() {
    const mine = source;
    let found = null;
    try {
      found = await suggestEraseArea(source.downloadId);
    } catch (e) {
      if (source !== mine) return;        // another video came in meanwhile
      if (isPackMissing(e)) {
        packMissing = true;
        $("erasePackText").textContent = packNeededLine(packSize());
      } else {
        $("eraseError").textContent = errorText(e);
      }
    }
    if (source !== mine) return;
    finding = false;
    if (found && found.width && found.height) {
      frame = { w: found.width, h: found.height };
      // The box the screen opened with moves to where the writing actually
      // is -- but never out from under a hand that has already placed it.
      offered = clampArea(found.area, frame.w, frame.h);
      if (!touched) area = offered;
    } else {
      frame = await framePlayed();
      if (source !== mine) return;
      if (frame.w && frame.h) offered = defaultArea(frame.w, frame.h);
      if (offered && !touched) area = offered;
    }
    paint();
  }

  /** The size of the pack on this computer, as the catalog gives it. */
  function packSize() {
    const row = packRow(PACK_ID);
    return row ? row.bytes : 0;
  }

  // ---- Dragging the box -----------------------------------------------------
  // One pointer at a time, captured by the element it went down on, so a drag
  // that leaves the picture still ends where the pointer is let go.
  let drag = null;
  $("eraseBox").addEventListener("pointerdown", (e) => {
    // Locked while the erase runs.
    if (!area || job) return;
    e.preventDefault();
    const handle = e.target.dataset ? (e.target.dataset.handle || "move") : "move";
    const el = handle === "move" ? $("eraseBox") : e.target;
    el.setPointerCapture(e.pointerId);
    const stage = $("eraseStage").getBoundingClientRect();
    drag = { handle, el, x: e.clientX, y: e.clientY, from: area,
             scale: videoPerScreen(stage, frame.w, frame.h) };
  });
  $("eraseBox").addEventListener("pointermove", (e) => {
    if (!drag || !drag.el.hasPointerCapture(e.pointerId)) return;
    area = dragArea(drag.from, drag.handle, (e.clientX - drag.x) * drag.scale,
                    (e.clientY - drag.y) * drag.scale, frame.w, frame.h);
    touched = true;
    drawBox();
    paint();
  });
  const endDrag = (e) => {
    if (!drag) return;
    if (drag.el.hasPointerCapture(e.pointerId)) drag.el.releasePointerCapture(e.pointerId);
    drag = null;
    // The estimate goes up when the box is stretched to the whole frame, so the
    // top bar is repainted at the end of every drag rather than during one.
    paint();
  };
  $("eraseBox").addEventListener("pointerup", endDrag);
  $("eraseBox").addEventListener("pointercancel", endDrag);

  // Reset: the box goes back to where the app put it.
  $("eraseResetBtn").addEventListener("click", () => {
    if (!offered || job) return;
    area = offered;
    touched = false;
    paint();
  });

  // ---- The pack -------------------------------------------------------------
  // The download itself is the models controller's (it owns the progress the
  // rest of the app shows). When it finishes, the look that was refused is
  // taken again by itself -- the user asked for it once already.
  // The install draws itself HERE. The models controller writes its progress
  // and its errors into the models dialog, which is closed while this screen is
  // up: pressing Download looked like it did nothing at all, whether it was
  // downloading or refusing (user, 2026-09-09).
  if (onPackProgress) onPackProgress((p) => {
    if (!p || p.id !== PACK_ID) return;
    if (p.error) {
      $("eraseError").textContent = p.error;
      $("erasePackText").textContent = packNeededLine(packSize());
      return;
    }
    if (p.done) {
      $("erasePackText").textContent = packNeededLine(packSize());
      return;
    }
    const pct = p.pct == null ? "" : ` · ${Math.round(p.pct)}%`;
    // The step and the percentage. The step's detail is the file being
    // fetched, which is a line of its own length and says nothing to anyone.
    $("erasePackText").textContent = (p.title || t("Downloading the eraser (1 of 2, 790 MB)")) + pct;
  });

  $("erasePackBtn").addEventListener("click", async () => {
    if (installing) return;
    installing = true;
    $("eraseError").textContent = "";
    $("erasePackText").textContent = t("Starting the download…");
    $("erasePackBtn").disabled = true;
    const ok = await installPack(PACK_ID);
    installing = false;
    $("erasePackBtn").disabled = false;
    if (!ok || !source) return;
    packMissing = false;
    finding = true;
    paint();
    suggest();
  });

  // ---- Erasing --------------------------------------------------------------

  $("eraseRunBtn").addEventListener("click", async () => {
    if (!source || !area || packMissing) return;
    $("eraseRunBtn").disabled = true;
    $("eraseError").textContent = "";
    const held = source.downloadId;
    let jid;
    try {
      // One kept part is a trim; several are joined first, as a dub's are.
      const kept = source.ranges;
      jid = await startErase({ downloadId: source.downloadId, area, project: source.title,
                               trim: kept && kept.length === 1 ? { start: kept[0][0], end: kept[0][1] } : null,
                               ranges: kept && kept.length > 1 ? kept : null });
    } catch (e) {
      if (isPackMissing(e)) {
        packMissing = true;
        $("erasePackText").textContent = packNeededLine(packSize());
      } else {
        $("eraseError").textContent = errorText(e);
      }
      paint();
      return;
    }
    job = { id: jid, status: "queued", percent: 0, done: false };
    record("tool_started", { tool: "erase", from: "erase" });
    startedHere.add(jid);
    paint();
    onJobsChanged();
    onEraseStarted(held);
    watch(jid);
  });

  $("eraseCancelBtn").addEventListener("click", async () => {
    if (!job) return;
    $("eraseCancelBtn").disabled = true;
    try { await cancelDubJob(job.id); } catch (e) { $("eraseError").textContent = errorText(e); }
    $("eraseCancelBtn").disabled = false;
  });

  // Back to choosing: the held video, the same box, and the draft's cuts on
  // the timeline again -- made the draft once more if it went meanwhile.
  function backToArea() {
    job = null;
    $("eraseError").textContent = "";
    const d = getDraft();
    if (!d || d.downloadId !== source.downloadId) keep(source);
    else takeDraftParts();
    setVideo(downloadVideoUrl(source.downloadId));
    paint();
  }

  // A job that stopped without a video: the box is the thing to change, so Back
  // is the way to it, with the video and the box exactly as they were.
  $("eraseBackBtn").addEventListener("click", () => {
    if (source && source.downloadId) backToArea();
  });

  // Erase another part: the video that came in, the same box, and the cuts
  // back on the timeline to choose the next part with.
  $("eraseAgainBtn").addEventListener("click", () => {
    if (!source || !source.downloadId) return;
    savedPath = "";
    tab = "erased";
    backToArea();
  });

  // The same video, the same box, from the top. The job's folder still holds
  // the video it worked on, so nothing is uploaded and nothing is re-cut.
  $("eraseRetryBtn").addEventListener("click", async () => {
    if (!job) return;
    const from = job.id;
    $("eraseRetryBtn").disabled = true;
    $("eraseError").textContent = "";
    try {
      const jid = await retryErase(from);
      record("tool_started", { tool: "erase", from: "erase" });
      startedHere.add(jid);
      job = { id: jid, status: "queued", percent: 0, done: false, error: "", logs: [] };
      paint();
      onJobsChanged();
      catchUp(jid);
    } catch (e) {
      $("eraseError").textContent = errorText(e);
    } finally {
      $("eraseRetryBtn").disabled = false;
    }
  });

  function stopWatching() {
    clearInterval(timer);
    timer = null;
  }

  // Ask how far along, once a second, until the record settles. A question that
  // fails to arrive is left alone: the next second asks again, and the erase
  // carries on regardless of who is watching.
  function watch(jid) {
    stopWatching();
    timer = setInterval(async () => {
      let j;
      try {
        j = await fetchErase(jid);
      } catch { return; }
      if (!job || job.id !== jid) { stopWatching(); return; }
      job = { id: jid, status: j.status, percent: j.percent || 0,
              done: !!j.done, error: j.error || "", error_shown: j.error_shown || "", logs: j.logs || [] };
      if (!["queued", "running", "cancelling"].includes(j.status)) {
        stopWatching();
        onJobsChanged();
        // Tell the shell how it ended, the way a dub does. An erase never
        // touches handleJobUpdate -- it is watched from here -- so nothing
        // was saying, and a failed erase was the one kind of failure that
        // sent no report at all (user, 2026-09-11). In a plain browser
        // persodubShell is undefined and nothing is sent, which is the point:
        // the counts and the reports describe app installs.
        const how = j.status === "done" ? "done" : j.status === "cancelled" ? "cancelled" : "error";
        ended(jid, j.status);
        if (how !== "cancelled") {
          window.persodubShell?.countErase?.(how, j.error || "", jid);
        }
      }
      paint();
    }, POLL_MS);
  }

  // ---- The result -----------------------------------------------------------

  // Original / Erased. Which one is up is this screen's own; the finished
  // screen's tabs are wired separately and look at their own pane.
  for (const el of $("eraseTabs").querySelectorAll(".vtab")) {
    el.addEventListener("click", () => {
      if (!job || !job.done) return;
      tab = el.dataset.erase;
      paint();
    });
  }

  /** The erased job the top bar's Export has something to hand back from. */
  const erasedJob = () => (job && job.done ? job : null);
  // The erased video as a video to start from (Burn in subtitles): its job,
  // its name and the length that was erased.
  const erasedVideo = () => (erasedJob() ? { id: job.id, name: source.title || "", duration: workLength(source) } : null);

  /**
   * What the Export dialog saves while this screen is up: the erased video,
   * in the canvas of `ratio` when one is picked, or its sound alone
   * ({audio: "mp3" | "wav"}), into the user's Downloads
   * folder. Says where on this screen's own line too, and resolves to the
   * file written.
   */
  async function exportErased({ audio = "", ratio = null } = {}) {
    if (!erasedJob()) throw new Error(t("This video is not erased yet."));
    const res = await saveErased(job.id, { audio, ratio });
    const picked = await pickedFolder();
    savedPath = res.path || "";
    // Which folder, the way the dub's export line says it.
    $("eraseSavedWhere").textContent = downloadsLabel(savedPath, picked) || t("Downloads");
    // Show is the desktop app's; in a browser there is no file window to open,
    // so the line says where it went and stops there.
    $("eraseShowWrap").hidden = !reveal || !savedPath;
    paint();
    return savedPath;
  }
  $("eraseShowBtn").addEventListener("click", () => { if (reveal && savedPath) reveal(savedPath); });

  // The way on: the erased video goes back into the holding area under an id
  // of its own, and a new project opens on that id, on its Dubbing tab -- so
  // the dub reads the cleaned file, not the one with the writing still on it.
  async function handOn() {
    const btn = $("eraseDubBtn");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = t("Opening…");
    $("eraseError").textContent = "";
    try {
      const held = await eraseToDub(job.id);
      onDub({ downloadId: held.download_id, title: held.title,
              duration_sec: held.duration_sec });
    } catch (e) {
      $("eraseError").textContent = errorText(e);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
  $("eraseDubBtn").addEventListener("click", () => { if (job && job.done) handOn(); });

  // ---- The drop zone --------------------------------------------------------
  // The shared Import block, drawn at the top of this function. This tab
  // takes one video: the first of a drop. A pasted link is taken by the block
  // itself after a short wait, Enter at once (ui/src/importBlock.mjs); this
  // screen's own paste timer went with that (2026-10-09).
  wireImportInput($("eraseInput"), (files) => takeFile(files[0]));
  wireImportBlock($, {
    id: "eraseZone", linkId: "eraseLink", input: $("eraseInput"),
    onFiles: (files) => takeFile(files[0]),
    onLink: takeLink,
    onNotLink: (message) => { $("eraseDropError").textContent = message; },
  });

  // The timeline's empty row says "Drop videos here": a video dropped on it
  // while this tab has none comes in the way one dropped on the block does.
  const timelineEl = $("timeline");
  const takesDrop = (e) => getScreen() === "erase" && !source && e.dataTransfer
    && Array.from(e.dataTransfer.types || []).includes("Files");
  if (timelineEl) {
    timelineEl.addEventListener("dragover", (e) => {
      if (!takesDrop(e)) return;
      e.preventDefault();
      timelineEl.classList.add("tl-dropping");
    });
    timelineEl.addEventListener("dragleave", () => timelineEl.classList.remove("tl-dropping"));
    timelineEl.addEventListener("drop", (e) => {
      if (!takesDrop(e)) return;
      e.preventDefault();
      timelineEl.classList.remove("tl-dropping");
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) takeFile(file);
    });
  }

  // An erase job is on this screen, finished or not (the page asks when
  // another tab is pressed).
  const hasJob = () => !!job;
  // The video on this screen is the draft, before any erase of it.
  function showsDraft() {
    const d = getDraft();
    return !!source && !job && !!d && d.downloadId === source.downloadId;
  }
  // What Export hands back before an erase: the draft this screen shows, unless
  // a dubbing project is open. That project's video is held as the draft for its
  // Erase tab, and Export there handed back the dubbing's own files instead.
  const exportsDraft = () => showsDraft() && !projectOpen();
  return { openErase, openEraseTab, openEraseWith, openEraseOn, sourceId, openEraseJob, exportErased, erasedJob, erasedVideo, hasJob,
           showsDraft, exportsDraft, origin };
}
