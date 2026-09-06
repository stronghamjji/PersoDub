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
export function initModelsUi({ $, onStartDubbing, onOpenSettings, onRowsChanged }) {
  // Every element this file names is required markup (index.html always has
  // it), so nothing here null-checks what $ returns -- same as
  // ui/src/settingsDialog.mjs. A missing id is a broken page, and a crash on
  // the first paint says so far louder than a silent half-drawn dialog.
  let modelRows = [];
  let modelsPolling = false;
  let pendingDub = null;   // { ids, downloading } while the dialog drives a dub

  const modelRow = (id) => modelRows.find((m) => m.id === id) || null;

  async function fetchModels() {
    try {
      const r = await fetch("/api/models");
      if (r.ok) modelRows = (await r.json()).models;
    } catch { /* keep the last rows */ }
    return modelRows;
  }

  // Everything that paints from the rows, in the order the page shows it:
  // the caller's dropdown hints and chip first, then the catalog, then the
  // dialog (which is also where a finished download starts the dub).
  function repaint() {
    onRowsChanged(modelRows);
    renderModelsList();
    paintModelsDialog();
  }

  async function refreshModels() {
    await fetchModels();
    repaint();
    return modelRows;
  }

  function anyDownloading() { return modelRows.some((m) => m.state === "downloading"); }
  function startPolling() {
    if (modelsPolling) return;
    modelsPolling = true;
    const tick = async () => {
      await fetchModels();
      repaint();
      if (anyDownloading() || (pendingDub && pendingDub.downloading)) { setTimeout(tick, 2000); return; }
      modelsPolling = false;
    };
    tick();
  }
  async function downloadModel(id) {
    try { await fetch(`/api/models/${id}/download`, { method: "POST" }); } catch { /* poll shows it */ }
    startPolling();
  }
  async function cancelModel(id) {
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
    for (const m of modelRows) {
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
      status.className = "settings-hint" + (st.cls ? " " + st.cls : "");
      status.textContent = m.state === "not_downloaded" ? "" : st.text;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-outline model-btn";
      if (m.state === "ready") { btn.textContent = "Remove"; btn.onclick = () => removeModel(m.id); }
      else if (m.state === "downloading") { btn.textContent = "Cancel"; btn.onclick = () => cancelModel(m.id); }
      else if (m.state === "paused") { btn.textContent = "Resume"; btn.onclick = () => downloadModel(m.id); }
      else { btn.textContent = "Download"; btn.onclick = () => downloadModel(m.id); }
      row.append(name, size, status, btn);
      list.append(row);
    }
    const busy = modelRows.some((m) => m.state === "downloading" || m.state === "paused");
    $("modelsSummary").textContent =
      `${modelRows.length} models · ${gb(onDisk)} GB on this computer`
      + (busy ? " · attention needed" : "");
    // Never force it shut -- only open it for the user when something is busy.
    if (busy) $("modelsFold").open = true;
  }

  // -- the dub-start dialog (dub_start's 409) ------------------------------
  function showModelsDialog(detail) {
    const d = dubStartDialog(detail);
    pendingDub = { ids: d.ids, downloading: false };
    $("mnTitle").textContent = d.title;
    $("mnLine").textContent = d.line;
    $("mnError").textContent = "";
    $("mnProgress").hidden = true;
    $("mnDownload").hidden = false;
    $("mnSettings").hidden = false;
    $("mnHide").hidden = true;
    $("modelsNeededOverlay").classList.add("open");
  }
  function paintModelsDialog() {
    if (!pendingDub || !pendingDub.downloading) return;
    const pct = overallProgress(modelRows, pendingDub.ids);
    $("mnBar").style.width = pct + "%";
    $("mnTitle").textContent = "Downloading AI models";
    $("mnLine").textContent = `${pct}%. Dubbing starts when they finish.`;
    const failed = pendingDub.ids.map(modelRow).find((r) => r && r.state === "paused");
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
    pendingDub.downloading = true;
    $("mnDownload").hidden = true;
    $("mnSettings").hidden = true;
    $("mnHide").hidden = false;
    $("mnProgress").hidden = false;
    for (const id of pendingDub.ids) {
      const r = modelRow(id);
      if (!r || r.state !== "ready") downloadModel(id);
    }
  });
  $("mnSettings").addEventListener("click", () => onOpenSettings());
  $("mnHide").addEventListener("click", () => $("modelsNeededOverlay").classList.remove("open"));
  $("mnCancel").addEventListener("click", () => {
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
    showModelsDialog, refreshModels, modelRow, downloadModel, cancelModel,
    repaint, reopenDialogOrSettings,
    // used by tests only -- Remove is drawn by this file and clicked through
    // its own row, so the page never names it. Reachable so the test can.
    removeModel,
  };
}
