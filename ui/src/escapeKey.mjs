// Escape and "one menu at a time", for the whole page.
//
// Every dialog used to listen for Escape by itself, and each asked only "am I
// open?". So six dialogs had no Escape at all (What's new, the ChatGPT sign-in,
// the download window, out of credits, replace media, out of space), and with
// two dialogs stacked one press closed the one UNDERNEATH: the New project
// window vanished while the sign-in on top of it stayed. The rule is here
// once instead: Escape closes what is on top, and only that, by pressing that
// dialog's own way out -- so whatever its Cancel does, Escape does too.
//
// The same for menus. Their buttons stop their click from travelling
// (so that the press that opens a menu is not also the "click outside" that
// closes it), which meant every OTHER menu never heard the click either, and
// one menu stood open beside another. A press on one menu's button now
// reaches the others as the click outside it always was.
//
// A press on the dimmed backdrop is Escape by another hand (the dialog rule,
// 2026-09-30): it presses the same way out, so a dialog that is working (its
// way out disabled or gone) stays where it is under both.

// Dialog -> the button that is its way out, first one on screen wins.
export const WAYS_OUT = {
  projectOverlay: ["projectClose"],
  exportOverlay: ["exportCloseBtn"],
  whatsNewOverlay: ["wnOk"],
  helpOverlay: ["helpOk"],
  updateOverlay: ["updClose"],
  chatgptSignInOverlay: ["csCancel"],
  keyOverlay: ["keyCancel"],
  modelsNeededOverlay: ["mnHide", "mnCancel"],
  settingsOverlay: ["settingsCancelBtn"],
  settingsDiscardOverlay: ["settingsDiscardKeep"],
  creditOverlay: ["creditCloseBtn"],
  cancelDubOverlay: ["cancelDubKeepBtn"],
  deleteOverlay: ["deleteCancelBtn"],
  mediaReplaceOverlay: ["mediaReplaceCancelBtn"],
  newProjOverlay: ["newProjClose"],
  spaceOverlay: ["spaceCloseBtn"],
};

// Button -> the menu it opens. Each of these buttons stops its own click.
export const MENU_BUTTONS = [
  ["#ratioBtn", ["ratioMenu"]],
  ["#previewBtn", ["previewMenu"]],
  ["#subStyleChip", ["videoStylePop"]],
  [".proj-more", ["projectCardMenu"]],
];

/** Of the dialogs that are open, the one drawn on top: the highest z-index,
    and between equals the one later in the page. `open` is
    [{id, z, order}, ...]; returns an id, or null for none. */
export function topOverlay(open) {
  let top = null;
  for (const o of open) {
    if (!top || o.z > top.z || (o.z === top.z && o.order > top.order)) top = o;
  }
  return top ? top.id : null;
}

export function initEscapeKey({ doc = document, win = window, zOf = (el) => Number(win.getComputedStyle(el).zIndex) || 0 } = {}) {
  // Hidden itself, or inside something that is.
  const shown = (el) => !!el && !el.hidden && !(el.closest && el.closest("[hidden]"));

  // Press a dialog's way out, if it has one to press right now.
  function leave(id) {
    const out = (WAYS_OUT[id] || []).map((b) => doc.getElementById(b)).find((b) => shown(b) && !b.disabled);
    if (out) out.click();
  }

  function closeTopDialog() {
    const open = [...doc.querySelectorAll(".modal-overlay.open")]
      .map((el, order) => ({ id: el.id, z: zOf(el), order }));
    const id = topOverlay(open);
    if (!id) return false;
    // A dialog with nothing to press at this moment (the sign-in's last
    // second, when it closes itself) keeps the key to itself all the same:
    // Escape must not reach through it to the dialog underneath.
    leave(id);
    return true;
  }

  // The backdrop: a press that both began and ended on the dimmed part. One
  // that began inside the dialog (text dragged out of a field) is not a
  // press on the backdrop. Asked before the dialogs' own backdrop listeners,
  // which never hear it.
  const isBackdrop = (el) => !!el && !!el.classList && el.classList.contains("modal-overlay")
    && el.classList.contains("open");
  let pressed = null;
  doc.addEventListener("mousedown", (e) => { pressed = e.target; }, true);
  doc.addEventListener("click", (e) => {
    if (!isBackdrop(e.target)) return;
    e.stopPropagation();
    if (pressed === e.target) leave(e.target.id);
  }, true);

  // On the window and in the capture phase, so it is asked before any dialog's
  // own listener -- those stay as they are and simply never see a key this
  // has already answered.
  win.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.isComposing) return;
    if (closeTopDialog()) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  doc.addEventListener("click", (e) => {
    const target = e.target;
    if (!target || !target.closest) return;
    const hit = MENU_BUTTONS.find(([button]) => target.closest(button));
    if (!hit) return;
    // Its own menu open: this press is the one that closes it, as before.
    if (hit[1].some((m) => shown(doc.getElementById(m)))) return;
    doc.body.click();
  }, true);
}
