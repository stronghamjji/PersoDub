// Customer support in the production edition (ui/src/edition.mjs): a Service
// inquiry form like Perso's own -- the kind, a subject, the details and an
// address to answer -- and Send opens the mail app on it, with the app's
// version and the computer added (owner, 2026-10-27). The open-source
// edition's Send feedback opens the repository's issues instead
// (ui/src/homeSidebar.mjs).
//
// Owns #feedbackOverlay, #feedbackType, #feedbackSubjectInput,
// #feedbackDetails, #feedbackReplyTo, #feedbackClose and #feedbackSend.
import { feedbackBody, feedbackMailto, feedbackSubject } from "./edition.mjs";

/**
 * @param {object} deps
 * @param {(id: string) => any} deps.$
 * @param {string} deps.to                 the address the build was made with
 * @param {() => string} deps.version      read at Send: the version has loaded by then
 * @param {string} deps.system             the computer, "macOS 15.1.0"
 * @param {(url: string) => void} deps.openUrl
 * @returns {() => void} opens the form
 */
export function initFeedbackSheet({ $, to, version, system, openUrl }) {
  const type = $("feedbackType"), subject = $("feedbackSubjectInput"), details = $("feedbackDetails"), replyTo = $("feedbackReplyTo");
  // Subject and Details are required: Send waits for both.
  const ready = () => { $("feedbackSend").disabled = !subject.value.trim() || !details.value.trim(); };
  subject.addEventListener("input", ready);
  details.addEventListener("input", ready);
  // Close keeps what was typed for the next time it opens.
  const close = () => $("feedbackOverlay").classList.remove("open");
  $("feedbackClose").addEventListener("click", close);
  $("feedbackSend").addEventListener("click", () => {
    const v = version();
    openUrl(feedbackMailto(to, feedbackSubject(v, type.value, subject.value.trim()),
      feedbackBody({ details: details.value.trim(), type: type.value, replyTo: replyTo.value.trim(), version: v, system })));
    // Sent: the next inquiry starts empty.
    type.selectedIndex = 0;
    subject.value = details.value = replyTo.value = "";
    ready();
    close();
  });
  return function openFeedback() {
    ready();
    $("feedbackOverlay").classList.add("open");
    subject.focus();
  };
}
