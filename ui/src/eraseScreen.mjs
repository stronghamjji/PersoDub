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
         fetchErase, cancelDubJob, eraseVideoUrl, saveErased,
         eraseToDub } from "./dubApi.mjs";
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
 * @param {(source: object) => void} deps.onDub  open the New project dialog on
 *        the erased video (optionally with the user's own subtitles)
 * @param {(path: string) => void} deps.reveal  show a saved file in the
 *        computer's own file window, or null outside the desktop app
 * @returns the operations the rest of the page calls.
 */
export function initEraseScreenUi({ $, showScreen, setTopbar, checkFile,
                                    installPack, packRow, onJobsChanged,
                                    onDub, reveal }) {
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
  // Which of the two tabs is up once there is a result. Erased: it is the video
  // the user came here for, and Original is the one to check it against.
  let tab = "erased";
  // When Erase was pressed, so the finished screen can say how long it took.
  // 0 for a result opened out of the Projects list, which nobody timed.
  let startedAt = 0;
  // Where Export wrote the video, once it has. "" until then, which is what
  // keeps the "Saved to Downloads" line from claiming anything too early.
  let savedPath = "";

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
    const done = view === "done";
    $("eraseDrop").hidden = view !== "drop";
    $("eraseBody").hidden = view === "drop";
    $("erasePack").hidden = !packMissing || done;
    // The question and the tabs take turns in the same strip, so the picture
    // under them is in the same place before and after. While the erase runs
    // the strip goes: the question has been answered, and the row under the
    // picture is where the answer to "how long now" is.
    $("eraseHead").hidden = view !== "area";
    $("eraseTabs").hidden = !done;
    $("eraseBox").hidden = view !== "area" || !area;
    $("eraseFinding").hidden = !finding;
    $("eraseRow").hidden = view === "area";
    $("eraseCancelBtn").hidden = view !== "working";
    $("eraseBarBox").hidden = view !== "working";
    // Back is the way to the box that has to change -- which is only somewhere
    // to go while this screen still has the video that box was drawn on.
    $("eraseBackBtn").hidden = view !== "failed" || !area;
    $("eraseSrtBtn").hidden = !done;
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
    if (done) {
      setVideo(eraseVideoUrl(job.id, tab));
      for (const el of $("eraseTabs").querySelectorAll(".vtab")) {
        el.classList.toggle("active", el.dataset.erase === tab);
      }
    }
    setTopbar({
      title: source ? (source.title || "Erase subtitles") : "Erase subtitles",
      // How long it took is what the result says; until then, where you are.
      subtitle: done ? erasedFor() : (view === "drop" ? "" : "Erase subtitles"),
      back: true,
      estimate: view === "area" ? estimateLabel(estSeconds()) : "",
      erase: view === "area",
      // The top bar's Export saves the erased video; the page hands the press
      // to this screen while it is the screen that is up.
      done,
    });
    $("eraseRunBtn").disabled = !area || packMissing || finding;
    if (view === "area") drawBox();
  }

  /**
   * "Erased · 8 min" -- how long it actually took, timed on this screen. A job
   * record keeps when it started and nothing about when it ended, so a result
   * opened from the Projects list days later says plainly "Erased" rather than
   * a number worked out from the estimate, which is not the same thing.
   */
  function erasedFor() {
    if (!startedAt) return "Erased";
    return `Erased · ${Math.max(1, Math.round((Date.now() - startedAt) / 60000))} min`;
  }

  // The box is placed against the picture, so it has to be redrawn whenever the
  // picture changes size -- the window, the agent column folding, anything.
  new ResizeObserver(() => { if (!$("eraseBox").hidden) drawBox(); })
    .observe($("eraseStage"));

  // ---- Coming in ------------------------------------------------------------

  function reset() {
    stopWatching();
    source = null; area = null; job = null; frame = { w: 0, h: 0 };
    packMissing = false; finding = false; startedAt = 0; savedPath = "";
    tab = "erased";
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
   * A row in the Projects list, or the waiting line: an erase that is already
   * under way somewhere, or one that finished days ago. There is no held video
   * behind it any more -- the job's own two videos are what this screen shows,
   * and its length is not on the record, so no time is promised for it.
   */
  function openEraseJob(rec) {
    showScreen("erase");
    reset();
    source = { downloadId: "", title: rec.project || "", duration: 0 };
    job = { id: rec.id, status: rec.status, percent: 0, done: false,
            error: rec.error || "" };
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
            done: !!j.done, error: j.error || "" };
    paint();
    if (["queued", "running", "cancelling"].includes(j.status)) watch(jid);
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
    startedAt = Date.now();
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
    // Show is the desktop app's; in a browser there is no file window to open,
    // so the line says where it went and stops there.
    $("eraseShowWrap").hidden = !reveal || !savedPath;
    paint();
  }
  $("eraseShowBtn").addEventListener("click", () => { if (reveal && savedPath) reveal(savedPath); });

  // Both ways on are the same errand: the erased video goes back into the
  // holding area under an id of its own, and the New project dialog opens on
  // that id -- so the dub reads the cleaned file, not the one with the writing
  // still on it. The only difference is whether the user brought subtitles.
  async function handOn(sourceSrt) {
    const btn = sourceSrt ? $("eraseSrtBtn") : $("eraseDubBtn");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Opening…";
    $("eraseError").textContent = "";
    try {
      const held = await eraseToDub(job.id);
      onDub({ downloadId: held.download_id, title: held.title,
              duration_sec: held.duration_sec, sourceSrt: sourceSrt || null });
    } catch (e) {
      $("eraseError").textContent = e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
  $("eraseDubBtn").addEventListener("click", () => { if (job && job.done) handOn(null); });
  $("eraseSrtBtn").addEventListener("click", () => $("eraseSrtInput").click());
  $("eraseSrtInput").addEventListener("change", () => {
    const file = $("eraseSrtInput").files && $("eraseSrtInput").files[0];
    $("eraseSrtInput").value = "";
    if (file && job && job.done) handOn(file);
  });

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

  return { openErase, openEraseWith, openEraseJob, exportErased };
}
