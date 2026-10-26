import { join } from "node:path";
import { AUTH_FILE, authConfig, createAuth, tokenStore } from "./auth.js";
import { kitEdition } from "./edition.js";

// The wiring of src/auth.js into the app: the controller and the page's channels.

/** The sign-in controller, made before the app is ready; it reads nothing
 * until start(). On for the production edition: the kit's own edition once
 * the boot has found the kit (edition.js, kept in kit.env across updates),
 * this build's edition before that. `focus` brings the window forward when
 * the browser comes back. */
export function createShellAuth({ app, shell, safeStorage, net, ctx, edition, shellLog, focus = () => {}, env = process.env }) {
  const auth = createAuth({
    enabled: () => (kitEdition(ctx.kitDir) || edition) === "production",
    cfg: authConfig(env),
    store: tokenStore(join(app.getPath("userData"), AUTH_FILE), safeStorage),
    fetchFn: (url, opts) => net.fetch(url, opts), // the system's proxy and certificates, as the update check
    openExternal: (url) => shell.openExternal(url),
    kitDir: () => ctx.kitDir,
    log: shellLog,
    onCallback: focus,
    onChange: () => {
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
  ipcMain.handle("shell:auth-logout", () => auth.logout());
  ipcMain.handle("shell:auth-check-key", () => auth.connectKey());
  ipcMain.handle("shell:auth-open-key-page", () => (auth.enabled ? shell.openExternal(auth.keyPageUrl) : undefined));
}
