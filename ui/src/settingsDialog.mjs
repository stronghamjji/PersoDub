// The Settings sheet: what opens behind the topbar's gear. It reads
// GET /api/settings into its fields and saves edits back the moment a field
// is left -- there is no Save button (2026-08-28), a desktop app's settings
// take effect as they are changed. It also owns the Perso workspace picker
// (including the preview of a key that has only been pasted), the
// Show-in-Finder button, the Appearance picker, the usage-counts switch and
// the Acknowledgements fold.
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
 * @returns the operations the rest of the page calls.
 */
export function initSettingsUi({ $, onSaved, refreshModelCatalog }) {
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
        opt("", "Enter a Perso API key to see its workspaces"); return;
      }
      if (!r.ok) throw new Error();
      const { spaces } = await r.json();
      if (mine !== spacesLoadSeq) return;
      if (!spaces.length) { opt("", "No workspace available for this key"); return; }
      if (spaces.length > 1) opt("", "Choose a workspace…");
      for (const s of spaces) {
        const extra = [s.tier, s.credits != null ? `${s.credits} credits left` : null]
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
      opt("", "Couldn't load workspaces. Check the key or your connection.");
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
    o.value = ""; o.textContent = "Enter a Perso API key to see its workspaces";
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

  // Everything the sheet shows about the saved setup, in one pass:
  // GET /api/settings fills the key fields, the workspace picker, the
  // version line and the usage-counts switch. Not "loadSettings": the page has
  // one of those already (static/index.html), and it reads the browser's own
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
      if (realVersion(st.app_version)) {
        $("aboutVersion").textContent = `PersoDub ${st.app_version}`;
      }
      $("analyticsToggle").checked = !st.analytics_off;
      $("reportsToggle").checked = !st.reports_off;
    } catch {
      $("persoKeyInput").placeholder = $("geminiKeyInput").placeholder = "Unavailable";
    }
  }

  // Appearance. Dark is the app; "light" is the only other value, and the only
  // one written down -- an unreadable or missing entry is dark, which is what
  // the boot script at the top of static/index.html assumes too.
  const THEME_KEY = "persodub.theme";
  function savedTheme() {
    try { return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"; }
    catch { return "dark"; }   // private window
  }
  function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === "light") root.dataset.theme = "light";
    else delete root.dataset.theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* private window */ }
  }
  $("themeSelect").addEventListener("change", () => applyTheme($("themeSelect").value));

  // Opening the sheet: the saved values first, then the models catalog
  // (not awaited -- the sheet opens without waiting on it), then the sheet.
  async function openSettings() {
    $("themeSelect").value = savedTheme();
    await loadSavedSetup();
    refreshModelCatalog();
    $("settingsOverlay").classList.add("open");
  }
  // Closing saves too: a key typed and then Escape (or the X) never left the
  // field, so its change event never fired.
  function closeSettings() {
    $("settingsOverlay").classList.remove("open");
    saveSettingsEdits();
  }

  // "0.0.0" is what the engine answers when it is not running inside a packaged
  // build (the real number comes from the desktop shell), and a made-up version in
  // the app's own chrome is worse than none: it gets read out and reported.
  function realVersion(v) { return v && v !== "0.0.0" ? v : ""; }

  $("settingsCloseBtn").addEventListener("click", closeSettings);
  $("settingsOverlay").addEventListener("click", (e) => { if (e.target === $("settingsOverlay")) closeSettings(); });
  // Escape is the reflex way out of a dialog, so every dialog has to answer it --
  // Settings and New project were the two that did not.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("settingsOverlay").classList.contains("open")) closeSettings();
  });

  // Saves on the spot -- when a key field is left or a workspace is picked, and
  // again when the dialog closes. There is no Save button (2026-08-28): a
  // desktop app's settings take effect as they are changed.
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
        $("settingsSaveError").style.display = "none";
        // No restart prompt: the server reads these three values out of kit.env
        // when a dub starts, so what was just saved is what the next dub uses.
      } catch {
        $("settingsSaveError").style.display = "";
      }
    }
    // A key save may have just changed which engines are usable -- re-check so
    // the form doesn't keep a possibly-disabled engine silently selected.
    onSaved();
  }
  // "change" fires when a field is left with a different value -- not on every
  // keystroke, so a key is posted once, whole.
  $("persoKeyInput").addEventListener("change", saveSettingsEdits);
  $("geminiKeyInput").addEventListener("change", saveSettingsEdits);
  $("persoSpaceSelect").addEventListener("change", saveSettingsEdits);

  $("showKeysToggle").addEventListener("click", () => {
    const show = $("persoKeyInput").type === "password";
    $("persoKeyInput").type = $("geminiKeyInput").type = show ? "text" : "password";
    $("showKeysToggle").textContent = show ? "Hide keys" : "Show keys";
  });

  // The folder finished videos land in, opened in the desktop's own file
  // browser. Named for the one this machine has; "Show folder" where it is
  // neither Finder nor Explorer.
  $("revealOutputBtn").textContent =
    /Mac/.test(navigator.platform) ? "Show in Finder"
    : /Win/.test(navigator.platform) ? "Show in Explorer" : "Show folder";
  $("revealOutputBtn").addEventListener("click", async () => {
    try {
      const r = await fetch("/api/settings/reveal-output", { method: "POST" });
      if (!r.ok) throw new Error();
      $("storageHint").textContent = "";
    } catch {
      $("storageHint").textContent = "Could not open the folder. Is the engine running?";
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

  $("reportsToggle").addEventListener("change", async () => {
    const on = $("reportsToggle").checked;
    if (await setFailureReports(on)) {
      $("reportsHint").textContent = "Keys and folder names are removed first.";
      return;
    }
    $("reportsToggle").checked = !on;
    $("reportsHint").textContent = "Could not save that. Is the engine running?";
  });

  $("analyticsToggle").addEventListener("change", async () => {
    const on = $("analyticsToggle").checked;
    if (await setUsageCounts(on)) return;
    // Nothing was saved, so the switch must not sit there claiming otherwise.
    $("analyticsToggle").checked = !on;
    $("analyticsHint").textContent = "Could not save that. Is the engine running?";
  });

  // used by the page: openSettings. closeSettings and loadSavedSetup are
  // reached from the tests only -- the page's ways out of the sheet are the
  // sheet's own X, its backdrop and Escape, all wired above.
  return { openSettings, closeSettings, loadSavedSetup };
}
