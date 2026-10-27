// What's new: the release notes of the version just installed. After an
// update the page says so in one line ("Updated to 0.4.4 · What's new · x")
// until it is closed, and the notes open from there or from Settings > About.
// Which version was last seen is kept in the browser's storage. Lifted out of
// the page's script unchanged (2026-10-10).
//
// The elements this file touches: #updatedNotice (#updatedText,
// #updatedWhatsNew, #updatedClose), #whatsNewOverlay (#wnTitle, #wnList,
// #wnOk) and #aboutVersion.
import { t } from "./i18n.mjs";
import { record as recordStep } from "./events.mjs";

/**
 * Wire the notice and the notes window, and ask the app which version this is.
 *
 * @param {object} deps
 * @param {(id: string) => any} deps.$   the page's getElementById helper
 */
export function initWhatsNew({ $, record = recordStep }) {
  // What's new: shown once after an update. A fresh install only records the
  // version (everything is new to a new user); Settings > About reopens it.
  const WHATS_NEW_SEEN = "pd.whatsNewSeen";
  // The last version update_installed was recorded for (the charts,
  // ui/src/events.mjs): the notice stays launch after launch, the step once.
  const UPDATE_RECORDED = "pd.updateRecorded";
  let whatsNew = null;
  function showWhatsNew() {
    if (!whatsNew || !whatsNew.notes.length) return;
    // "in PersoDub 0.4.4", the way Chrome and Adobe name a release: alone, the
    // number said nothing (user, 2026-09-02).
    $("wnTitle").textContent = t("What\u2019s new in {app} {version}", { version: whatsNew.version });
    $("wnList").replaceChildren(...whatsNew.notes.map((n) => {
      const li = document.createElement("li");
      li.textContent = n;
      return li;
    }));
    $("whatsNewOverlay").classList.add("open");
  }
  async function checkWhatsNew() {
    try {
      const r = await fetch("/api/whats-new");
      if (!r.ok) return;
      whatsNew = await r.json();
    } catch { return; }
    if (!whatsNew.version || whatsNew.version === "0.0.0") return;
    let seen = null;
    try { seen = localStorage.getItem(WHATS_NEW_SEEN); } catch { return; }
    if (seen === null) {
      try { localStorage.setItem(WHATS_NEW_SEEN, whatsNew.version); } catch { /* fine */ }
      return;
    }
    if (seen === whatsNew.version) return;
    try {
      if (localStorage.getItem(UPDATE_RECORDED) !== whatsNew.version) {
        localStorage.setItem(UPDATE_RECORDED, whatsNew.version);
        record("update_installed", { version: whatsNew.version });
      }
    } catch { /* private window: no step */ }
    // Not marked seen here: the banner stays, launch after launch, until the
    // person closes it or opens the list (user, 2026-09-08 -- the six-second
    // version was gone before anyone looked up from the Updating screen).
    showUpdatedNotice();
  }
  // "Updated to 0.4.4 · What's new · ×": stays until closed. Adobe and the App
  // Store call the list "What's new", so the link does too.
  function hideUpdatedNotice() {
    $("updatedNotice").hidden = true;
    try { if (whatsNew && whatsNew.version) localStorage.setItem(WHATS_NEW_SEEN, whatsNew.version); } catch { /* fine */ }
  }
  function showUpdatedNotice() {
    $("updatedText").textContent = t("Updated to {version}", { version: whatsNew.version });
    $("updatedNotice").hidden = false;
  }
  $("updatedWhatsNew").addEventListener("click", () => { hideUpdatedNotice(); showWhatsNew(); });
  $("updatedClose").addEventListener("click", hideUpdatedNotice);
  $("wnOk").addEventListener("click", () => {
    try { localStorage.setItem(WHATS_NEW_SEEN, whatsNew.version); } catch { /* fine */ }
    $("whatsNewOverlay").classList.remove("open");
  });
  $("aboutVersion").addEventListener("click", showWhatsNew);
  checkWhatsNew();
}
