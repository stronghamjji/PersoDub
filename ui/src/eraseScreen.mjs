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
         fetchErase, cancelDubJob } from "./dubApi.mjs";
import { clampArea, defaultArea, dragArea, toScreen, videoPerScreen, isWhole,
         estimateSeconds, estimateLabel, progressLine, isPackMissing,
         packNeededLine, eraseView } from "./eraseArea.mjs";

// How often the erase is asked how far along it is. The same second the dub's
// queue card uses: the percentage moves in visible steps and the answer is small.
const POLL_MS = 1000;
// The pack that does the erasing, and the row in the catalog its size is read
// from (GET /api/models already answers with this platform's number).
const PACK_ID = "subtitle-eraser";

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
 * @returns the operations the rest of the page calls.
 */
export function initEraseScreenUi({ $, showScreen, setTopbar, checkFile,
                                    installPack, packRow, onJobsChanged }) {
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
  // Which video the <video> is playing, so a repaint does not reload it.
  let playing = "";

  // This computer's own speed. Windows machines here have a GPU doing the
  // work; a Mac does it on its own chip and takes longer per second of video.
  const onWindows = /^win/i.test(navigator.platform || "")
    || /Windows/.test(navigator.userAgent || "");

  // ---- Painting -------------------------------------------------------------

  function estSeconds() {
    if (!source) return 0;
    return estimateSeconds(source.duration, {
      whole: !!area && isWhole(area, frame.w, frame.h), windows: onWindows,
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

  /** Everything on screen, from what is known right now. One place, one order. */
  function paint() {
    const view = eraseView({ source, job });
    $("eraseDrop").hidden = view !== "drop";
    $("eraseBody").hidden = view === "drop";
    $("erasePack").hidden = !packMissing;
    $("eraseBox").hidden = view !== "area" || !area;
    $("eraseFinding").hidden = !finding;
    $("eraseRow").hidden = view !== "working" && view !== "failed";
    $("eraseCancelBtn").hidden = view !== "working";
    $("eraseBarBox").hidden = view !== "working";
    $("eraseBackBtn").hidden = view !== "failed";
    $("eraseState").classList.toggle("bad", view === "failed");
    if (view === "working") {
      const pct = job.percent || 0;
      $("eraseState").textContent = job.status === "cancelling"
        ? "Cancelling…" : progressLine(pct, estSeconds());
      $("eraseFill").style.width = `${pct}%`;
    } else if (view === "failed") {
      $("eraseState").textContent = job.status === "cancelled"
        ? "Erasing was cancelled." : (job.error || "The erase stopped.");
    }
    setTopbar({
      title: source ? (source.title || "Erase subtitles") : "Erase subtitles",
      subtitle: view === "drop" ? "" : "Erase subtitles",
      back: true,
      estimate: view === "area" ? estimateLabel(estSeconds()) : "",
      erase: view === "area",
    });
    $("eraseRunBtn").disabled = !area || packMissing || finding;
    if (view === "area") drawBox();
  }

  // The box is placed against the picture, so it has to be redrawn whenever the
  // picture changes size -- the window, the agent column folding, anything.
  new ResizeObserver(() => { if (!$("eraseBox").hidden) drawBox(); })
    .observe($("eraseStage"));

  // ---- Coming in ------------------------------------------------------------

  function reset() {
    stopWatching();
    source = null; area = null; job = null; frame = { w: 0, h: 0 };
    packMissing = false; finding = false;
    setVideo("");
    $("eraseError").textContent = "";
  }

  /** The rail icon: the screen with nothing on it yet. */
  function openErase() {
    showScreen("erase");
    reset();
    paint();
  }

  /**
   * The New project dialog's Erase subtitles button: the app is already
   * holding this video, so there is nothing to upload and nothing to wait for.
   */
  function openEraseWith({ downloadId, title, duration_sec }) {
    if (!downloadId) return;
    showScreen("erase");
    reset();
    source = { downloadId, title: title || "", duration: duration_sec || 0 };
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
    source = { downloadId: held.id, title: held.title || file.name, duration };
    begin();
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
    paint();
    suggest();
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
      area = clampArea(found.area, frame.w, frame.h);
    } else {
      frame = await framePlayed();
      if (source !== mine) return;
      if (frame.w && frame.h) area = defaultArea(frame.w, frame.h);
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
    drawBox();
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
  $("erasePackBtn").addEventListener("click", async () => {
    if (installing) return;
    installing = true;
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
      jid = await startErase({ downloadId: source.downloadId, area, project: source.title });
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
              done: !!j.done, error: j.error || "" };
      if (!["queued", "running", "cancelling"].includes(j.status)) {
        stopWatching();
        onJobsChanged();
      }
      paint();
    }, POLL_MS);
  }

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

  return { openErase, openEraseWith };
}
