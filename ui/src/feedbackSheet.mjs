// Send feedback in the production edition (ui/src/edition.mjs): a small sheet
// says what the mail will carry, and Write mail opens the mail app on it
// (prod-feedback mockup, owner, 2026-10-26). The open-source edition's Send
// feedback opens the repository's issues instead (ui/src/homeSidebar.mjs).
//
// Owns #feedbackOverlay, #feedbackTo, #feedbackSubject, #feedbackClose and
// #feedbackWrite.
import { t } from "./i18n.mjs";
import { feedbackMailto } from "./edition.mjs";

/**
 * @param {object} deps
 * @param {(id: string) => any} deps.$
 * @param {string} deps.to                 the address the build was made with
 * @param {() => string} deps.subject      read as the sheet opens: the version has loaded by then
 * @param {(url: string) => void} deps.openUrl
 * @returns {() => void} opens the sheet
 */
export function initFeedbackSheet({ $, to, subject, openUrl }) {
  let shown = "";
  const close = () => $("feedbackOverlay").classList.remove("open");
  $("feedbackClose").addEventListener("click", close);
  $("feedbackWrite").addEventListener("click", () => {
    openUrl(feedbackMailto(to, shown));
    close();
  });
  return function openFeedback() {
    shown = subject();
    $("feedbackTo").textContent = t("To: {address}", { address: to });
    $("feedbackSubject").textContent = t("Subject: {subject}", { subject: shown });
    $("feedbackOverlay").classList.add("open");
  };
}
