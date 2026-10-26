// What the What's new card and the "Version update" window show for each state
// the shell announces -- including an older shell that sends no date or notes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { updateLive, updateCardView, updateWindowView, noteLines, releaseDay, wireUpdates, whatsNewLines } from "./updateWindow.mjs";
import { DESKTOP_APP_URL } from "./edition.mjs";
import { readFileSync } from "node:fs";
import { loadTable, setLanguage } from "./i18n.mjs";

const DOWNLOADING = { version: "0.7.1", phase: "downloading", pct: 42 };
const READY = { version: "0.7.1", phase: "ready", pct: 100,
  releaseDate: "2026-09-30T12:00:00.000Z", releaseNotes: "<ul><li>ElevenLabs voices.</li><li>Erase box fits</li></ul>" };

// The top bar's update icon moved onto the Home sidebar's What's new card
// (2026-10-21): a dot while an update downloads or waits, and the title names
// it once it is on disk.
test("the card is plain What's new with no update, dotted while one downloads, and named once ready", () => {
  assert.deepEqual(updateCardView(null), { live: false, tip: "", title: "" });
  assert.deepEqual(updateCardView(undefined), { live: false, tip: "", title: "" });
  assert.deepEqual(updateCardView(DOWNLOADING), { live: true, tip: "Update available", title: "" });
  assert.deepEqual(updateCardView(READY), { live: true, tip: "Update available", title: "Update 0.7.1 is ready" });
  assert.equal(updateLive({ version: "0.7.1", phase: "something-else" }), false);
  assert.equal(updateLive({ phase: "ready" }), false, "no version, nothing to offer");
});

test("with no update the window says so and shows the running version's list", () => {
  const v = updateWindowView(null, { current: "0.7.0", currentNotes: ["One", "Two"] });
  assert.equal(v.title, "PersoDub is up to date");
  assert.equal(v.current, "Current version: 0.7.0");
  assert.equal(v.next, "");
  assert.equal(v.button, null);
  assert.deepEqual(v.notes, ["One", "Two"]);
  assert.equal(v.notesLink, null);
});

test("a check that found no answer says so, not that PersoDub is up to date", () => {
  const v = updateWindowView({ phase: "check-failed" }, { current: "0.8.5", currentNotes: ["One"] });
  assert.equal(v.title, "Could not check for updates.");
  assert.equal(v.next, "Check your internet connection, then open PersoDub again.");
  assert.equal(v.current, "Current version: 0.8.5");
  assert.equal(v.button, null);
  assert.deepEqual(v.notes, ["One"]);
  assert.equal(updateCardView({ phase: "check-failed" }).live, false);
});

// The production edition with no update address checks nothing
// (desktop/src/updateFlow.js): "up to date" would be a guess.
test("an app that did not check says only its version, never that it is up to date", async () => {
  const v = updateWindowView({ phase: "check-off" }, { current: "0.9.1", currentNotes: ["One"] });
  assert.equal(v.title, "Current version: 0.9.1");
  assert.deepEqual([v.current, v.next, v.running, v.button, v.notesLink], ["", "", "", null, null]);
  assert.deepEqual(v.notes, ["One"]);
  assert.equal(updateCardView({ phase: "check-off" }).live, false);
  const ko = JSON.parse(readFileSync(new URL("../../static/i18n/ui.ko.json", import.meta.url), "utf8"));
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ko });
  try {
    await loadTable("ko");
    setLanguage("ko");
    const kv = updateWindowView({ phase: "check-off" }, { current: "0.9.1" });
    assert.equal(kv.title, "현재 버전: 0.9.1");
    assert.ok(!kv.title.includes("최신"));
  } finally {
    globalThis.fetch = real;
    setLanguage("en");
  }
});

test("a download that broke shows no button and says what to do, and the card still has its dot", () => {
  const v = updateWindowView({ ...DOWNLOADING, phase: "download-failed" }, { current: "0.7.0", dubRunning: true });
  assert.equal(v.title, "You can update to the latest version");
  assert.equal(v.next, "New version: 0.7.1");
  assert.equal(v.button, null);
  assert.equal(v.running,
    "Could not download the update. Check your internet connection, then open PersoDub again and it downloads anew.");
  assert.deepEqual(updateCardView({ ...DOWNLOADING, phase: "download-failed" }), { live: true, tip: "Update available", title: "" });
});

test("a from-source run's 0.0.0 is not shown as a version", () => {
  assert.equal(updateWindowView(null, { current: "0.0.0" }).current, "");
});

test("while downloading the button is the percent and cannot be pressed", () => {
  const v = updateWindowView(DOWNLOADING, { current: "0.7.0" });
  assert.equal(v.title, "You can update to the latest version");
  assert.deepEqual(v.button, { label: "Downloading 42%", disabled: true });
});

test("when ready: restart button, version, day, and the notes as lines", () => {
  const v = updateWindowView(READY, { current: "0.7.0" });
  assert.deepEqual(v.button, { label: "Restart to update", disabled: false });
  assert.equal(v.next, "New version: 0.7.1");
  assert.equal(v.released, "Released on 2026-09-30");
  assert.deepEqual(v.notes, ["ElevenLabs voices.", "Erase box fits"]);
  assert.equal(v.notesLink, null);
});

test("in the production edition an update with no notes links to Perso's desktop app page", () => {
  const v = updateWindowView({ version: "0.9.1", phase: "ready", pct: 100 }, { notesPage: () => DESKTOP_APP_URL });
  assert.equal(v.notesLink, "https://perso.ai/dubbing/desktop-app");
});

test("an older shell (no date, no notes) gets no date and a link to the release", () => {
  // The releases page is the repository the build points at (app.mjs REPO_URL).
  const notesPage = (version) => `https://example.test/owner/PersoDub/releases/tag/v${version}`;
  const v = updateWindowView({ version: "0.7.1", phase: "ready", pct: 100 }, { current: "0.7.0", notesPage });
  assert.equal(v.next, "New version: 0.7.1");
  assert.equal(v.released, "");
  assert.deepEqual(v.notes, []);
  assert.equal(v.notesLink, "https://example.test/owner/PersoDub/releases/tag/v0.7.1");
});

test("a running dub is named only when an update is on offer", () => {
  assert.equal(updateWindowView(READY, { dubRunning: true }).running, "Dubbing is running. Restarting stops it.");
  assert.equal(updateWindowView(READY, { dubRunning: false }).running, "");
  assert.equal(updateWindowView(null, { dubRunning: true }).running, "");
});

test("release notes: HTML is stripped to text, never kept as markup", () => {
  assert.deepEqual(noteLines('<p>Fixes &amp; more</p><img src=x onerror="alert(1)"><script>x</script>', "1"),
    ["Fixes & more"]);
  // The column's own heading is not repeated as the first line.
  assert.deepEqual(noteLines("<h2>What&#39;s new</h2><p>A<br>B</p>", "1"), ["A", "B"]);
  assert.deepEqual(noteLines("&lt;b&gt; stays text", "1"), ["<b> stays text"]);
});

test("release notes: plain markdown lines lose their bullets and bold marks", () => {
  assert.deepEqual(noteLines("## New\n- **Voices.** ElevenLabs\n* Two\n\n", "1"), ["New", "Voices. ElevenLabs", "Two"]);
});

test("release notes: a list picks this version's note, or joins them all", () => {
  const list = [{ version: "0.7.1", note: "<p>Mine</p>" }, { version: "0.7.0", note: "Older" }];
  assert.deepEqual(noteLines(list, "0.7.1"), ["Mine"]);
  assert.deepEqual(noteLines(list, "9.9.9"), ["Mine", "Older"]);
  assert.deepEqual(noteLines([{ version: "0.7.1", note: null }], "0.7.1"), []);
});

test("release notes: nothing gives no lines", () => {
  assert.deepEqual(noteLines(null, "1"), []);
  assert.deepEqual(noteLines("", "1"), []);
  assert.deepEqual(noteLines(undefined, "1"), []);
});

// The GitHub release's description stays in English (owner, 2026-10-21): the
// window shows the new version's own list (its app/whats_new.json, which the
// shell reads) in the page's language, and the description only without it.
const WHATS_NEW = { notes: ["Faster dubbing.", "A clearer Help."], notes_ko: ["더빙이 빨라졌어요.", "도움말이 쉬워졌어요."] };

test("the new version's own list: the Korean one on a Korean page, the English one otherwise", (t) => {
  t.after(() => setLanguage("en"));
  setLanguage("ko");
  assert.deepEqual(updateWindowView({ ...READY, whatsNew: WHATS_NEW }).notes, ["더빙이 빨라졌어요.", "도움말이 쉬워졌어요."]);
  setLanguage("en");
  assert.deepEqual(updateWindowView({ ...READY, whatsNew: WHATS_NEW }).notes, ["Faster dubbing.", "A clearer Help."]);
  assert.deepEqual(whatsNewLines(WHATS_NEW, "fr"), WHATS_NEW.notes, "any other language reads the English");
  // A file with no Korean list gives its English one, as the app's own What's new does.
  assert.deepEqual(whatsNewLines({ notes: ["Faster dubbing."], notes_ko: [] }, "ko"), ["Faster dubbing."]);
});

test("without the new version's list -- not read, no file at that tag, an older shell -- the release's notes show", (t) => {
  t.after(() => setLanguage("en"));
  setLanguage("ko");
  assert.deepEqual(updateWindowView(READY).notes, ["ElevenLabs voices.", "Erase box fits"]);
  assert.deepEqual(updateWindowView({ ...READY, whatsNew: { notes: [], notes_ko: [] } }).notes, ["ElevenLabs voices.", "Erase box fits"]);
  assert.deepEqual(whatsNewLines(undefined, "ko"), []);
  // And with neither, the link to the release page, as before.
  const v = updateWindowView({ version: "0.7.1", phase: "ready", pct: 100 }, { notesPage: (version) => `https://example.test/o/r/releases/tag/v${version}` });
  assert.deepEqual(v.notes, []);
  assert.equal(v.notesLink, "https://example.test/o/r/releases/tag/v0.7.1");
});

test("release day reads an ISO date and gives up on anything else", () => {
  assert.equal(releaseDay("2026-09-30T12:00:00.000Z"), "2026-09-30");
  assert.equal(releaseDay("not a date"), "");
  assert.equal(releaseDay(undefined), "");
});

// wireUpdates on a stand-in page. The shell's announcement can come before the
// page listens -- app.mjs waits for its language first -- so the page asks the
// shell once as well (0.8.3 said "up to date" with 0.8.5 downloaded, 2026-10-17).
function standInPage() {
  const els = new Map();
  const el = () => {
    const classes = new Set();
    return {
      innerHTML: "", textContent: "", title: "", hidden: false, disabled: false, href: "", className: "",
      classList: {
        toggle(c, on = !classes.has(c)) { if (on) classes.add(c); else classes.delete(c); },
        add(c) { classes.add(c); },
        remove(c) { classes.delete(c); },
        contains(c) { return classes.has(c); },
      },
      setAttribute() {}, addEventListener() {}, replaceChildren() {},
    };
  };
  const $ = (id) => { if (!els.has(id)) els.set(id, el()); return els.get(id); };
  const saved = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  globalThis.window = { addEventListener() {} };
  globalThis.document = { addEventListener() {}, createElement: () => el(), querySelector: () => null };
  globalThis.fetch = async () => ({ ok: false });
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
  };
  return { $, restore };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test("an update announced before the page listened is asked for and offered", async () => {
  const { $, restore } = standInPage();
  try {
    let listening = false;
    const shell = { onUpdateState: () => { listening = true; }, getUpdateState: async () => READY };
    wireUpdates({ $, shell, notesPage: () => "" });
    await settle();
    assert.ok($("homeWhatsNew").classList.contains("live"), "the card has its dot");
    assert.equal($("homeWhatsNewTitle").textContent, "Update 0.7.1 is ready");
    assert.ok($("updateOverlay").classList.contains("open"), "the window opens by itself");
    assert.equal($("updGo").textContent, "Restart to update");
    assert.ok(listening, "and the page still listens for what comes next");
  } finally { restore(); }
});

test("a state the shell announced to the listener is not replaced by the answer", async () => {
  const { $, restore } = standInPage();
  try {
    const shell = { onUpdateState: (cb) => cb(READY), getUpdateState: async () => DOWNLOADING };
    wireUpdates({ $, shell, notesPage: () => "" });
    await settle();
    assert.equal($("updGo").textContent, "Restart to update");
  } finally { restore(); }
});

test("a shell with nothing to say, or without the question, leaves the card as it is", async () => {
  const { $, restore } = standInPage();
  try {
    wireUpdates({ $, shell: { onUpdateState() {}, getUpdateState: async () => null }, notesPage: () => "" });
    await settle();
    assert.equal($("homeWhatsNew").classList.contains("live"), false);
    wireUpdates({ $, shell: { onUpdateState() {} }, notesPage: () => "" });
    await settle();
    assert.equal($("homeWhatsNew").classList.contains("live"), false);
  } finally { restore(); }
});

test("a downloading update dots the card and leaves its What's new title alone", async () => {
  const { $, restore } = standInPage();
  try {
    $("homeWhatsNewTitle").textContent = "What’s new in 0.7.0";
    wireUpdates({ $, shell: { onUpdateState: (cb) => cb(DOWNLOADING) }, notesPage: () => "" });
    await settle();
    assert.ok($("homeWhatsNew").classList.contains("live"));
    assert.equal($("homeWhatsNew").classList.contains("ready"), false);
    assert.equal($("homeWhatsNewTitle").textContent, "What’s new in 0.7.0");
    assert.equal($("homeWhatsNew").title, "Update available");
  } finally { restore(); }
});
