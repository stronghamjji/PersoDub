// The AI-models screen logic: one controller over GET /api/models that owns
// the catalog rows and the pending dub, and paints the three places the user
// meets them -- the Settings catalog list, the "Download N GB to dub?" dialog
// (dub_start's 409) and, through the page's own repaint callback, the status
// line under each engine dropdown.
//
// The pure decisions (what a line says, what the dialog's title is, how far
// along the bar sits) live in ui/src/modelsUi.mjs; this file is the wiring:
// fetch, poll, render, and the four dialog buttons. index.html keeps the
// dropdown hints, because those reach into the New project form's selects.
//
// A single 2s poll runs only while something is downloading (same cadence as
// the dub-progress poll).
import { gb, modelStatusLine, dubStartDialog, overallProgress, downloadStopped, allReady, groupModels } from "./modelsUi.mjs";
import { t } from "./i18n.mjs";

/** The desktop app's "Connection problem, retrying (2/3)" in the page's
 * language. The shell sends it in English, because this file knows a retry by
 * those words (desktop/src/installer.js). */
export function retryLine(detail) {
  const m = /^Connection problem, retrying \((\d+)\/(\d+)\)/.exec(detail || "");
  return m ? t("Connection problem, retrying ({n}/{m})", { n: m[1], m: m[2] }) : detail;
}

/**
 * Wire the models UI to a page.
 *
 * @param {object} deps
 * @param {(id: string) => any} deps.$          the page's getElementById helper
 * @param {() => void} deps.onStartDubbing      resubmit the dub once every model is ready
 * @param {() => void} deps.onOpenSettings      open the Settings sheet
 * @param {() => void} deps.onUsePerso          set Dubbing to Perso API, the way round the download
 * @param {(rows: object[]) => void} deps.onRowsChanged  repaint the page's own
 *        model-dependent chrome (the dropdown hints and the topbar chip)
 * @param {(q: {title: string, line: string}) => Promise<boolean>} deps.askToDelete
 *        the page's Delete dialog (ui/src/confirmDialogs.mjs), for a base program
 * @returns the operations the page calls, and the one the tests do -- grouped
 *        and labelled in the returned object, so pruning this surface later
 *        does not have to guess which member has a caller off the page.
 */
export function initModelsUi({ $, onStartDubbing, onOpenSettings, onUsePerso = () => {}, onRowsChanged, shell = null, keepPolling = () => false, ramOk = () => true,
                              askToDelete = async () => false }) {
  // Every element this file names is required markup (index.html always has
  // it), so nothing here null-checks what $ returns -- same as
  // ui/src/settingsDialog.mjs. A missing id is a broken page, and a crash on
  // the first paint says so far louder than a silent half-drawn dialog.
  let modelRows = [];
  let modelsPolling = false;
  let pendingDub = null;   // { ids, packs, models, downloading } while the dialog drives a dub
  // The pack the desktop app is installing right now, with its latest
  // progress line. Packs (the engines venv, the Ollama runtime) are the
  // shell's to install: this page asks over `shell` (window.persodubShell,
  // absent in a plain browser) and follows the progress events it sends.
  let packBusy = null;     // { id, name, title, line, pct }
  let packFailed = null;   // { id, reason } until the next attempt or refresh clears it
  // A pack in a plain browser: the desktop app installs it. Read when drawn,
  // so it is in the page's language; the sentences below say it whole.
  const packHint = () => t("Installed by {app}");

  const modelRow = (id) => modelRows.find((m) => m.id === id) || null;

  // A base program asks in the Delete dialog first, saying what stops
  // working without it: a second press said nothing of the kind (owner,
  // 2026-10-22, 1-2 가). Read when asked, in the language of the moment.
  const BASE_PROGRAMS = {
    engine: () => ({ title: t("Delete Python + PyTorch?"),
                     line: t("Without it, local models cannot separate audio, transcribe or make voices.") }),
    "ollama-runtime": () => ({ title: t("Delete Ollama?"), line: t("Without it, local models cannot translate.") }),
  };

  // Any other Remove takes two presses: the first turns the button into the
  // question with the size, the second (within REMOVE_ARM_MS) removes. One
  // press used to delete 1.9 GB on the spot (Windows G2, 2026-10-07).
  const REMOVE_ARM_MS = 10000;
  let removeArmed = null;   // { id, until }
  function armRemove(btn, m, remove) {
    const armed = removeArmed && removeArmed.id === m.id && Date.now() < removeArmed.until;
    btn.textContent = armed ? t("Remove {size} GB?", { size: gb(m.bytes) }) : t("Remove");
    btn.onclick = () => {
      if (removeArmed && removeArmed.id === m.id && Date.now() < removeArmed.until) {
        removeArmed = null;
        return remove();
      }
      removeArmed = { id: m.id, until: Date.now() + REMOVE_ARM_MS };
      repaint();
      // The question goes away by itself; the timer must not keep a test
      // process alive, nor fail one whose page is already torn down.
      const timer = setTimeout(() => {
        if (removeArmed && removeArmed.id === m.id) { removeArmed = null; try { repaint(); } catch { /* page gone */ } }
      }, REMOVE_ARM_MS);
      if (timer.unref) timer.unref();
    };
  }

  if (shell && shell.onInstallProgress) {
    shell.onInstallProgress((p) => {
      if (!p || !p.pack || !packBusy || packBusy.id !== p.pack) return;
      // A detail that only restates the title ("Downloading the translation
      // runtime: Downloading the translation runtime", 2026-09-08) shows once.
      packBusy.title = p.title || "";
      // A retry notice stands alone: with the step title in front of it, the
      // Settings row's 34 characters ended before the word "retrying" (W22).
      packBusy.retry = p.state === "progress" && /^Connection problem/.test(p.detail || "");
      packBusy.line = packBusy.retry ? retryLine(p.detail) : p.state === "progress" && p.detail && p.detail !== p.title ? `${p.title}: ${p.detail}` : (p.title || "");
      // The shell sends the pack's overall percent on every event.
      if (p.pct != null) packBusy.pct = p.pct;
      repaint();
      // The title alone as well as the whole line: a screen with room for one
      // short sentence wants "Installing its Python parts (2 of 2, …)", not that plus
      // the name of the wheel being fetched (user, 2026-09-09).
      tellPack({ id: packBusy.id, title: packBusy.title, line: packBusy.line, pct: packBusy.pct });
    });
  }

  function showPackError(text) {
    $("mnError").textContent = text;
    $("modelsError").textContent = text;
  }

  // Whoever else is drawing this install. A pack can be started from a screen
  // that is not this dialog -- the erase screen's own Download row -- and that
  // screen has to be told what the dialog is told: an error written only into
  // #mnError is written into a dialog nobody has open (user, 2026-09-09).
  const packWatchers = new Set();
  function onPackProgress(fn) {
    packWatchers.add(fn);
    return () => packWatchers.delete(fn);
  }
  function tellPack(info) {
    // A watcher paints; one that throws must not take the install down with it.
    for (const fn of packWatchers) { try { fn(info); } catch { /* painter, not gate */ } }
  }

  // Resolves true once the pack is on disk and its process is up. A failure
  // (no desktop app, no room, a step that died, Cancel) is told in the dialog
  // and the Settings catalog alike, and nothing else is started.
  async function installPack(id) {
    const name = (modelRow(id) || {}).name || id;
    if (!shell || !shell.installPack) {
      showPackError(t("{name}: Installed by {app}.", { name }));
      tellPack({ id, error: t("{name}: Installed by {app}.", { name }) });
      return false;
    }
    if (packBusy) {
      // One at a time, and the one running keeps its place on screen: a second
      // press used to take over the busy slot and show the first as paused.
      if (packBusy.id !== id) {
        showPackError(t("{name} is still installing. Wait for it to finish.", { name: packBusy.name }));
        tellPack({ id, error: t("{name} is still installing. Wait for it to finish.", { name: packBusy.name }) });
      }
      return false;
    }
    packBusy = { id, name, line: "", pct: null };
    packFailed = null;
    repaint();
    let res;
    try { res = await shell.installPack(id); }
    catch (e) { res = { ok: false, reason: String((e && e.message) || e) }; }
    packBusy = null;
    if (!res || !res.ok) packFailed = { id, reason: (res && res.reason) || t("The install could not finish.") };
    await fetchModels();
    repaint();
    if (packFailed) {
      showPackError(`${name}: ${packFailed.reason}`);
      tellPack({ id, error: `${name}: ${packFailed.reason}` });
      return false;
    }
    showPackError("");   // a "still installing" notice from a second press is over
    tellPack({ id, done: true });
    return true;
  }
  async function cancelPack(id) {
    if (shell && shell.cancelPack) await shell.cancelPack(id);
  }
  async function removePack(id) {
    $("modelsError").textContent = "";
    if (!shell || !shell.removePack) { $("modelsError").textContent = t("Installed by {app}."); return; }
    // The engine knows whether a dub is running; its DELETE refuses a pack
    // either way, and the sentence tells which reason. Only "PersoDub installs
    // this itself" (app/models.py, in English on purpose) means the coast is clear.
    try {
      const r = await fetch(`/api/models/${id}`, { method: "DELETE" });
      const body = await r.json().catch(() => null);
      const why = String((body && body.detail) || "");
      if (why !== "PersoDub installs this itself.") { $("modelsError").textContent = why || t("Could not remove it."); return; }
    } catch { $("modelsError").textContent = t("Could not remove it. Is {app} running?"); return; }
    const res = await shell.removePack(id).catch((e) => ({ ok: false, reason: String((e && e.message) || e) }));
    if (!res || !res.ok) $("modelsError").textContent = (res && res.reason) || t("Could not remove it.");
    await fetchModels();
    repaint();
  }

  async function fetchModels() {
    try {
      const r = await fetch("/api/models");
      if (r.ok) modelRows = (await r.json()).models;
    } catch { /* keep the last rows */ }
    return modelRows;
  }

  // The rows as the page should paint them: a pack the desktop app is
  // installing reads as "downloading" with its progress, and one whose install
  // just failed as "paused" with the reason -- so the dropdown hints, the
  // topbar chip and Settings show the pack the way they show a model, wherever
  // the install was started from. The engine's own rows never say either: it
  // does not install packs.
  function rowsToPaint() {
    return modelRows.map((r) => {
      if (packBusy && r.id === packBusy.id) return { ...r, state: "downloading", progress: packBusy.pct ?? null };
      if (packFailed && r.id === packFailed.id && r.state !== "ready") return { ...r, state: "paused", error: packFailed.reason };
      return r;
    });
  }

  // Everything that paints from the rows, in the order the page shows it:
  // the caller's dropdown hints and chip first, then the catalog, then the
  // dialog (which is also where a finished download starts the dub).
  function repaint() {
    onRowsChanged(rowsToPaint());
    renderModelsList();
    paintModelsDialog();
  }

  async function refreshModels() {
    await fetchModels();
    repaint();
    // A download this page did not start (the Dub Agent asked for it) was
    // painted once and then held that percent: Windows showed 18% long after
    // the model was ready (2026-09-25). Whoever started it, keep it moving.
    // And while Settings is open: a model the agent downloaded while the sheet
    // was up (1.1 GB in under a second when the file was already on disk)
    // never showed as Ready until it was reopened (Windows, 2026-09-26).
    if (anyDownloading() || keepPolling()) startPolling();
    return modelRows;
  }

  function anyDownloading() { return modelRows.some((m) => m.state === "downloading"); }
  // Polls while anything is on its way, while a dub waits on downloads, and
  // while the page says so (Settings open: its rows went stale on screen
  // while a model finished behind them, Windows 2026-09-07). A paint that
  // throws must not end the poll -- it did, silently, once.
  function startPolling() {
    if (modelsPolling) return;
    modelsPolling = true;
    const tick = async () => {
      try {
        await fetchModels();
        repaint();
      } catch (e) {
        console.error("models poll:", e);
      }
      if (anyDownloading() || (pendingDub && pendingDub.downloading) || keepPolling()) { setTimeout(tick, 2000); return; }
      modelsPolling = false;
    };
    tick();
  }
  async function downloadModel(id) {
    const row = modelRow(id);
    if (row && row.role === "pack") { await installPack(id); return; }
    try {
      const r = await fetch(`/api/models/${id}/download`, { method: "POST" });
      if (!r.ok) {
        // The engine's reason -- "install the Translation runtime first" --
        // in the dialog and in Settings, instead of a download that never starts.
        // In the page's language: the one it keeps in English (a pack is the
        // desktop app's to install) is said here.
        const body = await r.json().catch(() => null);
        showPackError(`${(row && row.name) || id}: ${t(String((body && body.detail) || t("The download could not start.")))}`);
      }
    } catch { /* poll shows it */ }
    startPolling();
  }
  // Everything a choice needs, in order: the packs one after another through
  // the desktop app (a failure stops here, with its reason shown), then the
  // models all at once -- the same sequence Download and Start runs.
  async function downloadAll(ids) {
    const packs = ids.filter((id) => (modelRow(id) || {}).role === "pack");
    const rest = ids.filter((id) => !packs.includes(id));
    for (const id of packs) {
      const r = modelRow(id);
      if (r && r.state === "ready") continue;
      if (!(await installPack(id))) return false;
    }
    for (const id of rest) {
      const r = modelRow(id);
      if (!r || r.state !== "ready") downloadModel(id);
    }
    return true;
  }
  async function cancelModel(id) {
    const row = modelRow(id);
    if (row && row.role === "pack") { await cancelPack(id); return; }
    try { await fetch(`/api/models/${id}/cancel`, { method: "POST" }); } catch { /* poll shows it */ }
    startPolling();
  }
  async function removeModel(id) {
    $("modelsError").textContent = "";
    try {
      const r = await fetch(`/api/models/${id}`, { method: "DELETE" });
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        $("modelsError").textContent = String((body && body.detail) || t("Could not remove it."));
      }
    } catch { $("modelsError").textContent = t("Could not remove it. Is {app} running?"); }
    await fetchModels();
    repaint();
  }

  // No rebuild under a finger. Each paint throws the buttons away, and one that
  // landed between pointerdown and click (the 2s poll, or the refresh that a
  // click into the window from behind starts on focus) took the pressed Cancel
  // with it: the click reached no button, and the download went on (Windows
  // C18, 2026-10-20). The paint waits for the release instead. The keyboard
  // needs none of this: Enter and Space click with no pointer before it.
  let pressed = false;
  let paintWaiting = false;
  $("modelsList").addEventListener("pointerdown", () => { pressed = true; });
  function release() {
    if (!pressed) return;
    pressed = false;
    // A tick later: the click comes after pointerup, and painting now would
    // still take its button away.
    if (paintWaiting) setTimeout(renderModelsList, 0);
  }
  // On the whole page, so a press let go off the list ends too; and one the
  // window loses (switched away from, hidden) must not hold the list for good.
  document.addEventListener("pointerup", release);
  document.addEventListener("pointercancel", release);
  document.addEventListener("visibilitychange", release);
  window.addEventListener("blur", release);

  function renderModelsList() {
    if (pressed) { paintWaiting = true; return; }
    paintWaiting = false;
    const list = $("modelsList");
    list.replaceChildren();
    let onDisk = 0;
    for (const group of groupModels(rowsToPaint())) {
      // A heading for each purpose, with what its rows take on this computer.
      // It sits in the list beside the rows, so the rows' lines still draw.
      const head = document.createElement("div");
      head.className = "model-group-head";
      const title = document.createElement("span");
      title.textContent = t(group.title);
      const total = document.createElement("span");
      total.className = "model-size";
      total.textContent = `${gb(group.bytes)} GB`;
      head.append(title, total);
      if (group.note) {
        // What the group is there for, on a line under its name.
        const note = document.createElement("span");
        note.className = "model-group-note";
        note.textContent = t(group.note);
        head.append(note);
      }
      list.append(head);
      for (const m of group.rows) {
        if (m.state === "ready") onDisk += m.bytes;
        const row = document.createElement("div");
        row.className = "settings-row model-row";
        const name = document.createElement("span");
        name.textContent = m.name;
        const size = document.createElement("span");
        size.className = "model-size";
        size.textContent = `${gb(m.bytes)} GB`;
        const st = modelStatusLine(m);
        const status = document.createElement("span");
        // Anything but "Ready" takes a line of its own under the name, whole:
        // beside the name a download's line was cut before its percent.
        status.className = "settings-hint" + (st.cls ? " " + st.cls : "")
          + (m.state === "ready" ? "" : " model-status-long");
        status.textContent = m.state === "not_downloaded" ? "" : st.text;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn btn-outline model-btn";
        if (m.comes_with) {
          // Part of a pack (Demucs, in Python + PyTorch): listed with its
          // stage, with nothing of its own to download or remove.
          if (m.state !== "ready") status.textContent = "";
        } else if (m.role === "pack") {
          // The desktop app installs and removes packs; a plain browser can only look.
          if (packBusy && packBusy.id === m.id) {
            status.textContent = packBusy.retry ? packBusy.line : st.text + (packBusy.line ? ` · ${packBusy.line}` : "");
            btn.textContent = t("Cancel"); btn.onclick = () => cancelPack(m.id);
          } else if (packFailed && packFailed.id === m.id) {
            status.textContent = t("Stopped: {reason}", { reason: packFailed.reason });
            btn.textContent = t("Resume"); btn.onclick = () => installPack(m.id);
          } else if (!shell) {
            if (m.state !== "ready") status.textContent = packHint();
            btn.textContent = m.state === "ready" ? t("Remove") : t("Download");
            btn.disabled = true; btn.title = packHint();
          } else if (packBusy) {
            // Another pack is installing: this one waits its turn.
            btn.textContent = m.state === "ready" ? t("Remove") : t("Download");
            btn.disabled = true; btn.title = t("{name} is still installing", { name: packBusy.name });
          } else if (m.state === "ready" && BASE_PROGRAMS[m.id]) {
            btn.textContent = t("Remove");
            btn.onclick = async () => { if (await askToDelete(BASE_PROGRAMS[m.id]())) await removePack(m.id); };
          } else if (m.state === "ready") { armRemove(btn, m, () => removePack(m.id)); }
          else { btn.textContent = m.state === "paused" ? t("Resume") : t("Download"); btn.onclick = () => installPack(m.id); }
        } else if (m.state === "ready") { armRemove(btn, m, () => removeModel(m.id)); }
        else if (m.state === "downloading") { btn.textContent = t("Cancel"); btn.onclick = () => cancelModel(m.id); }
        else if (m.state === "paused") { btn.textContent = t("Resume"); btn.onclick = () => downloadModel(m.id); }
        else { btn.textContent = t("Download"); btn.onclick = () => downloadModel(m.id); }
        // A program not here yet, with nothing else to say, says what it is
        // for where "Ready" would stand: a bare "Ollama" under Required
        // programs said nothing of why to download it (owner, 2026-10-22).
        const forWhat = m.role === "pack" && m.state === "not_downloaded" && !status.textContent && !!m.hint;
        if (forWhat) status.className = "settings-hint";
        if ((m.state === "ready" || m.comes_with || forWhat) && m.hint) {
          // What it is for, after "Ready", where the group's title does not
          // say it all, and where a pack's part comes from. A row on its way
          // keeps the cell for its own line. Added last: a textContent set
          // above would wipe it.
          const note = document.createElement("span");
          note.className = "model-note";
          note.textContent = m.hint;
          status.append(note);
        }
        row.append(name, size, status, m.comes_with ? document.createElement("span") : btn);
        list.append(row);
      }
    }
    const downloading = !!packBusy || rowsToPaint().some((m) => m.state === "downloading");
    const busy = downloading || rowsToPaint().some((m) => m.state === "paused");
    // Said as what is happening: "attention needed" read as an error while a
    // download was simply under way (Windows G2, 2026-10-07).
    // One whole line for each case, so each language says it in one piece.
    const summary = { n: modelRows.length, size: gb(onDisk) };
    $("modelsSummary").textContent = downloading
      ? t("{n} models · {size} GB on this computer · downloading", summary)
      : busy ? t("{n} models · {size} GB on this computer · a download is paused", summary)
        : t("{n} models · {size} GB on this computer", summary);
    // The list is a tab of Settings now, always open; this mark is what
    // makes the sheet open on that tab (ui/src/settingsDialog.mjs).
    $("modelsFold").dataset.attention = busy ? "1" : "";
  }

  // -- the dub-start dialog (dub_start's 409) ------------------------------
  function showModelsDialog(detail) {
    const d = dubStartDialog(detail, ramOk());
    // The room left and the memory note go on a line of their own under the
    // sentence: run on after it, they broke as "남은 / 공간" (owner,
    // 2026-10-22, 5). A computer short of memory gets its sentence in red,
    // as the dialog's error instead: the download could not end in a dub
    // here, so its button is off.
    const facts = [d.free, d.ram && !d.ramLow ? d.ram : ""].filter(Boolean).join(" · ");
    const line = facts ? `${d.line}\n${facts}` : d.line;
    // The opening words are kept: a download that stops puts them back.
    pendingDub = { ids: d.ids, packs: d.packs, models: d.models, downloading: false, title: d.title, line };
    $("mnTitle").textContent = d.title;
    $("mnLine").textContent = line;
    $("mnDownload").disabled = d.ramLow;
    // The way round it is the link under the line: Perso dubbing makes the
    // voices itself, so nothing here has to download (user, 2026-09-28).
    $("mnError").textContent = d.ramLow ? d.ram : "";
    $("mnProgress").hidden = true;
    $("mnDownload").hidden = false;
    $("mnSettings").hidden = !d.perso;
    $("mnHide").hidden = true;
    $("modelsNeededOverlay").classList.add("open");
  }
  function paintModelsDialog() {
    if (!pendingDub || !pendingDub.downloading) return;
    // The painted rows, not the raw ones: a pack's percent lives on the
    // painted row (rowsToPaint), the engine's own row has none.
    const rows = rowsToPaint();
    const pct = overallProgress(rows, pendingDub.ids);
    // Stopped -- a pack the desktop app could not install, a model paused --
    // the dialog's opening words come back, without the bar: "Downloading 0%"
    // stayed above the reason and the Download button (click-through, 2026-10-21).
    const stopped = downloadStopped(rows, pendingDub.ids);
    $("mnProgress").hidden = stopped;
    $("mnBar").style.width = (pct ?? 0) + "%";
    // One number, where the eye lands. Which file or step it is on is left
    // out: nobody downloading asked (user, 2026-09-28). No number before
    // there is one (overallProgress).
    $("mnTitle").textContent = stopped ? pendingDub.title
      : pct == null ? t("Getting ready…") : t("Downloading {pct}%", { pct });
    $("mnLine").textContent = stopped ? pendingDub.line : "";
    if (packBusy) return;
    // A model whose download stopped: paused with its pieces on disk, or --
    // an Ollama pull that failed before it began -- not_downloaded with the
    // engine's reason attached. Either way the dialog says so instead of
    // polling at 0% for good.
    const failed = pendingDub.ids.map(modelRow)
      .find((r) => r && (r.state === "paused" || (r.state === "not_downloaded" && r.error)));
    if (failed) {
      $("mnError").textContent = failed.error
        ? t("{name} stopped: {reason} Resume it from the line under its dropdown.", { name: failed.name, reason: failed.error })
        : t("{name} stopped. Resume it from the line under its dropdown.", { name: failed.name });
    }
    if (allReady(modelRows, pendingDub.ids)) {
      pendingDub = null;
      $("modelsNeededOverlay").classList.remove("open");
      onStartDubbing();   // the New project dialog still holds the same form
    }
  }
  // The topbar chip's click: mid-dub it brings the dialog it belongs to back,
  // and otherwise there is nothing to come back to, so Settings' catalog.
  function reopenDialogOrSettings() {
    if (pendingDub) $("modelsNeededOverlay").classList.add("open");
    else onOpenSettings();
  }

  $("mnDownload").addEventListener("click", () => {
    if (!pendingDub) return;
    const dub = pendingDub;
    dub.downloading = true;
    $("mnError").textContent = "";
    $("mnDownload").hidden = true;
    $("mnSettings").hidden = true;
    $("mnHide").hidden = false;
    $("mnProgress").hidden = false;
    (async () => {
      // Packs first, one after another (the desktop app installs one at a
      // time); a pack that fails stops here, with its reason in the dialog
      // and the button back for another go. Then the models, all at once,
      // the way it always went -- the poll starts the dub when all are ready.
      for (const id of dub.packs || []) {
        const r = modelRow(id);
        if (r && r.state === "ready") continue;
        if (!(await installPack(id))) {
          if (pendingDub === dub) { dub.downloading = false; $("mnDownload").hidden = false; $("mnHide").hidden = true; }
          return;
        }
        if (pendingDub !== dub) return;   // cancelled meanwhile
      }
      for (const id of dub.models || dub.ids) {
        const r = modelRow(id);
        if (!r || r.state !== "ready") downloadModel(id);
      }
      startPolling();
    })();
  });
  $("mnSettings").addEventListener("click", () => {
    pendingDub = null;
    $("modelsNeededOverlay").classList.remove("open");
    onUsePerso();
  });
  // Hidden, the download shows as the top-bar chip instead -- the page draws
  // that chip only while this dialog is closed, so it needs a repaint now.
  $("mnHide").addEventListener("click", () => { $("modelsNeededOverlay").classList.remove("open"); repaint(); });
  $("mnCancel").addEventListener("click", () => {
    if (packBusy) cancelPack(packBusy.id);
    if (pendingDub && pendingDub.downloading) {
      // The dub is off; the downloads stop too. Their pieces stay (Paused).
      for (const id of pendingDub.ids) {
        const r = modelRow(id);
        if (r && r.state === "downloading") cancelModel(id);
      }
    }
    pendingDub = null;
    $("modelsNeededOverlay").classList.remove("open");
  });

  return {
    // used by the page
    showModelsDialog, refreshModels, modelRow, downloadModel, downloadAll, cancelModel,
    repaint, reopenDialogOrSettings, startPolling, onPackProgress,
    // used by tests only -- Remove is drawn by this file and clicked through
    // its own row, so the page never names it. Reachable so the test can.
    removeModel, installPack, removePack,
  };
}
