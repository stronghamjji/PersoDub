// What every pick list of the dubbing options does the same way -- the Dubbing
// model's and the Target language's (ui/src/newProject.mjs) and the four
// stages' (ui/src/stagePicker.mjs): where the list sits, and how the keys
// move through it (the Target language's keys are its own, for its search).

/** Under the button, as wide as it (300 to 420 pixels), or over it when the
    screen has no room below -- held there by its bottom edge, so a search
    that shortens the Target language's list leaves it against the button.
    The list is fixed to the screen (app.css .model-pick-list), so the
    options panel's scrolling cannot clip it. */
export function placeList(list, btn) {
  const r = btn.getBoundingClientRect();
  list.style.left = `${r.left}px`;
  list.style.width = `${Math.min(Math.max(r.width, 300), 420)}px`;
  const below = r.bottom + 5;
  const screen = globalThis.innerHeight ?? Infinity;   // none in the tests' stand-in page
  if (below + list.offsetHeight > screen && r.top > list.offsetHeight + 5) list.style.bottom = `${screen - r.top + 5}px`;
  else list.style.top = `${below}px`;
}

/** Up and down move between the options that can be chosen; Escape closes
    the list (`close`) and not the dialog under it. The chosen option has the
    focus first. */
export function listKeys(list, close) {
  // A press on what cannot take the focus -- a greyed option, the gap
  // between two -- hands it to the list itself, so Escape still reaches it:
  // the page took it, and the list stayed open (Mac check, 2026-10-22, remark 6).
  list.tabIndex = -1;
  list.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const opts = [...list.querySelectorAll(".model-opt:not([disabled])")];
    let at = opts.indexOf(document.activeElement);
    // From the list itself Up goes to the last option, as Down goes to the first.
    if (at < 0 && e.key === "ArrowUp") at = 0;
    const next = opts[(at + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length];
    if (next) next.focus();
  });
  setTimeout(() => { list.querySelector(".model-opt.on")?.focus?.(); }, 0);
}
