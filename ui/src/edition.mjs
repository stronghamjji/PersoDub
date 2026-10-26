// Which edition the page is in (desktop/src/edition.js), as the shell's
// preload says (persodubShell.edition). The production edition, the
// company's build, is Perso_DesktopApp: no GitHub anywhere, Perso's own page
// for its downloads and guide, and Send feedback as a mail to the address it
// was built with. A plain browser has no shell and is the open-source page.
export const DESKTOP_APP_URL = "https://perso.ai/dubbing/desktop-app";

const shellOf = () => globalThis.window?.persodubShell;

/** True in the production edition's app. */
export function isProduction(shell = shellOf()) {
  return shell?.edition === "production";
}

/** The app's name as the window and About show it. */
export function productName(shell = shellOf()) {
  return isProduction(shell) ? "Perso_DesktopApp" : "PersoDub";
}

/** The feedback mail's subject: the app, its version and the computer. */
export function feedbackSubject(version, system) {
  return `Perso_DesktopApp ${version} · ${system} · 의견/Feedback`;
}

/** The mailto: link that opens the mail app on that subject, with an empty body. */
export function feedbackMailto(to, subject) {
  return `mailto:${to}?subject=${encodeURIComponent(subject)}`;
}
