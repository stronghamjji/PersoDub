// The Settings sheet: what opens behind the topbar's gear. It reads
// GET /api/settings into its fields and saves them back when Save is pressed
// (Mac tester, 2026-09-28: saving the moment a field was left gave nobody a
// way to tell whether it had saved). Cancel, the X, Escape and the backdrop
// leave without saving; the next open reads the saved values again. It also owns the Perso workspace picker
// (including the preview of a key that has only been pasted), the
// Show-in-Finder button, the usage-counts switch, the language picker and the
// Acknowledgements fold. The sheet is five tabs (Models, API keys, Storage, Privacy, About),
// one panel showing at a time; openSettings picks the one to open on.
//
// What is NOT here: the Models catalog rows inside the sheet belong to
// ui/src/modelsDialog.mjs -- this file only asks for a repaint when the sheet
// opens. Neither are the buttons that OPEN the sheet (the topbar gear, the
// Advanced-options keys link, the models dialog, the out-of-credits popup):
// they live with the rest of index.html and call openSettings().
//
// Everything this file touches is #settingsOverlay and its children.

/**
 * Wire the Settings sheet to a page.
 *
 * @param {object} deps
 * @param {(id: string) => any} deps.$   the page's getElementById helper
 * @param {() => void} deps.onSaved      run at the end of every save pass, so the
 *        page can re-check what a changed key made usable (the page passes
 *        applyEngineAvailabilityToForm, which reaches into the New project form)
 * @param {() => void} deps.refreshModelCatalog  bring the model rows up to date
 *        when the sheet opens. The page passes models.refreshModels, which does
 *        more than paint this sheet's list: it asks GET /api/models, repaints
 *        the topbar's download chip and the New project dropdown hints, and --
 *        if the rows a held-up dub was waiting for have all arrived -- starts
 *        that dub. Not awaited, here or before the move: the sheet opens
 *        without waiting on any of it.
 * @param {object} [deps.shell]  the desktop shell (window.persodubShell), which
 *        says where downloads go (downloadFolder); null in a browser
 * @param {object} [deps.account]  the Perso sign-in (ui/src/signIn.mjs): its
 *        status, a way to hear it change, and logout. Only the
 *        production edition's status is enabled; the sheet is unchanged otherwise.
 * @returns the operations the rest of the page calls.
 */
import { setupText, watchSetup } from "./chatgptSetup.mjs";
import { refreshEvents } from "./events.mjs";
import { errorText } from "./format.mjs";
import { t, useLanguage } from "./i18n.mjs";
import { paintMarkupWords } from "./markupWords.mjs";

// The tabs, in the order they stand. Each is #settingsTab-<name> and shows
// #settingsPanel-<name>.
export const SETTINGS_TABS = ["keys", "models", "storage", "privacy", "about"];

export function initSettingsUi({ $, onSaved, refreshModelCatalog, startAgain = () => window.location.reload(),
                                 shell = null, account = null }) {
  // The tab the user last chose, for this sitting only: a new launch starts
  // on the first tab, the keys, again.
  let lastTab = "keys";
  let shownTab = "keys";
  // Whether the user has chosen a tab since the sheet opened, so a late
  // answer about the models does not pull them off the one they chose.
  let chosenSinceOpen = false;
  function showTab(name) {
    shownTab = name;
    for (const t of SETTINGS_TABS) {
      const tab = $(`settingsTab-${t}`);
      tab.setAttribute("aria-selected", String(t === name));
      tab.tabIndex = t === name ? 0 : -1;
      $(`settingsPanel-${t}`).hidden = t !== name;
    }
  }
  function chooseTab(name) {
    lastTab = name;
    chosenSinceOpen = true;
    showTab(name);
  }
  SETTINGS_TABS.forEach((name, i) => {
    const tab = $(`settingsTab-${name}`);
    tab.addEventListener("click", () => chooseTab(name));
    // The arrows move along the row and wrap; Home and End go to its ends.
    tab.addEventListener("keydown", (e) => {
      const last = SETTINGS_TABS.length - 1;
      const to = { ArrowRight: i === last ? 0 : i + 1, ArrowLeft: i === 0 ? last : i - 1,
                   Home: 0, End: last }[e.key];
      if (to == null) return;
      e.preventDefault();
      chooseTab(SETTINGS_TABS[to]);
      $(`settingsTab-${SETTINGS_TABS[to]}`).focus();
    });
  });
  // A model that is downloading or stopped half-way (modelsDialog.mjs marks
  // the list): what the old fold opened itself for.
  const modelsNeedAttention = () => $("modelsFold").dataset.attention === "1";

  // The saved workspace id at modal-open time, so Save can post only an actual
  // change (posting the unchanged value would rewrite kit.env for nothing).
  let persoSpaceInitial = "";

  // Which key the picker's current options belong to, so Save knows whether the
  // chosen workspace actually goes with the key in the field. null = the list
  // never loaded (or failed), and no workspace may be posted from it.
  let spacesForKey = null;
  // Bumped per load: a slow answer for an old key must not overwrite a newer one.
  let spacesLoadSeq = 0;

  // Fill the Perso workspace picker. With `typedKey` it asks
  // POST /api/perso/spaces/preview about a key the user has only pasted (nothing
  // saved yet); without one it asks GET /api/perso/spaces about the saved key.
  // The preview is what lets key and workspace be chosen together and saved once
  // -- listing only saved keys is what used to cost a second restart.
  // Options carry "name (plan, credits left)" and never the internal seq -- the
  // same label rule the official plugin follows when it asks this question. One
  // workspace preselects silently; several make the user choose.
  async function loadPersoSpaces(savedSeq, typedKey) {
    const sel = $("persoSpaceSelect");
    const mine = ++spacesLoadSeq;
    sel.disabled = true;
    sel.innerHTML = "";
    spacesForKey = null;
    const opt = (value, label, credits) => {
      const o = document.createElement("option");
      o.value = value; o.textContent = label;
      if (credits != null) o.dataset.credits = String(credits);
      sel.appendChild(o);
    };
    try {
      const r = typedKey
        ? await fetch("/api/perso/spaces/preview", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_key: typedKey }),
          })
        : await fetch("/api/perso/spaces");
      if (mine !== spacesLoadSeq) return;   // a newer key is being looked up
      if (r.status === 409 || r.status === 400) {
        opt("", t("Add a Perso API key first")); return;
      }
      if (!r.ok) throw new Error();
      const { spaces } = await r.json();
      if (mine !== spacesLoadSeq) return;
      if (!spaces.length) { opt("", t("No workspace available for this key")); return; }
      if (spaces.length > 1) opt("", t("Choose a workspace…"));
      for (const s of spaces) {
        const extra = [s.tier, s.credits != null ? t("{n} credits left", { n: s.credits }) : null]
          .filter(Boolean).join(", ");
        opt(String(s.seq), s.name + (extra ? ` (${extra})` : ""), s.credits);
      }
      sel.value = (savedSeq && spaces.some((s) => String(s.seq) === String(savedSeq)))
        ? String(savedSeq)
        : (spaces.length === 1 ? String(spaces[0].seq) : "");
      sel.disabled = false;
      spacesForKey = typedKey || keysInitial.per;
    } catch {
      if (mine !== spacesLoadSeq) return;
      opt("", t("Could not load workspaces. Check the key or your connection."));
    } finally {
      if (mine === spacesLoadSeq) updateSpaceWarning();
    }
  }

  // Look up the workspaces of the key currently in the field, before it is saved.
  // Never on every keystroke: the field is debounced below, anything shorter than
  // a key is ignored, and the same key is not asked about twice in a row.
  const PERSO_KEY_MIN_LEN = 20;
  let persoPreviewTimer = null;
  let persoPreviewedKey = "";
  // Back to "no key, so nothing to choose". Used the moment the key field is
  // emptied: without it the picker kept listing the workspaces of the key that
  // was just deleted, and painted an unpickable "Choose a workspace…" red.
  function resetPersoSpaces() {
    const sel = $("persoSpaceSelect");
    spacesLoadSeq++;          // any lookup still in flight no longer counts
    spacesForKey = null;
    // Forget what was last looked up, so retyping the same key looks it up again
    // instead of being skipped as a repeat and leaving the picker empty.
    persoPreviewedKey = "";
    sel.innerHTML = "";
    const o = document.createElement("option");
    o.value = ""; o.textContent = t("Add a Perso API key first");
    sel.appendChild(o);
    sel.disabled = true;      // disabled is also what keeps the red styling off
    updateSpaceWarning();
  }

  function previewPersoSpaces() {
    clearTimeout(persoPreviewTimer);
    const key = $("persoKeyInput").value.trim();
    if (!key) { resetPersoSpaces(); return; }
    if (key.length < PERSO_KEY_MIN_LEN || key === persoPreviewedKey) return;
    persoPreviewedKey = key;
    // The saved pin only preselects when the field still holds the saved key --
    // a pin from another key would silently bill the wrong workspace.
    loadPersoSpaces(key === keysInitial.per ? persoSpaceInitial : "", key);
  }

  // A 0-credit workspace still lists -- Perso refuses mid-job and the job
  // FAILS (no silent free-engine fallback) -- so the moment one is selected
  // the consequence is spelled out here, not discovered after a failed dub.
  function updateSpaceWarning() {
    const sel = $("persoSpaceSelect");
    const o = sel.selectedOptions[0];
    $("persoSpaceWarning").style.display = (o && o.dataset.credits === "0") ? "" : "none";
    // With a key saved and several workspaces, an unpicked "Choose a
    // workspace…" is the one thing standing between the user and a working
    // Perso setup -- paint it red so it can't be overlooked. The job-start
    // preflight (app/api/dub.py) is the backstop for anyone who skips it anyway.
    sel.classList.toggle("needs-choice",
      !sel.disabled && sel.value === "" && sel.options.length > 1);
  }
  $("persoSpaceSelect").addEventListener("change", updateSpaceWarning);

  // Three ways a key lands in the field, one lookup: typing (settled for 600ms),
  // pasting (read on the next tick, when the field actually holds the pasted
  // text) and leaving the field. previewPersoSpaces ignores repeats, so the
  // overlap between them costs nothing.
  $("persoKeyInput").addEventListener("input", () => {
    clearTimeout(persoPreviewTimer);
    persoPreviewTimer = setTimeout(previewPersoSpaces, 600);
  });
  $("persoKeyInput").addEventListener("paste", () => setTimeout(previewPersoSpaces, 0));
  $("persoKeyInput").addEventListener("blur", previewPersoSpaces);

  // What was saved when the modal opened, so Save only posts actual edits.
  let keysInitial = { gem: "", per: "" };
  let togglesInitial = { analytics: true, reports: true, events: false };
  // The saved language setting ("auto", "en", "ko"); null until the saved
  // setup has been read, so a sheet that could not read it has no change to
  // count in a picker it never filled.
  let languageInitial = null;

  // Everything the sheet shows about the saved setup, in one pass:
  // GET /api/settings fills the key fields, the workspace picker, the
  // version line and the usage-counts switch. Not "loadSettings": the page has
  // one of those already (ui/src/app.mjs), and it reads the browser's own
  // persodub_settings blob -- the opposite source of truth to this one.
  async function loadSavedSetup() {
    try {
      const r = await fetch("/api/settings");
      if (!r.ok) throw new Error();
      const st = await r.json();
      // Saved values are shown in the clear -- single-user desktop app, and the
      // file they live in is the user's own (see the API KEYS markup note).
      keysInitial = { gem: st.gemini_api_key || "", per: st.perso_api_key || "" };
      $("persoKeyInput").value = keysInitial.per;
      $("geminiKeyInput").value = keysInitial.gem;
      persoSpaceInitial = st.perso_space_seq || "";
      // The saved key's workspaces; a key typed in afterwards triggers a preview.
      persoPreviewedKey = keysInitial.per;
      clearTimeout(persoPreviewTimer);
      loadPersoSpaces(persoSpaceInitial); // async on purpose -- the modal opens without waiting on Perso
      if (st.perso_signup_link) $("persoSignupLink").href = st.perso_signup_link;
      if (st.perso_recharge_link) $("persoRechargeLink").href = st.perso_recharge_link;
      // The app's name is the edition's: PersoDubbing in production ({app}, ui/src/i18n.mjs).
      if (realVersion(st.app_version)) {
        $("aboutVersion").textContent = `${t("{app}")} ${st.app_version}`;
      }
      $("analyticsToggle").checked = !st.analytics_off;
      $("reportsToggle").checked = !st.reports_off;
      $("eventsToggle").checked = !!st.events_enabled;
      togglesInitial = { analytics: !st.analytics_off, reports: !st.reports_off, events: !!st.events_enabled };
      languageInitial = st.ui_language || "auto";
      $("uiLanguageSelect").value = languageInitial;
    } catch {
      $("persoKeyInput").placeholder = $("geminiKeyInput").placeholder = t("Unavailable");
    }
  }

  // Opening the sheet: the saved values first, then the models catalog
  // (not awaited -- the sheet opens without waiting on it), then the sheet.
  // ChatGPT sign-in. The state comes from GET /api/agent/status?login=1
  // (the same answer the Dub Agent strip reads for Codex, whose sign-in IS
  // the ChatGPT sign-in); the button starts it with POST /api/agent/login
  // and this polls until the answer changes. Wording never names the CLI.
  // One chain of checks at a time, whichever started it: a check waits for
  // the one before it (no overlapping callbacks), and reopening Settings in
  // the middle of a sign-in leaves that sign-in's waiting alone.
  let chatgptWaiting = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function chatgptState() {
    try {
      const r = await fetch("/api/agent/status?login=1");
      if (!r.ok) return null;
      return ((await r.json()).agents || []).find((x) => x.id === "chatgpt") || null;
    } catch { return null; }
  }
  function paintChatgpt(a, { busy = false, prep = false, note = "" } = {}) {
    const el = $("chatgptState");
    const btn = $("chatgptSignInBtn");
    el.classList.toggle("danger", !!note);
    if (note) { el.textContent = note; btn.disabled = false; return; }
    if (a && !a.installed) {
      el.textContent = t("Not available on this computer");
      btn.disabled = true;
      return;
    }
    btn.disabled = busy || prep;
    // The first Sign In may fetch OpenAI's sign-in program before any browser.
    if (prep) { el.textContent = t("Opening sign-in…"); return; }
    if (busy) { el.textContent = t("Finish signing in in your browser…"); return; }
    if (!a || a.logged_in == null) { el.textContent = t("Checking…"); return; }
    if (a.logged_in) { el.textContent = t("Signed in"); btn.textContent = t("Switch account"); return; }
    btn.textContent = t("Sign in with ChatGPT");
    el.textContent = t("Not signed in");
  }
  // The server answers "not known yet" until its check finishes, so ask a
  // few times before settling (review 2026-09-23: the row sat blank).
  async function loadChatgpt() {
    if (chatgptWaiting) return;
    for (let i = 0; i < 6; i++) {
      const a = await chatgptState();
      paintChatgpt(a);
      if (a && a.logged_in != null) return;
      await sleep(1000);
    }
  }
  $("chatgptSignInBtn").addEventListener("click", async () => {
    if (chatgptWaiting) return;
    chatgptWaiting = true;
    paintChatgpt(null, { prep: true });
    // A computer without the sign-in program fetches it first: say so, and how far.
    const stopWatching = watchSetup((p) => {
      if (p.stage) $("chatgptState").textContent = setupText(p);
    });
    try {
      const r = await fetch("/api/agent/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "chatgpt" }),
      }).finally(stopWatching);
      if (!r.ok) {
        const detail = (await r.json().catch(() => ({}))).detail;
        throw new Error(typeof detail === "string" ? detail : t("Could not start signing in."));
      }
      paintChatgpt(null, { busy: true });
      // The sign-in lands in the browser; the program's own status says when.
      // Every 3 s for three minutes, one check after the other.
      for (let i = 0; i < 60; i++) {
        await sleep(3000);
        const a = await chatgptState();
        if (a && a.logged_in === true) { paintChatgpt(a); return; }
      }
      paintChatgpt(null, { note: t("Sign-in didn't finish. Try again.") });
    } catch (e) {
      paintChatgpt(null, { note: errorText(e) });
    } finally {
      chatgptWaiting = false;
    }
  });

  // The production edition's Perso account (mockup 2026-10-25): signed in
  // through Perso's sign-in window, so the account row takes the pasted
  // key's place and the tab is "Account and keys". The open-source
  // edition's status is not enabled, and then nothing here is touched.
  let lastAccountStatus = null;   // the status last painted, to tell a real change from a repeat
  function paintAccount(s) {
    if (!s || !s.enabled) return;
    lastAccountStatus = s;
    $("persoAccountRow").hidden = false;
    $("persoKeyRow").hidden = true;
    const tab = $("settingsTab-keys");
    if (tab.dataset.i18n !== "Account and keys") {
      tab.dataset.i18n = "Account and keys";
      tab.textContent = t("Account and keys");
    }
    $("persoAccountMail").textContent = s.account || t("Perso account");
    $("persoKeyChip").textContent = s.hasKey ? t("Key connected") : t("No key");
    $("persoKeyChip").classList.toggle("done", !!s.hasKey);
  }
  // A sign-in changes the key in kit.env (another account's, or none): the
  // open sheet takes the new one and its workspaces, and nothing else it has.
  async function reloadPersoKey() {
    try {
      const r = await fetch("/api/settings");
      if (!r.ok) return;
      const st = await r.json();
      const per = st.perso_api_key || "";
      if (per === keysInitial.per) return;
      keysInitial.per = per;
      $("persoKeyInput").value = per;
      persoSpaceInitial = st.perso_space_seq || "";
      persoPreviewedKey = per;
      loadPersoSpaces(persoSpaceInitial);
      paintChanges();
    } catch { /* the next open reads it again */ }
  }
  if (account) {
    paintAccount(account.status());
    account.onChange((s) => {
      // The key in kit.env changes only with the account or its key; a status
      // that repeats them (the sign-in's waiting, a quiet look) asks for nothing.
      const before = lastAccountStatus;
      paintAccount(s);
      // Signed out, from Sign out here or anywhere else: the sign-in screen
      // takes the window, and the sheet is not left open under it.
      if (s.enabled && s.required) { closeSettings(); return; }
      const changed = !before || before.hasKey !== s.hasKey || before.account !== s.account;
      if (s.enabled && changed && $("settingsOverlay").classList.contains("open")) reloadPersoKey();
    });
    $("persoSignOutBtn").addEventListener("click", () => account.logout());
  }

  // Storage's line on where downloads go, the folder they go into now (the
  // one Change in the Download dialog picked, or Downloads). Said, not
  // changed here. A browser saves where it is set to, so the row stays away.
  async function paintDownloadFolder() {
    const f = shell && shell.downloadFolder ? await shell.downloadFolder().catch(() => null) : null;
    $("downloadFolderLine").textContent = f ? t("Download folder: {path}", { path: f.folder }) : "";
    $("downloadFolderRow").hidden = !f;
  }

  // `tab` is for a way in that knows what it came for ("keys" from the
  // out-of-credits popup, "models" from the download chip). The gear passes
  // its click event, which is no tab: then a model that needs attention
  // opens Models, and otherwise the tab last chosen.
  async function openSettings(tab) {
    const asked = SETTINGS_TABS.includes(tab) ? tab : "";
    chosenSinceOpen = false;
    showTab(asked || (modelsNeedAttention() ? "models" : lastTab));
    if (account) paintAccount(account.status());
    loadChatgpt(); // async on purpose -- the sheet opens without waiting on a child process
    paintDownloadFolder(); // the same: the shell answers at once, and the sheet does not wait for it
    await loadSavedSetup();
    // Not waited for either; what it learns about the models may still move
    // the sheet to Models, unless the user has chosen a tab by then.
    Promise.resolve(refreshModelCatalog()).then(() => {
      if (!asked && !chosenSinceOpen && modelsNeedAttention()) showTab("models");
    }).catch(() => {});
    paintChanges();
    $("settingsOverlay").classList.add("open");
  }
  // Leaving without Save keeps nothing: the fields are read again on open.
  function closeSettings() {
    $("settingsDiscardOverlay").classList.remove("open");
    $("settingsOverlay").classList.remove("open");
  }
  // Cancel, Escape and the backdrop: with something changed and not saved,
  // the way out asks once ("Discard changes?") before it throws it away.
  function leaveSettings() {
    if (changeCount()) $("settingsDiscardOverlay").classList.add("open");
    else closeSettings();
  }

  // What Save would write, counted for the line beside it; Save rests at zero.
  function changeCount() {
    const spaceSel = $("persoSpaceSelect");
    const keyChanged = $("persoKeyInput").value.trim() !== keysInitial.per;
    return [
      $("geminiKeyInput").value.trim() !== keysInitial.gem,
      keyChanged,
      // A new key brings its own workspace: one change, not two.
      !keyChanged && !spaceSel.disabled && spaceSel.value !== persoSpaceInitial,
      $("analyticsToggle").checked !== togglesInitial.analytics,
      $("reportsToggle").checked !== togglesInitial.reports,
      $("eventsToggle").checked !== togglesInitial.events,
      languageInitial !== null && $("uiLanguageSelect").value !== languageInitial,
    ].filter(Boolean).length;
  }
  function paintChanges() {
    const n = changeCount();
    $("settingsChanges").textContent = !n ? "" : n === 1 ? t("1 change") : t("{n} changes", { n });
    $("settingsSaveBtn").disabled = !n;
    $("settingsSaveBtn").title = n ? "" : t("No changes to save");
  }
  for (const id of ["geminiKeyInput", "persoKeyInput"]) $(id).addEventListener("input", paintChanges);
  for (const id of ["persoSpaceSelect", "analyticsToggle", "reportsToggle", "eventsToggle", "uiLanguageSelect"]) {
    $(id).addEventListener("change", paintChanges);
  }

  async function saveSettings() {
    $("settingsSaveBtn").disabled = true;
    let ok = await saveSettingsEdits();
    if ($("analyticsToggle").checked !== togglesInitial.analytics) {
      if (await setUsageCounts($("analyticsToggle").checked)) togglesInitial.analytics = $("analyticsToggle").checked;
      else ok = false;
    }
    if ($("reportsToggle").checked !== togglesInitial.reports) {
      if (await setFailureReports($("reportsToggle").checked)) togglesInitial.reports = $("reportsToggle").checked;
      else ok = false;
    }
    if ($("eventsToggle").checked !== togglesInitial.events) {
      if (await setEvents($("eventsToggle").checked)) togglesInitial.events = $("eventsToggle").checked;
      else ok = false;
    }
    const language = $("uiLanguageSelect").value;
    if (languageInitial !== null && language !== languageInitial) {
      // Saved first, and a save that failed leaves the page in the language
      // it was in. Then the page starts again from the saved setting, so every
      // word already drawn is in the new language at once: the screen it was
      // on comes back and a running dub is followed again (app.mjs
      // openLastScreen). Not while the Dub Agent is answering, since leaving
      // the page ends its turn: then the page redraws in place, the markup's
      // words now (ui/src/markupWords.mjs too) and the rest at its next paint.
      if (await setUiLanguage(language)) {
        languageInitial = language;
        if (ok && !document.body.dataset.agentTurn) { startAgain(); return; }
        await useLanguage(language);
        paintMarkupWords();
      } else ok = false;
    }
    if (ok) { closeSettings(); return; }
    // Beside the button that was pressed, where the eye already is.
    paintChanges();
    $("settingsChanges").textContent = t("Could not save. Is {app} running?");
  }
  $("settingsSaveBtn").addEventListener("click", saveSettings);
  $("settingsCancelBtn").addEventListener("click", leaveSettings);
  $("settingsDiscardKeep").addEventListener("click", () => $("settingsDiscardOverlay").classList.remove("open"));
  $("settingsDiscardYes").addEventListener("click", closeSettings);

  // "0.0.0" is what the engine answers when it is not running inside a packaged
  // build (the real number comes from the desktop shell), and a made-up version in
  // the app's own chrome is worse than none: it gets read out and reported.
  function realVersion(v) { return v && v !== "0.0.0" ? v : ""; }

  $("settingsCloseBtn").addEventListener("click", leaveSettings);
  $("settingsOverlay").addEventListener("click", (e) => { if (e.target === $("settingsOverlay")) leaveSettings(); });
  // Escape is the reflex way out of a dialog, so every dialog has to answer it --
  // Settings and New project were the two that did not.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("settingsOverlay").classList.contains("open")) leaveSettings();
  });

  // The keys and the workspace, for Save. True when they are saved (or had
  // nothing to save).
  async function saveSettingsEdits() {
    // Only actual edits go on the wire -- posting unchanged values would rewrite
    // kit.env for nothing (keysInitial/persoSpaceInitial hold what was already
    // saved when the modal opened).
    // Compare without a truthiness gate: clearing a field to "" IS a change
    // (posted as "" so the backend removes the saved value -- otherwise a
    // mistyped key or stale workspace pin could never be deleted in-app).
    const gem = $("geminiKeyInput").value.trim();
    const per = $("persoKeyInput").value.trim();
    const gemChanged = gem !== keysInitial.gem;
    const perChanged = per !== keysInitial.per;
    // Saving with an empty field is the user deleting their key -- clear the
    // picker here too, in case Save was reached without the field ever blurring.
    if (!per) resetPersoSpaces();
    // A disabled picker means the list never loaded -- its empty value is a
    // load failure, not the user clearing the pin, so it must not post.
    const spaceSel = $("persoSpaceSelect");
    const space = spaceSel.value;
    const spaceChanged = !spaceSel.disabled && space !== persoSpaceInitial;
    // The picker was filled by the preview for the key now in the field, so the
    // workspace chosen before Save is saved WITH the key -- one save, no restart.
    // If the list belongs to some other key (it failed, or the field was edited
    // after), a changed key clears the pin instead: a pin from another key would
    // auto-select and silently bill the wrong workspace, and the red "Choose a
    // workspace…" then prompts a fresh, explicit pick.
    const spaceGoesWithKey = spacesForKey === per && !spaceSel.disabled;
    const persoSpaceToPost = perChanged ? (spaceGoesWithKey ? space : "")
                                        : (spaceChanged ? space : null);
    if (gemChanged || perChanged || spaceChanged) {
      try {
        const r = await fetch("/api/settings", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gemini_api_key: gemChanged ? gem : null,
                                 perso_api_key: perChanged ? per : null,
                                 perso_space_seq: persoSpaceToPost }),
        });
        if (!r.ok) throw new Error();
        if (gemChanged) keysInitial.gem = gem;
        if (perChanged) { keysInitial.per = per; persoSpaceInitial = persoSpaceToPost; }
        else if (spaceChanged) persoSpaceInitial = space;
        // No restart prompt: the server reads these three values out of kit.env
        // when a dub starts, so what was just saved is what the next dub uses.
      } catch {
        return false;
      }
    }
    // A key save may have just changed which engines are usable -- re-check so
    // the form doesn't keep a possibly-disabled engine silently selected.
    onSaved();
    return true;
  }

  // A switch now (mockup 2026-09-29): on shows every key, off masks them.
  $("showKeysToggle").addEventListener("change", () => {
    $("persoKeyInput").type = $("geminiKeyInput").type =
      $("showKeysToggle").checked ? "text" : "password";
  });

  // The folder finished videos land in, opened in the desktop's own file
  // browser. Named for the one this machine has; "Show folder" where it is
  // neither Finder nor Explorer.
  $("revealOutputBtn").textContent =
    /Mac/.test(navigator.platform) ? t("Show in Finder")
    : /Win/.test(navigator.platform) ? t("Show in Explorer") : t("Show folder");
  $("revealOutputBtn").addEventListener("click", async () => {
    try {
      const r = await fetch("/api/settings/reveal-output", { method: "POST" });
      if (!r.ok) throw new Error();
      $("storageHint").textContent = "";
    } catch {
      $("storageHint").textContent = t("Could not open the folder.");
    }
  });

  // The license list, behind one word: it is there for whoever wants it and in
  // nobody else's way.
  $("ackToggle").addEventListener("click", () => {
    const open = $("ackList").hidden;
    $("ackList").hidden = !open;
    $("ackToggle").setAttribute("aria-expanded", String(open));
  });

  // Usage counts. kit.env is where the desktop shell looks before every count,
  // so this POST is the whole off switch -- there is no second copy to disagree
  // with it, and the next event already obeys it.
  async function setUsageCounts(on) {
    try {
      const r = await fetch("/api/settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analytics_off: !on }),
      });
      return r.ok;
    } catch { return false; }
  }

  // The same shape for the same reason: one POST is the whole switch, and the
  // shell re-reads the file before it sends anything.
  async function setFailureReports(on) {
    try {
      const r = await fetch("/api/settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reports_off: !on }),
      });
      return r.ok;
    } catch { return false; }
  }

  // Button and screen events: one POST, then the page asks the shell again,
  // which reads the line straight back (ui/src/events.mjs).
  async function setEvents(on) {
    try {
      const r = await fetch("/api/settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events_enabled: on }),
      });
      if (r.ok) await refreshEvents();
      return r.ok;
    } catch { return false; }
  }

  // The language: kit.env's PERSODUB_LANG, which the engine and the desktop
  // shell read as well, so all three speak the one the user chose.
  async function setUiLanguage(value) {
    try {
      const r = await fetch("/api/settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ui_language: value }),
      });
      return r.ok;
    } catch { return false; }
  }

  // used by the page: openSettings. closeSettings and loadSavedSetup are
  // reached from the tests only -- the page's ways out of the sheet are the
  // sheet's own X, its backdrop and Escape, all wired above.
  return { openSettings, closeSettings, loadSavedSetup, saveSettings, currentTab: () => shownTab };
}
