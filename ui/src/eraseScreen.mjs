// The Erase subtitles screen: one section wearing three faces in turn -- drop a
// video, drag a box over the burned-in subtitles, then the erased video beside
// the one that came in. The rail's third icon opens it, and so does the New
// project dialog's "Erase subtitles" button, which hands over the video the app
// is already holding rather than a second copy of it.
//
// What is NOT here: the pure geometry and the wording of the estimate live in
// ui/src/eraseArea.mjs, and every request this screen makes is one of the erase
// helpers in ui/src/dubApi.mjs. This file is the wiring in between -- which of
// the three faces is up, and what each button does.
//
// Everything this file touches is #screen-erase and the top bar's two erase
// buttons, which setTopbar hides for every other screen.
import { uploadDownload, downloadVideoUrl } from "./dubApi.mjs";

/**
 * Wire the Erase subtitles screen to a page.
 *
 * @param {object} deps
 * @param {(id: string) => any} deps.$  the page's getElementById helper
 * @param {(name: string) => void} deps.showScreen  the page's one way to swap screens
 * @param {(opts: object) => void} deps.setTopbar   the page's one top bar
 * @param {(file: File) => string|null} deps.checkFile  the home screen's own
 *        "is this a video we can take?" -- one rule for both ways in
 * @returns the operations the rest of the page calls.
 */
export function initEraseScreenUi({ $, showScreen, setTopbar, checkFile }) {
  // The video being worked on: the id the app holds it under, what to call it,
  // and how long it is (the estimate is made from that length).
  let source = null;

  // A file played from memory while its length is read costs an object URL.
  let objectUrl = null;
  function releaseVideo() {
    const v = $("eraseVideo");
    v.pause();
    v.removeAttribute("src");
    v.load();
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  }

  // ---- The three faces ------------------------------------------------------

  /** Nothing chosen yet: the drop zone, and a top bar that says where you are. */
  function showDrop() {
    source = null;
    releaseVideo();
    $("eraseError").textContent = "";
    $("eraseDrop").hidden = false;
    $("eraseBody").hidden = true;
    setTopbar({ title: "Erase subtitles", back: true });
  }

  /** A video is in the app's hands: play it and name it in the top bar. */
  function showVideo() {
    $("eraseDrop").hidden = true;
    $("eraseBody").hidden = false;
    releaseVideo();
    $("eraseVideo").src = downloadVideoUrl(source.downloadId);
    setTopbar({ title: source.title || "Erase subtitles", subtitle: "Erase subtitles", back: true });
  }

  // ---- The two ways in ------------------------------------------------------

  /** The rail icon: the screen with nothing on it yet. */
  function openErase() {
    showScreen("erase");
    showDrop();
  }

  /**
   * The New project dialog's Erase subtitles button: the app is already
   * holding this video, so there is nothing to upload and nothing to wait for.
   */
  function openEraseWith({ downloadId, title, duration_sec }) {
    if (!downloadId) return;
    showScreen("erase");
    $("eraseError").textContent = "";
    source = { downloadId, title: title || "", duration: duration_sec || 0 };
    showVideo();
  }

  // A dropped file goes into the same holding area a link lands in, so from
  // here on both ways in are one id. The length is read from the file itself
  // first -- the record keeps it, and the estimate is made from it.
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
    showVideo();
  }

  // How long a file is, read by the same <video> that will show it. 0 when the
  // browser cannot say -- the estimate then has nothing to offer, and says so.
  function lengthOf(file) {
    return new Promise((resolve) => {
      const v = $("eraseVideo");
      releaseVideo();
      objectUrl = URL.createObjectURL(file);
      v.addEventListener("loadedmetadata", () => resolve(Number.isFinite(v.duration) ? v.duration : 0),
                         { once: true });
      v.addEventListener("error", () => resolve(0), { once: true });
      v.src = objectUrl;
    });
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
