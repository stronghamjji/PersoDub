// A dub that is running, inside the work screen: the progress card with its
// four stages under the Dubbing tab, the original in the center panel, the one
// notice line a job gets, the out-of-credits popup, and the Cancel button.
// Everything here is PAINT -- it is handed a job and draws it.
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
// head/bar/steps, #runNote, the two notice lines (#jobNotice on the running screen and
// #doneNotice above the script -- one job crosses from one screen to the other
// and the reason has to survive the crossing), #creditOverlay and its children,
// and #cancelBtn. It never reaches the top bar, the finished screen or `state`.
import { escapeHtml, plainFailure } from "./format.mjs";
import { CHECK_ICON } from "./icons.mjs";
import { STAGES, SYNTH_STEP, stepLabels } from "./dubApi.mjs";
import { resetsSentence } from "./translatorChoice.mjs";
import { t } from "./i18n.mjs";

// The card's steps, in the order parseProgress numbers them: read off the one
// stage table (dubApi.mjs) rather than written out again, so a seventh pipeline
// stage shows up here too instead of leaving the card describing a shorter job.
// English, as the table has them: each is drawn through t().
const STAGE_NAMES = stepLabels(STAGES);

// Failures the server records as a token rather than a sentence, because the
// token is what the code elsewhere tests. Said in plain words here, where the
// only audience is the person reading the screen.
const ERROR_SENTENCES = {
  get interrupted() { return t("The app was closed before dubbing finished."); },
};

// A dub on this computer that stopped with no sentence of its own, by the
// stage it was on (dubApi.mjs STAGES, 1-based; the voices' check is part of
// making them): what it was doing, the button that goes on from there, and
// the way round when it stops again. The person cannot read the job's log.
const STOPPED_AT = {
  1: () => t("It stopped while separating the audio. Press Resume to go on from where it stopped. If it stops again, you can try the Perso API."),
  2: () => t("It stopped while transcribing. Press Resume to go on from where it stopped. If it stops again, you can try the Perso API."),
  3: () => t("It stopped while translating. Press Resume to go on from where it stopped. If it stops again, you can try the Perso API."),
  4: () => t("It stopped while making the voices. Press Resume to go on from where it stopped. If it stops again, you can try the Perso API."),
  5: () => t("It stopped while making the voices. Press Resume to go on from where it stopped. If it stops again, you can try the Perso API."),
  6: () => t("It stopped while making the video. Press Resume to go on from where it stopped. If it stops again, you can try the Perso API."),
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
// `choose`: ChatGPT stopped the dubbing at translation, so the popup also
// offers the translators that could carry on (translatorChoice.mjs) -- the
// app never switches by itself (owner, 2026-10-03).
// The words are getters, so they are read in the language of the moment. A
// `choose` popup's message is a function: it names the button to press once
// that is dealt with (Resume, or Translate again), and the other translators
// when there are some to offer.
// "1 min" for a whole number of minutes, "90 s" otherwise: a plan's limit.
function limitText(seconds) {
  return seconds % 60 === 0 ? t("{n} min", { n: seconds / 60 }) : t("{n} s", { n: seconds });
}

const CREDIT_MODALS = {
  perso_credit_exhausted: {
    get title() { return t("Out of credits"); },
    get message() { return t("Recharge, then try again."); },
    get button() { return t("Recharge"); },
  },
  // Perso refused the video as longer than the plan allows (F4008). The one
  // who meets it is almost always on the free plan, so the button is the
  // public plan page, and the limit is the one Perso named.
  perso_duration_limit: {
    get title() { return t("Video too long"); },
    message: (notice) => (notice && notice.limit_seconds
      ? t("Your Perso plan dubs videos up to {limit}. Upgrade your plan, or set Choose a model to Local model.",
        { limit: limitText(notice.limit_seconds) })
      : t("Your Perso plan does not take a video this long. Upgrade your plan, or set Choose a model to Local model.")),
    get button() { return t("See plans"); },
  },
  // A voice model the plan does not cover (VT40314: FINCH and NIGHTINGALE
  // need Pro). It came as a 403 and read as a wrong key until 2026-10-19.
  perso_plan_required: {
    get title() { return t("Higher plan needed"); },
    get message() { return t("This dubbing model needs a higher Perso plan. Upgrade your plan, or choose another dubbing model."); },
    get button() { return t("See plans"); },
  },
  perso_invalid_key: {
    get title() { return t("Check your Perso key"); },
    get message() { return t("Perso rejected the key."); },
    get button() { return t("Open Settings"); },
    action: "settings",  // in-app action instead of an external link
  },
  perso_unavailable: {
    get title() { return t("Perso server busy"); },
    get message() { return t("Try again in a few minutes."); },
    button: null,
  },
  gemini_quota_exhausted: {
    get title() { return t("Gemini quota used up"); },
    get message() { return t("Upgrade, or try again after the daily reset."); },
    get button() { return t("Upgrade"); },
  },
  chatgpt_signed_out: {
    get title() { return t("Sign in with ChatGPT"); },
    message: (button, canSwitch) => (canSwitch
      ? t("Sign in from Settings, then {button}, or pick another translator.", { button })
      : t("Sign in from Settings, then {button}.", { button })),
    get button() { return t("Open Settings"); },
    action: "settings",
    choose: true,
  },
  chatgpt_limit: {
    get title() { return t("ChatGPT usage limit"); },
    message: (button, canSwitch) => (canSwitch
      ? t("Wait for it to reset, then {button}, or pick another translator.", { button })
      : t("Wait for it to reset, then {button}.", { button })),
    button: null,
    choose: true,
  },
  gemini_unavailable: {
    get title() { return t("Google server busy"); },
    get message() { return t("Try again in a few minutes."); },
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
 * @param {() => Promise<boolean>} deps.askCancel  put the "Stop dubbing?"
 *        question to the user and resolve with their answer. The page's own
 *        dialog, not window.confirm(): that one freezes every event in the
 *        Electron shell while it is up, and Chromium writes its buttons in the
 *        machine's language, so an English question came with Korean answers
 * @param {() => void} deps.onOpenSettings  open the Settings sheet, for the
 *        popup's in-app button ("Open Settings")
 * @param {(job: object) => string} [deps.jobNote]  what this dub was started
 *        with, on one line: the two languages and the engines
 * @param {(job: object) => Promise<{id: string, label: string}[]>} [deps.translatorChoices]
 *        the translators a job ChatGPT stopped could carry on with, one button
 *        each (translatorChoice.mjs, fed by the page's fetches)
 * @param {(jobId: string, translator: string) => void} [deps.onResumeWith]
 *        resume the job with the translator the user picked
 * @param {(anchor: any, url: string) => void} deps.openExternal  arm the popup's
 *        Recharge button to open somewhere outside the app. The page keeps the
 *        anchor's own target="_blank" behaviour by setting its href; passing it
 *        in is what lets a test see which link the user was offered, and what
 *        would let the desktop shell open it its own way later.
 * @returns the operations the rest of the page calls.
 */
export function initRunningScreenUi({ $, parseProgress, trimLabel, homeNoticeAndLog,
                                      getJobId, getJobStatus, onCancel, askCancel,
                                      onOpenSettings, openExternal,
                                      jobNote = () => "",
                                      translatorChoices = async () => [],
                                      onResumeWith = () => {} }) {
  // Every element this file names is required markup (index.html always has
  // it), so nothing here null-checks what $ returns -- same as
  // ui/src/settingsDialog.mjs. A missing id is a broken page.
  const shownFor = new Set();   // jobs whose popup has already been seen
  let modalAction = null;       // "settings" while the open popup's button is an in-app action
  let modalJob = null;          // the job the open popup's translator buttons resume
  let modalPick = null;         // or, from Translate again, what a translator button does instead
  let modalShown = 0;           // which popup the translators being fetched are for

  // The job's own video in the center panel, and under it which part of it is
  // being dubbed. A job that stopped shows the same two (paintStopped).
  function paintOriginal(job, progress) {
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
  }

  // The original plus the progress card, redrawn on every poll.
  // NO time estimate, ever: the four stages take wildly different times on
  // different machines, so any "about N minutes left" we showed would be a
  // promise we break.
  function paintRunning(job) {
    const progress = parseProgress(job.logs);
    // A job that failed took the raw log onto the failure card with it. This
    // job's log has to be readable here, under this job's steps.
    homeNoticeAndLog();
    paintOriginal(job, progress);

    const note = jobNote(job);
    $("runNote").textContent = note;
    $("runNote").hidden = !note;

    paintProgress(progress);
  }

  function paintProgress(progress) {
    $("progressTitle").textContent = t(progress.label);
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
        ? ` <span class="step-note">· ${t("voice {done} of {total}", { done: Math.min(progress.voiceDone, progress.voiceTotal), total: progress.voiceTotal })}</span>`
        : "";
      const mark = stepState === "done" ? CHECK_ICON : "";
      // "step-done", not the bare "done": .done is the finished screen's own
      // layout class, and a step wearing it turned into a column -- tick above
      // the name instead of beside it.
      const cls = stepState === "done" ? "step-done" : stepState;
      return `<li class="${cls}"><span class="step-mark ${cls}">${mark}</span>${escapeHtml(t(name))}${note}</li>`;
    }).join("");
  }

  // A job that failed or was cancelled: the failure card is the page's, and the
  // video beside it is this file's.
  function paintStopped(job) {
    paintOriginal(job, parseProgress(job.logs));
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
    // A plain sentence only: what a program said when it broke is in Raw log
    // (the page's renderLog puts it there), not on the screen. The engine's
    // sentence in the page's language when it sent one (error_shown, a
    // notice's message_shown); error and message stay English for the
    // desktop app and the failure reports.
    // A failure the engine sent with its cause apart (error_detail: "Reason:
    // no reply", "Perso said: ... (code)") is its own sentence through and
    // through, so it is shown whole, advice and all, and the cause goes under
    // it -- plainFailure cut such a sentence at its first colon.
    const said = n && (n.message_shown || n.message);
    const detail = failed ? (job.error_detail || "") : "";
    const message = failed
      ? (ERROR_SENTENCES[job.error] || (detail && job.error_shown)
         || plainFailure(job.error_shown || job.error) || said || failedAt(job))
      : said;
    const linkText = n && CREDIT_MODALS[n.type] ? CREDIT_MODALS[n.type].button : t("Recharge");
    const html = ((n && n.link && linkText)
      ? `${escapeHtml(message)} <a href="${escapeHtml(n.link)}" target="_blank" rel="noopener">${linkText}</a>`
      : escapeHtml(message || ""))
      + (detail ? `<span class="notice-detail">${escapeHtml(detail)}</span>` : "");
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

  // The sentence for a failure that has none of its own: the stage it stopped
  // on and the button to press. A Perso API dub has no Resume (the page hides
  // it), so it says Start over; so does one that stopped before any stage.
  function failedAt(job) {
    const progress = parseProgress(job.logs);
    if (!progress.stage) {
      return t("It stopped while getting the dubbing ready. Press Start over. If it stops again, quit and reopen PersoDub, then try again.");
    }
    if (job.dub_mode === "perso") return t("It stopped while dubbing with the Perso API. Press Start over.");
    return (STOPPED_AT[progress.raw] || STOPPED_AT[4])();
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
    showCreditModal(n, job);
  }

  // The popup's line. A ChatGPT limit that named its reset time says it, and
  // once there are translators to offer, the line says they are there.
  // Opened by Translate again, the button to press later is that one.
  function creditMessage(notice, cfg, canSwitch) {
    if (!cfg.choose) return typeof cfg.message === "function" ? cfg.message(notice) : cfg.message;
    const button = modalPick ? t("Translate again") : t("Resume");
    const resets = resetsSentence(notice.message);
    if (!resets) return cfg.message(button, canSwitch);
    return canSwitch ? t("{resets} {button} then, or pick another translator.", { resets, button })
      : t("{resets} {button} then.", { resets, button });
  }

  // `onPick`: the script pane's Translate again (ChatGPT stopped it), whose
  // translator buttons translate those lines again rather than resume a dubbing.
  function showCreditModal(notice, job = null, onPick = null) {
    const cfg = CREDIT_MODALS[notice.type];
    const shown = ++modalShown;
    modalPick = onPick;
    $("creditTitle").textContent = cfg.title;
    $("creditMessage").textContent = creditMessage(notice, cfg, false);
    modalAction = cfg.action || null;
    modalJob = job;
    const btn = $("creditRechargeBtn");
    const show = cfg.button && (notice.link || cfg.action);
    btn.style.display = show ? "" : "none";
    if (show) { btn.textContent = cfg.button; openExternal(btn, notice.link || "#"); }
    const box = $("creditChoices");
    box.hidden = true;
    box.innerHTML = "";
    if (cfg.choose && job) {
      // Asked now, not at page load: a download or a key saved since counts.
      Promise.resolve(translatorChoices(job)).then((choices) => {
        if (shown !== modalShown || !choices.length) return;
        $("creditMessage").textContent = creditMessage(notice, cfg, true);
        box.innerHTML = choices.map((c) => '<button class="btn btn-secondary" type="button" '
          + `data-translator="${escapeHtml(c.id)}">${escapeHtml(c.label)}</button>`).join("");
        box.hidden = false;
      }).catch(() => {});
    }
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
  // A translator button: Resume with it. Not downloaded yet, the resume's
  // answer opens the download dialog (the page's onResumeWith).
  $("creditChoices").addEventListener("click", (e) => {
    const translator = e.target && e.target.dataset && e.target.dataset.translator;
    if (!translator || !modalJob) return;
    hideCreditModal();
    if (modalPick) modalPick(translator);
    else onResumeWith(modalJob.id, translator);
  });

  function paintCancel() {
    const btn = $("cancelBtn");
    const status = getJobStatus();
    btn.hidden = !["running", "cancelling", "queued"].includes(status);
    btn.disabled = status === "cancelling";
    // The label element, not the button: the word is written many times over
    // a job's life, and the button is where any other child would live.
    ($("cancelLabel") || btn).textContent = status === "cancelling" ? t("Stopping…") : t("Stop");
  }

  $("cancelBtn").addEventListener("click", async () => {
    const jobId = getJobId();
    if (!jobId) return;
    if (!(await askCancel())) return;
    $("cancelBtn").disabled = true;
    ($("cancelLabel") || $("cancelBtn")).textContent = t("Stopping…");
    try {
      await onCancel(jobId);
    } catch (e) {
      // The job may already have finished between the confirm dialog and this
      // call (backend returns 409) -- not fatal, the next poll shows the truth.
      // Anything else is a stop that did not happen, and says so.
      if (!e || e.status !== 409) showNoticeError(t("Could not stop the dubbing. Try again."));
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

  // A dubbing that has just been started, before its first answer: the card
  // still held the last dubbing's percent, steps, video and note, and showed
  // them as this one's until the server was heard from.
  function starting() {
    reset();
    paintProgress(parseProgress([]));
    $("runNote").hidden = true;
    $("runningTrim").textContent = "";
    $("runningVideo").removeAttribute("src");
    $("runningVideo").load();
  }

  // A resumed job keeps its id: its popups may be shown again.
  function forgetPopups(jobId) { shownFor.delete(jobId); }

  return { paintRunning, paintStopped, paintNotices, showCreditModal, hideCreditModal,
           showNoticeError, paintCancel, reset, starting, forgetPopups };
}
