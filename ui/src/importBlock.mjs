// The one Import block (import-unify mockup): the Home banner's composition at
// a panel's size -- a square plus and "Import", "Drop videos here, or click to
// choose", and a link field with its icon and words centred, where a paste or
// Enter adds the link. The Dubbing, Audio and Erase tabs with no video and the New
// project window all draw this and wire it here, so they cannot drift apart
// again. A click anywhere on it opens the file picker, a drop hands the
// files on, and the ring shows only while something is dragged over it.
import { lucide } from "./icons.mjs";
import { isLink, NOT_A_LINK } from "./linkField.mjs";
import { t } from "./i18n.mjs";

// The block's colours: "dark" is the dashed dark card, "blue" the Home
// banner's own gradient. One word here changes all three places.
export const IMPORT_VARIANT = "dark";

/** The block's markup: #<id> around the words and the link field
    #<linkId>Row > #<linkId>Input. `linkOnly`: the link field alone in the
    same dashed block, with no words and nothing to click or drop. */
export function importBlockHtml(id, linkId, variant = IMPORT_VARIANT, linkOnly = false) {
  if (linkOnly) return `<div class="import-block link-only" id="${id}">` + linkFieldHtml(linkId) + `</div>`;
  return `<div class="import-block${variant === "blue" ? " import-blue" : ""}" id="${id}" tabindex="0">`
    + `<div class="import-head"><span class="import-plus">${lucide("plus", 12)}</span>${t("Import")}</div>`
    + `<div class="import-sub">${t("Drop videos here, or click to choose")}</div>`
    + linkFieldHtml(linkId)
    + `</div>`;
}

function linkFieldHtml(linkId) {
  return `<label class="import-link" id="${linkId}Row">${lucide("link", 14)}`
    + `<input id="${linkId}Input" type="url" placeholder="${t("Paste a YouTube, TikTok or Reels link")}" autocomplete="off"></label>`;
}

// A tab with no video yet says what it is for, in the Home cards' words: a
// heading, one short sentence, and the Import block under them. The tabs
// draw this one group, so they are the same thing in the same place. Save
// video's block is its link field alone: it saves a video from a link
// (owner, 2026-10-24).
// Getters, so each read is in the page's language at that moment.
export const EMPTY_TABS = {
  get dubbing() { return [t("Dubbing"), t("Voice a video in another language.")]; },
  get erase() { return [t("Erase subtitles"), t("Takes burned-in subtitles out.")]; },
  get captions() { return [t("Burn in subtitles"), t("Burns subtitles into a video.")]; },
  get save() { return [t("Save video"), t("Saves a video from a link.")]; },
};

/** The empty tab's group: heading, sentence, then the block #<id>. */
export function emptyTabHtml(tab, id, linkId) {
  const [heading, sentence] = EMPTY_TABS[tab];
  return `<div class="tab-empty-title">${heading}</div>`
    + `<div class="tab-empty-sub">${sentence}</div>`
    + importBlockHtml(id, linkId, IMPORT_VARIANT, tab === "save");
}

/**
 * Wire a block drawn by importBlockHtml(id, linkId).
 *
 * @param {(id: string) => any} $
 * @param {object} o
 * @param {string} o.id
 * @param {string} o.linkId
 * @param {any} [o.input]  the hidden <input type=file> the block opens; none
 *        for a link-only block, which takes no click and no drop
 * @param {(files: File[]) => void} o.onFiles  dropped files, never empty
 * @param {(url: string) => void} o.onLink  a link pasted (or typed) and left 400 ms, or Enter on one
 * @param {(message: string) => void} o.onNotLink  Enter on anything else typed
 */
export function wireImportBlock($, { id, linkId, input, onFiles, onLink, onNotLink }) {
  const block = $(id);
  if (!block) return;
  if (input) {
    block.addEventListener("click", () => input.click());
    block.addEventListener("keydown", (e) => {
      if (e.target === block && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); input.click(); }
    });
    for (const ev of ["dragenter", "dragover"]) {
      block.addEventListener(ev, (e) => { e.preventDefault(); block.classList.add("drag-over"); });
    }
    block.addEventListener("dragleave", () => block.classList.remove("drag-over"));
    block.addEventListener("drop", (e) => {
      e.preventDefault();
      block.classList.remove("drag-over");
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (files.length) onFiles(files);
    });
  }
  // The link field sits inside the block: a click in it is for typing, not
  // for the file picker.
  const field = $(`${linkId}Input`);
  $(`${linkId}Row`).addEventListener("click", (e) => e.stopPropagation());
  // A paste (or a dropped address) arrives as one input event with the whole
  // address in it, and starts by itself after a short wait, so a second paste
  // over it does not start the first. Typing is left to Enter: a wait alone,
  // as on Home, started a link typed by hand at the first pause, cut short
  // (review, 2026-10-09). Something that is not a link says nothing until
  // Enter: no telling people off mid-word (owner, 2026-10-09).
  let pasted = null;
  field.addEventListener("input", (e) => {
    clearTimeout(pasted);
    const url = field.value.trim();
    if (!/^insertFrom(Paste|Drop)$/.test(e.inputType || "")) return;
    if (isLink(url)) pasted = setTimeout(() => onLink(url), 400);
  });
  // An Enter out of habit after the paste has already started the link is
  // each receiver's to ignore (the "already on its way" check in
  // draftImport's holdLink and eraseScreen's takeLink).
  field.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    clearTimeout(pasted);   // Enter starts it now, not again 400 ms later
    const typed = field.value.trim();
    if (isLink(typed)) onLink(typed);
    else if (typed) onNotLink(t(NOT_A_LINK));
  });
}

/** The file input's side, wired once per input. Picking the same file twice fires twice. */
export function wireImportInput(input, onFiles) {
  input.addEventListener("change", () => {
    const files = Array.from(input.files || []);
    input.value = "";
    if (files.length) onFiles(files);
  });
}
