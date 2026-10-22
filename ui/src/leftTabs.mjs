// The tabs across the top of the finished screen's left panel (new-layout
// mockup, user 2026-09-29), in Home's order (owner, 2026-10-22): Dubbing,
// Audio, Erase, and Captions last, named Subtitle style. Dubbing, Audio and
// Captions each show their own body under the row -- #tabDubbing, #tabAudio,
// #tabCaptions -- and hide the others. Erase has no body: it is the way to
// the erase screen, so pressing it runs onErase and leaves the row as it was.
//
// A new tool is a new tab: a button with data-tab="<name>" in #leftTabs and a
// body with id "tab" + <Name>. Nothing here needs to change for it.
//
// A tab with nothing to show yet can be locked (setLocked): it is dimmed,
// cannot be opened, and says why as its tip. Captions is, until there is a dub.
//
// The elements this file touches: #leftTabs, its buttons, and the tab bodies.

const bodyId = (name) => "tab" + name[0].toUpperCase() + name.slice(1);

/**
 * Wire the left panel's tabs to a page.
 *
 * @param {object} deps
 * @param {(id: string) => any} deps.$   the page's getElementById helper
 * @param {() => void} deps.onErase      what the Erase tab does
 * @returns {{ show: (name: string) => void, current: () => string,
 *   setLocked: (name: string, locked: boolean, why?: string) => void }}
 */
export function initLeftTabs({ $, onErase }) {
  const row = $("leftTabs");
  const buttons = [...row.querySelectorAll("[data-tab]")];
  let current = "dubbing";

  const button = (name) => buttons.find((b) => b.dataset.tab === name);

  function show(name) {
    // A locked tab cannot be opened, whoever asks.
    if (button(name) && button(name).disabled) return;
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
    else show(b.dataset.tab);
  });

  /** Dim a tab and keep it shut, with `why` as its tip; or open it again. If
      it was the tab on show, Dubbing takes its place. */
  function setLocked(name, locked, why = "") {
    const b = button(name);
    if (!b) return;
    b.disabled = locked;
    b.title = locked ? why : "";
    if (locked && current === name) show("dubbing");
  }

  show(current);
  return { show, current: () => current, setLocked };
}
