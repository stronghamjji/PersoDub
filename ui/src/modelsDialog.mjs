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
import { gb, modelStatusLine, dubStartDialog, overallProgress, allReady } from "./modelsUi.mjs";

/**
 * Wire the models UI to a page.
 *
 * @param {object} deps
 * @param {(id: string) => any} deps.$          the page's getElementById helper
 * @param {() => void} deps.onStartDubbing      resubmit the dub once every model is ready
 * @param {() => void} deps.onOpenSettings      open the Settings sheet
 * @param {(rows: object[]) => void} deps.onRowsChanged  repaint the page's own
 *        model-dependent chrome (the dropdown hints and the topbar chip)
 * @returns the operations the page calls, and the one the tests do -- grouped
 *        and labelled in the returned object, so pruning this surface later
 *        does not have to guess which member has a caller off the page.
 */
export function initModelsUi({ $, onStartDubbing, onOpenSettings, onRowsChanged, shell = null, keepPolling = () => false }) {
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
  let packBusy = null;     // { id, name, line, pct }
  let packFailed = null;   // { id, reason } until the next attempt or refresh clears it
  const PACK_HINT = "Installed by the desktop app";

  const modelRow = (id) => modelRows.find((m) => m.id === id) || null;

  if (shell && shell.onInstallProgress) {
    shell.onInstallProgress((p) => {
      if (!p || !p.pack || !packBusy || packBusy.id !== p.pack) return;
      // A detail that only restates the title ("Downloading the translation
      // runtime: Downloading the translation runtime", 2026-09-08) shows once.
      packBusy.line = p.state === "progress" && p.detail && p.detail !== p.title ? `${p.title}: ${p.detail}` : (p.title || "");
      // The shell sends the pack's overall percent on every event.
      if (p.pct != null) packBusy.pct = p.pct;
      repaint();
    });
  }

  function showPackError(text) {
    $("mnError").textContent = text;
    $("modelsError").textContent = text;
  }

  // Resolves true once the pack is on disk and its process is up. A failure
  // (no desktop app, no room, a step that died, Cancel) is told in the dialog
  // and the Settings catalog alike, and nothing else is started.
  async function installPack(id) {
    const name = (modelRow(id) || {}).name || id;
    if (!shell || !shell.installPack) {
      showPackError(`${name}: ${PACK_HINT}.`);
      return false;
    }
    if (packBusy) {
      // One at a time, and the one running keeps its place on screen: a second
      // press used to take over the busy slot and show the first as paused.
      if (packBusy.id !== id) showPackError(`${packBusy.name} is still installing. Wait for it to finish.`);
      return false;
    }
    packBusy = { id, name, line: "", pct: null };
    packFailed = null;
    repaint();
    let res;
    try { res = await shell.installPack(id); }
    catch (e) { res = { ok: false, reason: String((e && e.message) || e) }; }
    packBusy = null;
    if (!res || !res.ok) packFailed = { id, reason: (res && res.reason) || "The install could not finish." };
    await fetchModels();
    repaint();
    if (packFailed) {
      showPackError(`${name}: ${packFailed.reason}`);
      return false;
    }
    showPackError("");   // a "still installing" notice from a second press is over
    return true;
  }
  async function cancelPack(id) {
    if (shell && shell.cancelPack) await shell.cancelPack(id);
  }
  async function removePack(id) {
    $("modelsError").textContent = "";
    if (!shell || !shell.removePack) { $("modelsError").textContent = PACK_HINT + "."; return; }
    // The engine knows whether a dub is running; its DELETE refuses a pack
    // either way, and the sentence tells which reason. Only "packs are the
    // desktop app's" means the coast is clear.
    try {
      const r = await fetch(`/api/models/${id}`, { method: "DELETE" });
      const body = await r.json().catch(() => null);
      const why = String((body && body.detail) || "");
      if (!why.startsWith("Packs are installed")) { $("modelsError").textContent = why || "Could not remove it."; return; }
    } catch { $("modelsError").textContent = "Could not remove it. Is the engine running?"; return; }
    const res = await shell.removePack(id).catch((e) => ({ ok: false, reason: String((e && e.message) || e) }));
    if (!res || !res.ok) $("modelsError").textContent = (res && res.reason) || "Could not remove it.";
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
        const body = await r.json().catch(() => null);
        showPackError(`${(row && row.name) || id}: ${String((body && body.detail) || "The download could not start.")}`);
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
        $("modelsError").textContent = String((body && body.detail) || "Could not remove it.");
      }
    } catch { $("modelsError").textContent = "Could not remove it. Is the engine running?"; }
    await fetchModels();
    repaint();
  }

  function renderModelsList() {
    const list = $("modelsList");
    list.replaceChildren();
    let onDisk = 0;
    for (const m of rowsToPaint()) {
      if (m.state === "ready") onDisk += m.bytes;
      const row = document.createElement("div");
      row.className = "settings-row model-row";
      const name = document.createElement("span");
      name.textContent = m.name;
      if (m.hint) {
        // What it is for, under the name: "AI engine" says nothing on its own.
        const hint = document.createElement("small");
        hint.className = "model-hint";
        hint.textContent = m.hint;
        name.append(hint);
      }
      const size = document.createElement("span");
      size.className = "model-size";
      size.textContent = `${gb(m.bytes)} GB`;
      const st = modelStatusLine(m);
      const status = document.createElement("span");
      status.className = "settings-hint" + (st.cls ? " " + st.cls : "");
      status.textContent = m.state === "not_downloaded" ? "" : st.text;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-outline model-btn";
      if (m.role === "pack") {
        // The desktop app installs and removes packs; a plain browser can only look.
        if (packBusy && packBusy.id === m.id) {
          status.textContent = st.text + (packBusy.line ? ` · ${packBusy.line}` : "");
          btn.textContent = "Cancel"; btn.onclick = () => cancelPack(m.id);
        } else if (packFailed && packFailed.id === m.id) {
          status.textContent = `Stopped: ${packFailed.reason}`;
          btn.textContent = "Resume"; btn.onclick = () => installPack(m.id);
        } else if (!shell) {
          if (m.state !== "ready") status.textContent = PACK_HINT;
          btn.textContent = m.state === "ready" ? "Remove" : "Download";
          btn.disabled = true; btn.title = PACK_HINT;
        } else if (packBusy) {
          // Another pack is installing: this one waits its turn.
          btn.textContent = m.state === "ready" ? "Remove" : "Download";
          btn.disabled = true; btn.title = `${packBusy.name} is still installing`;
        } else if (m.state === "ready") { btn.textContent = "Remove"; btn.onclick = () => removePack(m.id); }
        else { btn.textContent = m.state === "paused" ? "Resume" : "Download"; btn.onclick = () => installPack(m.id); }
      } else if (m.state === "ready") { btn.textContent = "Remove"; btn.onclick = () => removeModel(m.id); }
      else if (m.state === "downloading") { btn.textContent = "Cancel"; btn.onclick = () => cancelModel(m.id); }
      else if (m.state === "paused") { btn.textContent = "Resume"; btn.onclick = () => downloadModel(m.id); }
      else { btn.textContent = "Download"; btn.onclick = () => downloadModel(m.id); }
      row.append(name, size, status, btn);
      list.append(row);
    }
    const busy = !!packBusy || rowsToPaint().some((m) => m.state === "downloading" || m.state === "paused");
    $("modelsSummary").textContent =
      `${modelRows.length} models · ${gb(onDisk)} GB on this computer`
      + (busy ? " · attention needed" : "");
    // Never force it shut -- only open it for the user when something is busy.
    if (busy) $("modelsFold").open = true;
  }

  // -- the dub-start dialog (dub_start's 409) ------------------------------
  function showModelsDialog(detail) {
    const d = dubStartDialog(detail);
    pendingDub = { ids: d.ids, packs: d.packs, models: d.models, downloading: false };
    $("mnTitle").textContent = d.title;
    $("mnLine").textContent = d.line;
    // The list: a first-time user never opens Settings, so this is where they
    // learn what an "AI engine" is and that the Perso API is the other road.
    const list = $("mnItems");
    list.replaceChildren();
    for (const it of d.items) {
      const li = document.createElement("li");
      const name = document.createElement("b");
      name.textContent = `${it.name} · ${it.size}`;
      li.append(name);
      if (it.hint) {
        const hint = document.createElement("span");
        hint.textContent = it.hint;
        li.append(hint);
      }
      list.append(li);
    }
    list.hidden = !d.items.length;
    $("mnAlt").hidden = false;
    $("mnError").textContent = "";
    $("mnProgress").hidden = true;
    $("mnDownload").hidden = false;
    $("mnSettings").hidden = false;
    $("mnHide").hidden = true;
    $("modelsNeededOverlay").classList.add("open");
  }
  function paintModelsDialog() {
    if (!pendingDub || !pendingDub.downloading) return;
    // The painted rows, not the raw ones: a pack's percent lives on the
    // painted row (rowsToPaint), the engine's own row has none.
    const pct = overallProgress(rowsToPaint(), pendingDub.ids);
    $("mnBar").style.width = pct + "%";
    $("mnItems").hidden = true;   // the list said what; the bar now says how far
    $("mnAlt").hidden = true;
    if (packBusy) {
      // The percent lives in the title, where the eye lands; the line below
      // says what step the installer is on (2026-09-08: only the bar moved).
      $("mnTitle").textContent = packBusy.pct != null ? `Installing ${packBusy.name} · ${packBusy.pct}%` : `Installing ${packBusy.name}`;
      $("mnLine").textContent = packBusy.line || "Starting…";
      return;
    }
    $("mnTitle").textContent = "Downloading AI models";
    $("mnLine").textContent = `${pct}%. Dubbing starts when they finish.`;
    // A model whose download stopped: paused with its pieces on disk, or --
    // an Ollama pull that failed before it began -- not_downloaded with the
    // engine's reason attached. Either way the dialog says so instead of
    // polling at 0% for good.
    const failed = pendingDub.ids.map(modelRow)
      .find((r) => r && (r.state === "paused" || (r.state === "not_downloaded" && r.error)));
    if (failed) $("mnError").textContent = `${failed.name} stopped${failed.error ? ` (${failed.error})` : ""}. Resume it from the line under its dropdown.`;
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
    $("mnItems").hidden = true;   // the list said what; the bar now says how far
    $("mnAlt").hidden = true;
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
  $("mnSettings").addEventListener("click", () => onOpenSettings());
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
    repaint, reopenDialogOrSettings, startPolling,
    // used by tests only -- Remove is drawn by this file and clicked through
    // its own row, so the page never names it. Reachable so the test can.
    removeModel, installPack, removePack,
  };
}
