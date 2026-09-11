// The running screen: the blurred original, the progress card with its four
// stages, the one notice line a job gets, the out-of-credits popup, and the
// Cancel button. Everything here is PAINT -- it is handed a job and draws it.
//
// What is NOT here: handleJobUpdate and runPollLoop stay on the page. They are
// the job-state engine, not rendering -- they write state.job, park the id on
// document.body.dataset, count poll generations, pick the screen, fill the top
// bar and hand a finished job to renderDone. Both call into this file for the
// drawing and nothing else. renderLog stays on the page too: #rawLogDetails is
// borrowed by the failure card (homeNoticeAndLog/moveInto), so the raw log is
// shared between two screens rather than owned by this one. trimLabel and the
// top bar's jobStatusLine stay as well; this file is handed trimLabel because
// the running screen and the top bar say the same trim in two lengths.
//
// The elements this file touches: #runningVideo, #runningTrim, the #progressCard
// head/bar/steps, the two notice lines (#jobNotice on the running screen and
// #doneNotice above the script -- one job crosses from one screen to the other
// and the reason has to survive the crossing), #creditOverlay and its children,
// and #cancelBtn. It never reaches the top bar, the finished screen or `state`.
import { escapeHtml } from "./format.mjs";
import { CHECK_ICON } from "./icons.mjs";
import { STAGES, SYNTH_STEP, stepLabels } from "./dubApi.mjs";

// The card's steps, in the order parseProgress numbers them: read off the one
// stage table (dubApi.mjs) rather than written out again, so a seventh pipeline
// stage shows up here too instead of leaving the card describing a shorter job.
const STAGE_NAMES = stepLabels(STAGES);

// Failures the server records as a token rather than a sentence, because the
// token is what the code elsewhere tests. Said in plain words here, where the
// only audience is the person reading the screen.
const ERROR_SENTENCES = {
  interrupted: "The app was closed before dubbing finished.",
};

// The mark above that sentence on a job that stopped. Two states share the one
// screen and only the words told them apart, so a stopped job read the same as
// a finished one until it was read: a stop square when someone cancelled it, an
// exclamation when it failed on its own.
const STOPPED_MARKS = {
  cancelled: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  error: '<path d="M12 7.5v5.5"/><path d="M12 16.6h.01"/>',
};
/** The mark for a job that stopped -- anything not cancelled has failed. */
export function stoppedMark(status) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${STOPPED_MARKS[status] || STOPPED_MARKS.error}</svg>`;
}

// Out-of-credits / quota popup: pop once per job on the first exhaustion-type
// notice. The inline yellow notice line stays either way, so the reason
// is still visible after the popup is dismissed. Per-type wording; button is
// only shown when going somewhere actually helps (a 503 has nowhere to go).
const CREDIT_MODALS = {
  perso_credit_exhausted: {
    title: "Out of credits",
    message: "Perso credits are used up. Recharge, then run this job again.",
    button: "Recharge",
  },
  perso_invalid_key: {
    title: "Check your Perso key",
    message: "Perso rejected the API key. Open Settings and check the key.",
    button: "Open Settings",
    action: "settings",  // in-app action instead of an external link
  },
  perso_unavailable: {
    title: "Perso server busy",
    message: "Perso's server is temporarily unavailable. Wait a few minutes, then run this job again.",
    button: null,
  },
  gemini_quota_exhausted: {
    title: "Gemini quota used up",
    message: "The Gemini key's free quota is used up. Upgrade its plan, or try again after the daily reset.",
    button: "Upgrade",
  },
  gemini_unavailable: {
    title: "Google server busy",
    message: "Google's Gemini server is temporarily overloaded. Wait a few minutes, then run this job again.",
    button: null,
  },
};

/**
 * Wire the running screen to a page.
 *
 * @param {object} deps
 * @param {(id: string) => any} deps.$  the page's getElementById helper
 * @param {(logs: string[]) => object} deps.parseProgress  dubApi.mjs's reader of
 *        the job log -- which stage, how far in, how many voices are done
 * @param {(job: object, withLength?: boolean) => string} deps.trimLabel  the
 *        page's own caption for a trimmed job; the running screen has the room
 *        for the length, so it asks for the long form
 * @param {() => void} deps.homeNoticeAndLog  put the notice line and the raw log
 *        back where they belong -- a failed job borrows both onto the done
 *        screen, and this job's log has to be readable under this job's steps
 * @param {() => string|null} deps.getJobId  which job is open right now -- read
 *        late, because state.jobId changes under this file all day
 * @param {() => string|null} deps.getJobStatus  that job's status, read late for
 *        the same reason; it is what decides whether Cancel is shown at all
 * @param {(jobId: string) => Promise} deps.onCancel  ask the server to stop the
 *        job (cancelDubJob)
 * @param {() => Promise<boolean>} deps.askCancel  put the "Stop this dub?"
 *        question to the user and resolve with their answer. The page's own
 *        dialog, not window.confirm(): that one freezes every event in the
 *        Electron shell while it is up, and Chromium writes its buttons in the
 *        machine's language, so an English question came with Korean answers
 * @param {() => void} deps.onOpenSettings  open the Settings sheet, for the
 *        popup's in-app button ("Open Settings")
 * @param {(anchor: any, url: string) => void} deps.openExternal  arm the popup's
 *        Recharge button to open somewhere outside the app. The page keeps the
 *        anchor's own target="_blank" behaviour by setting its href; passing it
 *        in is what lets a test see which link the user was offered, and what
 *        would let the desktop shell open it its own way later.
 * @returns the operations the rest of the page calls.
 */
export function initRunningScreenUi({ $, parseProgress, trimLabel, homeNoticeAndLog,
                                      getJobId, getJobStatus, onCancel, askCancel,
                                      onOpenSettings, openExternal }) {
  // Every element this file names is required markup (index.html always has
  // it), so nothing here null-checks what $ returns -- same as
  // ui/src/settingsDialog.mjs. A missing id is a broken page.
  const shownFor = new Set();   // jobs whose popup has already been seen
  let modalAction = null;       // "settings" while the open popup's button is an in-app action

  // The blurred original plus the progress card, redrawn on every poll.
  // NO time estimate, ever: the four stages take wildly different times on
  // different machines, so any "about N minutes left" we showed would be a
  // promise we break.
  function paintRunning(job) {
    const progress = parseProgress(job.logs);
    // A job that failed took the raw log onto the done screen with it. This job's
    // log has to be readable here, under this job's steps.
    homeNoticeAndLog();
    // Set once -- assigning src on every poll would restart the download three
    // seconds in, forever. A link job has no input.mp4 yet when it starts (the
    // video is downloaded inside the job thread, app/api/dub.py:dub_start), so that
    // first request 404s; the error handler below drops the src again and this
    // guard re-arms it on the next poll. Once a load succeeds no error fires, so
    // the src stays put and the request is not repeated.
    const video = $("runningVideo");
    // A link job is downloaded whole inside the job thread and only cut after
    // that, so the picture above may be the untrimmed download. The first stage
    // starting is the sign the cut has landed; the mark makes it a different URL
    // exactly once, so the browser fetches the trimmed file and then settles.
    const cut = job.from_link && job.trim && progress.stage > 0 ? "?cut=1" : "";
    const src = `/api/dub/result/${job.id}/original${cut}`;
    if (video.getAttribute("src") !== src) video.setAttribute("src", src);

    $("runningTrim").textContent = trimLabel(job, true);

    $("progressTitle").textContent = progress.label;
    $("progressPct").textContent = `${progress.percent}%`;
    $("progressFill").style.width = `${progress.percent}%`;
    $("progressFill").parentElement.setAttribute("aria-valuenow", String(progress.percent));

    $("progressSteps").innerHTML = STAGE_NAMES.map((name, i) => {
      const n = i + 1;
      const stepState = n < progress.stage ? "done" : n === progress.stage ? "current" : "todo";
      // Only the voice stage counts lines, and only once the pipeline has
      // logged how many there are AND finished at least one. A standard-quality
      // run never logs a chosen take, so the counter would sit at "voice 0 of 5"
      // for the whole stage and read like something stuck.
      const counted = stepState === "current" && n === SYNTH_STEP
        && progress.voiceTotal && progress.voiceDone > 0;
      const note = counted
        ? ` <span class="step-note">· voice ${Math.min(progress.voiceDone, progress.voiceTotal)} of ${progress.voiceTotal}</span>`
        : "";
      const mark = stepState === "done" ? CHECK_ICON : "";
      // "step-done", not the bare "done": .done is the finished screen's own
      // layout class, and a step wearing it turned into a column -- tick above
      // the name instead of beside it.
      const cls = stepState === "done" ? "step-done" : stepState;
      return `<li class="${cls}"><span class="step-mark ${cls}">${mark}</span>${escapeHtml(name)}${note}</li>`;
    }).join("");
  }

  // Removing the attribute does not itself start a load, so this cannot loop:
  // it only puts the element back to "no source", which paintRunning notices on
  // the next poll (three seconds later) and tries again -- until the download
  // lands, after which there is no error and nothing to re-arm.
  $("runningVideo").addEventListener("error", (e) => e.target.removeAttribute("src"));

  // The single reason line. On a failed job it carries THE explanation
  // (job.error, with the notice's clickable Recharge link when the backend
  // attached one); on a running job it shows the latest notice. Everything else
  // stays short so this one message actually gets read -- splitting the story
  // across four banners meant none of them did.
  // It is written into both screens, because a job crosses from one to the other
  // and the reason has to survive the crossing: #jobNotice under the progress
  // steps while it runs, #doneNotice above the script once it is finished.
  //
  // The popup rides along at the end, where the page used to call it a line
  // later: the line and the popup are one answer to one notice, and nothing
  // ever wanted only half of it.
  function paintNotices(job) {
    const notices = job.notices || [];
    const n = notices.length ? notices[notices.length - 1] : null;
    const failed = job.status === "error";
    const message = failed
      ? (ERROR_SENTENCES[job.error] || job.error || (n && n.message) || "Something went wrong. Try again, or use a shorter clip.")
      : (n && n.message);
    const linkText = n && CREDIT_MODALS[n.type] ? CREDIT_MODALS[n.type].button : "Recharge";
    const html = (n && n.link && linkText)
      ? `${escapeHtml(message)} <a href="${escapeHtml(n.link)}" target="_blank" rel="noopener">${linkText}</a>`
      : escapeHtml(message || "");
    for (const id of ["jobNotice", "doneNotice"]) {
      const el = $(id);
      // "danger" only ever comes from the poll loop's own failure
      // (showNoticeError below); a real notice replaces that message, so it
      // drops the red with it.
      el.classList.remove("danger");
      el.hidden = !message;
      el.innerHTML = message ? html : "";
    }
    maybeShowCreditModal(job);
  }

  // The poll loop's own failure: the server went quiet, or said this job is
  // gone. Red, and plain text -- these sentences carry no link.
  function showNoticeError(text) {
    const el = $("jobNotice");
    el.textContent = text;
    el.classList.add("danger");
    el.hidden = false;
  }

  function maybeShowCreditModal(job) {
    const n = (job.notices || []).find((x) => CREDIT_MODALS[x.type]);
    if (!n || shownFor.has(job.id)) return;
    shownFor.add(job.id);
    showCreditModal(n);
  }

  function showCreditModal(notice) {
    const cfg = CREDIT_MODALS[notice.type];
    $("creditTitle").textContent = cfg.title;
    $("creditMessage").textContent = cfg.message;
    modalAction = cfg.action || null;
    const btn = $("creditRechargeBtn");
    const show = cfg.button && (notice.link || cfg.action);
    btn.style.display = show ? "" : "none";
    if (show) { btn.textContent = cfg.button; openExternal(btn, notice.link || "#"); }
    $("creditOverlay").classList.add("open");
  }
  function hideCreditModal() { $("creditOverlay").classList.remove("open"); }
  $("creditCloseX").addEventListener("click", hideCreditModal);
  $("creditCloseBtn").addEventListener("click", hideCreditModal);
  $("creditRechargeBtn").addEventListener("click", (e) => {
    // Link-type button: the link opens in a new tab and the popup closes.
    // Action-type button ("Open Settings"): stay in the app and open Settings.
    if (modalAction === "settings") { e.preventDefault(); onOpenSettings(); }
    hideCreditModal();
  });
  $("creditOverlay").addEventListener("click", (e) => { if (e.target === $("creditOverlay")) hideCreditModal(); });

  function paintCancel() {
    const btn = $("cancelBtn");
    const status = getJobStatus();
    btn.hidden = !["running", "cancelling", "queued"].includes(status);
    btn.disabled = status === "cancelling";
    // The label element, not the button: the word is written many times over
    // a job's life, and the button is where any other child would live.
    ($("cancelLabel") || btn).textContent = status === "cancelling" ? "Cancelling…" : "Cancel";
  }

  $("cancelBtn").addEventListener("click", async () => {
    const jobId = getJobId();
    if (!jobId) return;
    if (!(await askCancel())) return;
    $("cancelBtn").disabled = true;
    ($("cancelLabel") || $("cancelBtn")).textContent = "Cancelling…";
    try {
      await onCancel(jobId);
    } catch (e) {
      // The job may already have finished between the confirm dialog and this
      // call (backend returns 409) -- not fatal, the next poll shows the truth.
      console.warn(e.message);
      // Unless there is no next poll: if the server is unreachable the poll loop
      // has already given up, so put the button back by hand rather than leaving
      // it stuck on a disabled "Cancelling…".
      paintCancel();
    }
  });

  // Starting a fresh job: both notice lines go quiet, and the red goes with
  // them. The set of jobs whose popup has been seen is deliberately NOT
  // cleared -- it is keyed by job id and one job's popup is worth showing once,
  // whatever the user does in between.
  function reset() {
    $("jobNotice").hidden = true;
    $("jobNotice").classList.remove("danger");
    $("doneNotice").hidden = true;
  }

  return { paintRunning, paintNotices, showCreditModal, hideCreditModal,
           showNoticeError, paintCancel, reset };
}
