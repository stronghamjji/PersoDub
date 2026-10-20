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
// Everything this file touches is #historyList (drawn only while
// #historySidebar is open) and the #queueCard box.
import { escapeHtml, fmtLength } from "./format.mjs";
import { parseProgress } from "./dubApi.mjs";
import { erasePercent } from "./eraseArea.mjs";
import { t } from "./i18n.mjs";

// Anything that is not finished, failed or cancelled is still going.
const JOB_DOT = { done: "dot-done", error: "dot-error", cancelled: "dot-cancelled",
                  queued: "dot-queued" };

// The same five states, said in shape as well as in colour: five coloured dots
// are one dot to anyone who does not see colour the way the palette assumes.
// Drawn at 12px in the page's own inline-SVG way -- no icon font, still offline.
// Done is a tick, waiting is an empty ring, running is that ring filled, a
// failure is a cross and a cancelled job is the ring struck through.
const JOB_MARK = {
  done: '<path d="M2.6 6.4l2.4 2.4 4.5-5"/>',
  error: '<path d="M3.2 3.2l5.6 5.6"/><path d="M8.8 3.2l-5.6 5.6"/>',
  cancelled: '<circle cx="6" cy="6" r="3.6"/><path d="M3.5 8.5l5-5"/>',
  queued: '<circle cx="6" cy="6" r="3.6"/>',
  running: '<circle cx="6" cy="6" r="3.6" style="fill:currentColor;stroke:none"/>',
};
/** The mark for a job's state -- "running" for anything still going. */
/**
 * What a project is called on screen: the name the user gave it, or the name
 * its folder was made with. A link's own title is long enough to fill the top
 * bar and to be cut off in this list, so it can be replaced (user,
 * 2026-09-10). The folder never moves -- only this changes.
 */
export function shownName(job) {
  return (job && job.title || "").trim() || (job && job.project) || t("Dubbing");
}

export function jobMark(status) {
  return `<svg viewBox="0 0 12 12" aria-hidden="true">${JOB_MARK[status] || JOB_MARK.running}</svg>`;
}

// Erasing subtitles is the other work this app does, so its rows say so twice:
// the rail's own eraser, shrunk, beside the name, and a word under it. A row
// with neither is a dub, which is what every row here used to be.
const ERASE_ICON = '<svg class="job-kind" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="5" width="15" height="11" rx="2"/><path d="M6 12.5h4"/><path d="M13.5 21l6.8-6.8a1.6 1.6 0 0 0 0-2.3l-1.7-1.7a1.6 1.6 0 0 0-2.3 0L9.5 17z"/><path d="M12 14.5l3.5 3.5"/></svg>';
// What an erase row says under its name. A job that stopped says only what it
// was -- the dot beside it is what says how it ended, exactly as for a dub.
// Getters here and below, so the words are read in the page's language.
const ERASE_META = { get done() { return t("Erased"); }, get error() { return t("Erase subtitles"); },
                     get cancelled() { return t("Erase subtitles"); } };
export const isErase = (job) => job.kind === "erase";
// Separate audio is the third kind of work: the word under its name says so.
const SEPARATE_META = { get done() { return t("Separated"); }, get error() { return t("Separate audio"); },
                        get cancelled() { return t("Separate audio"); } };
export const isSeparate = (job) => job.kind === "separate";
/** What a running job of this kind is doing, as the queue and the cards say it. */
export const doingWord = (job) => (isErase(job) ? t("Erasing") : isSeparate(job) ? t("Separating") : t("Dubbing"));

// The line under a project's name: which way the dub goes and how long it is.
// Length is only known for a job the user trimmed -- the record says what was
// cut, never how long the film was -- so it is left out rather than guessed at.
// Its own export (not just a closure inside initProjectsUi) so the Home screen's
// project grid (ui/src/homeScreen.mjs) can say the same thing under a card.
export function projectMeta(job, langName) {
  if (isErase(job)) return ERASE_META[job.status] || t("Erasing");
  if (isSeparate(job)) return SEPARATE_META[job.status] || t("Separating");
  const langs = `${langName(job.source_lang) || t("Auto")} → ${langName(job.language_code) || t("Script")}`;
  const length = job.trim ? fmtLength(job.trim.end - job.trim.start) : "";
  return [langs, length].filter(Boolean).join(" · ");
}

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
                                 onOpenJob, onDeleteJob, onCancelJob,
                                 // Both optional, and both there so the Home
                                 // screen's project grid can stay in step with
                                 // this list without asking the server twice:
                                 // onJobs gets the raw list renderHistory just
                                 // fetched, onRunningPct the percent
                                 // renderQueueCard works out for the job on air.
                                 onJobs, onRunningPct }) {
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
  // The jobs that were in line at the last look: one that has left it since
  // (done, failed, stopped) is what the project cards must be told about.
  let inLine = new Set();
  // The line the rows on show were drawn for: each job's id, state and name,
  // in order. A job's turn coming, a rename or a job leaving draws them again.
  let drawnLine = "";

  async function renderQueueCard() {
    const card = $("queueCard");
    if (!isHomeScreen()) { card.hidden = true; return; }
    let jobs;
    try {
      jobs = (await (await fetch("/api/dub/jobs")).json()).jobs || [];
    } catch { return; }
    const running = jobs.filter((j) => j.status === "running" || j.status === "cancelling");
    const waiting = jobs.filter((j) => j.status === "queued");
    // A job that finished while the user was on Home: the cards kept saying
    // "Dubbing 97%" for over a minute, since only an event redrew them
    // (Windows H19, 2026-10-07). The list is read again the moment one leaves.
    const nowInLine = new Set([...running, ...waiting].map((j) => j.id));
    const left = [...inLine].some((id) => !nowInLine.has(id));
    inLine = nowInLine;
    if (left) renderHistory().catch(() => {});
    if (!running.length && !waiting.length) { card.hidden = true; return; }
    waiting.reverse();       // the list is newest first; the line is oldest first

    let pct = null;
    if (running.length) {
      try {
        const detail = await (await fetch(`/api/dub/jobs/${running[0].id}`)).json();
        // The two kinds of work count themselves differently: a dub logs the
        // stage it is on, an erase logs a percentage of one long stage.
        // A separation has no percentage of its own to give.
        pct = isErase(running[0]) ? erasePercent(detail.logs || [])
          : isSeparate(running[0]) ? null : parseProgress(detail.logs || []).percent;
      } catch { /* the row just says Dubbing... */ }
      if (onRunningPct) onRunningPct(running[0].id, pct);
    }

    $("queueSummary").textContent =
      t("{running} running · {waiting} waiting", { running: running.length, waiting: waiting.length });
    card.hidden = false;

    const queue = [...running, ...waiting];
    const stateText = (job) => {
      const doing = doingWord(job);
      return job.status === "cancelling" ? t("Stopping…")
        : job.status !== "queued" ? (pct != null ? `${doing} ${pct}%` : `${doing}…`) : t("Waiting");
    };
    const rows = $("queueRows");
    const lineKey = JSON.stringify(queue.map((job) => [job.id, job.status, shownName(job)]));
    // Patched, not drawn again: a redraw every tick swapped the X out under a click (Windows C18).
    if (lineKey === drawnLine) {
      const states = rows.querySelectorAll(".q-state");
      const bars = rows.querySelectorAll(".queue-bar i");
      queue.forEach((job, i) => { states[i].textContent = stateText(job); });
      for (const bar of bars) bar.style.width = `${pct ?? 0}%`;
      return;
    }
    drawnLine = lineKey;
    rows.innerHTML = "";
    for (const job of queue) {
      const live = job.status !== "queued";
      const row = document.createElement("button");
      row.type = "button";
      row.className = "queue-row";
      row.innerHTML = `<span class="q-name">${escapeHtml(shownName(job))}${
        live ? `<div class="queue-bar"><i style="width:${pct ?? 0}%"></i></div>` : ""
      }</span><span class="q-state${live ? " run" : ""}">${stateText(job)}</span>`;
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
        // One whole sentence per kind of work, not "Stop " + the word.
        x.title = !live ? t("Take this video out of line")
          : isErase(job) ? t("Stop erasing") : isSeparate(job) ? t("Stop separating") : t("Stop dubbing");
        x.textContent = "✕";
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          onCancelJob(job);
        });
        line.appendChild(x);
      }
      rows.appendChild(line);
    }
  }

  // Folded away, the list is not drawn at all: nothing has opened it since the
  // Home grid took its place (app.mjs), and its rows were drawn for no one on
  // every refresh. Whatever opens it again calls renderHistory then.
  const folded = () => $("historySidebar").classList.contains("collapsed");

  async function renderHistory() {
    const container = $("historyList");
    let jobs;
    try {
      jobs = (await (await fetch("/api/dub/jobs")).json()).jobs || [];
    } catch {
      if (!folded()) container.innerHTML = `<div class="history-empty">${t("PersoDub is not running. Restart the app.")}</div>`;
      return;
    }
    if (onJobs) onJobs(jobs);
    if (folded()) return;
    if (jobs.length === 0) {
      container.innerHTML = `<div class="history-empty">${t("No projects yet - drop a video to start one.")}</div>`;
      return;
    }
    container.innerHTML = "";
    for (const job of jobs) {
      const row = document.createElement("button");
      row.className = "job-row" + (job.id === getActiveJobId() ? " current" : "");
      row.type = "button";
      row.innerHTML = `<span class="job-dot ${JOB_DOT[job.status] || "dot-running"}">${jobMark(job.status)}</span>
      <div class="job-info"><div class="job-name">${isErase(job) ? ERASE_ICON : ""}${escapeHtml(shownName(job))}</div><div class="job-meta">${escapeHtml(projectMeta(job, langName))}</div></div>`;
      row.addEventListener("click", () => onOpenJob(job.id));

      const del = document.createElement("button");
      del.className = "job-del";
      del.type = "button";
      del.title = t("Delete this project's files");
      del.textContent = t("Delete");
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
