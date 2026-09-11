// The Erase subtitles screen: one section wearing three faces in turn -- drop a
// video, drag a box over the burned-in subtitles, then the erased video beside
// the one that came in. The rail's third icon opens it, and so does the New
// project dialog's "Erase subtitles" button, which hands over the video the app
// is already holding rather than a second copy of it.
//
// What is NOT here: the geometry and every word with a number in it live in
// ui/src/eraseArea.mjs, and every request this screen makes is one of the erase
// helpers in ui/src/dubApi.mjs. This file is the wiring in between -- which
// face is up, what each button does, and the dragging of the box itself.
//
// Everything this file touches is #screen-erase and the top bar's two erase
// controls, which setTopbar hides for every other screen.
import { uploadDownload, downloadVideoUrl, suggestEraseArea, startErase,
         fetchErase, retryErase, cancelDubJob, eraseVideoUrl, saveErased,
         startDownload, fetchDownload, eraseToDub } from "./dubApi.mjs";
import { clampArea, defaultArea, dragArea, toScreen, videoPerScreen, isWhole,
         estimateSeconds, estimateLabel, progressLine, isPackMissing, noGpuNote, bigBoxNote,
         packNeededLine, eraseView, workLength, trimNote } from "./eraseArea.mjs";
import { initTrimBar } from "./trimBar.mjs";
import { downloadsLabel } from "./format.mjs";

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
 * @param {(opts: object) => void} deps.setTopbar   the page's one top bar
 * @param {(file: File) => string|null} deps.checkFile  the home screen's own
 *        "is this a video we can take?" -- one rule for both ways in
 * @param {(id: string) => Promise<boolean>} deps.installPack  the models
 *        controller's pack install, progress dialog and top-bar chip included
 * @param {(id: string) => object|null} deps.packRow  one catalog row, read
 *        for the pack's size on this computer
 * @param {() => void} deps.onJobsChanged  the Projects list has a new row
 * @param {(source: object) => void} deps.onDub  open the New project dialog on
 *        the erased video (optionally with the user's own subtitles)
 * @param {(path: string) => void} deps.reveal  show a saved file in the
 *        computer's own file window, or null outside the desktop app
 * @param {(video, start, end) => Promise} deps.playRange  play only [start, end]
 * @param {(video) => void} deps.cancelRange  stop that
 * @param {() => number} deps.labelPx  how much room a clock label needs on the
 *        trim bar's ruler
 * @returns the operations the rest of the page calls.
 */
export function initEraseScreenUi({ $, showScreen, setTopbar, checkFile,
                                    installPack, packRow, onPackProgress, onJobsChanged,
                                    onDub, reveal,
                                    playRange, cancelRange, labelPx }) {
  // The video being worked on: the id the app holds it under, what to call it,
  // and how long it is (the estimate is made from that length).
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
  // Which video the <video> is playing, so a repaint does not reload it.
  let playing = "";
  // Which of the two tabs is up once there is a result. Erased: it is the video
  // the user came here for, and Original is the one to check it against.
  let tab = "erased";
  // Where Export wrote the video, once it has. "" until then, which is what
  // keeps the "Saved to Downloads" line from claiming anything too early.
  let savedPath = "";

  // The same trim bar the New project dialog draws, on this screen's own video
  // and under its own ids. Before it, a video already cut down in the dialog
  // could not be cut again here, and one brought in whole could not be cut at
  // all -- so every erase ran over the entire file.
  const trimBar = initTrimBar({
    $, prefix: "erase", getVideo: () => $("eraseVideo"),
    playRange, cancelRange, labelPx,
    onChange: (trim) => { if (source) { source.trim = trim; paint(); } },
  });

  // The bar, drawn on the part that came in with the video -- or nothing at
  // all when the length is not known, which is what a job opened out of the
  // Projects list has.
  function drawTrim() {
    if (source && source.duration >= 1) trimBar.render(source.duration, source.trim);
    else trimBar.clear();
  }

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
    // The part the trim kept, not the whole file: erasing 10 seconds of a
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

  /**
   * The width of the picture as it was actually laid out, published to the CSS
   * so the trim bar and the row of controls under it come out the same width.
   * A letterboxed video is narrower than its stage, and no CSS rule can ask a
   * sibling how wide it turned out to be.
   */
  function sizeColumn() {
    const w = $("eraseVideo").getBoundingClientRect().width;
    if (w > 0) $("eraseBody").style.setProperty("--erase-col", `${Math.round(w)}px`);
  }

  /** Draw the box where it stands, in the picture's own place on the screen. */
  function drawBox() {
    sizeColumn();
    const stage = $("eraseStage").getBoundingClientRect();
    if (!area || !frame.w || !frame.h || !stage.width) return;
    const box = toScreen(area, stage, frame.w, frame.h);
    const el = $("eraseBox");
    el.style.left = `${box.left}px`;
    el.style.top = `${box.top}px`;
    el.style.width = `${box.width}px`;
    el.style.height = `${box.height}px`;
  }

  /** Everything on screen, from what is known right now. One place, one order. */
  function paint() {
    const view = eraseView({ source, job });
    const done = view === "done";
    $("eraseDrop").hidden = view !== "drop";
    $("eraseBody").hidden = view === "drop";
    // The red line goes where the eye already is. At the foot of the screen it
    // was 257 pixels below the picture it was about, with nothing in between,
    // and the two did not read as one thing (Windows measured it,
    // 2026-09-11). It cannot simply live in the column: a file refused before
    // there is any video to show is reported in it too, and the column is not
    // on the page then.
    const host = view === "drop" ? $("screen-erase") : $("eraseMid");
    if ($("eraseError").parentElement !== host) host.appendChild($("eraseError"));
    $("erasePack").hidden = !packMissing || done;
    // Only a finished erase has two videos to choose between, so the tabs are
    // the only thing that ever stands above the picture. The screen's own
    // title band went (user, 2026-09-10): the top bar was already saying the
    // same three words an inch above it.
    $("eraseTabs").hidden = !done;
    $("eraseBox").hidden = view !== "area" || !area;
    // Two states, not three: red and "Finding subtitles…" while the app hunts
    // for the writing, green and "Subtitles" once it has stopped. A third --
    // back to yellow the moment a hand moved the box -- was never asked for
    // and read as the app having lost something (user, 2026-09-11). The line
    // over the picture's top left corner that used to say it is gone; nobody
    // read it there.
    $("eraseBox").classList.toggle("finding", finding);
    $("eraseBox").classList.toggle("found", !finding);
    $("eraseBox").querySelector("b").textContent = finding ? "Finding subtitles…" : "Subtitles";
    // The row carries the minutes and the Erase button now, so it is up while
    // the box is being placed too.
    $("eraseRow").hidden = false;
    // The trim bar belongs to the question "which part?", which is only asked
    // while the box is being placed. Emptied rather than hidden, so it also
    // lets go of the player it was scrubbing.
    if (view !== "area" && $("eraseTrimBox").innerHTML) trimBar.clear();
    $("eraseCancelBtn").hidden = view !== "working";
    $("eraseBarBox").hidden = view !== "working";
    // Back is the way to the box that has to change -- which is only somewhere
    // to go while this screen still has the video that box was drawn on.
    $("eraseBackBtn").hidden = view !== "failed" || !area;
    // Try again and the log are the dub failure card's two, on this screen for
    // the same reasons: Back is nowhere to go when the job came out of the
    // Projects list, and the row's one sentence is all there was to read.
    $("eraseRetryBtn").hidden = view !== "failed";
    $("eraseLogDetails").hidden = view !== "failed";
    if (view === "failed") $("eraseLogBox").textContent = (job.logs || []).join("\n");
    $("eraseDubBtn").hidden = !done;
    $("eraseSaved").hidden = !done || !savedPath;
    $("eraseState").classList.toggle("bad", view === "failed");
    if (view === "working") {
      const pct = job.percent || 0;
      $("eraseState").textContent = job.status === "cancelling"
        ? "Cancelling…" : progressLine(pct, estSeconds());
      $("eraseFill").style.width = `${pct}%`;
    } else if (view === "failed") {
      $("eraseState").textContent = job.status === "cancelled"
        ? "Erasing was cancelled." : (job.error || "The erase stopped.");
    } else {
      $("eraseState").textContent = "";
    }
    // A job picked up out of the Projects list has no held video behind it, so
    // the picture comes from the job's own folder: the original while it runs,
    // and whichever tab is up once there is a result.
    if (view === "working" && !playing) setVideo(eraseVideoUrl(job.id, "original"));
    // A finished erase is the thing the user came for, so it is a video they
    // can play and hear -- not a still. Everywhere else on this screen the
    // picture is a backdrop for the box being drawn on it, where a play bar
    // over the writing and a burst of sound would both be in the way: muted
    // and no controls there, both back here (user, 2026-09-11).
    const player = $("eraseVideo");
    player.controls = done;
    player.muted = !done;
    if (done) {
      setVideo(eraseVideoUrl(job.id, tab));
      for (const el of $("eraseTabs").querySelectorAll(".vtab")) {
        el.classList.toggle("active", el.dataset.erase === tab);
      }
    }
    // The top bar is the whole app's, not this screen's. An erase is followed
    // once a second whether or not the user stayed to watch it, and a tick
    // that ran while they were on the home screen used to put this video's
    // name, its subtitle and its back arrow up there over theirs. Every way
    // back onto this screen paints on arrival, so there is nothing to lose by
    // leaving the bar alone while the screen is away.
    if (!$("screen-erase").hidden) setTopbar({
      title: source ? (source.title || "Erase subtitles") : "Erase subtitles",
      // How long it took is what the result says; until then, where you are.
      // And how much of the video it is about, whenever that is not all of it:
      // without those four words the whole thing looks like it is going.
      // The band below names the screen, so the top bar carries only what is
      // its own: the file, and which part of it (user, 2026-09-09). A
      // finished erase says "Erased" -- the band has stepped aside for the
      // tabs by then, and nothing else says it is done.
      subtitle: done ? "Erased" : view === "drop" ? "" : trimNote(source),
      back: true,
      estimate: view === "area"
        ? [estimateLabel(estSeconds()), bigBoxNote(area, frame.w, frame.h)].filter(Boolean).join(" · ")
        : "",
      erase: view === "area",
      // The top bar's Export saves the erased video; the page hands the press
      // to this screen while it is the screen that is up.
      done,
    });
    // The warning belongs to the screen where the box is placed, beside the
    // minutes it explains; a result or a drop zone has nothing to warn about.
    const gpuNote = view === "area" ? noGpuNote(platformKey) : "";
    $("eraseNoGpu").textContent = gpuNote;
    $("eraseNoGpu").hidden = !gpuNote;
    $("eraseRunBtn").disabled = !area || packMissing || finding;
    if (view === "area") drawBox();
  }

  // The box is placed against the picture, so it has to be redrawn whenever the
  // picture changes size -- the window, the agent column folding, anything.
  new ResizeObserver(() => { sizeColumn(); if (!$("eraseBox").hidden) drawBox(); })
    .observe($("eraseStage"));
  // A video that has just loaded is laid out after the poster space it had:
  // the column has to be measured again once the real picture is in place.
  $("eraseVideo").addEventListener("loadedmetadata", sizeColumn);

  // ---- Coming in ------------------------------------------------------------

  function reset() {
    stopWatching();
    source = null; area = null; job = null; frame = { w: 0, h: 0 };
    packMissing = false; finding = false; touched = false; savedPath = "";
    tab = "erased";
    trimBar.clear();
    setVideo("");
    $("eraseError").textContent = "";
    stopWatchingLink();
    $("eraseDlRow").hidden = true;
    $("eraseDropError").textContent = "";
    $("eraseLinkInput").value = "";
  }

  // The New project dialog this screen was reached from, or null when it was
  // reached from the rail or the Projects list. Leaving the screen puts that
  // dialog back rather than dropping the user on the home screen with the
  // video they were in the middle of gone (user, 2026-09-09).
  let cameFrom = null;

  /** The New project dialog to reopen on the way out, or null. */
  function origin() {
    return cameFrom;
  }

  /** The rail icon: the screen with nothing on it yet. */
  function openErase() {
    cameFrom = null;
    showScreen("erase");
    reset();
    paint();
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
    source = { downloadId: "", title: rec.project || "", duration: 0, trim: null };
    job = { id: rec.id, status: rec.status, percent: 0, done: false,
            error: rec.error || "", logs: [] };
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
      $("eraseError").textContent = e.message;
      return;
    }
    if (!job || job.id !== jid) return;
    job = { id: jid, status: j.status, percent: j.percent || 0,
            done: !!j.done, error: j.error || "", logs: j.logs || [] };
    paint();
    if (["queued", "running", "cancelling"].includes(j.status)) watch(jid);
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
    source = { downloadId, title: title || "", duration: duration_sec || 0, trim };
    begin();
  }

  // A dropped file goes into the same holding area a link lands in, so from
  // here on both ways in are one id. Its length is read from the file itself,
  // which is what the estimate is made of.
  async function takeFile(file) {
    const bad = checkFile(file);
    if (bad) { $("eraseError").textContent = bad; return; }
    $("eraseError").textContent = "";
    const duration = await lengthOf(file);
    let held;
    try {
      held = await uploadDownload(file, duration);
    } catch (e) {
      $("eraseError").textContent = e.message;
      return;
    }
    source = { downloadId: held.id, title: held.title || file.name, duration, trim: null };
    begin();
  }

  // ---- A link ---------------------------------------------------------------
  // The app fetches it into the same holding area an upload lands in, so from
  // the id on this screen cannot tell the two apart (user, 2026-09-09). The
  // work is the New project dialog's, done again here in the six lines it
  // takes rather than by dragging that dialog onto this screen.
  let dlTimer = null;
  let dlTyped = null;

  function stopWatchingLink() {
    if (dlTimer) { clearInterval(dlTimer); dlTimer = null; }
  }

  function linkFailed(message) {
    stopWatchingLink();
    $("eraseDlRow").hidden = true;
    $("eraseDropError").textContent = message;
  }

  function sayFetching(rec) {
    const pct = rec && rec.percent != null ? ` · ${Math.round(rec.percent)}%` : "";
    $("eraseDlRow").hidden = false;
    $("eraseDlRow").textContent = `Fetching the video${pct}`;
  }

  async function takeLink(url) {
    stopWatchingLink();
    $("eraseDropError").textContent = "";
    sayFetching(null);
    let id;
    try {
      id = await startDownload(url);
    } catch (e) {
      linkFailed(e.message);
      return;
    }
    // Once a second, the same beat the New project dialog watches on.
    dlTimer = setInterval(async () => {
      let rec;
      try {
        rec = await fetchDownload(id);
      } catch (e) {
        linkFailed(e.message);
        return;
      }
      if (rec.status === "failed") {
        linkFailed(rec.error || "The video could not be fetched.");
        return;
      }
      if (rec.status !== "ready") { sayFetching(rec); return; }
      stopWatchingLink();
      $("eraseDlRow").hidden = true;
      $("eraseLinkInput").value = "";
      source = { downloadId: id, title: rec.title || "", duration: rec.duration_sec || 0, trim: null };
      begin();
    }, 1000);
  }

  // A pasted link arrives as one input event with the whole address in it, so
  // a short wait after the last keystroke is enough to tell a paste from
  // somebody still typing.
  $("eraseLinkInput").addEventListener("input", () => {
    clearTimeout(dlTyped);
    const url = $("eraseLinkInput").value.trim();
    if (!/^https?:\/\/\S+$/.test(url)) return;
    dlTyped = setTimeout(() => takeLink(url), 400);
  });
  $("eraseLinkInput").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    clearTimeout(dlTyped);
    const url = $("eraseLinkInput").value.trim();
    if (/^https?:\/\/\S+$/.test(url)) takeLink(url);
  });

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
    // After paint, so the ruler is measured off a bar that is on the screen:
    // ticks worked out against a width of zero come out as one tick.
    drawTrim();
    suggest();
  }

  /** The bottom band, placed as soon as the video knows its own size. */
  async function offerDefaultBox() {
    const mine = source;
    const f = await framePlayed();
    if (source !== mine || touched || area || !f.w || !f.h) return;
    frame = f;
    area = defaultArea(f.w, f.h);
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
        $("eraseError").textContent = e.message;
      }
    }
    if (source !== mine) return;
    finding = false;
    if (found && found.width && found.height) {
      frame = { w: found.width, h: found.height };
      // The box the screen opened with moves to where the writing actually
      // is -- but never out from under a hand that has already placed it.
      if (!touched) area = clampArea(found.area, frame.w, frame.h);
    } else {
      frame = await framePlayed();
      if (source !== mine) return;
      if (frame.w && frame.h && !touched) area = defaultArea(frame.w, frame.h);
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
    if (!area) return;
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
    $("erasePackText").textContent = (p.title || "Downloading the eraser (1 of 2, 790 MB)") + pct;
  });

  $("erasePackBtn").addEventListener("click", async () => {
    if (installing) return;
    installing = true;
    $("eraseError").textContent = "";
    $("erasePackText").textContent = "Starting the download…";
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
    let jid;
    try {
      jid = await startErase({ downloadId: source.downloadId, area,
                               project: source.title, trim: source.trim || null });
    } catch (e) {
      if (isPackMissing(e)) {
        packMissing = true;
        $("erasePackText").textContent = packNeededLine(packSize());
      } else {
        $("eraseError").textContent = e.message;
      }
      paint();
      return;
    }
    job = { id: jid, status: "queued", percent: 0, done: false };
    paint();
    onJobsChanged();
    watch(jid);
  });

  $("eraseCancelBtn").addEventListener("click", async () => {
    if (!job) return;
    $("eraseCancelBtn").disabled = true;
    try { await cancelDubJob(job.id); } catch (e) { $("eraseError").textContent = e.message; }
    $("eraseCancelBtn").disabled = false;
  });

  // A job that stopped without a video: the box is the thing to change, so Back
  // is the way to it, with the video and the box exactly as they were.
  $("eraseBackBtn").addEventListener("click", () => {
    job = null;
    $("eraseError").textContent = "";
    paint();
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
      job = { id: jid, status: "queued", percent: 0, done: false, error: "", logs: [] };
      paint();
      onJobsChanged();
      catchUp(jid);
    } catch (e) {
      $("eraseError").textContent = e.message;
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
              done: !!j.done, error: j.error || "", logs: j.logs || [] };
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
    el.addEventListener("click", () => { tab = el.dataset.erase; paint(); });
  }

  /**
   * The top bar's Export while this screen is up: write the erased video into
   * the user's Downloads folder and say so on one line. No dialog -- there is
   * one file and one place for it to go.
   */
  async function exportErased() {
    if (!job || !job.done) return;
    $("eraseError").textContent = "";
    let res;
    try {
      res = await saveErased(job.id);
    } catch (e) {
      $("eraseError").textContent = e.message;
      return;
    }
    savedPath = res.path || "";
    // Which folder, the way the dub's export line says it.
    $("eraseSavedWhere").textContent = downloadsLabel(savedPath) || "Downloads";
    // Show is the desktop app's; in a browser there is no file window to open,
    // so the line says where it went and stops there.
    $("eraseShowWrap").hidden = !reveal || !savedPath;
    paint();
  }
  $("eraseShowBtn").addEventListener("click", () => { if (reveal && savedPath) reveal(savedPath); });

  // The way on: the erased video goes back into the holding area under an id
  // of its own, and the New project dialog opens on that id -- so the dub
  // reads the cleaned file, not the one with the writing still on it.
  async function handOn() {
    const btn = $("eraseDubBtn");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Opening…";
    $("eraseError").textContent = "";
    try {
      const held = await eraseToDub(job.id);
      onDub({ downloadId: held.download_id, title: held.title,
              duration_sec: held.duration_sec });
    } catch (e) {
      $("eraseError").textContent = e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
  $("eraseDubBtn").addEventListener("click", () => { if (job && job.done) handOn(); });

  // ---- The drop zone --------------------------------------------------------
  const zone = $("eraseZone");
  const input = $("eraseInput");
  zone.addEventListener("click", () => input.click());
  zone.addEventListener("keydown", (e) => {
    if (e.target === zone && (e.key === "Enter" || e.key === " ")) input.click();
  });
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    // Cleared so that picking the same file again fires another change event.
    input.value = "";
    if (file) takeFile(file);
  });
  for (const evt of ["dragenter", "dragover"]) {
    zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.add("drag-over"); });
  }
  for (const evt of ["dragleave", "drop"]) {
    zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.remove("drag-over"); });
  }
  zone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) takeFile(file);
  });

  return { openErase, openEraseWith, openEraseJob, exportErased, origin };
}
