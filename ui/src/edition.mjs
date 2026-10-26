// Which edition the page is in (desktop/src/edition.js), as the shell's
// preload says (persodubShell.edition). The production edition, the
// company's build, is Perso_DesktopApp: no GitHub anywhere, Perso's own page
// for its downloads and guide, and Customer support as an inquiry form sent
// to our relay. A plain browser has no shell and is the open-source page.
export const DESKTOP_APP_URL = "https://perso.ai/dubbing/desktop-app";

const shellOf = () => globalThis.window?.persodubShell;

/** A link into Perso with the app's utm tail (GET /api/settings perso_utm)
    and the pressed button as utm_content, so Perso's web analytics say which
    button of which app and version brought the visit. No tail yet: the bare link. */
export function persoLink(url, content, utm) {
  if (!utm) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${utm}&utm_content=${encodeURIComponent(content)}`;
}

/** True in the production edition's app. */
export function isProduction(shell = shellOf()) {
  return shell?.edition === "production";
}

/** The app's name as the window and About show it. */
export function productName(shell = shellOf()) {
  return isProduction(shell) ? "Perso_DesktopApp" : "PersoDub";
}
