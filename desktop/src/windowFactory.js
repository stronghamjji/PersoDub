import { join } from "node:path";
import { zoomResetter } from "./zoomReset.js";
import { useLanguage } from "./i18n.js";

// Outbound links (the credit popup's Recharge button, Settings' "get a key") belong in
// the user's own browser. Only http(s) is handed to the OS, so a page can never make
// us open file:// or a custom scheme.
export function openExternally(shell, url) {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
}

/**
 * The app's one window, with the guards every page in it lives under.
 * `ctx.updateState`, `ctx.engines` and `ctx.kitDir` are read as each page
 * loads or navigates, since none of them exists yet when the window is made.
 */
export function createWindow({ app, BrowserWindow, screen, shell, ctx, appDir, repo, locale, platform = process.platform }) {
  // The finished screen is a table beside a video with a strip under both, and
  // it needs 1280 to show the table's full set of columns. Clamped to the screen
  // the window opens on, so a small laptop gets a window that fits it rather
  // than one hanging off the bottom. The floor is the narrowest window the
  // screens are still whole at. Nothing remembers a size between launches, so
  // this is what every launch opens at.
  const room = screen.getPrimaryDisplay().workAreaSize;
  // Packaged builds carry build/icon.icns / icon.ico; a dev run (npm start)
  // would otherwise show Electron's own icon in the dock and the taskbar.
  if (!app.isPackaged && platform === "darwin" && app.dock) {
    try { app.dock.setIcon(join(appDir, "build", "icon.png")); } catch { /* cosmetic */ }
  }
  const win = new BrowserWindow({
    icon: join(appDir, "build", "icon.png"),
    // What the frame is painted with before the first page arrives. The app is
    // dark (0.5.5), and Electron's default white flashed on every launch.
    backgroundColor: "#0e131b",
    // Windows and Linux hang Electron's stock File/Edit/View menu bar inside the
    // window, in English whatever the app's language. Hidden; Alt shows it. The
    // Mac menu bar is the system's and stays.
    autoHideMenuBar: true,
    // Windows hung its white system title bar over the dark app, with the app's
    // own 36px bar right under it (W26, 2026-10-14). There the system bar is
    // hidden and the window's three buttons are drawn over the page's bar in
    // the desk's colours (static/css/app.css --desk, --foreground), the bar's
    // height; the page marks its bar as what the window is moved by (the
    // data-platform below).
    ...(platform === "win32"
      ? { titleBarStyle: "hidden", titleBarOverlay: { color: "#0e131b", symbolColor: "#eaf0fd", height: 36 } }
      : {}),
    // The Mac's system bar goes too, so both systems show one 36px bar
    // (2026-10-21): the three lights sit in the page's bar, which starts
    // after them (static/css/app.css). trafficLightPosition is where their
    // 16px-tall row starts, so y = (36 - 16) / 2 = 10 centres them in it,
    // and x = 12 matches the bar's own 12px left edge.
    ...(platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 12, y: (36 - 16) / 2 } }
      : {}),
    width: Math.min(1280, room.width),
    height: Math.min(800, room.height),
    minWidth: Math.min(960, room.width),
    minHeight: Math.min(640, room.height),
    webPreferences: {
      preload: join(appDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // The repository ("owner/repo") the build's edition points at, for the
      // page's GitHub links; preload.cjs reads it back as persodubShell.repo.
      // And the computer's language ("ko" or "en", src/i18n.js), which the
      // page reads as persodubShell.locale for a language setting of Auto.
      // And which system this is ("win32", "darwin"), which preload.cjs stamps
      // on the page as data-platform: the stylesheet draws Windows' scrollbars
      // itself and leaves the Mac's to the system, and makes its top bar what
      // the window is moved by on both.
      additionalArguments: [`--persodub-repo=${repo}`, `--persodub-locale=${locale}`, `--persodub-platform=${platform}`],
    },
  });
  // Every page load -- the app page arriving after boot, or a reload mid
  // download -- gets the update's current state again; announcements sent to
  // the loading screen would otherwise be the last the app page never hears.
  // ...and starts at 100% zoom, whatever an earlier launch was left on.
  const resetZoom = zoomResetter();
  win.webContents.on("did-finish-load", () => {
    resetZoom(win.webContents);
    // The page starts again when Settings saves a language; the shell's own
    // words (its dialogs, the update window) follow at the same moment by
    // reading kit.env again. Before this they changed at the next launch
    // only, and an app set to English kept asking in Korean (owner, 0.8.1).
    if (ctx.kitDir) useLanguage({ kitDir: ctx.kitDir });
    if (ctx.updateState && !win.isDestroyed()) win.webContents.send("shell:update-state", ctx.updateState);
  });
  // This window has no chrome -- no address bar, no Back -- so letting a page open
  // here strands the user with only force-quit to get out. Two routes lead out, and
  // both are closed: target=_blank / window.open goes through setWindowOpenHandler, a
  // same-window navigation through will-navigate. Both hand the link to
  // openExternally above.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(shell, url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    // The app's own pages (the local backend, the bundled screens/) must still
    // navigate. Compare parsed origins, not string prefixes: with a prefix
    // check, "http://127.0.0.1:5001@evil.com" (real host evil.com) passed.
    if (url === win.webContents.getURL()) return;
    const here = ctx.engines?.url;
    try {
      if (url.startsWith("file://") || (here && new URL(url).origin === new URL(here).origin)) return;
    } catch { /* unparseable URL: treat as external */ }
    e.preventDefault();
    openExternally(shell, url);
  });
  return win;
}
