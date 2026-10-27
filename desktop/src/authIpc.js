import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTH_FILE, authConfig, createAuth, tokenStore } from "./auth.js";
import { eventsUserId } from "./events.js";
import { openExternally } from "./windowFactory.js";

// The wiring of src/auth.js into the app: the controller and the page's channels.

/** The sign-in controller, made before the app is ready; it reads nothing
 * until start(). On for the production build only: never from the edition a
 * kit remembers in kit.env (edition.js), which an open-source app updated
 * from a 0.8.4 or 0.8.5 production install still says is production, and
 * which only a dub's default follows. `focus` brings the app's window forward
 * when the sign-in window comes back; `makeSignInWindow` opens that window
 * and `clearSignInSession` wipes its cookies (signInWindow.js). Every change of the sign-in sets ctx.userId, so the next
 * batch of button events carries the account, hashed, or nothing;
 * `onSignOut` runs at every sign-out, and `track` records the sign-in's
 * steps (auth.js createAuth). */
/** The app's logo as a data: URL for the sign-in's way-back page, or "" without one. */
export function logoDataUrl(path) {
  try { return `data:image/png;base64,${readFileSync(path).toString("base64")}`; } catch { return ""; }
}

export function createShellAuth({ app, safeStorage, net, shell, ctx, edition, shellLog, makeSignInWindow, clearSignInSession, focus = () => {}, onSignOut = () => {},
                                 appName = "PersoDub", logoPath = "", env = process.env, track = () => {} }) {
  const auth = createAuth({
    enabled: edition === "production",
    cfg: authConfig(env, app.getVersion()),
    store: tokenStore(join(app.getPath("userData"), AUTH_FILE), safeStorage),
    fetchFn: (url, opts) => net.fetch(url, opts), // the system's proxy and certificates, as the update check
    makeSignInWindow,
    clearSignInSession,
    openExternal: (url) => openExternally(shell, url),
    kitDir: () => ctx.kitDir,
    log: shellLog,
    onCallback: focus,
    onSignOut,
    track,
    appName,
    logo: logoPath ? logoDataUrl(logoPath) : "",
    onChange: () => {
      ctx.userId = eventsUserId(auth.signedInAccount()?.id);
      const { win } = ctx;
      if (!win || win.isDestroyed()) return;
      void auth.status().then((s) => win.webContents.send("shell:auth-state", s));
    },
  });
  return auth;
}

/** The key window's onKeyMade (signInWindow.js): the account's key looked up at once, and the window closed once it
 * is saved. One look at a time; a key made during one is left to the page's next look. */
export function keyMadeCheck({ auth, closeKeyWindow }) {
  let checking = false;
  return async () => {
    if (checking) return;
    checking = true;
    try {
      const r = await auth.connectKey();
      if (r.key === "saved") closeKeyWindow();
    } finally { checking = false; }
  };
}

/** The page's channels. Answered in both editions; a disabled sign-in says
 * "disabled" and does nothing. `openKeyWindow` opens the key page in the key window, signed in with the
 * session's own tokens (signInWindow.js); opening it is a step (`track`). `closeKeyWindow` closes it once
 * a key is saved, by Check again or the page's quiet look, and at sign-out. */
export function registerAuthIpc({ ipcMain, auth, openKeyWindow, closeKeyWindow, track = () => {} }) {
  ipcMain.handle("shell:auth-status", () => auth.status());
  ipcMain.handle("shell:auth-login", () => auth.login());
  ipcMain.handle("shell:auth-cancel", () => auth.cancelLogin());
  ipcMain.handle("shell:auth-show", () => auth.showLogin());
  ipcMain.handle("shell:auth-logout", () => {
    closeKeyWindow();
    return auth.logout();
  });
  ipcMain.handle("shell:auth-check-key", async () => {
    const r = await auth.connectKey();
    if (r.key === "saved") closeKeyWindow();
    return r;
  });
  ipcMain.handle("shell:auth-open-key-page", async () => {
    if (!auth.enabled) return undefined;
    track("key_page_opened", {});
    return openKeyWindow(auth.keyPageUrl, await auth.sessionCookies());
  });
}
