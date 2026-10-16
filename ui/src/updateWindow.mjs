// The update icon in the top bar and the "Version update" window it opens
// (mockup key-update-mockup.html sections 2 and 3). The shell downloads a new
// version in the background and announces {version, phase: "downloading" |
// "ready", pct, releaseDate?, releaseNotes?} as it goes (desktop/src/updater.js
// nextUpdateState); this file turns that into what the icon and the window
// show. A shell built before releaseDate/releaseNotes existed sends only the
// first three -- the window then leaves out the date and links to the release
// page. Outside the desktop shell nothing is announced and the icon stays grey.
//
// Everything this file touches is #updateBtn and #updateOverlay.
import { lucide } from "./icons.mjs";
import { t } from "./i18n.mjs";

// An update exists (found and downloading, or on disk).
export function updateLive(state) {
  return !!state?.version && (state.phase === "downloading" || state.phase === "ready");
}

export function updateIconView(state) {
  return updateLive(state)
    ? { live: true, title: t("Update available") }
    : { live: false, title: t("Updates") };
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
  if (!updateLive(state)) {
    return { title: t("PersoDub is up to date"), current: shownCurrent, next: "", released: "", button: null,
      running: "", notes: currentNotes, notesLink: null };
  }
  const day = releaseDay(state.releaseDate);
  const notes = noteLines(state.releaseNotes, state.version);
  const ready = state.phase === "ready";
  return {
    title: t("You can update to the latest version"),
    current: shownCurrent,
    next: t("New version: {version}", { version: state.version }),
    released: day ? t("Released on {day}", { day }) : "",
    button: ready ? { label: t("Restart to update"), disabled: false }
                  : { label: t("Downloading {pct}%", { pct: state.pct || 0 }), disabled: true },
    // A restart stops the dub: the job comes back as interrupted, with Resume
    // for a local one (app/jobs.py, app/api/dub.py) -- it does not carry on
    // by itself, so the line says only what is true for every dub.
    running: dubRunning ? t("Dubbing is running. Restarting stops it.") : "",
    notes,
    notesLink: notes.length ? null : `${releases}/tag/v${state.version}`,
  };
}

/**
 * Wire the icon and the window. `shell` is window.persodubShell or null, and
 * `releases` the releases page the window links to when an update has no notes.
 * The window opens by itself once per session, the first time an update is
 * announced while no other dialog is open; after that only from the icon,
 * or from the `persodub:open-update` event (the Home sidebar's card).
 */
export function wireUpdates({ $, shell, releases }) {
  let state = null;
  let current = "";
  let currentNotes = [];
  let dubRunning = false;
  let autoShown = false;
  const btn = $("updateBtn");
  const overlay = $("updateOverlay");
  btn.innerHTML = lucide("circle-arrow-up", 16);

  function paintIcon() {
    const v = updateIconView(state);
    btn.classList.toggle("live", v.live);
    btn.title = v.title;
    btn.setAttribute("aria-label", v.title);
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

  btn.addEventListener("click", open);
  window.addEventListener("persodub:open-update", open);
  $("updClose").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("open")) close();
  });
  $("updGo").addEventListener("click", () => shell?.restartToUpdate?.());

  paintIcon();
  const onState = (s) => {
    state = s;
    paintIcon();
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
