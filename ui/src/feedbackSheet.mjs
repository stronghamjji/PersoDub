// Customer support in the production edition (ui/src/edition.mjs): a Service
// inquiry form like Perso's own -- the kind, a subject, the details and an
// address to answer -- and Send hands it to the shell, which sends it to the
// support web app with the app's version and this computer, a bug report with
// the app's masked logs (desktop/src/reporting.js sendInquiry). No mail app:
// a computer without a mail account left the person with nothing (owner,
// 2026-10-27).
// The open-source edition's Send feedback opens the repository's issues
// instead (ui/src/homeSidebar.mjs).
//
// Owns #feedbackOverlay, #feedbackType, #feedbackSubjectInput,
// #feedbackDetails, #feedbackReplyTo, #feedbackReplyToHint, #feedbackLogsNote, #feedbackConsent,
// #feedbackPrivacy, #feedbackStatus, #feedbackClose and #feedbackSend.
import { t } from "./i18n.mjs";
import { record as recordStep } from "./events.mjs";

// Perso's privacy policy, in Korean and in English.
export const PRIVACY_URL = {
  ko: "https://info.perso.ai/policy-perso-saas/policy/privacy-policy/docs/260619.html",
  en: "https://info.perso.ai/policy-perso-saas/policy/privacy-policy-en/docs/260619.html",
};

/**
 * @param {object} deps
 * @param {(id: string) => any} deps.$
 * @param {(form: object) => Promise<{id?: string, queued?: boolean, needReplyTo?: boolean} | null>} deps.send  persodubShell.sendInquiry
 * @param {() => string} deps.language     the page's language, "ko" or "en"
 * @param {() => string} deps.account      the signed-in account's line (ui/src/signIn.mjs status):
 *        its e-mail, or its name when it has none
 * @param {(url: string) => void} deps.openUrl
 * @returns {() => void} opens the form
 */
export function initFeedbackSheet({ $, send, language, openUrl, account, record = recordStep }) {
  const type = $("feedbackType"), subject = $("feedbackSubjectInput"), details = $("feedbackDetails"),
        consent = $("feedbackConsent"), status = $("feedbackStatus");
  // Optional: left empty, the answer goes to the signed-in account's address,
  // which the shell adds itself (desktop/src/reporting.js accountForInquiry).
  // An account with no e-mail has none: then the shell answers needReplyTo.
  const replyTo = $("feedbackReplyTo");
  let sending = false;
  // Subject, Details and the consent are required: Send waits for all three.
  const ready = () => {
    $("feedbackSend").disabled = sending || !subject.value.trim() || !details.value.trim() || !consent.checked;
  };
  subject.addEventListener("input", ready);
  details.addEventListener("input", ready);
  consent.addEventListener("change", ready);
  // A bug report says it carries the logs.
  const logsNote = () => { $("feedbackLogsNote").hidden = type.value !== "bug"; };
  type.addEventListener("change", logsNote);
  $("feedbackPrivacy").addEventListener("click", (e) => {
    e.preventDefault();
    openUrl(PRIVACY_URL[language()] || PRIVACY_URL.en);
  });
  // Close keeps what was typed for the next time it opens.
  const close = () => $("feedbackOverlay").classList.remove("open");
  $("feedbackClose").addEventListener("click", close);
  $("feedbackSend").addEventListener("click", async () => {
    sending = true;
    ready();
    let answer = null;
    try {
      answer = await send({ type: type.value, subject: subject.value.trim(), details: details.value.trim(),
                            replyTo: replyTo.value.trim(), locale: language() });
    } catch { answer = null; }
    sending = false;
    // Landed, or kept by the shell for the next launch: either way it is on
    // its way, and the next inquiry starts empty. One the shell could not
    // even keep stays in the form, to be sent again.
    // A step in the charts: its kind and whether it went now, never what it says.
    if (answer && (answer.id || answer.queued)) record("inquiry_sent", { kind: type.value, queued: !answer.id });
    else record("inquiry_failed", { reason: answer && answer.needReplyTo ? "need_reply_to" : "failed" });
    if (answer && (answer.id || answer.queued)) {
      status.textContent = answer.id
        ? t("Received. Reference {id}", { id: answer.id })
        : t("Could not send it now. It is saved and goes the next time the app opens.");
      type.selectedIndex = 0;
      subject.value = details.value = replyTo.value = "";
      consent.checked = false;
      logsNote();
    } else if (answer && answer.needReplyTo) {
      // Nothing was sent: the form stays as it is, waiting for the address.
      status.textContent = t("Add an email so we can answer.");
      replyTo.focus();
    } else {
      status.textContent = t("Could not send it. Try again in a moment.");
    }
    ready();
  });
  return function openFeedback() {
    status.textContent = "";
    // The line under Reply-to promises the account's address: only an account that has one.
    $("feedbackReplyToHint").hidden = !String(account() || "").includes("@");
    logsNote();
    ready();
    $("feedbackOverlay").classList.add("open");
    subject.focus();
  };
}
