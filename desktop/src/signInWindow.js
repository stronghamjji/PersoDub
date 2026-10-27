import { openExternally } from "./windowFactory.js";

// The sign-in is one window on Perso's page. Perso's pages stay in it; Google and Microsoft go to the computer's
// browser, at Perso's start for them with the return address (handOffUrl).
// Three rules keep the way back: a Perso sign-in/sign-up page without the return address gets it (wayBackUrl);
// a window left elsewhere on Perso while signed in goes back to the start address once (landedOnPerso);
// after a browser hand-off, Continue runs Perso's Google or Microsoft start again (auth.js showLogin).
// Sign-out clears the window's cookies. The key page always opens in a window of the same partition, with the app's tokens.

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
// `utm` is the app's utm tail ("utm_source=...&utm_content=sign_in"): its parameters go on the page's own
// address when it has none, so Perso's web analytics see the visit as the desktop app's.
export function wayBackUrl(to, start, utm = "") {
  const u = parsed(to);
  if (!u || !persoPage(u) || !SIGN_PAGE.test(u.pathname) || hasWayBack(u)) return null;
  u.searchParams.set("continue", start);
  u.searchParams.set("callbackUrl", start);
  for (const [k, v] of new URLSearchParams(utm)) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
  return u.href;
}

// Perso's sign-in or sign-up page that already has its way back but not the app's utm tail: the same
// address with the tail, else null. Perso's own redirect from the authorize address arrives this way.
export function taggedPageUrl(to, utm) {
  const u = parsed(to);
  if (!utm || !u || !persoPage(u) || !SIGN_PAGE.test(u.pathname) || u.searchParams.has("utm_source")) return null;
  for (const [k, v] of new URLSearchParams(utm)) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
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

// createAuth's makeSignInWindow: navigation(to) answers allow, browser, hand-off (the browser opens handOffAddress(to), then it closes) or deny; show() reloads `url`, not after a hand-off.
export function signInWindowFactory({ BrowserWindow, shell, parent = () => null, title = "PersoDub" }) {
  return ({ url, navigation, handOffAddress, utm = "", onClosed, onFailed, onHandOff }) => {
    const win = persoWindow({ BrowserWindow, shell, parent, title, width: WIDTH, height: HEIGHT });
    const wc = win.webContents;
    let handedOff = false; // the sign-in goes on in the computer's browser
    let cameBack = false; // the window has gone back to `url` by itself after a landing
    const handOff = (to) => {
      if (handedOff) return;
      handedOff = true;
      openExternally(shell, handOffAddress(to));
      onHandOff(to);
      // After the navigation's event: Electron is still in that navigation.
      setImmediate(() => { if (!win.isDestroyed()) win.destroy(); });
    };
    const load = (to) => { if (!win.isDestroyed()) win.loadURL(to).catch(() => { /* did-fail-load has said it */ }); };
    // Likewise after the navigation's event.
    const loadAfter = (to) => setImmediate(() => load(to));
    const guard = (e, to) => {
      const where = navigation(to);
      const back = where === "allow" ? (wayBackUrl(to, url, utm) || taggedPageUrl(to, utm)) : null;
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
      const back = wayBackUrl(to, url, utm) || taggedPageUrl(to, utm);
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

// The app's tokens (auth.js sessionCookies) as Perso's session cookies; one that cannot be set is left out.
async function setSessionCookies(jar, tokens) {
  for (const name of SESSION_COOKIES) {
    if (!tokens[name]) continue;
    try {
      await jar.set({ url: "https://perso.ai/", name, value: tokens[name], domain: ".perso.ai", path: "/", secure: true, sameSite: "lax" });
    } catch { /* the page then asks for the account */ }
  }
}

// Calls that make nothing: OPTIONS is the browser's own check before the real call.
const READS = new Set(["GET", "HEAD", "OPTIONS"]);

// main.js's key window on the sign-in's cookies: open(url, cookies) sets the app's tokens there first, then shows `url`;
// Perso's https pages stay in it, the rest go to the browser. close() closes it, if it is open. onKeyMade() is called
// once Perso's page has made a key: a call other than a read to an api-key address of api.perso.ai, answered without
// an error. The exact address is not known; a call taken for one costs one more look at the account's key.
export function keyWindowFactory({ BrowserWindow, shell, parent = () => null, title = "PersoDub", onKeyMade = () => {} }) {
  let win = null;
  const stay = (e, to) => {
    const u = parsed(to);
    if (u && persoSite(u)) return;
    e.preventDefault();
    openExternally(shell, to);
  };
  const keyCall = (d) => { if (!READS.has(d.method) && /api-key/i.test(d.url) && d.statusCode < 400) onKeyMade(); };
  return {
    async open(url, cookies) {
      if (!win || win.isDestroyed()) {
        win = persoWindow({ BrowserWindow, shell, parent, title, width: 1000, height: 760 });
        win.webContents.on("will-navigate", stay);
        win.webContents.on("will-redirect", stay);
        // A session has one such listener: a new window's takes the place of the last one's.
        win.webContents.session.webRequest.onCompleted({ urls: ["https://api.perso.ai/*"] }, keyCall);
      }
      if (cookies?.accessToken) await setSessionCookies(win.webContents.session.cookies, cookies);
      if (win.isDestroyed()) return;
      win.loadURL(url).catch(() => { /* the window shows the error */ });
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    },
    close() { if (win && !win.isDestroyed()) win.destroy(); },
  };
}

// Everything the sign-in window kept, Perso's cookie first, gone: the next sign-in asks for the account again.
export async function clearSignInStorage(session) {
  const kept = session.fromPartition(SIGN_IN_PARTITION);
  await kept.clearStorageData();
  await kept.clearCache();
}
