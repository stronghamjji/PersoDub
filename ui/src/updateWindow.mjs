// The update's mark on the Home sidebar's What's new card and the "Version
// update" window the card opens (mockup key-update-mockup.html sections 2 and
// 3). The top bar's update icon is gone (one-line title bar, 2026-10-21): the
// card carries its red dot and, once the update is on disk, says so in its
// title. The shell downloads a new
// version in the background and announces {version, phase: "downloading" |
// "ready" | "download-failed", pct, releaseDate?, releaseNotes?, whatsNew?} as it goes (desktop/src/updater.js
// nextUpdateState); this file turns that into what the card and the window
// show. A shell built before releaseDate/releaseNotes existed sends only the
// first three -- the window then leaves out the date and links to the release
// page. Outside the desktop shell nothing is announced and the card stays
// What's new.
//
// Everything this file touches is #homeWhatsNew (its class and tip, and
// #homeWhatsNewTitle once the update is ready) and #updateOverlay.
import { t, currentLanguage } from "./i18n.mjs";

// An update exists (found and downloading, on disk, or its download broke).
export function updateLive(state) {
  return !!state?.version && ["downloading", "ready", "download-failed"].includes(state.phase);
}

// The card's dot while an update downloads or waits, and the title it takes
// once the update is on disk ("" keeps the card's own What's new).
export function updateCardView(state) {
  if (!updateLive(state)) return { live: false, tip: "", title: "" };
  return { live: true, tip: t("Update available"),
    title: state.phase === "ready" ? t("Update {version} is ready", { version: state.version }) : "" };
}

// "2026-09-30" in the viewer's own time zone, or "" for a date it cannot read.
export function releaseDay(iso) {
  const d = new Date(iso || "");
  if (Number.isNaN(d.getTime())) return "";
  const two = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (/^#x/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e[0] === "#") return String.fromCodePoint(Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Release notes as plain lines. electron-updater hands over the GitHub
// release's body as HTML, as a plain string, as a list of {version, note}, or
// as nothing. The tags are only ever stripped here; the page writes the lines
// with textContent, so nothing from the network becomes markup.
export function noteLines(notes, version) {
  if (!notes) return [];
  if (Array.isArray(notes)) {
    const own = notes.find((n) => n?.version === version);
    notes = (own ? [own] : notes).map((n) => n?.note || "").join("\n");
  }
  const text = String(notes)
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\s*\/?\s*(br|p|li|ul|ol|div|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  return decode(text).split(/\r?\n/)
    .map((l) => l.trim().replace(/^(#+|[-*•])\s+/, "").replace(/\*\*/g, "").trim())
    // The window's column already says "What's new" above the list.
    .filter((l) => l && !/^what.?s new$/i.test(l));
}

// The new version's own list of changes, which the shell reads from that
// version's app/whats_new.json (desktop/src/updater.js readWhatsNew), in the
// page's language: the Korean list on a Korean page, else the English one --
// also when the file has no Korean list, as GET /api/whats-new picks. [] when
// the shell read none; the window then shows the release's notes, which stay
// in English on GitHub (owner, 2026-10-21).
export function whatsNewLines(whatsNew, language) {
  const own = language === "ko" ? whatsNew?.notes_ko : null;
  return (own?.length ? own : whatsNew?.notes) || [];
}

/**
 * What the window shows for one state.
 * @param state      the shell's latest announcement, or null
 * @param current    the running version ("" when unknown)
 * @param currentNotes  the running version's own list (GET /api/whats-new),
 *                   shown when there is nothing newer
 * @param dubRunning whether a dub is running right now
 * @param releases   the releases page of the repository the build points at
 */
export function updateWindowView(state, { current = "", currentNotes = [], dubRunning = false, releases } = {}) {
  const shownCurrent = current && current !== "0.0.0" ? t("Current version: {version}", { version: current }) : "";
  // The shell could not reach the releases (desktop/src/updater.js): saying
  // "up to date" then was a guess, and a wrong one when an update was out.
  // It checks once a launch, so opening PersoDub again is what checks again.
  if (state?.phase === "check-failed") {
    return { title: t("Could not check for updates."), current: shownCurrent,
      next: t("Check your internet connection, then open PersoDub again."), released: "", button: null,
      running: "", notes: currentNotes, notesLink: null };
  }
  if (!updateLive(state)) {
    return { title: t("PersoDub is up to date"), current: shownCurrent, next: "", released: "", button: null,
      running: "", notes: currentNotes, notesLink: null };
  }
  const day = releaseDay(state.releaseDate);
  const own = whatsNewLines(state.whatsNew, currentLanguage());
  const notes = own.length ? own : noteLines(state.releaseNotes, state.version);
  const ready = state.phase === "ready";
  // A download that broke: no button held at its last percent, and the line
  // under it says what to do. electron-updater drops the broken file, so
  // the next launch's check downloads it anew.
  const failed = state.phase === "download-failed";
  return {
    title: t("You can update to the latest version"),
    current: shownCurrent,
    next: t("New version: {version}", { version: state.version }),
    released: day ? t("Released on {day}", { day }) : "",
    button: ready ? { label: t("Restart to update"), disabled: false }
      : failed ? null : { label: t("Downloading {pct}%", { pct: state.pct || 0 }), disabled: true },
    // A restart stops the dub: the job comes back as interrupted, with Resume
    // for a local one (app/jobs.py, app/api/dub.py) -- it does not carry on
    // by itself, so the line says only what is true for every dub.
    running: failed ? t("Could not download the update. Check your internet connection, then open PersoDub again and it downloads anew.")
      : dubRunning ? t("Dubbing is running. Restarting stops it.") : "",
    notes,
    notesLink: notes.length ? null : `${releases}/tag/v${state.version}`,
  };
}

/**
 * Wire the card's mark and the window. `shell` is window.persodubShell or
 * null, and `releases` the releases page the window links to when an update
 * has no notes. The window opens by itself once per session, the first time
 * an update is announced while no other dialog is open; after that from the
 * `persodub:open-update` event (the card's click, ui/src/homeSidebar.mjs).
 */
export function wireUpdates({ $, shell, releases }) {
  let state = null;
  let current = "";
  let currentNotes = [];
  let dubRunning = false;
  let autoShown = false;
  const card = $("homeWhatsNew");
  const overlay = $("updateOverlay");

  // The "ready" class also tells the sidebar not to put What's new back over
  // this title when its own answer comes in later (ui/src/homeSidebar.mjs).
  function paintCard() {
    const v = updateCardView(state);
    card.classList.toggle("live", v.live);
    card.classList.toggle("ready", !!v.title);
    card.title = v.tip;
    if (v.title) $("homeWhatsNewTitle").textContent = v.title;
  }
  function paint() {
    const v = updateWindowView(state, { current, currentNotes, dubRunning, releases });
    $("updTitle").textContent = v.title;
    $("updCurrent").textContent = v.current;
    // The day in a span that does not wrap, so "2026-09-30" never breaks at a hyphen.
    const day = document.createElement("span");
    day.className = "upd-day";
    day.textContent = v.released ? ` \u00b7 ${v.released}` : "";
    $("updNext").replaceChildren(v.next, day);
    $("updNext").hidden = !v.next;
    const go = $("updGo");
    go.hidden = !v.button;
    if (v.button) { go.textContent = v.button.label; go.disabled = v.button.disabled; }
    $("updRunning").textContent = v.running;
    $("updRunning").hidden = !v.running;
    $("updNotes").replaceChildren(...v.notes.map((n) => {
      const li = document.createElement("li");
      li.textContent = n;
      return li;
    }));
    const link = $("updNotesLink");
    link.hidden = !v.notesLink;
    if (v.notesLink) link.href = v.notesLink;
    $("updNotesBox").hidden = !v.notes.length && !v.notesLink;
    overlay.classList.toggle("upd-single", $("updNotesBox").hidden);
  }
  // The running version and its list, and whether a dub would be cut off:
  // read fresh each time the window opens. A failed read leaves them as they were.
  async function refresh() {
    try {
      const r = await fetch("/api/whats-new");
      if (r.ok) { const w = await r.json(); current = w.version || ""; currentNotes = w.notes || []; }
    } catch { /* keep what we had */ }
    try {
      const r = await fetch("/api/dub/jobs");
      if (r.ok) {
        const jobs = (await r.json()).jobs || [];
        dubRunning = jobs.some((j) => j.status === "running" && (j.kind || "dub") === "dub");
      }
    } catch { /* keep what we had */ }
    if (overlay.classList.contains("open")) paint();
  }
  function open() {
    paint();
    overlay.classList.add("open");
    refresh();
  }
  function close() { overlay.classList.remove("open"); }

  window.addEventListener("persodub:open-update", open);
  $("updClose").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("open")) close();
  });
  $("updGo").addEventListener("click", () => shell?.restartToUpdate?.());

  paintCard();
  const onState = (s) => {
    state = s;
    paintCard();
    if (overlay.classList.contains("open")) paint();
    else if (!autoShown && updateLive(s) && !document.querySelector(".modal-overlay.open")) {
      autoShown = true;
      open();
    }
  };
  shell?.onUpdateState?.(onState);
  // The announcement can come before this listener: app.mjs waits for the
  // page's language first, and a quick download (or one already on disk) is
  // announced, and re-sent at page load, while it waits. 0.8.3 said "up to
  // date" with 0.8.5 downloaded (2026-10-17), so the page also asks once. An
  // answer never replaces a state the listener has had since.
  shell?.getUpdateState?.().then((s) => { if (s && !state) onState(s); }, () => {});
}
