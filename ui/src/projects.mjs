// The two places the app shows its jobs: the Projects list in the left rail,
// and the Up next card at the top of the home screen. Both read the same
// GET /api/dub/jobs -- every job leaves a job.json beside its video, so the
// list is the same tomorrow morning as it is now, and nothing about it is
// remembered in the browser.
//
// What is NOT here: opening a job (resumeJob), the delete confirmation dialog
// and the cancel question stay on the page, because each of them reaches well
// past the list -- into the running screen, the top bar and the forward arrow.
// This file only draws the rows and hands the click back through onOpenJob,
// onDeleteJob and onCancelJob. The rail's fold (the toggle button, the
// remembered open/closed state) stays on the page too: the topbar's pane
// buttons watch that class, and this file must not reach the topbar. The
// polling tick that keeps the Up next card fresh is the page's as well, so
// that a test can call renderQueueCard without leaving a timer running.
//
// Everything this file touches is #historyList and the #queueCard box.
import { escapeHtml, fmtClock } from "./format.mjs";
import { parseProgress } from "./dubApi.mjs";

// Anything that is not finished, failed or cancelled is still going.
const JOB_DOT = { done: "dot-done", error: "dot-error", cancelled: "dot-cancelled",
                  queued: "dot-queued" };

/**
 * Wire the Projects list and the Up next card to a page.
 *
 * @param {object} deps
 * @param {(id: string) => any} deps.$  the page's getElementById helper
 * @param {() => string|null} deps.getActiveJobId  which job is open right now,
 *        so its row can be marked -- read late, because state.jobId changes
 *        under this file all day
 * @param {() => boolean} deps.isHomeScreen  whether the first screen is up; the
 *        Up next card is shown there and nowhere else
 * @param {(code: string) => string|null} deps.langName  human name for a
 *        language code (the page's own, shared with the finished screen)
 * @param {(jobId: string) => void} deps.onOpenJob  open a job (resumeJob)
 * @param {(job: object) => void} deps.onDeleteJob  a row's Delete button (the
 *        page asks in its own dialog -- window.confirm freezes the shell)
 * @param {(job: object) => void} deps.onCancelJob  a queue row's X: take a
 *        waiting job out of line, or stop the one on air
 * @returns the operations the rest of the page calls.
 */
export function initProjectsUi({ $, getActiveJobId, isHomeScreen, langName,
                                 onOpenJob, onDeleteJob, onCancelJob }) {
  // The line under a project's name: which way the dub goes and how long it is.
  // Length is only known for a job the user trimmed -- the record says what was
  // cut, never how long the film was -- so it is left out rather than guessed at.
  function projectMeta(job) {
    const langs = `${langName(job.source_lang) || "Auto"} → ${langName(job.language_code) || "Script"}`;
    const length = job.trim ? fmtClock(job.trim.end - job.trim.start) : "";
    return [langs, length].filter(Boolean).join(" · ");
  }

  // A name too long for the column is cut off with an ellipsis, and hovering it
  // is then the only way to read the rest. Only the names actually cut off get a
  // tooltip: one that repeats a name already fully on show is noise under the
  // pointer. Run again whenever the column changes width, since which names are
  // cut off changes with it.
  function markClippedNames() {
    for (const name of $("historyList").querySelectorAll(".job-name")) {
      if (name.scrollWidth > name.clientWidth) name.title = name.textContent;
      else name.removeAttribute("title");
    }
  }

  // Shown only on the home screen, and only while something is running or
  // waiting. The one job on air is asked for its detail (that is where the
  // stage lives); the waiting rows each carry an X that takes them out of line.
  async function renderQueueCard() {
    const card = $("queueCard");
    if (!isHomeScreen()) { card.hidden = true; return; }
    let jobs;
    try {
      jobs = (await (await fetch("/api/dub/jobs")).json()).jobs || [];
    } catch { return; }
    const running = jobs.filter((j) => j.status === "running" || j.status === "cancelling");
    const waiting = jobs.filter((j) => j.status === "queued");
    if (!running.length && !waiting.length) { card.hidden = true; return; }
    waiting.reverse();       // the list is newest first; the line is oldest first

    let pct = null;
    if (running.length) {
      try {
        const detail = await (await fetch(`/api/dub/jobs/${running[0].id}`)).json();
        pct = parseProgress(detail.logs || []).percent;
      } catch { /* the row just says Dubbing... */ }
    }

    const rows = $("queueRows");
    rows.innerHTML = "";
    for (const job of [...running, ...waiting]) {
      const live = job.status !== "queued";
      const row = document.createElement("button");
      row.type = "button";
      row.className = "queue-row";
      const stateText = job.status === "cancelling" ? "Cancelling…"
        : live ? (pct != null ? `Dubbing ${pct}%` : "Dubbing…") : "Waiting";
      row.innerHTML = `<span class="q-name">${escapeHtml(job.project || "Dubbing")}${
        live ? `<div class="queue-bar"><i style="width:${pct ?? 0}%"></i></div>` : ""
      }</span><span class="q-state${live ? " run" : ""}">${stateText}</span>`;
      row.addEventListener("click", () => onOpenJob(job.id));
      const line = document.createElement("div");
      line.className = "queue-line";
      line.appendChild(row);
      // Every row can leave the line -- the one on air included (user request
      // 2026-09-01). A waiting job goes quietly; stopping the one running is
      // asked about first, since minutes of work go with it. "cancelling" has
      // no X: it is already on its way out.
      if (job.status !== "cancelling") {
        const x = document.createElement("button");
        x.type = "button";
        x.className = "queue-x";
        x.title = live ? "Cancel dubbing" : "Take this video out of line";
        x.textContent = "✕";
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          onCancelJob(job);
        });
        line.appendChild(x);
      }
      rows.appendChild(line);
    }
    $("queueSummary").textContent =
      `${running.length} running · ${waiting.length} waiting`;
    card.hidden = false;
  }

  async function renderHistory() {
    const container = $("historyList");
    let jobs;
    try {
      jobs = (await (await fetch("/api/dub/jobs")).json()).jobs || [];
    } catch {
      container.innerHTML = '<div class="history-empty">Could not reach the app server.</div>';
      return;
    }
    if (jobs.length === 0) {
      container.innerHTML = '<div class="history-empty">No projects yet - drop a video to start one.</div>';
      return;
    }
    container.innerHTML = "";
    for (const job of jobs) {
      const row = document.createElement("button");
      row.className = "job-row" + (job.id === getActiveJobId() ? " current" : "");
      row.type = "button";
      row.innerHTML = `<span class="job-dot ${JOB_DOT[job.status] || "dot-running"}"></span>
      <div class="job-info"><div class="job-name">${escapeHtml(job.project || "Dubbing")}</div><div class="job-meta">${escapeHtml(projectMeta(job))}</div></div>`;
      row.addEventListener("click", () => onOpenJob(job.id));

      const del = document.createElement("button");
      del.className = "job-del";
      del.type = "button";
      del.title = "Delete this project's files";
      del.textContent = "Delete";
      del.addEventListener("click", (e) => { e.stopPropagation(); onDeleteJob(job); });

      const line = document.createElement("div");
      line.className = "job-line";
      line.appendChild(row);
      line.appendChild(del);
      container.appendChild(line);
    }
    markClippedNames();
  }

  return { renderHistory, renderQueueCard, markClippedNames };
}
