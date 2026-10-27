import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTH_FILE, authConfig, createAuth, tokenStore } from "./auth.js";
import { eventsUserId } from "./events.js";

// The wiring of src/auth.js into the app: the controller and the page's channels.

/** The sign-in controller, made before the app is ready; it reads nothing
 * until start(). On for the production build only: never from the edition a
 * kit remembers in kit.env (edition.js), which an open-source app updated
 * from a 0.8.4 or 0.8.5 production install still says is production, and
 * which only a dub's default follows. `focus` brings the app's window forward
 * when the sign-in window comes back; `makeSignInWindow` opens that window
 * and `clearSignInSession` wipes its cookies (signInWindow.js). Every change of the sign-in sets ctx.userId, so the next
 * batch of button events carries the account, hashed, or nothing;
 * `onSignOut` runs at every sign-out (auth.js createAuth). */
/** The app's logo as a data: URL for the sign-in's way-back page, or "" without one. */
export function logoDataUrl(path) {
  try { return `data:image/png;base64,${readFileSync(path).toString("base64")}`; } catch { return ""; }
}

export function createShellAuth({ app, safeStorage, net, ctx, edition, shellLog, makeSignInWindow, clearSignInSession, focus = () => {}, onSignOut = () => {},
                                 appName = "PersoDub", logoPath = "", env = process.env }) {
  const auth = createAuth({
    enabled: edition === "production",
    cfg: authConfig(env, app.getVersion()),
    store: tokenStore(join(app.getPath("userData"), AUTH_FILE), safeStorage),
    fetchFn: (url, opts) => net.fetch(url, opts), // the system's proxy and certificates, as the update check
    makeSignInWindow,
    clearSignInSession,
    kitDir: () => ctx.kitDir,
    log: shellLog,
    onCallback: focus,
    onSignOut,
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

/** The page's channels. Answered in both editions; a disabled sign-in says
 * "disabled" and does nothing. */
export function registerAuthIpc({ ipcMain, shell, auth }) {
  ipcMain.handle("shell:auth-status", () => auth.status());
  ipcMain.handle("shell:auth-login", () => auth.login());
  ipcMain.handle("shell:auth-cancel", () => auth.cancelLogin());
  ipcMain.handle("shell:auth-show", () => auth.showLogin());
  ipcMain.handle("shell:auth-logout", () => auth.logout());
  ipcMain.handle("shell:auth-check-key", () => auth.connectKey());
  ipcMain.handle("shell:auth-open-key-page", () => (auth.enabled ? shell.openExternal(auth.keyPageUrl) : undefined));
}
