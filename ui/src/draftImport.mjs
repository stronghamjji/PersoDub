// How a video comes into a new project, whichever tab is open (no-media-tab
// mockup, owner 2026-09-30): one project holds one video, so there is no bin
// to keep it in. With no video the Dubbing tab shows the one shared
// Import block (ui/src/importBlock.mjs) over the timeline's empty row "Drop
// videos here"; a file, a drop or a link lands as the draft
// (ui/src/draft.mjs), on the timeline at once, and the tab that was open
// stays open. What the import is doing ("Importing…", "Reading the link…",
// "Downloading… 40%", why it failed) is said on the line under each block.
// (The Erase tab is a screen of its own and brings its video in itself,
// ui/src/eraseScreen.mjs.)
//
// A video dropped on the timeline while the draft already has one replaces
// it -- asked first, in the app's usual confirm-dialog style. Replace on the
// Before dubbing card's Video (owner, 2026-10-22) opens this block's own
// file picker, and the file chosen replaces it with no question: pressing
// Replace was the asking.
//
// The network calls (uploading a dropped file, fetching a link) are the same
// ones the New project dialog makes (ui/src/dubApi.mjs); nothing here talks
// to the server a second way.
import { startDownload, fetchDownload, downloadVideoUrl, uploadDownload } from "./dubApi.mjs";
import { getDraft, setDraft, onDraftChange } from "./draft.mjs";
import { errorText } from "./format.mjs";
import { emptyTabHtml, wireImportBlock, wireImportInput } from "./importBlock.mjs";
import { t } from "./i18n.mjs";
import { record as recordStep } from "./events.mjs";

const DOWNLOAD_POLL_MS = 1000;
// The line under each tab's Import block, and the one under the Before
// dubbing card, where a video taking the card's place says how it is going.
const STATUS_IDS = ["dubbingImportStatus", "draftImportStatus", "capImportStatus", "saveImportStatus"];

/**
 * Wire importing to a page. The page needs: #dubbingImport, the Dubbing tab's
 * face with no video, holding #dubbingImportSlot (the block is drawn there)
 * and #dubbingImportStatus; #saveImport, the Save video tab's, with
 * #saveImportSlot and #saveImportStatus; and a hidden `<input type=file accept="video/*">`
 * at #draftFileInput.
 *
 * @param {object} deps
 * @param {(id: string) => any} deps.$
 * @param {object} [deps.state]  state.jobId: a job that owns the work screen
 * @param {() => string} [deps.getScreen]  a video file dropped on the timeline
 *        is taken only while the draft's own screen ("done") is up
 * @param {(file: File) => string|null} [deps.checkFile]  the app's one rule
 *        about which files it takes: why not, or null
 * @param {(downloadId: string) => void} [deps.onReplaced]  told the id of the
 *        draft a file took the place of (Replace on the card, or a drop on the
 *        timeline answered Replace), so Home lets its Draft card go
 * @param {() => void} [deps.onSaveLinkReady]  told once a link pasted on the
 *        Save video tab is the draft, so the page can save it
 * @returns {{ render: () => void, importSource: (source: {file?, link?,
 *   onReady?, downloadId?, name?, duration?}) => Promise<void>, cancelImport: () => void,
 *   say: (text: string, isError?: boolean) => void }}
 */
export function initDraftImport({ $, state = {}, getScreen = () => "done",
                                  checkFile = () => null, onReplaced = () => {}, onSaveLinkReady = () => {},
                                  record = recordStep }) {
  const slot = $("dubbingImportSlot");
  if (slot) slot.outerHTML = emptyTabHtml("dubbing", "dubbingZone", "dubbingLink");
  const saveSlot = $("saveImportSlot");
  if (saveSlot) saveSlot.outerHTML = emptyTabHtml("save", "saveZone", "saveLink");

  let importSeq = 0;
  let downloadTimer = null;
  // The link being fetched for this draft, "" between fetches.
  let linkOnItsWay = "";

  function stopWatching() { clearInterval(downloadTimer); downloadTimer = null; }

  // A file still uploading or a link still coming down belongs to the draft
  // it was started on. Once that draft is let go (another project opened, a
  // held video put in its place, Home) its arrival must not become the draft
  // of whatever is on screen by then, so nobody waits for it any more. The
  // download itself carries on in the app.
  function cancelImport() {
    importSeq += 1;
    linkOnItsWay = "";
    stopWatching();
    setStatus("");
  }

  function setStatus(text, isError = false) {
    for (const id of STATUS_IDS) {
      const el = $(id);
      if (el) { el.textContent = text; el.classList.toggle("error", isError); }
    }
  }

  // ---- the video pane: the draft's own video --------------------------------
  function paintVideoPane(d) {
    // A real job on screen owns the pane: a draft left over beside it must not
    // swap its video.
    if (state.jobId) return;
    const video = $("doneVideo");
    // An empty new project has no video: the last one's picture and length
    // go (the player's clock follows the video being emptied).
    if (!d) {
      if (video && video.getAttribute("src")) { video.removeAttribute("src"); video.load(); }
      return;
    }
    $("vtabOriginal").classList.add("active");
    $("vtabDubbed").classList.remove("active");
    // Nothing is dubbed yet, so there is nothing behind that tab: off, and
    // it says when it comes on (the page's paintVideoTabs puts it back on for
    // a finished job).
    $("vtabDubbed").disabled = true;
    $("vtabDubbed").title = t("After dubbing");
    if (video && video.getAttribute("src") !== d.videoUrl) video.setAttribute("src", d.videoUrl);
  }

  // ---- holding a video (same network calls the New project dialog makes) ---
  async function holdFile(file) {
    const bad = checkFile(file);
    if (bad) { setStatus(bad, true); return; }
    const seq = ++importSeq;
    // The video this one takes the place of, if any: replacing is not keeping
    // both, so its Draft card goes once this one is in (owner, 2026-10-22).
    const replacing = getDraft();
    // A link still coming down is let go for this file; pasted again later
    // it must be fetched again.
    linkOnItsWay = "";
    stopWatching();
    setStatus(t("Importing…"));
    const objectUrl = URL.createObjectURL(file);
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.src = objectUrl;
    const duration = await new Promise((resolve) => {
      probe.addEventListener("loadedmetadata", () => resolve(probe.duration), { once: true });
      probe.addEventListener("error", () => resolve(0), { once: true });
    });
    URL.revokeObjectURL(objectUrl);
    if (seq !== importSeq) return;
    let rec;
    try {
      rec = await uploadDownload(file, duration);
    } catch (e) {
      if (seq === importSeq) setStatus(errorText(e), true);
      return;
    }
    if (seq !== importSeq) return;
    setStatus("");
    setDraft({ downloadId: rec.id, name: file.name, duration, videoUrl: downloadVideoUrl(rec.id) });
    if (replacing) onReplaced(replacing.downloadId);
  }

  // `onReady` is told once this link's video is the draft: never when the
  // link is let go first (another video brought in, the draft let go, Home).
  async function holdLink(url, onReady = null) {
    // A paste starts the link by itself, and an Enter out of habit follows a
    // moment later: the same link already on its way is not fetched twice
    // (the erase screen's takeLink has the same check).
    if (url === linkOnItsWay) return;
    const seq = ++importSeq;
    linkOnItsWay = url;
    setStatus(t("Reading the link…"));
    let id;
    try {
      id = await startDownload(url);
    } catch (e) {
      if (seq === importSeq) { linkOnItsWay = ""; setStatus(errorText(e), true); }
      return;
    }
    // A link taken is a video brought in, for the charts (a file is seen as it is picked or dropped).
    record("media_added", { source: "link", kind: "video" });
    if (seq !== importSeq) return;
    stopWatching();
    downloadTimer = setInterval(async () => {
      let d;
      try { d = await fetchDownload(id); } catch { return; }
      if (seq !== importSeq) { stopWatching(); return; }
      if (d.status === "failed") { stopWatching(); linkOnItsWay = ""; setStatus(d.error || t("Could not fetch the video from this link. Paste it again in a moment, or drag the video file in."), true); return; }
      if (d.status === "ready") {
        stopWatching();
        linkOnItsWay = "";
        setStatus("");
        setDraft({ downloadId: d.id, name: d.title || url, duration: d.duration_sec || 0, videoUrl: downloadVideoUrl(d.id) });
        if (onReady) onReady();
        return;
      }
      setStatus(d.status === "probing" ? t("Reading the link…") : t("Downloading… {percent}%", { percent: d.percent || 0 }));
    }, DOWNLOAD_POLL_MS);
  }

  /** Hold a new source, replacing the current draft's video if there is one. */
  async function importSource(source) {
    if (source.downloadId) {
      cancelImport();
      setDraft({ downloadId: source.downloadId, name: source.name || "", duration: source.duration || 0,
                 videoUrl: downloadVideoUrl(source.downloadId), speech: source.speech || null });
      return;
    }
    if (source.file) return holdFile(source.file);
    if (source.link) return holdLink(source.link, source.onReady);
  }

  // ---- the confirm dialog: importing a second video replaces the first -----
  function confirmReplace() {
    const overlay = $("mediaReplaceOverlay");
    if (!overlay) return Promise.resolve(true);   // the dialog is optional in tests
    overlay.classList.add("open");
    return new Promise((resolve) => {
      function close(ok) {
        overlay.classList.remove("open");
        $("mediaReplaceConfirmBtn").removeEventListener("click", onYes);
        $("mediaReplaceCancelBtn").removeEventListener("click", onNo);
        $("mediaReplaceCloseX").removeEventListener("click", onNo);
        resolve(ok);
      }
      function onYes() { close(true); }
      function onNo() { close(false); }
      $("mediaReplaceConfirmBtn").addEventListener("click", onYes);
      $("mediaReplaceCancelBtn").addEventListener("click", onNo);
      $("mediaReplaceCloseX").addEventListener("click", onNo);
    });
  }

  async function pickOrReplace(source) {
    const already = getDraft();
    if (already) {
      const ok = await confirmReplace();
      if (!ok) return;
    }
    return importSource(source);
  }

  // ---- the Dubbing and Save video tabs with no video: the block and its line --
  function render() {
    const d = getDraft();
    for (const id of ["dubbingImport", "saveImport"]) {
      const face = $(id);
      if (face) face.hidden = !!d || !!state.jobId;
    }
    paintVideoPane(d);
  }

  // A video file dropped on the timeline is imported the way one dropped on
  // the block is, asking first when it would replace the draft's video. Only
  // on the draft's own screen: the Erase tab has its own drop zone, and a job
  // on screen is not a draft.
  const timelineEl = $("timeline");
  const takesFile = (e) => getScreen() === "done" && !state.jobId && e.dataTransfer
    && Array.from(e.dataTransfer.types || []).includes("Files");
  if (timelineEl) {
    timelineEl.addEventListener("dragover", (e) => {
      if (!takesFile(e)) return;
      e.preventDefault();
      timelineEl.classList.add("tl-dropping");
    });
    timelineEl.addEventListener("dragleave", () => timelineEl.classList.remove("tl-dropping"));
    timelineEl.addEventListener("drop", (e) => {
      timelineEl.classList.remove("tl-dropping");
      if (!takesFile(e)) return;
      e.preventDefault();
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) pickOrReplace({ file });
    });
  }

  const fileInput = $("draftFileInput");
  if (fileInput) {
    // Opened by the Import block, there only with no video, or by Replace.
    wireImportInput(fileInput, (files) => importSource({ file: files[0] }));
    wireImportBlock($, {
      id: "dubbingZone", linkId: "dubbingLink", input: fileInput,
      // A project holds one video: the first of a drop is the one taken.
      onFiles: (files) => pickOrReplace({ file: files[0] }),
      onLink: (url) => pickOrReplace({ link: url }),
      onNotLink: (message) => setStatus(message, true),
    });
    // Save video with no video: the link field alone, fetched the same way.
    wireImportBlock($, {
      id: "saveZone", linkId: "saveLink",
      onLink: (url) => pickOrReplace({ link: url, onReady: onSaveLinkReady }),
      onNotLink: (message) => setStatus(message, true),
    });
  }

  // The line under the card is about the video on it: another one there
  // (a draft opened from Home) is not what an earlier refusal was about.
  let onCard = "";
  onDraftChange((d) => {
    if (!d) cancelImport();
    else if (d.downloadId !== onCard) setStatus("");
    onCard = d ? d.downloadId : "";
    render();
  });

  return { render, importSource: pickOrReplace, cancelImport, say: setStatus };
}
