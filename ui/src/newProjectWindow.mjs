// The top bar's "+ New project" (editor-fixes mockup, section 2): a small
// window over the work screen with the Home banner's three ways in -- drop
// videos, click to choose them, or paste a link. The screen underneath stays
// as it is until a video is actually chosen. Then the open job is left the
// way Home leaves it (its id, script and timeline lanes cleared: a new draft
// once showed the old job's script over the new video), and the video goes
// where the Home banner sends it: one file or a link to its own draft,
// several to the New project dialog. A dub started while another one runs
// waits its turn (the server queues it).
//
// An empty new project has the same block on screen already, so there the
// button points at that block's link field instead of opening a second one
// over it (2026-10-21).
import { importBlockHtml, wireImportBlock, wireImportInput } from "./importBlock.mjs";
import { askForLink } from "./linkField.mjs";

/**
 * @param {object} deps
 * @param {(id: string) => any} deps.$
 * @param {(file: File) => string|null} deps.checkFile  why a file is refused, or null
 * @param {() => void} deps.leaveJob  clear the open job, as Home does
 * @param {(source: {file?: File, link?: string}) => void} deps.openDraft
 * @param {(source: {files: File[]}) => void} deps.openNewProject
 * @param {() => string|null} [deps.emptyImport]  the link id of an empty
 *        project's Import block on screen ("dubbingLink"), or null
 * @returns {{ open: () => void, close: () => void }}
 */
export function initNewProjectWindow({ $, checkFile, leaveJob, openDraft, openNewProject,
                                       emptyImport = () => null }) {
  const overlay = $("newProjOverlay");
  const input = $("newProjFileInput");
  // The shared Import block, drawn into the window's inner panel.
  $("newProjImportSlot").outerHTML = importBlockHtml("newProjDrop", "newProjLink");

  function open() {
    const here = emptyImport();
    if (here) { askForLink($(`${here}Row`), $(`${here}Input`)); return; }
    $("newProjError").textContent = "";
    $("newProjLinkInput").value = "";
    overlay.classList.add("open");
  }
  function close() { overlay.classList.remove("open"); }

  // One bad file stops the whole drop, as on Home.
  function take(list) {
    const files = Array.from(list || []);
    if (!files.length) return;
    for (const f of files) {
      const bad = checkFile(f);
      if (bad) { $("newProjError").textContent = files.length > 1 ? `${f.name}: ${bad}` : bad; return; }
    }
    close();
    leaveJob();
    if (files.length > 1) openNewProject({ files });
    else openDraft({ file: files[0] });
  }

  $("newProjectBtn").addEventListener("click", open);
  $("newProjClose").addEventListener("click", close);
  wireImportInput(input, take);
  wireImportBlock($, {
    id: "newProjDrop", linkId: "newProjLink", input, onFiles: take,
    onLink: (url) => {
      close();
      leaveJob();
      openDraft({ link: url });
    },
    onNotLink: (message) => { $("newProjError").textContent = message; },
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("open")) close();
  });

  return { open, close };
}
