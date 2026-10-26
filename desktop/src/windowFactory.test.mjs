// Run with: node --test desktop/src/windowFactory.test.mjs
// BrowserWindow, the screen and the system browser are stand-ins.
import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createWindow, openExternally } from "./windowFactory.js";
import { currentLanguage, useLanguage } from "./i18n.js";

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), "..");

function setup({ workArea = { width: 1440, height: 900 }, ctx = {}, platform = "darwin", edition } = {}) {
  const opened = [];
  const on = {};
  class BrowserWindow {
    constructor(options) {
      this.options = options;
      this.url = "";
      this.zooms = [];
      this.sent = [];
      this.webContents = {
        on: (event, fn) => { on[event] = fn; },
        send: (channel, value) => this.sent.push([channel, value]),
        setWindowOpenHandler: (fn) => { on.windowOpen = fn; },
        getURL: () => this.url,
        setZoomLevel: (z) => this.zooms.push(z),
      };
    }
    isDestroyed() { return false; }
    on(event, fn) { on[`win:${event}`] = fn; }
  }
  const win = createWindow({
    app: { isPackaged: true }, BrowserWindow, ctx, appDir: "/app", repo: "owner/PersoDub", locale: "ko", platform,
    edition,
    screen: { getPrimaryDisplay: () => ({ workAreaSize: workArea }) },
    shell: { openExternal: (url) => opened.push(url) },
  });
  // true when the window was kept from going to `url`
  const blocked = (url) => {
    let prevented = false;
    on["will-navigate"]({ preventDefault: () => { prevented = true; } }, url);
    return prevented;
  };
  return { win, on, opened, blocked };
}

test("the window opens at 1280 by 800, or at the screen's size when that is smaller", () => {
  const big = setup().win.options;
  assert.deepEqual([big.width, big.height, big.minWidth, big.minHeight], [1280, 800, 960, 640]);
  assert.equal(big.autoHideMenuBar, true, "no English File/Edit/View bar on Windows");
  const small = setup({ workArea: { width: 1100, height: 600 } }).win.options;
  assert.deepEqual([small.width, small.height, small.minWidth, small.minHeight], [1100, 600, 960, 600]);
  assert.deepEqual(big.webPreferences, { preload: join("/app", "preload.cjs"), contextIsolation: true, nodeIntegration: false,
    // The page's GitHub links follow the build's edition (preload.cjs repo).
    // ...and Auto's language follows the computer's (preload.cjs locale).
    // ...and the page is told which system it is on (preload.cjs platform).
    // ...and its edition (preload.cjs edition), and the name it shows (preload.cjs name).
    additionalArguments: ["--persodub-repo=owner/PersoDub", "--persodub-locale=ko", "--persodub-platform=darwin",
      "--persodub-edition=opensource", "--persodub-name=PersoDub"] });
  assert.equal(big.title, undefined, "the open-source window takes each page's title");
});

test("the production window is PersoDubbing whatever its page is called, and tells the page its edition and name", () => {
  const { win, on } = setup({ edition: "production", platform: "win32" });
  assert.equal(win.options.title, "PersoDubbing");
  let kept = false;
  on["win:page-title-updated"]({ preventDefault: () => { kept = true; } });
  assert.ok(kept, "a page's own title does not replace it");
  const args = win.options.webPreferences.additionalArguments;
  assert.ok(args.includes("--persodub-edition=production"));
  assert.ok(args.includes("--persodub-name=PersoDubbing"));
});

// Windows hung its white system title bar over the dark app, with the app's own
// 36px bar right under it (W26, 2026-10-14). There the system bar is hidden and
// the window's three buttons are drawn over the page's bar in the app's colours.
// The Mac's system bar went too (2026-10-21): its lights sit in the page's 36px
// bar, centred in its height. Linux keeps the system's.
test("Windows draws its buttons over the page's bar, the Mac's lights sit centred in it, Linux keeps the system's", () => {
  const win = setup({ platform: "win32" }).win.options;
  assert.equal(win.titleBarStyle, "hidden");
  assert.deepEqual(win.titleBarOverlay, { color: "#0e131b", symbolColor: "#eaf0fd", height: 36 });
  assert.equal(win.trafficLightPosition, undefined);
  assert.ok(win.webPreferences.additionalArguments.includes("--persodub-platform=win32"));
  const mac = setup({ platform: "darwin" }).win.options;
  assert.equal(mac.titleBarStyle, "hiddenInset");
  assert.deepEqual(mac.trafficLightPosition, { x: 12, y: 10 });
  assert.equal(mac.titleBarOverlay, undefined);
  assert.ok(mac.webPreferences.additionalArguments.includes("--persodub-platform=darwin"));
  const linux = setup({ platform: "linux" }).win.options;
  assert.equal(linux.titleBarStyle, undefined);
  assert.equal(linux.trafficLightPosition, undefined);
});

// With the system bar gone on Windows and the Mac, the page has to say what the
// window is moved by. The app's page marks its top bar (static/css/app.css, by the
// data-platform the preload stamps on the page); the bundled screens, which
// have no bar, take a strip along their top edge.
test("the preload stamps the system on the page, and the bundled screens can be dragged by their top edge", () => {
  const preload = readFileSync(join(DESKTOP, "preload.cjs"), "utf8");
  assert.match(preload, /const PLATFORM_ARG = "--persodub-platform=";/);
  assert.match(preload, /document\.documentElement\.dataset\.platform = platform;/);
  // ...and the edition, for the production edition's palette and type.
  assert.match(preload, /if \(edition\) document\.documentElement\.dataset\.edition = edition;/);
  for (const name of ["loading", "installing", "not-installed", "error"]) {
    const html = readFileSync(join(DESKTOP, "screens", `${name}.html`), "utf8");
    assert.match(html, /\.drag \{ position: fixed; top: 0; left: 0; right: 0; height: 36px; -webkit-app-region: drag; \}/, name);
    assert.match(html, /<div class="drag"><\/div>/, name);
  }
});

test("each page load starts at 100% once per place, and hears the update's state again", () => {
  const ctx = { updateState: null };
  const { win, on } = setup({ ctx });
  win.url = "file:///app/screens/loading.html";
  on["did-finish-load"]();
  assert.deepEqual(win.zooms, [0]);
  assert.deepEqual(win.sent, [], "no update known yet");
  ctx.updateState = { version: "0.7.2", phase: "downloading", pct: 10 };
  win.url = "http://127.0.0.1:5001/";
  on["did-finish-load"]();
  on["did-finish-load"]();   // the same page again: the zoom the person chose stays
  assert.deepEqual(win.zooms, [0, 0]);
  assert.deepEqual(win.sent, [["shell:update-state", ctx.updateState], ["shell:update-state", ctx.updateState]]);
});

test("a page never opens a window of its own; an http(s) link goes to the user's browser instead", () => {
  const { on, opened } = setup();
  for (const url of ["https://perso.ai/pricing", "http://example.com/", "file:///etc/hosts", "persodub://x"]) {
    assert.deepEqual(on.windowOpen({ url }), { action: "deny" });
  }
  assert.deepEqual(opened, ["https://perso.ai/pricing", "http://example.com/"]);
});

test("the window moves only between the app's own pages; anything else goes to the browser", () => {
  const ctx = { engines: null };
  const { win, opened, blocked } = setup({ ctx });
  // Before the engines are up, only the bundled screens are the app's own.
  assert.equal(blocked("http://127.0.0.1:5001/"), true);
  ctx.engines = { url: "http://127.0.0.1:5001" };
  win.url = "http://127.0.0.1:5001/";
  assert.equal(blocked("http://127.0.0.1:5001/"), false, "the same page");
  assert.equal(blocked("http://127.0.0.1:5001/?project=1"), false, "the app's own origin");
  assert.equal(blocked("file:///app/screens/error.html"), false, "a bundled screen");
  assert.equal(blocked("http://127.0.0.1:5001@evil.com/"), true, "another host behind the app's address");
  assert.equal(blocked("https://example.com/"), true);
  assert.equal(blocked("not a url"), true);
  assert.deepEqual(opened, ["http://127.0.0.1:5001/", "http://127.0.0.1:5001@evil.com/", "https://example.com/"]);
});

test("only http(s) is ever handed to the system", () => {
  const opened = [];
  for (const url of ["https://a.example/", "HTTP://b.example/", "mailto:team@example.com?subject=x", "file:///x", "ftp://c.example/", "javascript:alert(1)"]) {
    openExternally({ openExternal: (u) => opened.push(u) }, url);
  }
  assert.deepEqual(opened, ["https://a.example/", "HTTP://b.example/"]);
});

test("each page load reads the language off kit.env again, so a language saved in Settings reaches the shell's dialogs at once", () => {
  const kitDir = mkdtempSync(join(tmpdir(), "persodub-lang-"));
  writeFileSync(join(kitDir, "kit.env"), "PERSODUB_LANG=ko\n");
  useLanguage({ osLocale: "en-US", kitDir });
  assert.equal(currentLanguage(), "ko");
  const { on } = setup({ ctx: { kitDir } });
  writeFileSync(join(kitDir, "kit.env"), "PERSODUB_LANG=en\n");   // Settings saved English; the page starts again
  on["did-finish-load"]();
  assert.equal(currentLanguage(), "en");
  writeFileSync(join(kitDir, "kit.env"), "PERSODUB_LANG=auto\n");
  on["did-finish-load"]();
  assert.equal(currentLanguage(), "en", "auto on an English computer");
  // No kit known yet (the loading screen before boot): nothing to read, nothing changes.
  useLanguage({ kitDir });
  setup({ ctx: {} }).on["did-finish-load"]();
  assert.equal(currentLanguage(), "en");
});
