import { openExternally } from "./windowFactory.js";

// The Perso sign-in's own window (src/auth.js login): Perso's sign-in page in
// a window of the app's, with cookies of its own, apart from the computer's
// browser and from the app's page. Perso keeps a person signed in by a cookie
// and cannot be asked for the password again, so a sign-in in the computer's
// browser went straight through after the app signed out; this window's
// cookies go at every sign-out instead (clearSignInStorage below). No
// preload, no Node, sandboxed: the page in it is Perso's, and it reaches
// nothing of the app. Google and Microsoft, which refuse a window like this,
// take the whole sign-in to the computer's browser (auth.js signInNavigation).
//
// Over the app's window but not modal: the app's Cancel and Open again stay
// pressable, and the window keeps its own close button on a Mac, where a modal
// one is a sheet without one.

export const SIGN_IN_PARTITION = "persist:perso-sign-in";
const WIDTH = 520;
const HEIGHT = 720;
// net::ERR_ABORTED: a load stopped on purpose, by the rule below or by the next load.
const ABORTED = -3;

// Perso's sign-in and sign-up pages: /login, /ko/join, /es-mx/login.
const SIGN_PAGE = /^\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?(login|join)\/?$/;
// Perso's session cookies, on .perso.ai.
const SESSION_COOKIES = ["accessToken", "refreshToken"];

const parsed = (url) => { try { return new URL(url); } catch { return null; } };
const persoSite = (u) => u.protocol === "https:" && (u.hostname === "perso.ai" || u.hostname.endsWith(".perso.ai"));
// Perso's site, except its sign-in server api.perso.ai.
const persoPage = (u) => persoSite(u) && u.hostname !== "api.perso.ai";
// Perso's pages go on to continue, or else callbackUrl, after a sign-in or a sign-up.
const hasWayBack = (u) => Boolean(u.searchParams.get("continue") || u.searchParams.get("callbackUrl"));

// `to` with continue and callbackUrl set to `start` when it is Perso's sign-in or sign-up page without a way back, else null.
export function wayBackUrl(to, start) {
  const u = parsed(to);
  if (!u || !persoPage(u) || !SIGN_PAGE.test(u.pathname) || hasWayBack(u)) return null;
  u.searchParams.set("continue", start);
  u.searchParams.set("callbackUrl", start);
  return u.href;
}

// Where a sign-in or sign-up that lost its way back ends: Perso's other pages, without a way back.
export function landedOnPerso(url) {
  const u = parsed(url);
  return Boolean(u && persoPage(u) && !SIGN_PAGE.test(u.pathname) && !hasWayBack(u));
}

// `to` with callbackUrl=`start` added when it has none, as text: Perso's redirect_uri keeps nested & unencoded.
export function handOffUrl(to, start) {
  if (/[?&]callbackUrl=/.test(to)) return to;
  return `${to}${to.includes("?") ? "&" : "?"}callbackUrl=${encodeURIComponent(start)}`;
}

// A window over `parent()` on the sign-in's cookies: sandboxed, no permissions, Esc closes it, new windows go to the browser.
function persoWindow({ BrowserWindow, shell, parent, title, width, height }) {
  const over = parent();
  const p = over && !over.isDestroyed() ? over.getBounds() : null;
  const win = new BrowserWindow({
    title, width, height,
    ...(p ? { parent: over, x: Math.round(p.x + (p.width - width) / 2), y: Math.max(p.y, Math.round(p.y + (p.height - height) / 2)) } : {}),
    autoHideMenuBar: true,
    webPreferences: { partition: SIGN_IN_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const wc = win.webContents;
  wc.session.setPermissionRequestHandler((_wc, _permission, answer) => answer(false));
  win.on("page-title-updated", (e) => e.preventDefault());
  wc.setWindowOpenHandler(({ url }) => {
    openExternally(shell, url);
    return { action: "deny" };
  });
  // A page that asks to stay (beforeunload) cannot keep the window from closing.
  wc.on("will-prevent-unload", (e) => e.preventDefault());
  wc.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown" || input.key !== "Escape") return;
    e.preventDefault();
    win.destroy();
  });
  return win;
}

/** createAuth's makeSignInWindow: Perso's sign-in on `url` in a window over `parent()`.
 * navigation(to) answers "allow" (the window goes), "browser" (the computer's browser opens `to`),
 * "hand-off" (the browser opens handOffUrl(to, url) and the window closes) or "deny".
 * show() opens `url` again in the window; after a hand-off it does nothing. */
export function signInWindowFactory({ BrowserWindow, shell, parent = () => null, title = "PersoDub" }) {
  return ({ url, navigation, onClosed, onFailed, onHandOff }) => {
    const win = persoWindow({ BrowserWindow, shell, parent, title, width: WIDTH, height: HEIGHT });
    const wc = win.webContents;
    let handedOff = false; // the sign-in goes on in the computer's browser
    let cameBack = false; // the window has gone back to `url` by itself after a landing
    const handOff = (to) => {
      if (handedOff) return;
      handedOff = true;
      openExternally(shell, handOffUrl(to, url));
      onHandOff(to);
      // After the navigation's event: Electron is still in that navigation.
      setImmediate(() => { if (!win.isDestroyed()) win.destroy(); });
    };
    const load = (to) => { if (!win.isDestroyed()) win.loadURL(to).catch(() => { /* did-fail-load has said it */ }); };
    // Likewise after the navigation's event.
    const loadAfter = (to) => setImmediate(() => load(to));
    const guard = (e, to) => {
      const where = navigation(to);
      const back = where === "allow" ? wayBackUrl(to, url) : null;
      if (where === "allow" && !back) return;
      e.preventDefault();
      if (back) loadAfter(back);
      else if (where === "hand-off") handOff(to);
      else if (where === "browser") openExternally(shell, to);
    };
    wc.on("will-navigate", guard);
    wc.on("will-redirect", guard);
    // Signed in on Perso: `url` again, which Perso answers with the code; once, so it cannot loop.
    const comeBack = async () => {
      try {
        const cookies = await wc.session.cookies.get({ domain: "perso.ai" });
        if (cameBack || !cookies.some((c) => SESSION_COOKIES.includes(c.name))) return;
        cameBack = true;
        load(url);
      } catch { /* the window has gone or its cookies cannot be read: it stays */ }
    };
    // Perso's links between its sign-in and sign-up pages change the page in place, without will-navigate.
    const arrived = (to) => {
      const back = wayBackUrl(to, url);
      if (back) loadAfter(back);
      else if (landedOnPerso(to)) comeBack();
    };
    wc.on("did-navigate", (_e, to) => arrived(to));
    wc.on("did-navigate-in-page", (_e, to, mainFrame) => { if (mainFrame) arrived(to); });
    wc.on("did-fail-load", (_e, code, _text, _url, mainFrame) => { if (mainFrame && code !== ABORTED) onFailed(); });
    win.on("closed", () => onClosed());
    win.loadURL(url).catch(() => { /* did-fail-load has said it */ });
    return {
      show() {
        if (handedOff || win.isDestroyed()) return;
        // From the start: Perso's sign-in page, or, signed in, the code at once.
        load(url);
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      },
      close() { if (!win.isDestroyed()) win.destroy(); },
    };
  };
}

/** main.js's openKeyWindow(url): one window over `parent()` on the sign-in's cookies, so Perso's pages
 * in it are the account signed in there. Perso's https pages stay in it; anything else opens in the browser. */
export function keyWindowFactory({ BrowserWindow, shell, parent = () => null, title = "PersoDub" }) {
  let win = null;
  const stay = (e, to) => {
    const u = parsed(to);
    if (u && persoSite(u)) return;
    e.preventDefault();
    openExternally(shell, to);
  };
  return (url) => {
    if (!win || win.isDestroyed()) {
      win = persoWindow({ BrowserWindow, shell, parent, title, width: 1000, height: 760 });
      win.webContents.on("will-navigate", stay);
      win.webContents.on("will-redirect", stay);
    }
    win.loadURL(url).catch(() => { /* the window shows the error */ });
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };
}

/** Everything the sign-in window kept, Perso's cookie first, gone: the next
 * sign-in asks for the account again. */
export async function clearSignInStorage(session) {
  const kept = session.fromPartition(SIGN_IN_PARTITION);
  await kept.clearStorageData();
  await kept.clearCache();
}
