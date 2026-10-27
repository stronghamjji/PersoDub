import { openExternally } from "./windowFactory.js";

// The Perso sign-in's own window (src/auth.js login): Perso's sign-in page in
// a window of the app's, with cookies of its own, apart from the computer's
// browser and from the app's page. Perso keeps a person signed in by a cookie
// and cannot be asked for the password again, so a sign-in in the computer's
// browser went straight through after the app signed out; this window's
// cookies go at every sign-out instead (clearSignInStorage). No preload, no
// Node, sandboxed: the page in it is Perso's, and it reaches nothing of the app.
//
// Over the app's window but not modal: the app's Cancel and Open again stay
// pressable, and the window keeps its own close button on a Mac, where a modal
// one is a sheet without one.

export const SIGN_IN_PARTITION = "persist:perso-sign-in";
const WIDTH = 520;
const HEIGHT = 720;
// net::ERR_ABORTED: a load stopped on purpose, by the rule below or by the next load.
const ABORTED = -3;

/** createAuth's makeSignInWindow: a window over `parent()` on `url`, going
 * only where `navigation(url)` answers "allow" ("browser" opens the address
 * in the computer's browser instead). onClosed is called once when the window
 * goes, however it goes; onFailed when its page does not load. */
export function signInWindowFactory({ BrowserWindow, shell, parent = () => null, title = "PersoDub" }) {
  return ({ url, navigation, onClosed, onFailed }) => {
    const over = parent();
    const p = over && !over.isDestroyed() ? over.getBounds() : null;
    const win = new BrowserWindow({
      title, width: WIDTH, height: HEIGHT,
      ...(p ? { parent: over, x: Math.round(p.x + (p.width - WIDTH) / 2), y: Math.max(p.y, Math.round(p.y + (p.height - HEIGHT) / 2)) } : {}),
      autoHideMenuBar: true,
      webPreferences: { partition: SIGN_IN_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const wc = win.webContents;
    // Camera, microphone, notifications: nothing a sign-in needs.
    wc.session.setPermissionRequestHandler((_wc, _permission, answer) => answer(false));
    win.on("page-title-updated", (e) => e.preventDefault());
    const guard = (e, to) => {
      const where = navigation(to);
      if (where === "allow") return;
      e.preventDefault();
      if (where === "browser") openExternally(shell, to);
    };
    wc.on("will-navigate", guard);
    wc.on("will-redirect", guard);
    wc.setWindowOpenHandler(({ url: to }) => {
      openExternally(shell, to);
      return { action: "deny" };
    });
    // A page that asks to stay (beforeunload) cannot keep the window from closing.
    wc.on("will-prevent-unload", (e) => e.preventDefault());
    wc.on("before-input-event", (e, input) => {
      if (input.type !== "keyDown" || input.key !== "Escape") return;
      e.preventDefault();
      win.destroy();
    });
    wc.on("did-fail-load", (_e, code, _text, _url, mainFrame) => { if (mainFrame && code !== ABORTED) onFailed(); });
    win.on("closed", () => onClosed());
    win.loadURL(url).catch(() => { /* did-fail-load has said it */ });
    return {
      show() {
        if (win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      },
      close() { if (!win.isDestroyed()) win.destroy(); },
    };
  };
}
