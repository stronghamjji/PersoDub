// The work screen wears one frame under four names: a dub that is running
// ("running"), one that finished ("done"), one that stopped ("failed") and the
// Erase tab ("erase"). The stylesheet picks each one's panels by that name;
// this file keeps the left panel's tab row in step with it, and the one
// Export button (#exportBtn) at the right end of the tab row of the video
// panel that name shows (owner, 2026-10-22).
//
// What it does: lights the Erase tab while the erase screen is up and the
// Dubbing tab when a job takes the screen, and tells the page when a tab
// other than Erase, Save video or Burn in subtitles is pressed on the erase
// screen -- that is the way back to the job. Save video saves what is on
// screen, where it is; Burn in subtitles starts from that video (owner,
// 2026-10-23).
//
// The elements this file touches: #leftTabs and its buttons, #exportBtn, and
// the three video panels' tab rows (#videoTabsNormal, #runTabs, #eraseTabs).

// The tab row of the video panel each name shows (static/css/app.css): the
// finished one for a finished job and a draft, the running one for a dub that
// runs or stopped, and the Erase tab's own.
const EXPORT_ROWS = { done: "videoTabsNormal", running: "runTabs", failed: "runTabs", erase: "eraseTabs" };

/**
 * @param {object} deps
 * @param {(id: string) => any} deps.$   the page's getElementById helper
 * @param {{show: (name: string) => void, current: () => string}} deps.tabs
 *        the left panel's tabs (ui/src/leftTabs.mjs)
 * @param {() => string} deps.getScreen  the screen that is up right now
 * @param {() => void} deps.onLeaveErase  another tab was pressed on the erase
 *        screen
 * @returns {{ onScreen: (name: string) => void }}
 */
export function initWorkFrame({ $, tabs, getScreen, onLeaveErase }) {
  const row = $("leftTabs");
  let last = null;

  // Called whenever the screen's name is written, which a running dub does
  // on every report: only a change of name moves the tabs, so the tab the
  // user went to while the dub runs stays up.
  function onScreen(name) {
    if (name === last) return;
    const from = last;
    last = name;
    // Home has no video panel; the button stays, hidden, in the last row.
    if (EXPORT_ROWS[name]) $(EXPORT_ROWS[name]).append($("exportBtn"));
    if (name === "erase") { tabs.show("erase"); return; }
    if (name === "home") return;
    // A job opened from the first screen starts on its own tab; so does one
    // that takes the screen from the Erase tab, or from Captions, which a
    // running dub has nothing for, or from Save video, whose body is only
    // for a project with no video.
    if (!from || from === "home" || ["erase", "save"].includes(tabs.current())
      || (name === "running" && tabs.current() === "captions")) tabs.show("dubbing");
  }

  // After the row's own listener, which has already shown the tab's body.
  row.addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (!b || ["erase", "save", "captions"].includes(b.dataset.tab)) return;
    if (getScreen() === "erase") onLeaveErase();
  });

  onScreen(getScreen());
  return { onScreen };
}
