// The page's script. static/index.html imports it from its one inline module
// block, which it used to be: it was lifted out unchanged (2026-10-10), so the
// order below is still the order the page starts in, and that order is
// behaviour. initEscapeKey() runs first, so Escape is answered before any
// dialog's own listener; openLastScreen() runs last, once everything it can
// open is wired; and the hooks assigned further down (workFrame,
// leaveEraseTimeline, fitWorkLayout, showAudioLanes, dubRestart) are read only
// when called, or checked for null first.
//
// Its imports are "./x.mjs": app/main.py stamps that form (and "/js/x.mjs")
// with the launch token, so an update never runs this file against a module a
// browser kept from the version before.
import { LANGUAGES, buildDubFormData, startDubJob, pollDubJob, cancelDubJob, parseProgress, applyEngineAvailability, probeSource, engineChips, engineLine, voiceLabel, dubAgainSource, holdDownload, downloadVideoUrl } from "./dubApi.mjs";
import { gb, neededModelId, neededPackIds, modelStatusLine, downloadChipText } from "./modelsUi.mjs";
import { initModelsUi } from "./modelsDialog.mjs";
import { initSubtitleOverlay } from "./subtitleOverlay.mjs";
import { initEscapeKey } from "./escapeKey.mjs";
// Escape closes what is on top, and one menu is open at a time
// (ui/src/escapeKey.mjs). First, so it is asked before every dialog's own listener.
initEscapeKey();
import { initSettingsUi } from "./settingsDialog.mjs";
import { initWhatsNew } from "./whatsNew.mjs";
import { initKeyWindow } from "./keyWindow.mjs";
import { initChatgptSignIn } from "./chatgptSignIn.mjs";
import { initNewProjectUi } from "./newProject.mjs";
import { initEraseScreenUi, PACK_ID as ERASER_PACK_ID } from "./eraseScreen.mjs";
import { initProjectsUi, shownName } from "./projects.mjs";
import { initHomeScreen } from "./homeScreen.mjs";
import { initHomeSidebar, homeAgentHidden, openHomeAgent } from "./homeSidebar.mjs";
import { countedOnce } from "./reportedOnce.mjs";
import { initRunningScreenUi, stoppedMark } from "./runningScreen.mjs";
import { translatorChoices } from "./translatorChoice.mjs";
import { initScriptTableUi } from "./scriptTable.mjs";
import { scriptChecker } from "./scriptWatch.mjs";
import { initTimelineUi, TL_LABEL_PX } from "./timeline.mjs";
import { playRange, cancelRange } from "./playRange.mjs";
import { initDonePlayer } from "./donePlayer.mjs";
import { initLeftTabs } from "./leftTabs.mjs";
import { initWorkFrame } from "./workFrame.mjs";
import { initPlayerFoot, clockLine } from "./playerFoot.mjs";
import { initDraftImport } from "./draftImport.mjs";
import { initAudioTab } from "./audioTab.mjs";
import { openSeparated } from "./dubApi.mjs";
import { initNewProjectWindow } from "./newProjectWindow.mjs";
import { initDraftSetup } from "./draftSetup.mjs";
import { initLanguageRow } from "./languageRow.mjs";
import { initConfirmDialogs } from "./confirmDialogs.mjs";
import { initExportDialog } from "./exportDialog.mjs";
import { clearDraft, getDraft, onDraftChange, setDraft, setRanges, setDraftRatio } from "./draft.mjs";
import { readKept, keepDraft, dropKept, draftMark } from "./keptDrafts.mjs";
import { initRatioUi } from "./ratio.mjs";
import { wireUpdates } from "./updateWindow.mjs";
import { fmtClock, fmtClockTenths, fmtLength, formatBytes, escapeHtml, errorText, serverText, statusParts, rawLogLines, restartFailure } from "./format.mjs";
import { languageName, pageLanguage, savedSettings, t } from "./i18n.mjs";
import { paintMarkupWords } from "./markupWords.mjs";

// The language before anything is drawn, so the first paint is already in it
// (ui/src/i18n.mjs; capped, so a slow answer only means starting in English).
// The markup's words that cannot carry data-i18n follow it (ui/src/markupWords.mjs).
await pageLanguage();
paintMarkupWords();

const $ = (id) => document.getElementById(id);

// ---------------- localStorage-backed settings ---------------------------
// The API keys moved to the backend: GET/POST /api/settings (app/main.py's
// settings_get/settings_post) reads and writes kit.env. What is left in this
// block is client-side only -- the one-time cleanup of the key values this
// localStorage entry used to hold, and dropping the old job-history key.
const SETTINGS_KEY = "persodub_settings";
const HISTORY_KEY = "persodub_job_history";

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
  catch { return {}; }
}
function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }
// One-time cleanup: the pre-2026-08-04 flow stored key VALUES in localStorage.
{
  const s = loadSettings();
  if ("persoApiKey" in s || "geminiApiKey" in s) {
    delete s.persoApiKey; delete s.geminiApiKey; saveSettings(s);
  }
}
// (The Defaults section is gone: the Upload form always opens on the shipped
// defaults, so the stored defaultTranslateEngine/defaultQualityMode values --
// and the migrateStoredSettings pass that guarded them -- no longer apply.)

// The job list used to live here too, and so was lost the moment the user
// opened the app on another day or cleared their browser data. The server now
// keeps a job.json beside every video, so GET /api/dub/jobs is the list and
// this key is dead weight -- dropped once, on launch.
localStorage.removeItem(HISTORY_KEY);

// ---------------- App state ----------------
const state = {
  linkProbe: null,    // {url, title, duration_sec, thumbnail_url} once a link probes OK
  newProject: null,   // {file, probe, trim} -- what the New project dialog is working on
  jobId: null,
  job: null,
  pollGeneration: 0, // bumped whenever we switch jobs, so a stale poll loop stops itself
};

// ---------------- The left panel: the top bar's left pane button -----------
// Projects moved to the Home screen (new-layout mockup, user 2026-09-29);
// #paneList now shows/hides the whole left panel -- #leftTabs and whichever
// tab body is on show -- the way the mockup's left-panel toggle does. The
// projects sidebar this used to open (#historySidebar) is not opened by
// anything any more; it stays as the markup left it, collapsed.
const LEFT_PANEL_OPEN_KEY = "persodub.layout.leftPanelOpen";
$("paneList").addEventListener("click", () => {
  $("scriptPane").hidden = !$("scriptPane").hidden;
  try { localStorage.setItem(LEFT_PANEL_OPEN_KEY, $("scriptPane").hidden ? "0" : "1"); } catch { /* private window */ }
});
// Closed at launch only if it was closed when the app was closed (the markup starts it open).
try {
  if (localStorage.getItem(LEFT_PANEL_OPEN_KEY) === "0") $("scriptPane").hidden = true;
} catch { /* private window */ }

// ---------------- Topbar pane buttons ----------------
// Pressed = open. The agent one presses the agent strip's fold, so this stays
// a remote and never a second source of truth; the observers below repaint
// whichever way a panel was toggled. The timeline exists only on the done
// screen, so its button dims elsewhere.
// Home and New project stand in the left panel's tab row; with that panel
// hidden they move to the top bar as icon buttons, their words on the tip.
function placeWaysOut() {
  const inBar = $("scriptPane").hidden;
  const home = $("homeBtn"), fresh = $("newProjectBtn");
  if (inBar === (home.parentElement === $("topbarWays"))) return;
  if (inBar) $("topbarWays").append(home, fresh);
  else { $("leftTabs").prepend(home); $("leftTabs").append(fresh); }
  home.title = inBar ? t("Home") : "";
  fresh.title = inBar ? t("New project") : "";
}
function paintPanes() {
  placeWaysOut();
  $("paneList").classList.toggle("on", !$("scriptPane").hidden);
  $("paneAgent").classList.toggle("on", document.body.classList.contains("agent-open")
    && !homeAgentHidden(document.body));
  // A running dub and the Erase tab have a panel of their own in its place.
  const done = ["done", "running", "erase"].includes(document.body.dataset.screen);
  $("paneTimeline").disabled = !done;
  $("paneTimeline").title = done ? t("Timeline") : t("Timeline: open a project first");
  // The left panel is the work screen's; on Home this button had nothing to
  // show or hide, yet lit up and quietly changed what the next project opened
  // with. Dim there, with the reason on its tip (2026-09-30).
  const home = document.body.dataset.screen === "home";
  $("paneList").disabled = home;
  $("paneList").title = home ? t("Left panel: open a project first") : t("Left panel");
  if (home) $("paneList").classList.remove("on");
  $("paneTimeline").classList.toggle(
    "on", done && !document.body.classList.contains("timeline-off"));
}
// On Home the column is held back until asked for (ui/src/homeSidebar.mjs).
$("paneAgent").addEventListener("click", () => {
  if (homeAgentHidden(document.body)) openHomeAgent($, document.body);
  else $("assistantFold").click();
});
$("paneTimeline").addEventListener("click", () => {
  if ($("paneTimeline").disabled) return;
  document.body.classList.toggle("timeline-off");
});
new MutationObserver(paintPanes).observe(document.body,
  { attributes: true, attributeFilter: ["class", "data-screen"] });
new MutationObserver(paintPanes).observe($("scriptPane"),
  { attributes: true, attributeFilter: ["hidden"] });
paintPanes();
// On a window squeezed too narrow the agent column folds first; the pane
// button reopens it. Only on the way DOWN through the line, so reopening it
// on a small window is respected.
let paneWasNarrow = window.innerWidth < 1080;
window.addEventListener("resize", () => {
  const narrow = window.innerWidth < 1080;
  if (narrow && !paneWasNarrow && document.body.classList.contains("agent-open")) {
    $("assistantFold").click();
  }
  paneWasNarrow = narrow;
});

// ---------------- Settings modal ----------------
// The sheet itself is ui/src/settingsDialog.mjs -- it owns everything inside
// #settingsOverlay: the API keys, the Perso workspace picker, Storage, the
// usage-counts switch and the About lines. What stays on this page are the
// ways IN (the gear below, the Advanced-options keys link, the models dialog
// and the out-of-credits popup all call settings.openSettings()) and the two
// things the sheet reaches back for: re-checking which engines a saved key
// makes usable, and the Models catalog, which modelsDialog.mjs paints.
const settings = initSettingsUi({
  $,
  onSaved: () => applyEngineAvailabilityToForm(),
  refreshModelCatalog: () => models.refreshModels(),
});

$("settingsBtn").addEventListener("click", settings.openSettings);

// What's new: shown once after an update, from the "Updated to" notice; a
// fresh install only records the version, and Settings > About reopens it
// (ui/src/whatsNew.mjs).
initWhatsNew({ $ });

// Help, from the Home sidebar: what each tool does and where it runs. Escape
// and the backdrop press OK (ui/src/escapeKey.mjs). The two links open the
// repo's docs in the system browser, the way the sidebar's links do.
function openHelp() { $("helpOverlay").classList.add("open"); }
$("helpOk").addEventListener("click", () => $("helpOverlay").classList.remove("open"));
for (const [id, doc] of [["helpGuide", "usage"], ["helpFaq", "faq"]]) {
  $(id).addEventListener("click", (e) => {
    e.preventDefault();
    window.open(`${REPO_URL}/blob/main/docs/${doc}.md`, "_blank", "noopener");
  });
}
// The way out of a greyed-out "needs API key" option, inside Advanced options.

// ---------------- Engine availability (progressive enhancement) ----------------
// GET /api/engines reports which translate/STT engines actually work on this
// machine (e.g. no Ollama installed, no API key saved yet). A fetch failure
// or non-200 response just leaves the form at its static defaults -- see
// applyEngineAvailability in dubApi.mjs for the pure decision logic.

// Rebuilds the option's label from a base captured on first call instead of
// `textContent +=` -- this runs again after every Settings save, and
// appending unconditionally would double the suffix on a second disabled run.
// Which keyed engines have a key saved. A choice that needs one is no longer
// greyed out: picking it asks for the key on the spot (Mac tester,
// 2026-09-28 -- "needs API key" in grey said what was missing and nothing
// about where to put it).
const keySaved = { perso: true, gemini: true };
// The model behind each voice engine (GET /api/engines voice_models): the
// Text-to-speech dropdown and a job's engine line name it with the engine.
let voiceModels = {};
// Whether this computer has the memory to dub on it (GET /api/engines ram_ok),
// for the download dialog. Enough until the answer comes.
let ramOk = true;

// (loadSavedDefaults -- the GET /api/setup pass that starts those dropdowns on
// the app's saved defaults -- moved with the dialog it fills, into
// ui/src/newProject.mjs.)

async function applyEngineAvailabilityToForm() {
  // The dropdowns this greys out live in Advanced options, inside the New
  // project dialog.
  const translateSel = $("translateSelect");
  const sttSel = $("sttSelect");

  let av;
  try {
    const r = await fetch("/api/engines");
    if (!r.ok) return;
    av = await r.json();
  } catch {
    return;
  }
  const result = applyEngineAvailability(av, {
    translate: translateSel.value,
    stt: sttSel.value,
    dubMode: $("dubModeSelect").value,
  });

  keySaved.perso = !result.disable.perso;
  keySaved.gemini = !result.disable.gemini;
  voiceModels = av.voice_models || {};
  ramOk = av.ram_ok !== false;
  for (const o of $("voiceSelect").options) o.textContent = voiceLabel(o.value, voiceModels);

  $("engineWarning").textContent = result.warning || "";
}
applyEngineAvailabilityToForm();

// Picking a keyed engine with no key saved opens the key window (ui/src/keyWindow.mjs).
// Save keeps the choice; Cancel puts the dropdown back where it was.
const keyWindow = initKeyWindow({ $, keySaved, onSaved: applyEngineAvailabilityToForm });

// Picking Hunyuan before it is downloaded shows a Download button in the
// field's own hint -- a 1.1GB download must be asked for, never started by a
// mere selection (user decision 2026-08-31). An install already running (the
// dialog was reopened mid-download) resumes its progress display instead.
// ---------------- Models: hints, dialog, chip, Settings catalog ----------
// One controller over GET /api/models (ui/src/modelsDialog.mjs) owns the rows
// and the pending dub, and renders the Settings catalog and the download
// dialog. The status line under each dropdown and the topbar chip stay here,
// because they read the New project form's own selects; the controller calls
// paintModelStatusLines after every refresh so they repaint with the rest.
// Which "start again" a finished model download resumes: the New project
// dialog's own startDubbing by default, or a draft's startDraftDubbing while
// that is the one waiting on the download (ui/src/draftSetup.mjs sets this
// back before every attempt of its own, the way startDubbing does below).
let dubRestart = startDubbing;
const models = initModelsUi({
  $,
  onStartDubbing: () => dubRestart(),
  onOpenSettings: () => settings.openSettings("models"),
  // Dubbing on Perso makes the voices there; no key yet opens the key window.
  onUsePerso: () => {
    const sel = $("dubModeSelect");
    sel.value = "perso";
    sel.dispatchEvent(new Event("change"));
  },
  onRowsChanged: paintModelStatusLines,
  // The desktop app's bridge (absent in a plain browser): packs are its to install.
  shell: window.persodubShell || null,
  // Keep the catalog fresh while Settings shows it.
  keepPolling: () => $("settingsOverlay").classList.contains("open"),
  ramOk: () => ramOk,
});

// Everything a dropdown choice needs, in the order it downloads: the pack it
// runs in first (as in the dub's own 409), then its model. Only the rows
// that are not ready -- an empty list means the choice is good to go.
function hintNeeds(role, value) {
  const ids = [...neededPackIds(role, value), neededModelId(role, value)].filter(Boolean);
  return ids.map((id) => models.modelRow(id)).filter((r) => r && r.state !== "ready");
}

// One line under the dropdown, one button. Nothing missing: hidden (or Ready,
// once this session saw it busy). Something downloading or stopped: that
// row's own status, with Cancel or Resume. Otherwise every missing thing by
// name -- "Needs Translation runtime + Hunyuan · 1.4 GB" -- and one Download
// that fetches them all, in order, so a pack never arrives without a word
// about what it is or why (user, 2026-09-07).
function paintHint(el, needs, ready) {
  const active = needs.find((r) => r.state === "downloading") || needs.find((r) => r.state === "paused");
  if (active) el.dataset.everBusy = "1";
  if (!needs.length) {
    if (ready && el.dataset.everBusy) {
      el.hidden = false;
      el.className = "settings-hint model-line model-ok";
      el.replaceChildren(document.createTextNode(t("Ready")));
    } else el.hidden = true;
    return;
  }
  el.hidden = false;
  el.replaceChildren();
  const span = document.createElement("span");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "keys-link";
  const ids = needs.map((r) => r.id);
  if (active) {
    const line = modelStatusLine(active);
    el.className = "settings-hint model-line " + line.cls;
    // A stopped one is named: "Paused" alone under a dropdown says nothing
    // about which of the things the choice needs it is.
    span.textContent = active.state === "paused"
      ? (active.error ? t("{name} paused: {error}", { name: active.name, error: active.error })
        : t("{name} paused", { name: active.name }))
      : line.text;
    btn.textContent = line.button === "cancel" ? t("Cancel") : t("Resume");
    btn.addEventListener("click", () =>
      line.button === "cancel" ? models.cancelModel(active.id) : models.downloadAll(ids));
  } else {
    const total = needs.reduce((n, r) => n + r.bytes, 0);
    el.className = "settings-hint model-line";
    span.textContent = t("Needs {names} · {size} GB", { names: needs.map((r) => r.name).join(" + "), size: gb(total) });
    btn.textContent = t("Download");   // the size is in the sentence beside it
    btn.addEventListener("click", () => models.downloadAll(ids));
  }
  el.append(span, btn);
}

// The parts of the model UI this page owns: the three dropdown hints and the
// topbar download chip.
function paintModelStatusLines(rows) {
  // Cloud dubbing needs no local models -- their download lines would only
  // confuse; the per-stage dropdowns are greyed by paintDubMode below.
  const cloud = $("dubModeSelect").value === "perso";
  for (const [role, sel, hint] of [["stt", "sttSelect", "sttModelHint"],
                                    ["translate", "translateSelect", "translateModelHint"],
                                    ["voice", "voiceSelect", "voiceModelHint"]]) {
    const value = $(sel).value;
    const needsAnything = !cloud && (neededPackIds(role, value).length || neededModelId(role, value));
    paintHint($(hint), cloud ? [] : hintNeeds(role, value), !!needsAnything);
  }
  // The one under way, not one queued behind it: before its first byte it
  // has no figure either (Windows C2, 2026-10-21).
  const dl = rows.find((m) => m.state === "downloading" && m.progress != null)
          || rows.find((m) => m.state === "downloading" && !m.queued)
          || rows.find((m) => m.state === "downloading");
  // The chip stands in for the download dialog, not beside it: it shows only
  // once Hide closed the dialog (the dialog itself carries the percent). Same
  // rule for the erase screen, which draws its pack's percentage on its own
  // line -- the chip beside it was the same number twice (user, 2026-09-09).
  const dialogOpen = $("modelsNeededOverlay").classList.contains("open");
  const shownElsewhere = dl && dl.id === ERASER_PACK_ID
    && document.body.dataset.screen === "erase";
  $("topbarDl").hidden = !dl || dialogOpen || shownElsewhere;
  if (dl) $("topbarDl").textContent = downloadChipText(dl);
}

$("topbarDl").addEventListener("click", () => models.reopenDialogOrSettings());
for (const id of ["sttSelect", "translateSelect", "voiceSelect"]) {
  $(id).addEventListener("change", () => models.repaint());
}
// One sentence per line (they read as a wall when joined -- user feedback):
// the hint slots render these with pre-line whitespace. Getters, so each is
// read in the language of the moment. The Perso API dubbing hint names the
// free first minute (owner, 2026-10-21): it is what gets people to sign up.
const ENGINE_HINTS = {
  dubMode: { get local() { return [t("Runs on this computer, free."), t("You can edit the script after.")]; },
             get perso() { return [t("Perso does the dubbing start to finish."), t("Sign up and the first minute is free. Credits after that.")]; } },
  sep: { get local() { return [t("Runs on this computer, free."), t("For accuracy, use the API.")]; },
         get perso() { return [t("Most accurate."), t("Uses Perso credits.")]; } },
  stt: { get local() { return [t("Runs on this computer, free."), t("For accuracy, use the API.")]; },
         get perso() { return [t("Most accurate."), t("Uses Perso credits.")]; } },
  translate: { get hunyuan() { return [t("Runs on this computer, free and fastest."), t("For accuracy, use the API.")]; },
               get gemma() { return [t("Runs on this computer, free."), t("For accuracy, use the API.")]; },
               get gemini() { return [t("Most accurate."), t("Needs an API key.")]; },
               get chatgpt() { return [t("Free within a ChatGPT account's limit. Sign in once, no download.")]; } },
  voice: { get qwen3() { return [t("Runs on this computer, free."), t("Clones each speaker\u2019s voice.")]; } },
};
function updateEngineHints() {
  $("dubModeHint").textContent = (ENGINE_HINTS.dubMode[$("dubModeSelect").value] || []).join("\n");
  $("sepHint").textContent = (ENGINE_HINTS.sep[$("sepSelect").value] || []).join("\n");
  $("sttHint").textContent = (ENGINE_HINTS.stt[$("sttSelect").value] || []).join("\n");
  $("translateHint").textContent = (ENGINE_HINTS.translate[$("translateSelect").value] || []).join("\n");
  $("voiceHint").textContent = (ENGINE_HINTS.voice[$("voiceSelect").value] || []).join("\n");
}
for (const id of ["dubModeSelect", "sepSelect", "sttSelect", "translateSelect", "voiceSelect"]) {
  $(id).addEventListener("change", updateEngineHints);
}
updateEngineHints();

function paintDubMode() {
  const cloud = $("dubModeSelect").value === "perso";
  // numSpeakers stays live: the cloud asks for it too.
  for (const id of ["sepSelect", "sttSelect", "translateSelect", "voiceSelect", "qualitySelect"]) {
    $(id).disabled = cloud;
  }
}
// The voice engine's warning is for a dub on this computer only: asked again
// when the choice changes.
$("dubModeSelect").addEventListener("change", () => { paintDubMode(); models.repaint(); applyEngineAvailabilityToForm(); });
paintDubMode();
models.refreshModels();

// ---------------- Screens and top bar ----------------
// Two sections live inside <main class="work"> and exactly one is shown.
// Everything else in the app changes screens through showScreen() alone.
// #screen-done is the work screen, and it goes by four names: a dub that is
// running, one that finished, one that stopped, and the Erase tab all wear
// the same frame. The name is what the stylesheet picks each one's panels by,
// and what the agent strip and the shortcuts tell them apart by.
const SCREEN_SECTION = { failed: "done", running: "done", erase: "done" };
// The left panel's tab row follows the name (ui/src/workFrame.mjs). Wired
// further down, once the tabs are; a screen shown before that has no row to
// move.
let workFrame = null;
// The Erase tab borrows the timeline; any other screen gives it back. Set once
// the timeline is wired, further down.
let leaveEraseTimeline = null;
// The panels' remembered sizes (timeline.fitLayout), set the same way. They
// can only be put back on a work screen that is on show, whichever of its
// names it came up under: the Erase tab opened first had widths of its own.
let fitWorkLayout = null;
// The player each screen shows. A screen that goes takes its sound with it:
// a video left playing went on talking behind Home and behind the next project.
const SCREEN_VIDEO = { done: "doneVideo", running: "runningVideo", failed: "runningVideo", erase: "eraseVideo" };
function showScreen(name) {
  const id = `screen-${SCREEN_SECTION[name] || name}`;
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== id;
  for (const v of new Set(Object.values(SCREEN_VIDEO))) if (v !== SCREEN_VIDEO[name]) $(v).pause();
  const was = document.body.dataset.screen;
  document.body.dataset.screen = name;   // the assistant reads this, and the stylesheet
  if (name !== was && name !== "home" && fitWorkLayout) fitWorkLayout();
  if (workFrame) workFrame.onScreen(name);
  if (name !== "erase" && leaveEraseTimeline) leaveEraseTimeline();
}

// The top bar carries the whole state of the app: what is open, what it is
// doing, and the one or two buttons that apply right now.
function setTopbar({ title, subtitle = "", running = false, done = false, back = false,
                     estimate = "", erase = false, exportable = undefined }) {
  $("topbarTitle").textContent = title;
  // A job's name can be changed; the first screen's "PersoDub" cannot.
  $("topbarTitle").dataset.editable = state.jobId ? "1" : "0";
  $("topbarTitle").title = state.jobId ? t("Click to rename") : "";
  $("topbarTitle").hidden = false;
  $("topbarRename").hidden = true;
  // Several parts are chips, and so is a finished job's lone "Done"; any other
  // single part is the plain label it always was ("Local dubbing").
  const parts = statusParts(subtitle);
  const asChips = parts.length >= 2 || (done && parts.length === 1);
  const sub = $("topbarSub");
  sub.textContent = asChips ? "" : subtitle;
  if (asChips) parts.forEach((part, i) => {
    const chip = document.createElement("span");
    chip.className = "status-chip" + (done && i === 0 ? " done" : "");
    chip.textContent = part;
    sub.appendChild(chip);
  });
  $("homeBtn").hidden = !back;
  $("newProjectBtn").hidden = !back;
  $("cancelBtn").hidden = !running;
  // Only a finished job has anything to hand back. On the work screen the
  // button is there all along, and dim until then.
  $("exportBtn").hidden = !done && !back;
  // A draft with a video on its timeline has its kept parts to hand back,
  // on the Erase tab too -- which says itself (`exportable`) whether that
  // draft is the video it shows.
  $("exportBtn").disabled = exportable !== undefined ? !exportable
    : !done && !(back && !state.jobId && !!(getDraft() || {}).downloadId);
  // The erase screen's pair. Named here rather than left to that screen so
  // that every other call to setTopbar puts them away without knowing they
  // exist -- which is the whole point of one top bar.
  $("eraseEst").textContent = estimate;
  $("eraseEst").hidden = !estimate;
  $("eraseRunBtn").hidden = !erase;
  paintForward();
}

// ---- The way back into the job you just left --------------------------------
// The back arrow leaves a job for the list of projects; this is the other half
// of that step. Held in memory only: a fresh launch has nothing behind it, and
// an arrow that reopened a job from days ago would be a different promise.
let lastJobId = null;
let lastJobName = "";

// A job that failed counts too, on purpose: the failure card is where "Try
// again" lives, so the arrow back to it is a way on rather than a dead end.
// Where the app was when it was closed: the job on screen, or "" for home.
// Read once at launch (openLastScreen) so the app comes back where it was.
const LAST_SCREEN_KEY = "persodub.layout.lastJobId";
function noteLastScreen(jobId) {
  try { localStorage.setItem(LAST_SCREEN_KEY, jobId || ""); } catch { /* private window */ }
}

function rememberLastJob() {
  if (!state.jobId) return;
  lastJobId = state.jobId;
  lastJobName = state.job ? jobLabel(state.job) : "";
}

// That job is gone (deleted, or the server no longer has it), so the way back
// to it has to go too -- an arrow that lands on an error is worse than no arrow.
function forgetLastJob() {
  lastJobId = null;
  lastJobName = "";
  paintForward();
}

function paintForward() {
  const btn = $("topbarForward");
  // Only on the first screen: inside a job the back arrow is the way out, and
  // an arrow pointing the other way would have nowhere to go.
  btn.hidden = !lastJobId || document.body.dataset.screen !== "home";
  const what = lastJobName ? t("Back to {name}", { name: lastJobName }) : t("Back to the project you left");
  btn.setAttribute("aria-label", what);
  btn.title = what;
}

$("topbarForward").addEventListener("click", () => {
  if (lastJobId) resumeJob(lastJobId);
});

// The resting state: no job open, the first screen showing.
function showHome() {
  // Home hides the Dub Agent again until something on it opens the column.
  document.body.classList.remove("home-agent");
  // A project opened from Home later has no dub to go back to, and is no
  // other dubbing's language.
  state.draftFromJob = null;
  state.draftProject = null;
  paintDraftBack();
  showScreen("home");
  setTopbar({ title: "PersoDub", subtitle: t("Local dubbing") });
  projects.renderQueueCard().catch(() => {});
  noteLastScreen("");
}

// The screen the app was closed on. A job that is gone since (deleted, or the
// folder moved) means home, quietly -- a launch is not the moment for an
// error about yesterday.
async function openLastScreen() {
  let last = "";
  try { last = localStorage.getItem(LAST_SCREEN_KEY) || ""; } catch { /* private window */ }
  if (!last) { showHome(); return; }
  try {
    const r = await fetch(`/api/dub/jobs/${last}`);
    if (!r.ok) { showHome(); return; }
  } catch { showHome(); return; }
  await resumeJob(last);
}

// ---------------- New project dialog ----------------
// Opens the moment a video or a link is ready, and is the only place a job can
// be started from. Everything it holds -- the thumbnail and its trim bar, the
// language dropdowns, Advanced options and Start -- lives in
// ui/src/newProject.mjs; what stays here is everything that dialog reaches
// out to: the repaint passes that grey and hint dropdowns across sections,
// startDubbing (which drives the running screen and the top bar), and the two
// ways in on the home screen that call openNewProject().
const newProject = initNewProjectUi({
  $,
  state,
  onStart: startDubbing,
  applyEngineAvailability: applyEngineAvailabilityToForm,
  // The download line under each dropdown too: a remembered translator that
  // is still downloading must say so the moment the dialog puts it back.
  updateEngineHints: () => { updateEngineHints(); models.repaint(); },
  paintDubMode,
  playRange,
  cancelRange,
  // The timeline's own measure of how much room a time label needs, imported
  // from ui/src/timeline.mjs: the trim bar's ruler and the strip's thin out
  // their labels by the same number.
  labelPx: () => TL_LABEL_PX,
  // Closing the dialog throws the pending source away with it: the first
  // screen's error line, the file input (otherwise re-picking the same file
  // fires no change event) and the link field with its card (the probe only
  // runs on an `input` event, so a URL left sitting there could never open the
  // dialog again).
  onClosed: () => {
    $("formError").textContent = "";
    videoInput.value = "";
    $("linkInput").value = "";
    clearLink();
  },
  onPickFile: () => videoInput.click(),
  onErase: (source) => eraseScreen.openEraseWith(source),
  // Only the desktop app can open a folder (see the erase screen's own Show).
  reveal: window.persodubShell?.revealPath
    ? (path) => window.persodubShell.revealPath(path) : null,
  // Where the last project's choices are kept for the next one.
  storage: localStorage,
});

// ---------------- Erase subtitles ----------------
// The Erase tab and the video its box is drawn on (#tabErase, #erasePane)
// belong to
// ui/src/eraseScreen.mjs. What the page hands it is what is the page's: the
// one way screens are swapped, the one top bar, and the one rule about which
// files this app takes -- videoProblem, shared with the home drop zone, so a
// file refused on one screen is refused on the other in the same words.
const eraseScreen = initEraseScreenUi({
  $, showScreen, setTopbar, checkFile: videoProblem,
  getScreen: () => document.body.dataset.screen,
  // A dubbing project's Erase tab has nothing to export until its erase is done.
  projectOpen: () => !!state.jobId,
  // The eraser arrives as a pack, and packs are the models controller's to
  // install: it owns the progress the top-bar chip and Settings both show.
  installPack: (id) => models.installPack(id),
  packRow: (id) => models.modelRow(id),
  // ...and the progress and the refusals that go with it, so the erase screen
  // can draw them where the button was pressed.
  onPackProgress: (fn) => models.onPackProgress(fn),
  // An erase is a job like any other, so the list and the waiting line have a
  // new row the moment one starts and a changed one when it ends.
  onJobsChanged: () => {
    projects.renderHistory().catch(() => {});
    projects.renderQueueCard().catch(() => {});
  },
  // The way on from an erased video: a new project on the cleaned file rather
  // than the one with the writing still on it, on its Dubbing tab.
  onDub: (held) => openDraftHere({ downloadId: held.downloadId, name: held.title,
                                   duration: held.duration_sec }, { tab: "dubbing" }),
  // Only the desktop app can open a folder. In a browser there is none to
  // open, and the "Show" beside "Saved to Downloads" stays away.
  reveal: window.persodubShell?.revealPath
    ? (path) => window.persodubShell.revealPath(path) : null,
  // The timeline under it is the one the dub and the draft use (read late:
  // it is wired further down).
  showTimeline: (info) => timeline.showErase(info),
});
// The work screen's left panel: Dubbing, Audio, Captions, and Erase, which
// is the way to the erase screen (ui/src/leftTabs.mjs).
const leftTabs = initLeftTabs({ $, onErase: () => {
  // Lit here as well as by the screen's name: with no job to go back to, the
  // erase screen can be standing under another tab.
  leftTabs.show("erase");
  openEraseForProject();
} });
// A dub that is open (running, finished or stopped): its Erase tab starts
// from that project's own video, held again the way + Add language holds it,
// rather than asking for a video. The first press holds it; after that the
// tab comes back as it was left.
let erasingFor = null;   // {jobId, downloadId}
async function openEraseForProject() {
  const jid = state.jobId, job = state.job;
  const ownDub = jid && job && job.id === jid && (job.kind || "dub") === "dub";
  if (!ownDub || (erasingFor && erasingFor.jobId === jid && eraseScreen.sourceId() === erasingFor.downloadId)) {
    eraseScreen.openEraseTab();
    return;
  }
  try {
    const src = await dubAgainSource(jid);
    // Another project was opened, or another tab pressed, while it was held.
    if (state.jobId !== jid || leftTabs.current() !== "erase") return;
    erasingFor = { jobId: jid, downloadId: src.download_id };
    eraseScreen.openEraseOn({ downloadId: src.download_id, title: src.title,
                              duration: src.duration_sec, ranges: src.ranges });
  } catch (e) {
    // The video is gone, or still being fetched: the empty tab, and why.
    eraseScreen.openErase();
    $("eraseDropError").textContent = errorText(e);
  }
}
// Any other tab pressed there is the way back to the job that is open. With
// no job open the tab's own body is all there is to show.
workFrame = initWorkFrame({
  $, tabs: leftTabs,
  getScreen: () => document.body.dataset.screen,
  onLeaveErase: () => {
    if (state.job && state.job.id === state.jobId) handleJobUpdate(state.job, { opened: true });
    // An erase opened from Home has no draft behind it, and the other tabs
    // were an empty "New project" with nothing on it to press (2026-09-30).
    // Erased: they take the way on its own button takes, Dubbing this video.
    // Not finished: there is nothing for them yet, so the Erase tab stays.
    else if (!getDraft() && eraseScreen.hasJob()) {
      leftTabs.show("erase");
      if (eraseScreen.erasedJob()) $("eraseDubBtn").click();
    }
    // No job: the draft the Erase tab was cutting, as the Dubbing and Audio
    // tabs show it (or the empty new project, to bring one in).
    else draftSetup.showDraftScreen();
  },
});
// The player row under the two videos that are not a finished job's.
initPlayerFoot({ video: $("runningVideo"), time: $("runTime"), play: $("runPlay"),
                 fullscreen: $("runFs"), stage: $("runStage") });
initPlayerFoot({ video: $("eraseVideo"), time: $("eraseTime"), play: $("erasePlay"),
                 fullscreen: $("eraseFs"), stage: $("eraseStage") });

// ---------------- The draft state of the work screen ----------------------
// A video imported for a new project that is not dubbed yet: how it comes in
// (ui/src/draftImport.mjs) and the Dubbing tab's "Before dubbing" card and
// openDraft() (ui/src/draftSetup.mjs). timeline.fitLayout/sizeVideoPane are
// read late, the way newProject's labelPx is -- both are declared further
// down than this screen is wired up.
const draftImport = initDraftImport({
  $, state,
  getScreen: () => document.body.dataset.screen,
  checkFile: (file) => videoProblem(file),
});
const draftSetup = initDraftSetup({
  $, state, showScreen, setTopbar,
  fitLayout: () => timeline.fitLayout(),
  showDraftTimeline: () => timeline.showDraft(),
  sizeVideoPane: () => donePlayer.sizeVideoPane(),
  leftTabsShow: leftTabs.show,
  importer: draftImport, newProject,
  // A draft that becomes a dubbing is no longer a draft to come back to.
  submitDubStart: async (o) => {
    const d = getDraft();
    const started = await submitDubStart(o);
    if (started && d) forgetDraft(d.downloadId);
    if (started) state.draftProject = null;
    return started;
  },
  setDubRestart: (fn) => { dubRestart = fn; },
  getScreen: () => document.body.dataset.screen,
  // A dubbing of a cut the Audio tab already separated takes its two sounds.
  stemsFrom: () => (audioTab.separatedJob() || {}).id || "",
});
// ---------------- Separate audio ----------------
let showAudioLanes = () => {};
// The Audio tab (#tabAudio) belongs to ui/src/audioTab.mjs: the draft's kept
// parts, separated into voice and background as a job of its own. What the
// page hands it is the page's: the way a video comes in, the stop question,
// the windows a start can come back short of, and the Export dialog.
const audioTab = initAudioTab({
  $, state,
  getVideo: () => $("doneVideo"),
  goToTab: (name) => $("leftTabs").querySelector(`[data-tab="${name}"]`).click(),
  importSource: (source) => draftImport.importSource(source),
  say: (text, isError) => draftImport.say(text, isError),
  askStop: () => confirmDialogs.askCancelDub(t("Stop separating?")),
  // The engine pack is missing (the download notice, then the start again),
  // no Perso key or no workspace picked (the key window, then again), or no
  // room on the disk.
  onStartRefused: (e, retry) => {
    // The engine's words, English on purpose: the refusals are known by them.
    const text = serverText(e);
    if (e && e.status === 409 && e.detail && e.detail.missing) {
      dubRestart = retry;
      models.refreshModels().then(() => models.showModelsDialog(e.detail));
      return true;
    }
    if (e && e.status === 422 && /Select a Perso workspace/.test(text)) {
      keyWindow.askKey("perso", null, null, { spaceOnly: true, then: retry });
      return true;
    }
    if (e && e.status === 422 && /needs an API key/.test(text)) {
      keyWindow.askKey("perso", null, null, { then: retry });
      return true;
    }
    return confirmDialogs.showIfOutOfSpace(e);
  },
  onJobsChanged: () => {
    projects.renderHistory().catch(() => {});
    projects.renderQueueCard().catch(() => {});
  },
  openExport: () => exportDialog.open(),
  // The timeline is wired further down; until then there is none to tell.
  showTimeline: (info) => showAudioLanes(info),
});
// The tab is repainted when it is come to: whether a job owns the screen is
// read then.
$("leftTabs").addEventListener("click", () => audioTab.paint());
// A row in the Projects list: the separation's video is held again and
// opened as a draft, on its Audio tab, with its two sounds.
async function openSeparatedJob(job) {
  const held = await openSeparated(job.id);
  resetForNewJob();
  forgetLastJob();
  state.draftFromJob = null;
  state.draftProject = null;
  paintDraftBack();
  audioTab.adopt(job, held);
  await draftSetup.openDraft({ downloadId: held.download_id, name: job.title || held.title,
                               duration: held.duration_sec }, { tab: "audio", ranges: held.ranges });
}

// The top bar's New project: what the Home banner does with a video, from
// the work screen. The open job is left the way Home leaves it first
// (resetForNewJob: its id, script and timeline lanes); a job still running
// carries on, and a dub started meanwhile waits its turn.
initNewProjectWindow({
  $, checkFile: videoProblem,
  leaveJob: () => resetForNewJob(),
  openDraft: (source) => draftSetup.openDraft(source),
  openNewProject: (source) => newProject.openNewProject(source),
});
// A new draft opened from wherever the person stands -- a dubbing's
// + Add language, a finished erase's Dub this video: the job on screen is let
// go first, the way Home lets it go, and stays behind the top bar's forward
// arrow. The job it was opened from keeps a way back: the draft's Back button.
// `project` is the project an Add language draft's dubbing joins.
function openDraftHere(source, opts, project = null) {
  // resetForNewJob passes through Home, which forgets the dub to go back
  // to: note it first and put it back after.
  const from = state.jobId || null;
  // From an erased video the way back is to that erase, not to a dubbing.
  const fromErase = document.body.dataset.screen === "erase";
  resetForNewJob();
  state.draftFromJob = from;
  state.draftBackTip = fromErase ? "Back" : "Back to the dubbing";
  state.draftProject = project;
  paintDraftBack();
  // Back forgets a draft nothing was done to (draftOpened below). One that
  // was already a card before this opened it is never forgotten that way.
  const had = !!source && keptDrafts.some((k) => k.downloadId === source.downloadId);
  state.draftOpened = null;
  return draftSetup.openDraft(source, opts).then(() => {
    const d = getDraft();
    if (d && !had) state.draftOpened = { downloadId: d.downloadId, mark: draftMark(d), touched: false };
  });
}
// A choice made on the Before dubbing card is a change to the draft too.
for (const evt of ["change", "input"]) {
  $("draftSetup").addEventListener(evt, () => { if (state.draftOpened) state.draftOpened.touched = true; });
}
function paintDraftBack() {
  $("draftBackBtn").hidden = !state.draftFromJob;
  // The tip is kept in English ("Back", "Back to the dubbing") and said here.
  $("draftBackBtn").title = state.draftFromJob ? t(state.draftBackTip) : "";
}
$("draftBackBtn").addEventListener("click", () => {
  const jid = state.draftFromJob;
  state.draftFromJob = null;
  state.draftProject = null;
  paintDraftBack();
  // Opened and left as it was (no cut, no option): no Draft card stays on
  // Home for it. One that was cut is kept.
  const d = getDraft(), was = state.draftOpened;
  state.draftOpened = null;
  if (d && was && was.downloadId === d.downloadId && !was.touched && was.mark === draftMark(d)) {
    forgetDraft(d.downloadId);
  }
  if (jid) resumeJob(jid);   // resumeJob clears the draft itself
});
// The open dubbing's languages, at the foot of the left panel. The jobs list
// comes from the same fetch Home's cards are drawn from (onJobs below).
const languageRow = initLanguageRow({
  $, getJob: () => state.job, langName,
  onOpenJob: (jobId) => resumeJob(jobId),
  openDraft: openDraftHere,
  nameOf: (job) => shownName(job),
});
// The project's own page, from the logo in Settings > About. window.open
// rather than an <a>: the shell hands every http(s) open to the OS browser
// (desktop/src/windowFactory.js), and in a plain browser it is a new tab either way.
// The shell's edition decides it (desktop/src/edition.js); a plain browser has
// no shell and shows the public repository.
const REPO_URL = `https://github.com/${window.persodubShell?.repo || "stronghamjji/PersoDub"}`;
$("brandBtn").addEventListener("click", () => window.open(REPO_URL, "_blank", "noopener"));

// ---------------- Upload zone (drag & drop + click to browse) ----------------
const uploadZone = $("uploadZone");
const videoInput = $("videoInput");

// One constant to change if the allowed size ever moves. The zone's own hint
// spells the limit out in the markup -- keep the two in step.
const MAX_VIDEO_MB = 2048;
const MAX_VIDEO_LABEL = MAX_VIDEO_MB >= 1024 ? `${MAX_VIDEO_MB / 1024} GB` : `${MAX_VIDEO_MB} MB`;

// The zone itself never reports "video ready" any more: a good file opens the
// New project dialog straight away, and that dialog is the confirmation.
function videoProblem(file) {
  if (!/\.(mp4|mov)$/i.test(file.name)) {
    return t("Please choose an MP4 or MOV video file.");
  }
  if (file.size > MAX_VIDEO_MB * 1024 * 1024) {
    return t("This video is {size}. The limit is {limit}. Please use a shorter or smaller file.",
      { size: formatBytes(file.size), limit: MAX_VIDEO_LABEL });
  }
  return null;
}

function setVideoFiles(fileList) {
  $("formError").textContent = "";
  const files = Array.from(fileList || []);
  if (!files.length) return;
  // One bad file stops the whole drop: silently dubbing the rest would leave
  // the user thinking every video they dropped is in line.
  for (const f of files) {
    const bad = videoProblem(f);
    if (bad) {
      $("formError").textContent = files.length > 1 ? `${f.name}: ${bad}` : bad;
      return;
    }
  }
  // One video opens straight into its own draft, already on the timeline
  // (mockup hdrop, user 2026-09-29); several still open the New project
  // dialog, which dubs them one after another (ui/src/newProject.mjs).
  if (files.length === 1) draftSetup.openDraft({ file: files[0] });
  else newProject.openNewProject({ files });
}

uploadZone.addEventListener("click", () => videoInput.click());
// Only the zone itself: Enter on the Choose File… button inside it already
// clicks the button, and that click bubbles up to the handler above.
uploadZone.addEventListener("keydown", (e) => {
  if (e.target === uploadZone && (e.key === "Enter" || e.key === " ")) videoInput.click();
});
videoInput.addEventListener("change", () => setVideoFiles(videoInput.files));

// The link field lives inside the banner now -- clicking or typing into it
// must not also open the file picker the banner's own click handler opens.
$("homeBannerLink").addEventListener("click", (e) => e.stopPropagation());

["dragenter", "dragover"].forEach((evt) =>
  uploadZone.addEventListener(evt, (e) => { e.preventDefault(); uploadZone.classList.add("drag-over"); })
);
["dragleave", "drop"].forEach((evt) =>
  uploadZone.addEventListener(evt, (e) => { e.preventDefault(); uploadZone.classList.remove("drag-over"); })
);
uploadZone.addEventListener("drop", (e) => {
  setVideoFiles(e.dataTransfer.files);
});

// ---------------- Updates (desktop shell only) ----------------
// The top bar's update icon and the update window (ui/src/updateWindow.mjs).
// Outside Electron (plain browser, tests) persodubShell is absent: the icon
// stays grey and the window says the app is up to date.
wireUpdates({ $, shell: window.persodubShell || null, releases: `${REPO_URL}/releases` });

// ---------------- Link source (paste a URL) ----------------
// Probing is cheap (seconds, no download), so it runs as soon as a URL looks
// complete. The card is advisory -- it never blocks the rest of the form, which
// is why this is inline rather than a modal (see the spec's confirm-card note).
// There is no upload/link toggle any more: both ways in are on screen at once
// and whichever one produces a video wins.

// Which reading of the link field is the current one. Emptying the field, or
// leaving Home, makes an answer still on its way nobody's.
let probeTimer = null;
let probeSeq = 0;
function clearLink() {
  clearTimeout(probeTimer);
  probeSeq += 1;
  state.linkProbe = null;
  $("linkCard").hidden = true;
  $("linkCard").classList.remove("error");
  $("linkCard").innerHTML = "";
}

function renderLinkLoading() {
  const card = $("linkCard");
  card.hidden = false;
  card.classList.remove("error");
  card.innerHTML = `<div class="lc-loading">${t("Reading the link…")}</div>`;
}

function renderLinkCard(info) {
  const card = $("linkCard");
  card.hidden = false;
  card.classList.remove("error");
  const thumb = info.thumbnail_url
    ? `<img src="${escapeHtml(info.thumbnail_url)}" alt="">` : "";
  card.innerHTML = `
    <div class="lc-row">
      ${thumb}
      <div>
        <div class="lc-title">${escapeHtml(info.title)}</div>
        <div class="lc-meta">${info.duration_sec ? fmtLength(info.duration_sec) : ""}</div>
      </div>
    </div>`;
}

function renderLinkError(message) {
  const card = $("linkCard");
  card.hidden = false;
  card.classList.add("error");
  card.innerHTML = `
    <p class="lc-msg">${escapeHtml(message)}</p>
    <p class="lc-sub">${t("You can download the video yourself and drop it in.")}</p>
    <button class="btn btn-secondary" type="button" id="linkToUpload">${t("Upload a file")}</button>`;
  $("linkToUpload").addEventListener("click", () => videoInput.click());
}

// Enter on something that is not a link did nothing at all, with no word why
// (2026-09-30). The card under the banner says what the field takes.
$("linkInput").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const typed = $("linkInput").value.trim();
  if (!typed || /^https?:\/\/\S+$/.test(typed)) return;
  const card = $("linkCard");
  card.hidden = false;
  card.classList.add("error");
  card.innerHTML = `<p class="lc-msg">${t("That is not a link. Paste one that starts with https://")}</p>`;
});

// Home's link field is read from Home only: an answer that lands after a
// project was opened must not put a new draft in its place.
const probeIsStale = (mySeq) => mySeq !== probeSeq || document.body.dataset.screen !== "home";
$("linkInput").addEventListener("input", () => {
  clearLink();
  const url = $("linkInput").value.trim();
  if (!/^https?:\/\/\S+$/.test(url)) return;
  const mySeq = ++probeSeq;
  renderLinkLoading();
  probeTimer = setTimeout(async () => {
    try {
      const info = await probeSource(url);
      if (probeIsStale(mySeq)) return;   // a newer edit, or another screen by now
      state.linkProbe = { url, ...info };
      renderLinkCard(info);
      // A read link opens straight into its own draft, already on the
      // timeline -- the same shortcut a single dropped file gets.
      draftSetup.openDraft({ link: url });
    } catch (e) {
      if (probeIsStale(mySeq)) return;
      renderLinkError(errorText(e));
    }
  }, 400);
});

// ---------------- The open job in the top bar ----------------
// The bar carries the job's name and the one line that says where it is. The
// step-by-step display of the same thing lives on the running screen.

// What the user called this job. The server stamps the name onto the job when
// it starts, so the name is the same one whether the job is minutes or months
// old -- the browser used to remember it, and forgot on every restart.
function jobLabel(job) {
  return shownName(job);
}

// ---- Renaming a project ----------------------------------------------------
// The name a link brings is the video's own, which fills the top bar and is
// cut off in the Projects list; a file brings whatever it was called. The
// folder keeps the name it was made with -- the files inside it are written
// there already -- and this changes only what the screens show (user,
// 2026-09-10).
function startRename() {
  const job = state.job;
  if (!job || !state.jobId) return;
  const field = $("topbarRename");
  field.value = shownName(job);
  $("topbarTitle").hidden = true;
  field.hidden = false;
  field.focus();
  field.select();
}

async function finishRename(save) {
  const field = $("topbarRename");
  if (field.hidden) return;
  const typed = field.value.trim();
  field.hidden = true;
  $("topbarTitle").hidden = false;
  if (!save || !state.jobId) return;
  // An unchanged name is not a save: the folder's own name coming back is,
  // which is what an emptied field means.
  if (typed === shownName(state.job)) return;
  try {
    const r = await fetch(`/api/dub/jobs/${state.jobId}/title`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: typed }) });
    if (!r.ok) throw new Error("rename failed");
    const { title } = await r.json();
    if (state.job) state.job.title = title;
    $("topbarTitle").textContent = jobLabel(state.job || {});
    timeline.redraw();   // the video clip on the strip wears the name too
    projects.renderHistory().catch(() => {});
  } catch {
    // The name on screen is the one the server has; putting the old one back
    // is the honest answer to a save that did not happen. And a line beside
    // it for a few seconds, so the old name coming back is not a mystery.
    $("topbarTitle").textContent = jobLabel(state.job || {});
    const note = $("topbarNote");
    note.textContent = t("Could not rename");
    setTimeout(() => { note.textContent = ""; }, 6000);
  }
}

$("topbarTitle").addEventListener("click", () => {
  if ($("topbarTitle").dataset.editable === "1") startRename();
});
$("topbarRename").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); finishRename(true); }
  else if (e.key === "Escape") { e.preventDefault(); finishRename(false); }
});
$("topbarRename").addEventListener("blur", () => finishRename(true));

// A job started with a Trim dubbed only part of the video, and both screens say
// which part -- otherwise a ten-second result out of a half-hour video reads as
// something that stopped early. Empty for a job with no trim, which is what
// makes the caption disappear on its own. `withLength` adds how much video that
// range is, which the running screen has the room for and the top bar does not.
// The source video's own length is not kept on the job (app/jobs.py:
// SAVED_FIELDS), so it is not part of this line.
function trimLabel(job, withLength = false) {
  const trim = (job || {}).trim;
  if (!trim || trim.start == null || trim.end == null) return "";
  const range = t("Trimmed {start} – {end}", { start: fmtClockTenths(trim.start), end: fmtClockTenths(trim.end) });
  return withLength ? `${range} · ${fmtLength(trim.end - trim.start)}` : range;
}

// One short line. The WHY of a failure renders separately (paintNotices,
// ui/src/runningScreen.mjs) --
// four competing failure messages meant the user read none of them
// (feedback 2026-08-06).
// "English → Spanish · Fast mode · Translation ChatGPT · Voice Qwen3-TTS 1.7B":
// the languages, then what did each part of the dub, each with its role. The
// running card says it, and so does the foot of a finished dub's script.
function jobNote(job) {
  return [
    `${langName(job.source_lang) || t("Auto-detect")} → ${langName(job.language_code) || ""}`.trim(),
    engineLine(job, { voiceModels }),
  ].filter(Boolean).join(" · ");
}
function paintJobNote(job) {
  const el = $("scriptJobNote");
  const show = !!job && job.status === "done" && (job.kind || "dub") === "dub";
  el.hidden = !show;
  el.textContent = show ? jobNote(job) : "";
}
function jobStatusLine(job, progress) {
  if (job.status === "queued") return t("Waiting for its turn");
  if (job.status === "cancelling") return t("Cancelling…");
  if (job.status === "cancelled") return t("Cancelled");
  if (job.status === "error") return t("Dubbing failed");
  if (job.status !== "running") {
    // What made it rides on this same line (quality, then the engines), in
    // place of the chip row that used to sit under the top bar: one muted
    // line reads as one fact, where a row of pills read as buttons (2026-08-28).
    // A job saved before the app kept those choices simply has no engine part.
    const engines = engineChips(job, { voiceModels }).map((c) => c.label).join(" · ");
    return [t("Done"), trimLabel(job), engines].filter(Boolean).join(" · ");
  }
  // While it runs the top bar says exactly what the progress card says --
  // which stage, how far in. Never how long is left: the stages are too
  // uneven for a guess to be anything but a broken promise.
  return progress.stage > 0
    ? `${progress.label} · ${progress.percent}%`
    : t("Starting…");
}

// --- #10: reset everything for a fresh job without restarting the app ---
function resetForNewJob() {
  // A draft on screen is kept as it stands, the shape of its canvas included
  // (that one changes without a word to anyone).
  rememberDraft();
  // A video held beside the project being left (its Erase tab's) goes with it.
  if (state.jobId && getDraft()) clearDraft();
  state.pollGeneration += 1; // stops any stale poll loop
  // Noted before it is cleared: the top bar's other arrow is the way back in.
  rememberLastJob();
  state.jobId = null;
  state.job = null;
  delete document.body.dataset.jobId;
  videoInput.value = ""; // otherwise re-picking the same file fires no change event
  $("formError").textContent = "";
  state.newProject = null;
  // Both ways in are on the first screen at once now, so the link field has to
  // be emptied too -- otherwise the last job's link is still sitting there.
  $("linkInput").value = "";
  clearLink();
  // A video still coming in for the draft being left has nowhere to land.
  draftImport.cancelImport();
  runningScreen.reset();
  $("formError").textContent = "";
  donePlayer.releaseDoneVideo();
  homeNoticeAndLog();
  scriptTable.reset();
  paintJobNote(null);
  languageRow.paint();
  timeline.renderTimeline([], 0);
  runningScreen.paintCancel();
  showHome();
}
// Home is the way out of a job -- the same "start another one" the New job
// button used to be, at the left end of the top bar.
$("homeBtn").addEventListener("click", () => {
  // Leaving the erase screen that a New project dialog sent us to puts that
  // dialog back, with the same video and the same trim -- home would throw
  // away the video the user was in the middle of (user, 2026-09-09).
  const back = eraseScreen.origin();
  const fromDialog = document.body.dataset.screen === "erase" && back;
  resetForNewJob();
  if (fromDialog) newProject.openNewProject({ ...back, fromErase: true });
});

// A failure's own text goes here when the screen showed only its plain
// sentence (ui/src/format.mjs rawLogLines).
function renderLog(job) {
  $("logBox").textContent = rawLogLines(job.logs, job.status === "error" ? job.error : "").join("\n");
}

// ---------------- Running, inside the work screen ----------------
// The original in the center panel, the progress card and its four stages, the one notice
// line a job gets, the out-of-credits popup and the Cancel button are all
// drawn by ui/src/runningScreen.mjs. What stays here is the job-state engine
// that feeds it -- handleJobUpdate and runPollLoop below -- plus the two lines
// the running screen borrows from elsewhere: trimLabel, which the top bar says
// in its short form, and homeNoticeAndLog, which the failure card borrows the
// notice and the raw log through.
const runningScreen = initRunningScreenUi({
  $,
  parseProgress,
  trimLabel,
  // "English → Spanish · Fast mode · ChatGPT": the languages, then whatever
  // the job says it was made with.
  jobNote: (job) => jobNote(job),
  homeNoticeAndLog,
  // Read late: which job is open, and what it is doing, change all day under
  // the button that offers to stop it.
  getJobId: () => state.jobId,
  getJobStatus: () => (state.job ? state.job.status : null),
  onCancel: (jobId) => cancelDubJob(jobId),
  // The question, asked in the app's own dialog rather than the browser's.
  askCancel: () => confirmDialogs.askCancelDub(),
  onOpenSettings: () => settings.openSettings("keys"),
  // The popup's Recharge button is an anchor with target="_blank"; arming its
  // href is all the opening it needs. Handed in so the desktop shell could one
  // day open it its own way, and so a test can see the link offered.
  openExternal: (a, url) => { a.href = url; },
  // ChatGPT stopped the dubbing: which translators could carry on, asked
  // fresh (a model downloaded or a key saved since counts), and Resume with
  // the one picked.
  translatorChoices: async (job) => {
    const [engines, rows] = await Promise.all([
      fetch("/api/engines").then((r) => (r.ok ? r.json() : {})), models.refreshModels()]);
    return translatorChoices(job.translator, engines, rows);
  },
  onResumeWith: (jobId, translator) => resumeStopped(jobId, translator),
});

// ---------------- Projects (the job list, read from the server) ----------------
// Nothing is remembered in the browser any more: every job leaves a job.json
// beside its video, so GET /api/dub/jobs is the same list tomorrow morning as
// it is now -- which is what the sidebar is for. The rows themselves -- and the
// Up next card on the home screen, which reads the same list -- are drawn by
// ui/src/projects.mjs. What stays here is everything a row reaches out to and
// the list does not own: opening a job, the delete dialog, the cancel question,
// and the rail's fold (the topbar's pane buttons watch that one).
const projects = initProjectsUi({
  $,
  // Read late: which job is open changes all day, and the row marked "current"
  // has to be the one open at the moment the list is drawn.
  getActiveJobId: () => state.jobId,
  isHomeScreen: () => document.body.dataset.screen === "home",
  langName,
  onOpenJob: (jobId) => resumeJob(jobId),
  onDeleteJob: (job) => confirmDialogs.askDelete(job),
  onCancelJob: (job) => cancelQueuedJob(job),
  // The Home screen's own Projects grid (the mockup's shape, mockup 2026-09-29):
  // it never asks the server itself -- these two hooks hand it the same list
  // renderHistory just fetched and the same percent renderQueueCard just
  // worked out, so nothing here costs a second request.
  onJobs: (jobs) => { home.renderProjects(jobs); languageRow.setJobs(jobs); },
  onRunningPct: (jobId, pct) => home.setRunningPct(jobId, pct),
});

const home = initHomeScreen({
  $, langName,
  onOpenJob: (jobId) => resumeJob(jobId),
  onDeleteJob: (job, members) => confirmDialogs.askDelete(job, members),
  onError: homeError,
  onOpenDraft: (id) => reopenDraft(id),
  onDeleteDraft: (d) => confirmDialogs.askDelete({ draftId: d.downloadId, project: d.name || "this draft" }),
});

// ---------------- Drafts left before dubbing ----------------
// Leaving a draft with Home keeps it (owner, 2026-09-30): what it is goes
// into the browser's storage every time it changes (ui/src/keptDrafts.mjs),
// and Home shows it as a "Draft" card that opens it again with its cuts. It
// is let go when it is dubbed, deleted, or its video is no longer there.
let keptDrafts = readKept(localStorage);
function rememberDraft() {
  const d = getDraft();
  // A video held beside an open project (its Erase tab's) is not a draft.
  if (!d || !d.downloadId || state.jobId) return;
  keptDrafts = keepDraft(localStorage, d, keptDrafts);
  home.renderDrafts(keptDrafts);
}
function forgetDraft(downloadId) {
  keptDrafts = dropKept(localStorage, downloadId, keptDrafts);
  home.renderDrafts(keptDrafts);
}
onDraftChange(rememberDraft);
async function reopenDraft(downloadId) {
  const kept = keptDrafts.find((k) => k.downloadId === downloadId);
  if (!kept) return;
  // The last click wins: a project opened while the video was being held
  // again is the one on screen, and this draft stays a card.
  state.pollGeneration += 1;
  const myGeneration = state.pollGeneration;
  try {
    // The app forgets what it holds when it restarts; the file is still there.
    await holdDownload(downloadId, { title: kept.name, duration: kept.duration });
  } catch (e) {
    forgetDraft(downloadId);
    homeError(errorText(e));
    return;
  }
  if (myGeneration !== state.pollGeneration) return;
  // Still the draft in hand (left with Home a moment ago): as it was, splits
  // and undo steps too. Otherwise made again from what was kept.
  const live = getDraft();
  if (!live || live.downloadId !== downloadId) {
    setDraft({ downloadId, name: kept.name, duration: kept.duration,
               videoUrl: downloadVideoUrl(downloadId), ratio: kept.ratio });
    setRanges(kept.ranges);
    // And on the remembered choices, as a new draft starts: after a restart
    // nothing else had put them back, and the card opened on the page's own
    // English, ChatGPT and Fast mode, ready to start with them (Windows, 2026-10-10).
    newProject.startOnDefaults().then(draftSetup.paint, () => {});
  }
  $("draftError").textContent = "";
  draftSetup.showDraftScreen();
  leftTabs.show("dubbing");
}
// At launch: each kept draft's video is held again, so its card has a picture
// and opens at once; one whose file is gone is let go without a word.
(async () => {
  for (const k of [...keptDrafts]) {
    try { await holdDownload(k.downloadId, { title: k.name, duration: k.duration }); }
    catch (e) { if (e && e.status === 404) forgetDraft(k.downloadId); }
  }
  home.renderDrafts(keptDrafts);
})();

// The Home sidebar and the cards under the banner (the mockup's first screen,
// user 2026-09-30): each one opens a way in this page already has.
initHomeSidebar({
  $, body: document.body, repoUrl: REPO_URL,
  // The UTM-tagged link from the start-up's GET /api/settings; the plain page
  // until that has answered.
  persoUrl: () => savedSettings()?.perso_workspace_link || "https://perso.ai/workspace/vt",
  openUrl: (url) => window.open(url, "_blank", "noopener"),
  // An empty new project on its Dubbing tab: the Import block there takes a
  // file or a link, where the bare file picker took only a file (owner, 2026-10-09).
  onDubbing: () => draftSetup.openDraft(null, { tab: "dubbing" }),
  onErase: () => eraseScreen.openErase(),
  // An empty new project, on its Audio tab.
  onAudio: () => draftSetup.openDraft(null, { tab: "audio" }),
  // A link pasted into the banner is how a video gets saved.
  onSaveVideo: () => { $("linkInput").scrollIntoView({ block: "nearest" }); $("linkInput").focus(); },
  onSettings: () => settings.openSettings(),
  onHelp: () => openHelp(),
  loadWhatsNew: async () => (await fetch("/api/whats-new")).json(),
});

// ---------------- Up next: the waiting line on the first screen ----------
// The card follows the queue while the first screen is up. Cheap when idle:
// one list request a tick, and none at all off the home screen.
setInterval(() => { projects.renderQueueCard().catch(() => {}); }, 2500);

// A queue row's X, asked here because the answer is the page's: a waiting job
// goes quietly, but stopping the one on air is asked about first, since minutes
// of work go with it.
// One line on the first screen for something that did not work there, gone
// again after a few seconds: it is about a press, not about the screen.
let homeErrorTimer = null;
function homeError(text) {
  $("formError").textContent = text;
  clearTimeout(homeErrorTimer);
  homeErrorTimer = setTimeout(() => {
    if ($("formError").textContent === text) $("formError").textContent = "";
  }, 6000);
}

async function cancelQueuedJob(job) {
  const live = job.status !== "queued";
  const question = job.kind === "separate" ? t("Stop separating?") : job.kind === "erase" ? t("Stop erasing?") : undefined;
  if (live && !(await confirmDialogs.askCancelDub(question))) return;
  try {
    const r = await fetch(`/api/dub/jobs/${job.id}/cancel`, { method: "POST" });
    // 409: it was over already, and the list drawn below says so.
    if (!r.ok && r.status !== 409) throw new Error("cancel failed");
  } catch { homeError(t("Could not stop {name}. Try again.", { name: shownName(job) })); }
  projects.renderQueueCard().catch(() => {});
  projects.renderHistory().catch(() => {});
}

// Stopping a dub, deleting a project and a full disk are asked in dialogs of
// the app's own (ui/src/confirmDialogs.mjs): window.confirm() freezes every
// event in the Electron shell until it is dismissed.
const confirmDialogs = initConfirmDialogs({
  $, state, forgetDraft, resetForNewJob,
  getLastJobId: () => lastJobId,
  forgetLastJob,
  projects,
});

async function resumeJob(jobId) {
  // A real job takes the work screen back from whatever draft was showing.
  clearDraft();
  state.jobId = jobId;
  state.pollGeneration += 1;
  const myGeneration = state.pollGeneration;
  try {
    const job = await (await fetch(`/api/dub/jobs/${jobId}`)).json();
    // Another project was clicked (or Home) while this one was being read:
    // the last click is the one on screen, and this answer is dropped whole.
    if (myGeneration !== state.pollGeneration) return;
    if (job.detail) throw new Error(t("This project is no longer available. PersoDub may have restarted."));
    // Erasing subtitles is the other work this app does, and it has a screen of
    // its own: the same row, the same click, a different place to land.
    if (job.kind === "erase") { eraseScreen.openEraseJob(job); return; }
    // Separate audio is a tab of a draft: its video comes back as one.
    if (job.kind === "separate") { await openSeparatedJob(job); return; }
    // Asked for by name, from wherever the person happens to be standing: this
    // one is allowed to change the screen.
    handleJobUpdate(job, { opened: true });
    noteLastScreen(jobId);
    // queued is alive too (handleJobUpdate paints it as waiting): a job
    // restored at launch while it waits in line must keep polling.
    if (job.status === "running" || job.status === "cancelling" || job.status === "queued") {
      runPollLoop(jobId, myGeneration);
    }
  } catch (e) {
    if (myGeneration !== state.pollGeneration) return;
    // Nothing to show: fall back to the first screen with the reason on it.
    // The same full reset as a delete -- state.jobId was set optimistically at
    // the top of this function, and leaving it (and the previous job's rows
    // and video) behind on the home screen is what I-3 was about.
    resetForNewJob();
    // This job could not be opened, so it is not somewhere to go back to either
    // -- and resetForNewJob has just noted it as exactly that.
    forgetLastJob();
    $("formError").textContent = errorText(e);
  }
}

// ---------------- Quality mode hint ----------------
// The mode names alone don't tell a user what they trade away; spell it out.
const QUALITY_HINTS = {
  get fast() { return t("One take per line. The quickest preview."); },
  get high() { return t("Best of 4 takes per line. About 4× slower."); },
};
function updateQualityHint() {
  $("qualityHint").textContent = QUALITY_HINTS[$("qualitySelect").value] || "";
}
$("qualitySelect").addEventListener("change", updateQualityHint);
updateQualityHint();

// ---------------- Start dubbing ----------------
// (readOptions -- the whole form read back as one object -- moved with the
// dialog that holds it: newProject.readOptions() in ui/src/newProject.mjs.)

// The one line under the job's name while it runs: which way the dub is going.
function langsLabel() {
  const src = $("sourceLangSelect");
  // Plain names only -- the flag belongs to the dropdown, not the top bar.
  return `${langName(src.value) || t("Auto-detect")} → ${langName($("targetLangSelect").value)}`;
}

// Lives in the New project dialog, which is where the whole start-a-job
// decision now sits.
// The voice engine's pack is on disk but its process is not up (its start
// after an on-demand install timed out, or it died): the desktop app can start
// it again, and the dub goes on -- no "quit and reopen" for the user.
// errorEl: the dialog's own line -- or, for a draft's Start dubbing
// (ui/src/draftSetup.mjs), that panel's own -- since this is the one status
// word shown while the engine comes back up.
// {ok, why}: why is the line said under the refusal when it did not come back
// (ui/src/format.mjs restartFailure) -- without it the same "try again" came
// back and the shell's reason was thrown away.
async function restartVoiceEngine(errorEl) {
  const shell = window.persodubShell;
  if (!shell || !shell.installPack) return { ok: false, why: "" };
  errorEl.textContent = t("Starting the voice engine…");
  const r = await shell.installPack("engine").catch(() => ({ ok: false }));
  return r && r.ok ? { ok: true } : { ok: false, why: restartFailure(r && r.reason) };
}

// Posts the form and walks through every way a start can come back short --
// models missing (409), ChatGPT not signed in, no Perso workspace chosen, the
// voice engine still starting, out of disk space -- before giving up and
// printing the plain error on `errorEl`. Shared by the New project dialog's
// Start (below) and a draft's own (ui/src/draftSetup.mjs), so a fifth way to
// fail short never has to be taught to both.
// `retried`: this attempt already restarted the voice engine once. A start
// that "succeeded" while the engine still said it was not running retried
// forever, 2,676 times in 13 seconds on one Mac (issue #117, 2026-09-28).
// `retry`: try the whole thing again once whatever was missing is fixed (a
// key saved, a workspace picked, models downloaded, signed in to ChatGPT).
async function submitDubStart({ fd, label, errorEl, retry, retried = false }) {
  errorEl.textContent = "";
  try {
    const jobId = await startDubJob(fd);
    ratioUi.carryTo(jobId);   // a draft's ratio goes with the job it becomes
    state.jobId = jobId;
    noteLastScreen(jobId);
    state.pollGeneration += 1;
    const myGeneration = state.pollGeneration;
    // The server has the job on file already, so the sidebar only has to ask
    // again -- the new row comes back with it.
    projects.renderHistory().catch(() => {});
    // Until the first answer the pane is this dubbing's and empty, not the
    // last one's percent, video and log; nor is the last job still "open".
    state.job = null;
    runningScreen.starting();
    $("logBox").textContent = "";
    showScreen("running");
    // No back arrow while it runs: Cancel is the only way out of a live job.
    setTopbar({ title: label, subtitle: `${t("Working")} · ${langsLabel()}`, running: true, back: true });
    runPollLoop(jobId, myGeneration);
    return true;
  } catch (e) {
    if (e && e.status === 409 && e.detail && e.detail.missing) {
      await models.refreshModels();
      models.showModelsDialog(e.detail);
    } else if (e && e.status === 422 && /ChatGPT sign-in/.test(serverText(e))) {
      chatgptSignIn.askChatgptSignIn(retry);
    } else if (e && e.status === 422 && /Select a Perso workspace/.test(serverText(e))) {
      // A key with several workspaces and none picked: pick one here, then go on.
      keyWindow.askKey("perso", null, null, { spaceOnly: true, then: retry });
    } else if (!retried && e && e.status === 422 && /voice engine is not running/.test(serverText(e))) {
      const restart = await restartVoiceEngine(errorEl);
      if (restart.ok) {
        return submitDubStart({ fd, label, errorEl, retry, retried: true });
      }
      // The refusal, and under it why starting the engine again did not work.
      errorEl.textContent = [errorText(e), restart.why].filter(Boolean).join("\n");
    } else if (!confirmDialogs.showIfOutOfSpace(e)) {
      errorEl.textContent = errorText(e);
    }
    // With the advanced options open the line sits below the fold, where a
    // refused Start looked like nothing happened (2026-10-20).
    if (errorEl.textContent) errorEl.scrollIntoView({ block: "nearest" });
    return false;
  }
}

async function startDubbing() {
  const np = state.newProject;
  // Three ways a video can be in this dialog: dropped, pasted as a link, or
  // already in the app's hands (the erase screen's result).
  if (!np || (!np.file && !np.probe && !np.downloadId)) {
    $("projectError").textContent = t("Choose a video first."); return;
  }

  if (np.files) return startBatchDubbing(np.files);

  $("startBtn").disabled = true;
  dubRestart = startDubbing;
  try {
    const fd = buildDubFormData(newProject.readOptions());
    const label = np.file ? np.file.name : (np.probe ? np.probe.title : (np.title || t("Dubbing")));
    const started = await submitDubStart({
      fd, label, errorEl: $("projectError"), retry: () => startDubbing(),
    });
    if (started) {
      // The video is on its way to the server now; the dialog's copy of it can go.
      $("projectOverlay").classList.remove("open");
      newProject.releaseProjectVideo();
    }
  } catch (e) {
    $("projectError").textContent = errorText(e);
  } finally {
    $("startBtn").disabled = false;
  }
}

// First dub with ChatGPT and no sign-in yet: ask in a window of its own
// (ui/src/chatgptSignIn.mjs) instead of sending the user to Settings. Handed
// startDubbing: what a sign-in goes on with when no retry is named (a batch).
const chatgptSignIn = initChatgptSignIn({
  $, startDubbing,
  onTranslateHere: () => {
    const sel = $("translateSelect");
    sel.value = "hunyuan";
    sel.dispatchEvent(new Event("change"));
  },
});

// Several videos, one set of choices: the first starts now, the rest join the
// queue, and the first screen's Up next card is where the line shows.
async function startBatchDubbing(files) {
  $("startBtn").disabled = true;
  try {
    const opts = newProject.readOptions();
    for (const f of files) {
      const fd = buildDubFormData({ ...opts, video: f, sourceUrl: null,
                                    downloadId: null, project: undefined, trim: null });
      await startDubJob(fd);
    }
    newProject.closeNewProject();
    projects.renderHistory().catch(() => {});
    showHome();
    projects.renderQueueCard().catch(() => {});
  } catch (e) {
    // The jobs already posted are in line and stay there -- only the rest of
    // the batch stops, and the dialog says why.
    if (e && e.status === 409 && e.detail && e.detail.missing) {
      await models.refreshModels();
      models.showModelsDialog(e.detail);
    } else if (e && e.status === 422 && /ChatGPT sign-in/.test(serverText(e))) {
      chatgptSignIn.askChatgptSignIn();
    } else if (e && e.status === 422 && /Select a Perso workspace/.test(serverText(e))) {
      // A key with several workspaces and none picked: pick one here, then go on.
      keyWindow.askKey("perso", null, null, { spaceOnly: true, then: () => startDubbing() });
    } else if (!confirmDialogs.showIfOutOfSpace(e)) {
      $("projectError").textContent = errorText(e);
    }
  } finally {
    $("startBtn").disabled = false;
  }
}

function runPollLoop(jobId, myGeneration) {
  pollDubJob(jobId, {
    onUpdate: (job) => { if (myGeneration === state.pollGeneration) handleJobUpdate(job); },
    shouldStop: () => myGeneration !== state.pollGeneration,
    // The server stopped answering (app quit, machine slept). Say so, and keep
    // asking: the dub is very likely still running back there, so Cancel stays
    // exactly as it was and the loop only ends when the user leaves the job.
    // The next answer redraws this line through paintNotices, which is what
    // takes the red away again the moment the server is back.
    onUnreachable: (e) => {
      if (myGeneration !== state.pollGeneration) return;
      runningScreen.showNoticeError(t("PersoDub is not answering. Still trying."));
    },
  }).catch((e) => {
    // Leaving the job settles the loop without a word (it resolves, it does not
    // throw). What lands here is the server answering that this job is gone, and
    // that has to be said once rather than retried for ever.
    if (myGeneration !== state.pollGeneration) return;
    runningScreen.showNoticeError(errorText(e));
  });
}

// The screens a job owns. Everywhere else -- the erase tool, the first
// screen -- belongs to the person, not to the job.
const JOB_SCREENS = new Set(["running", "done", "failed"]);

// `opened` is the difference between the two ways this is called: the person
// clicked the job (resumeJob), or the job reported in on its own (the poll).
// Only the second one has to keep its hands off the screen.
async function handleJobUpdate(job, { opened = false } = {}) {
  // The Dubbing tab shows this project's script, not the Import block an
  // empty new project left there: painted when another project takes the
  // screen, not on every report of the same one.
  const newlyOpen = !state.job || state.job.id !== job.id;
  state.job = job;
  if (newlyOpen) draftSetup.paint();
  // The script assistant runs in its own module and cannot see `state`. Parking
  // the id here lets it answer "this job" without asking the user for a number
  // they have no way of knowing.
  document.body.dataset.jobId = job.id;
  // A dub reports its progress every second or so, and every report used to
  // put its own screen back up: pressing Erase subtitles mid-dub lit the rail
  // icon and then the running screen returned, so the tool could not be
  // reached until the dub ended (user, 2026-09-10). The job still updates --
  // its record, its row in Projects, the waiting card -- but it stops taking
  // the screen back from somewhere the person went on purpose.
  if (!opened && !JOB_SCREENS.has(document.body.dataset.screen)) {
    projects.renderHistory().catch(() => {});
    projects.renderQueueCard().catch(() => {});
    return;
  }
  const progress = parseProgress(job.logs);
  // "queued" is alive too -- it shows the waiting version of the running
  // screen rather than a failure, and starts by itself.
  const running = job.status === "running" || job.status === "cancelling"
    || job.status === "queued";
  showScreen(running ? "running" : job.status === "done" ? "done" : "failed");
  setTopbar({
    title: jobLabel(job),
    subtitle: jobStatusLine(job, progress),
    running,
    done: job.status === "done",
    // Always: the first screen's Up next card keeps a running job in view
    // now, so going back mid-dub no longer means losing it (user request
    // 2026-09-01 -- with a queue there has to be a way back to the line).
    back: true,
  });
  paintJobNote(job);
  languageRow.paint();
  renderLog(job);
  runningScreen.paintNotices(job);
  runningScreen.paintCancel();

  if (running) {
    // A stopped dub that was resumed: its failure card has to go, or it stands
    // under the progress card and squeezes it (2026-09-30).
    $("doneFail").hidden = true;
    runningScreen.paintRunning(job);
    return;
  }

  // The job is over, so its row's status dot has changed colour.
  projects.renderHistory().catch(() => {});

  // Desktop only: in a plain browser persodubShell is undefined and nothing is
  // counted, which is the intended behaviour -- the counts describe app installs.
  // The id goes with it: a failure report is built in the shell, and without
  // the job it cannot ask the engine which stage died or read that job's own
  // log -- it would travel with the app log alone and no "3/6 translate".
  // Never the first line: a job log opens with the video's own name -- a
  // title, a link, a file name -- and on a job that died early that line was
  // inside the last six and went into twelve public issues (2026-09-15).
  // Once per job, and remembered across restarts. This runs every time a
  // finished job is drawn -- opened from the list, walked back to, restored as
  // the last screen at launch -- and each of those sent another report. The
  // shell keeps its own guard for the session; this one survives a restart,
  // which is the case that produced the empty second report: a job's log is
  // not saved to disk, so after a restart there is nothing left to send and
  // the relay files the blank as a failure of its own (2026-09-18).
  if (!countedOnce(job.id)) {
    window.persodubShell?.countDub?.(job.status, (job.logs || []).slice(1).slice(-6).join("\n"), job.id);
  }

  await renderDone(job);
}

// Human name for a language code, falling back to the code itself; in the
// page's language (ui/src/i18n.mjs languageName).
function langName(code) {
  if (!code) return null;
  const l = LANGUAGES.find((x) => x.code === code);
  return languageName(code, l ? l.name : code.toUpperCase());
}

// The two language names, as the script table heads its columns and the
// timeline labels its lanes -- one source of truth, so the two can never
// disagree. That is why it stays on the page rather than moving into
// ui/src/scriptTable.mjs with the table: the timeline is the other caller.
// "Original / Script" said nothing about which languages were being compared.
// The source is whichever the user chose, or -- when they left it on auto --
// whatever was detected.
// The two columns of words. "Original" and "Translated" rather than the two
// language names: the pair is what the table is for, and "Korean" beside
// "Original" read as a language column rather than as the other half of a
// translation (user, 2026-09-11). The languages themselves are in the top bar.
function scriptLangNames() {
  return { source: "Original", target: "Translated" };
}

// ---------------- The finished screen ----------------
// The script table on the left, the video on the right, and the top bar's
// Export button over a small dialog of downloads. A job that failed or was
// cancelled has neither, so it shows the reason instead.

const doneVideo = $("doneVideo");

// The notice line and the raw log exist once each, so a failed job borrows them
// rather than printing a second copy. Everything else keeps them where they
// belong: the log in the progress card, the notice above the script.
function moveInto(el, parent, first = false) {
  if (el.parentElement === parent) return;
  if (first) parent.prepend(el); else parent.appendChild(el);
}

// Called by every screen that is not the failure one -- a borrowed log left on
// the done screen is a log the next running job writes into and nobody sees.
function homeNoticeAndLog() {
  moveInto($("doneNotice"), $("tabDubbing"), true);
  moveInto($("rawLogDetails"), $("runFoot"));
}

async function renderDone(job) {
  const finished = job.status === "done";
  // A different job starts its own count of remade-line changes, and its own
  // clean slate under the Retry button; the URL of a video nobody has remade
  // carries no mark at all. Only on the change of job: this runs on every poll,
  // and clearing it each time wiped the retry's own error message a moment
  // after it was written.
  if (donePlayer.openJob(job.id)) {
    $("doneRetryError").textContent = "";
    // The rest of the previous job's transient state, which nothing else
    // clears: how far the timeline was scrolled. (The player forgets its
    // own: which of its two files it showed, and a line's armed stop.)
    timeline.resetView();
  }
  $("doneFail").hidden = finished;
  timeline.fitLayout();   // the two panes have a width to measure only now they are on show
  donePlayer.sizeVideoPane();   // and only now can the row say whether the two fit side by side
  if (!finished) {
    // Cancelled and failed are two different stories, and neither has a screen
    // of its own: the back chevron in the top bar is the way out of both. The
    // reason itself is the notice line's job -- it is the copy that carries the
    // Recharge link, and one sentence said twice reads as a bug.
    runningScreen.paintStopped(job);
    $("doneFailMark").innerHTML = stoppedMark(job.status);
    $("doneFailWhy").textContent = job.status === "cancelled"
      ? t("This dubbing was stopped.")
      : t("Dubbing didn't finish.");
    // Appended in the order they should read -- why it stopped, what to do
    // about it, and the log last. moveInto leaves a borrowed element where it
    // already is, which put the log above the button the second time round.
    moveInto($("doneNotice"), $("doneFailBody"));
    $("doneFailBody").appendChild($("doneFailActions"));
    $("doneFailBody").appendChild($("doneRetryError"));
    $("doneFailBody").appendChild($("rawLogDetails"));
    $("doneRetry").disabled = false;
    $("doneResume").disabled = false;
    // A cloud dub was made on Perso's side: nothing here to pick up from.
    $("doneResume").hidden = job.dub_mode === "perso";
    $("doneRetry").className = job.dub_mode === "perso" ? "btn btn-primary" : "btn btn-secondary";
    return;
  }
  homeNoticeAndLog();
  // Tell the shell where this job's downloads belong. It has to be handed over
  // before any button is clicked, because will-download cannot ask for it.
  window.persodubShell?.rememberJob?.({ id: job.id, project: job.project, day: job.day });
  const src = donePlayer.doneVideoSrc(job, donePlayer.getDoneSource());
  // Assigning src on every poll would restart the download from the top.
  if (doneVideo.getAttribute("src") !== src) doneVideo.setAttribute("src", src);
  subtitles.loadSubStyle(job.id);
  ratioUi.refresh();
  await scriptTable.renderScript(job.id);
}

// The failure card's one way forward: ask the server to start the same job
// over. The video it began from is already sitting in the old job's folder, so
// the retry is one request -- it used to pull the whole original down into the
// page and post it straight back up, which for a 2 GB link job meant two
// copies in memory and a third on disk. The folder may have been cleared out
// since, which is the one thing that can stop it.
async function retryStopped(jobId) {
  setFailButtons(true);
  $("doneRetryError").textContent = "";
  try {
    const r = await fetch(`/api/dub/jobs/${jobId}/retry`, { method: "POST" });
    if (!r.ok) {
      await refusedRestart(r, () => retryStopped(jobId), t("Could not start this project again."));
      return;
    }
    const { job_id } = await r.json();
    // Straight onto the new job's running screen, sidebar and all -- the same
    // path Projects takes to open a job.
    projects.renderHistory().catch(() => {});
    // Unless the person has gone elsewhere meanwhile: it is in Projects.
    if (state.jobId === jobId) await resumeJob(job_id);
  } catch (e) {
    // Under the button, not over the headline: why the job failed is the
    // card's whole reason for being, and there is no way back to that
    // sentence once it has been written over.
    $("doneRetryError").textContent = errorText(e);
  } finally {
    // renderDone only clears this on a change of job, so a button left
    // disabled after a refused retry stays dead until the user navigates away.
    setFailButtons(false);
  }
}
$("doneRetry").addEventListener("click", () => { if (state.job) retryStopped(state.job.id); });

// Resume: the same job carries on in its own folder, keeping every stage the
// earlier run finished -- separation, the transcript, the translation, each
// voice line made -- so nothing is paid for or waited on twice (2026-09-23).
function setFailButtons(disabled) {
  // Both at once: Resume then Start over (or the reverse) before the screen
  // changed started the same video twice (review 2026-09-23).
  $("doneResume").disabled = disabled;
  $("doneRetry").disabled = disabled;
}
// A Try again or a Resume the server turned down. Models it still needs get
// the download dialog a start gets, which runs `again` once they are in;
// anything else is thrown with the server's sentence, or `fallback`. Try
// again threw the 409's detail itself, an object, and the card read
// "[object Object]" (2026-10-10).
async function refusedRestart(r, again, fallback) {
  const detail = (await r.json().catch(() => ({}))).detail;
  if (r.status === 409 && detail && detail.missing) {
    dubRestart = again;
    await models.refreshModels();
    models.showModelsDialog(detail);
    return;
  }
  throw new Error(detail || fallback);
}
// `translator`: carry on with another one (the ChatGPT popup's buttons). One
// not downloaded yet gets the download dialog a start gets, then this again.
async function resumeStopped(jobId, translator = null) {
  setFailButtons(true);
  $("doneRetryError").textContent = "";
  try {
    const r = await fetch(`/api/dub/jobs/${jobId}/resume`, translator
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ translator }) }
      : { method: "POST" });
    if (!r.ok) {
      await refusedRestart(r, () => resumeStopped(jobId, translator), t("Could not resume this project."));
      return;
    }
    runningScreen.forgetPopups(jobId);
    projects.renderHistory().catch(() => {});
    if (state.jobId === jobId) await resumeJob(jobId);
  } catch (e) {
    $("doneRetryError").textContent = errorText(e);
  } finally {
    setFailButtons(false);
  }
}
$("doneResume").addEventListener("click", () => { if (state.job) resumeStopped(state.job.id); });

// The player itself -- play and pause, the clock and the script row it is on,
// the Original / Dubbing tabs, the pane's size -- is ui/src/donePlayer.mjs.
const donePlayer = initDonePlayer({
  $, state, doneVideo,
  // Reached for when called: the timeline is wired further down this file.
  timeline: { paintTimeline: (t, total, clock) => timeline.paintTimeline(t, total, clock) },
});

// ---------------- Export dialog ----------------
// One Export button for everything a project can hand back: a draft's kept
// parts, a finished dub's files, an erased video. The dialog, its rows and
// the receipt each row gives are ui/src/exportDialog.mjs; this is only what
// is on screen right now, in the shape that file reads.
async function exportContext() {
  // The shape the Ratio button is on: every video row is saved in it
  // (ui/src/exportDialog.mjs puts it on the links and hands it to save).
  const ratio = ratioUi.current();
  // An erased video: the app writes the file itself. Its player has no Ratio
  // button, so the shape is the one its draft was left on; an erase opened
  // from Projects has no draft behind it and is saved as it is.
  if (document.body.dataset.screen === "erase" && eraseScreen.erasedJob()) {
    return { kind: "erase", ratio: (getDraft() || {}).ratio || "original", where: t("Saves to Downloads"), save: (what) => eraseScreen.exportErased(what) };
  }
  // Any other erase screen hands back only the draft it shows: an empty one
  // saved whatever draft was still held (Windows test E9).
  if (document.body.dataset.screen === "erase" && !eraseScreen.exportsDraft()) return null;
  // The Audio tab with its two sounds: those are what it hands back. Links,
  // the way a dubbing's own two are.
  const separated = !state.jobId && leftTabs.current() === "audio" && audioTab.separatedJob();
  if (separated) {
    return { kind: "separate", jobId: separated.id, project: String((getDraft() || {}).name || "").replace(/\.[A-Za-z0-9]{2,4}$/, "") || "audio",
             where: t("Saves to Downloads") };
  }
  // A draft with a video on the timeline, before any dub.
  if (!state.jobId && draftSetup.canExport()) {
    return { kind: "draft", ratio, where: t("Saves to Downloads"), save: (what) => draftSetup.saveDraft(what) };
  }
  const job = state.job;
  if (!job) return null;
  // The subtitles are only offered when there are some (an older job may have
  // none). Asked with HEAD: whether the file exists is the whole question, and
  // fetching it to find out downloaded the subtitles nobody had asked for yet.
  const hasSrt = await fetch(`/api/dub/result/${job.id}/srt`, { method: "HEAD" })
    .then((r) => r.ok).catch(() => false);
  // The original's voice and background, each only while the job's folder
  // still has it (a dubbing made wholly on Perso has neither).
  const stems = await fetch(`/api/dub/result/${job.id}/stems`)
    .then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  // The subtitled video downloads in the look chosen on the work screen: the
  // same subStyle the player edits (preset, position, size). Nothing to pick
  // here -- the dialog only hands files over (user, 2026-09-03). The remake
  // mark rides along for the same cache reason as the video row's.
  const target = job.language_code || "out";
  const doneVersion = donePlayer.getDoneVersion();
  const mark = doneVersion ? `&v=${doneVersion}` : "";
  const { preset: subPreset, query: posQ } = subtitles.exportParams();
  return {
    kind: "dub", jobId: job.id, target, mark, hasSrt, stems, project: job.project, fromLink: !!job.from_link, ratio,
    // The same URL the player is on, remake mark and all: without it a download
    // taken straight after a remake can be served the old video from cache.
    videoHref: donePlayer.doneVideoSrc(job, "dubbed"),
    subtitled: { href: `/api/dub/result/${job.id}/subtitled?preset=${subPreset}${posQ}&download=1${mark}`,
                 name: `dub_${target}-sub-${subPreset}.mp4` },
    where: whereDownloadsGo(job),
  };
}
const exportDialog = initExportDialog({
  $, getContext: exportContext, storage: localStorage, shell: window.persodubShell || null,
});
$("exportBtn").addEventListener("click", () => exportDialog.open());
// Why Export is dim, on its tip. Three places switch it on and off, so the tip
// follows the button itself rather than each of them.
new MutationObserver(() => {
  $("exportBtn").title = $("exportBtn").disabled ? t("Nothing to export yet") : "";
}).observe($("exportBtn"), { attributes: true, attributeFilter: ["disabled"] });

// A button keeps the keyboard after the mouse presses it, and the timeline's
// keys -- Space to play, Delete, undo -- stand down while a button has it (a
// focused button answers Space itself). So after clicking a tab or Export,
// Space no longer played the video until something else was clicked
// (2026-09-30). A press with the mouse gives the keyboard back; a press from
// the keyboard (detail 0) leaves focus where it is, and so does a dialog.
document.addEventListener("click", (e) => {
  if (!e.detail || !e.target.closest) return;
  const button = e.target.closest("button");
  if (button && document.activeElement === button && !button.closest(".modal-overlay")) button.blur();
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("exportOverlay").classList.contains("open")) exportDialog.close();
});

// The one sentence that says what clicking a link above will do. In the desktop
// shell the file is saved silently into <Downloads>/<day>/<project>/ -- the
// folder desktop/src/downloadsIpc.js builds in its will-download handler, from the day and
// project this same job carries. A plain browser saves it wherever the browser
// is set to, which is the browser's business, not ours.
function whereDownloadsGo(job) {
  if (!window.persodubShell) return t("Saves to the Downloads folder");
  return job?.day && job?.project
    ? t("Saves to Downloads / {day} / {project}", { day: job.day, project: job.project })
    : t("Saves to Downloads");
}

// ---------------- the script table ----------------
// The editable grid of lines lives in ui/src/scriptTable.mjs, tested there.
// What it needs from this page: the pair of language names (shared with the
// timeline), whether the open job is a Perso dub, the timeline and playhead it
// redraws under itself, and the finished screen's player -- which it only ever
// asks to show the dub, play one line and fetch itself again after a remake.
const scriptTable = initScriptTableUi({
  $,
  scriptLangNames,
  isPersoJob: () => !!(state.job && state.job.dub_mode === "perso"),
  // Reached for when it is called, not now: the timeline is wired up further
  // down this file, and naming it here would read a const that does not exist
  // yet.
  renderTimeline: (lines, duration) => {
    timeline.renderTimeline(lines, duration);
    subtitles.subLinesChanged();   // new words: the subtitles' layout is measured again
    // And shown again: the subtitle style can land before the script, and the
    // overlay it drew then held the previous project's line (2026-09-25).
    subtitles.updateSubtitleNow();
  },
  paintPlayhead: donePlayer.paintPlayhead,
  getVideo: () => doneVideo,
  showVideoSource: donePlayer.showVideoSource,
  playRange,
  reloadVideo: donePlayer.reloadDoneVideo,
  getJob: () => state.job,
  // ChatGPT stopped Translate again: the dubbing's own popup, whose
  // translator buttons translate those lines with the one picked.
  askTranslator: (notice, pick) =>
    runningScreen.showCreditModal(notice, { id: state.jobId, translator: "chatgpt" }, pick),
  // The project's translator is not downloaded: the dub start's dialog.
  needModels: (detail, retry) => {
    dubRestart = retry;
    models.refreshModels().then(() => models.showModelsDialog(detail));
  },
});

// ---------------- Subtitles on the player ----------------
// One object mirrors the job's subtitle_style.json: how the subtitles look
// (style, size, position), whether they go on at all, and any lines the user
// retimed on the timeline. The overlay, the timeline lane and the Export
// dialog all read and write it; saves are debounced PUTs.
// It lives in ui/src/subtitleOverlay.mjs, with the overlay and the work of the
// Captions tab's tools. What it needs from here: the finished screen's player
// and which of its two files is on, the left panel's tabs, and the timeline.
const subtitles = initSubtitleOverlay({
  $, state, doneVideo, leftTabs,
  // Reached for when called: the timeline is wired further down this file.
  timeline: {
    getLines: () => timeline.getLines(),
    redraw: () => timeline.redraw(),
    drawTimelineTrack: () => timeline.drawTimelineTrack(),
  },
  getDoneSource: donePlayer.getDoneSource,
  showVideoSource: donePlayer.showVideoSource,
});

// ---------------- Ratio and Preview ----------------
// The two buttons at the right of the player's foot (ui/src/ratio.mjs): the
// video inside a black canvas of another shape, and the video as a phone app
// would show it, that app's interface drawn over it. The subtitles keep following the picture, which only moves.
const ratioUi = initRatioUi({
  video: doneVideo, wrap: $("videoWrap"), canvas: $("ratioCanvas"), preview: $("ratioPreview"),
  ratioBtn: $("ratioBtn"), ratioMenu: $("ratioMenu"),
  previewBtn: $("previewBtn"), previewMenu: $("previewMenu"),
  getProject: () => {
    if (state.jobId) return { kind: "job", id: state.jobId };
    const d = getDraft();
    return d ? { kind: "draft", id: d.downloadId, ratio: d.ratio } : null;
  },
  saveDraftRatio: setDraftRatio,
  onLayout: subtitles.syncVideoChrome,
});
onDraftChange(() => ratioUi.refresh());
// And whenever the player's own box changes without the window moving: layout G
// sizes the video pane off the row it is in, so opening the Dub Agent or
// dragging the divider moves the picture and the subtitles have to follow it.
//
// The WRAP is watched as well as the video, and it is the one that matters
// while a divider is dragged: a portrait clip is as tall as the pane allows,
// so widening the pane does not change the video's SIZE at all -- only where
// it sits inside a wider box. The video's own observer never fired, and the
// subtitle stayed at the old left edge, out on the dark beside the picture
// (user, 2026-09-09).
new ResizeObserver(subtitles.syncVideoChrome).observe(doneVideo);
new ResizeObserver(subtitles.syncVideoChrome).observe(doneVideo.parentElement);

// ---------------- Done: the timeline ----------------
// The strip under the script table -- the ruler, the three lanes over it, the
// subtitle lane and its trim handles, the fold, the playhead, and the finished
// screen's keyboard -- lives in ui/src/timeline.mjs, tested there. The four
// pane grips went with it: the timeline's own ceiling is read off what the
// other three leave, so the four sizes are one agreement and belong in one
// file. The zoom controls in its head and the subtitle lane's eye toggle are
// written by that file now; this page keeps only the empty #timeline box they
// are drawn into.
// What it needs from here: the pair of language names (shared with the table),
// the player and the clock it was last painted with, the subtitle style object
// the overlay on the picture shares with the lane, and the projects list's
// re-measure for the sidebar grip.
// On the Erase tab the same strip scrubs, plays and counts that tab's own
// video: every "the player" below asks which screen is up.
const onEraseTab = () => document.body.dataset.screen === "erase";
function paintErasePlayhead() {
  if (!onEraseTab()) return;
  const v = $("eraseVideo");
  timeline.paintTimeline(v.currentTime || 0, Number.isFinite(v.duration) ? v.duration : 0, clockLine(v));
}
function toggleErasePlay() {
  const v = $("eraseVideo");
  if (!v.getAttribute("src")) return;
  if (v.paused || v.ended) v.play().catch(() => {}); else v.pause();
}
const timeline = initTimelineUi({
  // A Voice or Background lane's speaker (a separated draft, the Audio tab).
  onStemMute: (which) => audioTab.toggleMute(which),
  $,
  getVideo: () => (onEraseTab() ? $("eraseVideo") : doneVideo),
  getClock: () => (onEraseTab() ? clockLine($("eraseVideo")) : donePlayer.getDoneClock()),
  getPlayerClock: () => $(onEraseTab() ? "eraseTime" : "videoTime"),
  videos: () => [doneVideo, $("eraseVideo")],
  // The video lane's name, film strip and waveform: the open job's original.
  getMedia: () => (state.job ? { kind: "job", id: state.job.id, name: jobLabel(state.job) } : null),
  getSubStyle: subtitles.getSubStyle,
  subCueOf: subtitles.subCueOf,
  saveSubStyle: subtitles.saveSubStyle,
  updateSubtitleNow: subtitles.updateSubtitleNow,
  isNowLine: donePlayer.isNowLine,
  showVideoSource: donePlayer.showVideoSource,
  playRange,
  cancelRange,
  paintPlayhead: () => (onEraseTab() ? paintErasePlayhead() : donePlayer.paintPlayhead()),
  toggleDonePlay: () => (onEraseTab() ? toggleErasePlay() : donePlayer.toggleDonePlay()),
  markClippedNames: projects.markClippedNames,
});
// The keyboard, the observer that re-measures the track and the window resize
// that puts the remembered pane sizes back -- everything that listens outside
// the strip, attached in one step the page asks for rather than at import.
timeline.attach();
leaveEraseTimeline = () => timeline.showErase(null);
fitWorkLayout = () => timeline.fitLayout();
showAudioLanes = (info) => timeline.showAudio(info);
// After the player row's own listeners, so the clock under the erase video
// ends up counting kept time the way the strip does.
for (const e of ["play", "playing", "pause", "ended", "emptied", "timeupdate", "loadedmetadata", "seeked"]) {
  $("eraseVideo").addEventListener(e, paintErasePlayhead);
}

// The assistant rewrites lines through its own tools; when it does, the panel
// says so and the table reloads itself. Waiting for the user to refresh made an
// edit that had already happened look like nothing had.
window.addEventListener("persodub:script-changed", () => {
  const jobId = scriptTable.getJobId();
  if (!jobId) return;
  // Redrawing the table while a cell is being typed in would throw the typing
  // away. The turn-end redraw catches it a moment later either way.
  if (document.activeElement?.classList?.contains("sc-dst")) return;
  scriptTable.renderScript(jobId);
});

// The assistant can also make the changed voices again. It does that in place:
// the lines it re-speaks go back into THIS job's video, so there is no new job
// to follow -- the screen fetches the script again and reloads the player.
// Fired when the assistant's turn is over, which is the first moment the
// rebuilt video file is certainly finished being written.
// The conversation's Download button started a model: the top bar and Settings
// follow it from here.
window.addEventListener("persodub:models-changed", () => { models.refreshModels().catch(() => {}); });
// So does coming back to the window: a model folder put back (or taken away)
// in the file window was read again only when Settings opened, and the "Needs …"
// line under a choice stayed after the model was back (Windows, 2026-10-10).
window.addEventListener("focus", () => { models.refreshModels().catch(() => {}); });
window.addEventListener("persodub:jobs-changed", () => {
  projects.renderHistory().catch(() => {});
  projects.renderQueueCard().catch(() => {});
});
window.addEventListener("persodub:voices-remade", async () => {
  const jobId = scriptTable.getJobId();
  if (!jobId) return;
  // How many lines were waiting for a new voice, counted off the table that is
  // on screen right now. The marks that are gone after the redraw are the ones
  // that were remade -- no second way of deciding which lines those are.
  const before = scriptTable.countStale();
  await scriptTable.refreshAfterVoices(jobId);
  const remade = before - scriptTable.countStale();
  if (remade < 1) return;
  scriptTable.setSaving(remade === 1 ? t("1 line remade") : t("{n} lines remade", { n: remade }));
  setTimeout(() => scriptTable.setSaving(""), 2000);
});

// Whatever changed the script somewhere else -- the agent's remake on Perso,
// another window -- is drawn here a few seconds later (ui/src/scriptWatch.mjs).
// Never while a line is being typed in, nor while the table's own work is
// under way: its status line ends in "…" until that work is over.
const lookAtScript = scriptChecker({
  getJobId: () => scriptTable.getJobId(),
  getStamp: () => scriptTable.getStamp(),
  refresh: (jobId) => scriptTable.refreshAfterVoices(jobId),
  active: () => document.body.dataset.screen === "done"
    && !document.activeElement?.classList?.contains("sc-dst")
    && !$("scriptSaving").textContent.endsWith("…"),
});
(async function watchScript() {
  await lookAtScript().catch(() => {});
  setTimeout(watchScript, 3000);
})();

projects.renderHistory().catch(() => {});
openLastScreen();
