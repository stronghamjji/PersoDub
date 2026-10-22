// The page's three small confirms: "Stop dubbing?" (or separating, or
// erasing), "Delete this project?" (or draft, or a base program in Settings >
// Models), and the full disk. Each is the
// app's own dialog rather than window.confirm(), which freezes every event in
// the Electron shell while it is up and writes its buttons in the machine's
// own language. Lifted out of the page's script unchanged (2026-10-10).
//
// The elements this file touches: #cancelDubOverlay (#cancelDubTitle,
// #cancelDubCloseX, #cancelDubKeepBtn, #cancelDubConfirmBtn), #deleteOverlay
// (#deleteTitle, #deleteMessage, #deleteError, #deleteCloseX, #deleteCancelBtn,
// #deleteConfirmBtn) and #spaceOverlay (#spaceMessage, #spaceCloseX,
// #spaceCloseBtn).
import { clearDraft, getDraft } from "./draft.mjs";
import { errorText } from "./format.mjs";
import { deleteLine, projectLanguages } from "./languageRow.mjs";
import { t } from "./i18n.mjs";

/**
 * @param {object} deps
 * @param {(id: string) => any} deps.$   the page's getElementById helper
 * @param {{jobId: string|null}} deps.state  the page's app state: the job on screen
 * @param {(downloadId: string) => void} deps.forgetDraft  let go of a kept draft
 * @param {() => void} deps.resetForNewJob  leave the open job for Home
 * @param {() => string|null} deps.getLastJobId  the job behind the top bar's
 *        forward arrow, read when a delete lands
 * @param {() => void} deps.forgetLastJob  that arrow has nowhere to go any more
 * @param {{renderHistory: () => Promise<void>}} deps.projects  the Projects list
 * @returns {{ askCancelDub: (question?: string) => Promise<boolean>,
 *   askDelete: (job: object, members?: object[]) => void,
 *   askToDelete: (q: {title: string, line: string}) => Promise<boolean>,
 *   showIfOutOfSpace: (e: any) => boolean }}
 *   askCancelDub answers yes or no; askDelete asks about a project (every
 *   language in `members`) or a kept draft (`job.draftId`, and `job.onGone`
 *   told once it is deleted) and deletes it on yes; askToDelete asks the
 *   same dialog about anything else and answers yes or no;
 *   showIfOutOfSpace shows the full-disk dialog when `e` says so, and
 *   answers whether it did.
 */
export function initConfirmDialogs({ $, state, forgetDraft, resetForNewJob, getLastJobId, forgetLastJob,
                                     projects }) {
  // Stopping a dub is asked in a dialog of the app's own, for the same reasons
  // deleting is: window.confirm() freezes every event in the Electron shell
  // until it is dismissed, and Chromium writes its buttons in the machine's own
  // language -- an English question with Korean answers (Windows, 2026-09-10).
  // A promise, because both callers only want the yes or no: the running
  // screen's Cancel and a queued row's X.
  let answerCancelDub = null;

  function askCancelDub(question = t("Stop dubbing?")) {
    // Asked twice over is one dialog: whoever asked first gets a No, so no
    // caller is left waiting on a promise that never settles.
    if (answerCancelDub) answerCancelDub(false);
    $("cancelDubTitle").textContent = question;
    $("cancelDubOverlay").classList.add("open");
    $("cancelDubConfirmBtn").focus();
    return new Promise((resolve) => { answerCancelDub = resolve; });
  }

  function closeCancelDub(answer) {
    $("cancelDubOverlay").classList.remove("open");
    const done = answerCancelDub;
    answerCancelDub = null;
    if (done) done(answer);
  }
  $("cancelDubCloseX").addEventListener("click", () => closeCancelDub(false));
  $("cancelDubKeepBtn").addEventListener("click", () => closeCancelDub(false));
  $("cancelDubConfirmBtn").addEventListener("click", () => closeCancelDub(true));
  // Backdrop and Escape both mean "no", the way they do on the delete dialog:
  // backing out is the reflex in front of a question like this, and the stopping
  // is the deliberate act.
  $("cancelDubOverlay").addEventListener("click", (e) => {
    if (e.target === $("cancelDubOverlay")) closeCancelDub(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("cancelDubOverlay").classList.contains("open")) closeCancelDub(false);
  });

  // Deleting a project's folder cannot be undone, so it is asked in a dialog of
  // the app's own -- window.confirm() freezes every event in the Electron shell
  // until it is dismissed.
  let pendingDelete = null;
  // The same dialog asked about something that is not a project (a base
  // program in Settings > Models): whoever asked waits for the answer.
  let answerDelete = null;

  function askToDelete({ title, line }) {
    closeDelete();
    $("deleteTitle").textContent = title;
    $("deleteMessage").textContent = line;
    $("deleteError").textContent = "";
    $("deleteOverlay").classList.add("open");
    return new Promise((resolve) => { answerDelete = resolve; });
  }

  // A project is every language of its video (`members`, ui/src/languageRow.mjs):
  // they all go, and the second line says how many when there is more than one.
  function askDelete(job, members = [job]) {
    closeDelete();
    pendingDelete = { ...job, members };
    $("deleteTitle").textContent = job.draftId ? t("Delete this draft?") : t("Delete this project?");
    $("deleteMessage").textContent = deleteLine(job.draftId ? 1 : projectLanguages(members).length);
    $("deleteError").textContent = "";
    $("deleteOverlay").classList.add("open");
  }

  function closeDelete() {
    $("deleteOverlay").classList.remove("open");
    pendingDelete = null;
    // Closed without Delete is a no.
    const answer = answerDelete;
    answerDelete = null;
    if (answer) answer(false);
  }
  $("deleteCloseX").addEventListener("click", closeDelete);
  $("deleteCancelBtn").addEventListener("click", closeDelete);
  // Backdrop and Escape, the same way out the other dialogs give. Especially
  // Escape: backing out is the reflex in front of a destructive question, and
  // nothing is lost by leaving too easily -- the deleting is the deliberate act.
  $("deleteOverlay").addEventListener("click", (e) => {
    if (e.target === $("deleteOverlay")) closeDelete();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("deleteOverlay").classList.contains("open")) closeDelete();
  });
  $("deleteConfirmBtn").addEventListener("click", async () => {
    if (answerDelete) {
      const answer = answerDelete;
      answerDelete = null;
      $("deleteOverlay").classList.remove("open");
      answer(true);
      return;
    }
    const job = pendingDelete;
    if (!job) return;
    // A kept draft is only remembered here: forgetting it is the deleting.
    if (job.draftId) {
      forgetDraft(job.draftId);
      if ((getDraft() || {}).downloadId === job.draftId && !state.jobId) clearDraft();
      closeDelete();
      if (job.onGone) job.onGone();
      return;
    }
    const btn = $("deleteConfirmBtn");
    const ids = job.members.map((m) => m.id);
    // One language still running would leave the project half deleted.
    if (ids.length > 1 && job.members.some((m) => m.status === "running" || m.status === "cancelling")) {
      $("deleteError").textContent = t("A dubbing in this project is still running.");
      return;
    }
    btn.disabled = true;
    try {
      for (const id of ids) {
        const r = await fetch(`/api/dub/jobs/${id}/workspace`, { method: "DELETE" });
        if (!r.ok) throw new Error((await r.json()).detail || t("Could not delete this project"));
      }
      closeDelete();
      // The open screen would be showing files that are gone now -- and half a
      // reset is worse than none: the video src, the script rows and state.job
      // all went on pointing at a job that no longer exists. resetForNewJob()
      // clears every one of them and ends on the first screen.
      if (ids.includes(state.jobId)) resetForNewJob();
      // Deleted, so there is nothing behind the forward arrow any more -- whether
      // this job was the one on screen or one the user had already left.
      if (ids.includes(getLastJobId())) forgetLastJob();
      projects.renderHistory().catch(() => {});
    } catch (err) {
      $("deleteError").textContent = errorText(err);
      // Some languages may be gone already: the cards say which are left.
      if (ids.length > 1) projects.renderHistory().catch(() => {});
    } finally {
      btn.disabled = false;
    }
  });

  function showIfOutOfSpace(e) {
    const text = errorText(e);
    // The sentence itself is the server's, and it has been said in two languages
    // over this app's life, so both are matched: an out-of-space error that fell
    // through to the plain red line would tell the user to check a disk they
    // cannot see from here.
    if (!/disk space|not enough space|저장 공간/i.test(text)) return false;
    // The title says "Not enough space"; the line under it is only the numbers,
    // in either language (app/room.py's sentence, said in the user's).
    $("spaceMessage").textContent = text.replace(/^(Not enough (disk )?space[.:]|저장 공간이 부족해요\.)\s*/i, "");
    $("spaceOverlay").classList.add("open");
    return true;
  }

  $("spaceCloseX").addEventListener("click", () => $("spaceOverlay").classList.remove("open"));
  $("spaceCloseBtn").addEventListener("click", () => $("spaceOverlay").classList.remove("open"));

  return { askCancelDub, askDelete, askToDelete, showIfOutOfSpace };
}
