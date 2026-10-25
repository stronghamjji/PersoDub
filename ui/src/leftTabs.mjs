// The tabs across the top of the finished screen's left panel (new-layout
// mockup, user 2026-09-29), in Home's order (owner, 2026-10-23): Dubbing,
// Erase, Captions (named Burn in subtitles) and Save video. Dubbing and
// Captions each show their own body under the row -- #tabDubbing,
// #tabCaptions -- and hide the others. Erase and Save video run onErase or
// onSave and leave the row as it was: Erase is the way to the erase screen,
// Save video saves the project's video. With no video yet onSave shows Save
// video's own body, #tabSave, a link field (ui/src/app.mjs).
//
// A new tool is a new tab: a button with data-tab="<name>" in #leftTabs and a
// body with id "tab" + <Name>. Nothing here needs to change for it.
//
// The elements this file touches: #leftTabs, its buttons, and the tab bodies.

const bodyId = (name) => "tab" + name[0].toUpperCase() + name.slice(1);

/**
 * Wire the left panel's tabs to a page.
 *
 * @param {object} deps
 * @param {(id: string) => any} deps.$   the page's getElementById helper
 * @param {() => void} deps.onErase      what the Erase tab does
 * @param {() => void} [deps.onSave]     what the Save video tab does
 * @returns {{ show: (name: string) => void, current: () => string }}
 */
export function initLeftTabs({ $, onErase, onSave = () => {} }) {
  const row = $("leftTabs");
  const buttons = [...row.querySelectorAll("[data-tab]")];
  let current = "dubbing";

  function show(name) {
    current = name;
    for (const b of buttons) {
      const on = b.dataset.tab === name;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
      const body = $(bodyId(b.dataset.tab));
      if (body) body.hidden = !on;
    }
  }

  row.addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (!b) return;
    if (b.dataset.tab === "erase") onErase();
    else if (b.dataset.tab === "save") onSave();
    else show(b.dataset.tab);
  });

  show(current);
  return { show, current: () => current };
}
