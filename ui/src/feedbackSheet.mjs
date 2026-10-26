// Customer support in the production edition (ui/src/edition.mjs): a Service
// inquiry form like Perso's own -- the kind, a subject, the details and an
// address to answer -- and Send hands it to the shell, which sends it to our
// relay with the app's version and this computer, a bug report with the app's
// masked logs (desktop/src/reporting.js sendInquiry). No mail app: a computer
// without a mail account left the person with nothing (owner, 2026-10-27).
// The open-source edition's Send feedback opens the repository's issues
// instead (ui/src/homeSidebar.mjs).
//
// Owns #feedbackOverlay, #feedbackType, #feedbackSubjectInput,
// #feedbackDetails, #feedbackReplyTo, #feedbackLogsNote, #feedbackConsent,
// #feedbackPrivacy, #feedbackStatus, #feedbackClose and #feedbackSend.
import { t } from "./i18n.mjs";

// Perso's privacy policy, in Korean and in English.
export const PRIVACY_URL = {
  ko: "https://info.perso.ai/policy-perso-saas/policy/privacy-policy/docs/260619.html",
  en: "https://info.perso.ai/policy-perso-saas/policy/privacy-policy-en/docs/260619.html",
};

/**
 * @param {object} deps
 * @param {(id: string) => any} deps.$
 * @param {(form: object) => Promise<{id?: string, queued?: boolean} | null>} deps.send  persodubShell.sendInquiry
 * @param {() => string} deps.language     the page's language, "ko" or "en"
 * @param {(url: string) => void} deps.openUrl
 * @returns {() => void} opens the form
 */
export function initFeedbackSheet({ $, send, language, openUrl }) {
  const type = $("feedbackType"), subject = $("feedbackSubjectInput"), details = $("feedbackDetails"),
        consent = $("feedbackConsent"), status = $("feedbackStatus");
  // Optional. Once the production edition signs in, the account's address fills it here.
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
    if (answer && (answer.id || answer.queued)) {
      status.textContent = answer.id
        ? t("Received. Reference {id}", { id: answer.id.slice(0, 8).toUpperCase() })
        : t("Could not send it now. It is saved and goes the next time the app opens.");
      type.selectedIndex = 0;
      subject.value = details.value = replyTo.value = "";
      consent.checked = false;
      logsNote();
    } else {
      status.textContent = t("Could not send it. Try again in a moment.");
    }
    ready();
  });
  return function openFeedback() {
    status.textContent = "";
    logsNote();
    ready();
    $("feedbackOverlay").classList.add("open");
    subject.focus();
  };
}
