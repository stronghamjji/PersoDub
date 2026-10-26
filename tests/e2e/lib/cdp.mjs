// The app's page over the Chrome DevTools Protocol, for the end-to-end runs:
// one connection, and the few things a run does with it -- read the page,
// press a button the way a person does, pick a <select> option, hand a file
// to a file picker, take a screenshot, look a word up the way the page's own
// t() does. Node 22 or later (global WebSocket), nothing to install.
//
//   const app = await connect({ port: 9333, out: "<folder>" });
//   await app.click("#homeBtn"); await app.shot("01-home"); app.close();
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Thrown by a step this computer cannot run (not signed in, a model not
// installed): the report says skipped, with the reason, not failed.
export class Skip extends Error {}

// Page-side predicates, sent as source: they may use only their arguments and the page's globals.
export const shown = (s) => { const el = document.querySelector(s); return !!el && el.getClientRects().length > 0; };
export const pressable = (s) => { const el = document.querySelector(s); return !!el && el.getClientRects().length > 0 && !el.disabled; };
export const isOpen = (s) => document.querySelector(s).classList.contains("open");
export const isClosed = (s) => !document.querySelector(s).classList.contains("open");
export const onHome = () => document.body.dataset.screen === "home" && !document.querySelector("#screen-home").hidden;
export const textOf = (s) => (document.querySelector(s)?.textContent || "").replace(/\s+/g, " ").trim();

/** The page's words looked up the way its own t() does -- the English is the
 *  key -- with {app} the name the page shows the app by, unless given. */
export const translator = (words, appName) => (key, values = {}) => (Object.hasOwn(words, key) ? words[key] : key)
  .replace(/\{(\w+)\}/g, (_, k) => (k in values ? values[k] : k === "app" ? appName : `{${k}}`));

/** Whether `url` is the production edition's Help: Perso's desktop app page
 *  with the app's utm tail and utm_content=help (ui/src/app.mjs openHelp). */
export function isProductionHelp(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}` === "https://perso.ai/dubbing/desktop-app" && u.searchParams.has("utm_source")
      && u.searchParams.get("utm_content") === "help";
  } catch { return false; }
}

// What a person would hit at (x, y): a dialog or a toast over the button takes the click instead.
const HIT = function (x, y) {
  const hit = document.elementFromPoint(x, y);
  if (hit && (hit === this || this.contains(hit))) return "";
  return hit ? hit.tagName.toLowerCase() + (hit.id ? `#${hit.id}` : "") + [...hit.classList].map((c) => `.${c}`).join("") : "nothing";
}.toString();

/**
 * Open the app's page on the control port.
 *
 * @param {{port?: number|string, out?: string}} o  `out` is where shot() writes PNGs.
 */
export async function connect({ port = 9333, out = "." } = {}) {
  const START_IT = `start the app with --remote-debugging-port=${port}`;
  const targets = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5000) })
    .then((r) => r.json(), () => { throw new Error(`nothing answers on port ${port}; ${START_IT}`); });
  const target = targets.find((t) => t.type === "page" && t.url.startsWith("http://127.0.0.1:"));
  if (!target) throw new Error(`no app page on port ${port}; ${START_IT}`);
  const origin = new URL(target.url).origin;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error(`cannot open ${target.webSocketDebuggerUrl}`)); });
  let seq = 0;
  const pending = new Map();
  const handlers = new Map();
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (!m.id) { for (const fn of handlers.get(m.method) || []) fn(m.params); return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.no(new Error(`${p.method}: ${m.error.message}`)); else p.ok(m.result);
  };
  ws.onclose = () => { for (const p of pending.values()) p.no(new Error("the app closed its control port")); };

  // Every call has a limit: a page that stops answering ends the run instead of hanging it.
  function send(method, params = {}, ms = 30000) {
    return new Promise((ok, no) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); no(new Error(`${method}: no answer in ${ms / 1000} s`)); }, ms);
      pending.set(id, { method, ok: (v) => { clearTimeout(timer); ok(v); }, no: (e) => { clearTimeout(timer); no(e); } });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  function nextEvent(method, ms) {
    return new Promise((ok, no) => {
      const set = handlers.get(method) || new Set();
      handlers.set(method, set);
      const fn = (params) => { set.delete(fn); clearTimeout(timer); ok(params); };
      const timer = setTimeout(() => { set.delete(fn); no(new Error(`no ${method} in ${ms / 1000} s`)); }, ms);
      set.add(fn);
    });
  }
  async function js(expression) {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(`in the page: ${(r.exceptionDetails.exception?.description || r.exceptionDetails.text).split("\n")[0]}`);
    }
    return r.result.value;
  }
  // fn goes to the page as source, so it may use only its arguments and the page's globals.
  const inPage = (fn, ...args) => js(`(${fn})(...${JSON.stringify(args)})`);
  async function waitFor(what, ms, fn, ...args) {
    const end = Date.now() + ms;
    for (;;) {
      const v = await inPage(fn, ...args);
      if (v) return v;
      if (Date.now() > end) throw new Error(`waited ${ms / 1000} s for ${what}`);
      await sleep(250);
    }
  }
  async function api(path, init) {
    const r = await fetch(origin + path, { signal: AbortSignal.timeout(10000), ...init });
    if (!r.ok) throw new Error(`${init?.method || "GET"} ${path}: ${r.status}`);
    const type = r.headers.get("content-type") || "";
    return type.includes("json") ? r.json() : r;
  }
  // A press and a release at the middle of the element's box. No mouse move
  // first: on a window that another one covers, the page takes a move only
  // with its next frame, which does not come (5 s a move, measured 2026-10-21),
  // while a press and a release are taken at once.
  // True once the page draws a frame within 1.5 s; false when it is hidden.
  const frameSoon = () => inPage(() => new Promise((ok) => {
    const id = requestAnimationFrame(() => ok(true));
    setTimeout(() => { cancelAnimationFrame(id); ok(false); }, 1500);
  }));
  async function click(sel, ms = 10000) {
    await waitFor(`${sel} to be pressable`, ms, pressable, sel);
    const { result } = await send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(sel)})`, objectGroup: "e2e" });
    await send("DOM.scrollIntoViewIfNeeded", { objectId: result.objectId });
    const b = (await send("DOM.getBoxModel", { objectId: result.objectId })).model.border;
    const x = (b[0] + b[2] + b[4] + b[6]) / 4, y = (b[1] + b[3] + b[5] + b[7]) / 4;
    const over = (await send("Runtime.callFunctionOn", { objectId: result.objectId, functionDeclaration: HIT,
                                                         arguments: [{ value: x }, { value: y }], returnByValue: true })).result.value;
    if (over) throw new Error(`${sel} is covered by ${over}`);
    // Only while the page is on show: a window covered whole or minimised is
    // "hidden" to the browser, which then draws no frame and drops a press,
    // so nothing reached the page and the step waited for nothing (Mac,
    // 2026-10-26). Brought to the front once; still hidden, the run says so
    // instead of failing step after step. Then the pointer goes there first,
    // as a hand moves a mouse.
    if (!(await frameSoon())) {
      await send("Page.bringToFront", {});
      if (!(await frameSoon())) throw new Error("the app's window is hidden (covered or minimised), so a press would be dropped: keep it on show");
    }
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
    }
  }
  // A key the way a person types it: "Escape", "Enter", "ArrowDown"; letters go in as text.
  async function key(name) {
    const text = name.length === 1 ? name : undefined;
    for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: name, text, unmodifiedText: text });
  }
  async function type(sel, text) {
    await click(sel);
    await send("Input.insertText", { text });
    await inPage((s) => { const el = document.querySelector(s); el.dispatchEvent(new Event("input", { bubbles: true })); return true; }, sel);
  }
  // A <select> opens a native menu on macOS that CDP cannot press, so the
  // option is picked the way that menu leaves it: the value, then the input
  // and change events the page listens for. Nothing fires when it is on it already.
  async function choose(sel, value) {
    const ok = await inPage((s, v) => {
      const el = document.querySelector(s);
      if (!el || ![...el.options].some((o) => o.value === v)) return false;
      if (el.value !== v) {
        el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return true;
    }, sel, value);
    if (!ok) throw new Error(`${sel} has no option ${value}`);
  }
  // A block whose press opens the file picker: intercepted, the picker is not
  // drawn; the page names its file input instead, and the file goes into it.
  async function feed(sel, file) {
    await send("Page.setInterceptFileChooserDialog", { enabled: true });
    try {
      const chooser = nextEvent("Page.fileChooserOpened", 5000);
      chooser.catch(() => {});
      await click(sel);
      const { backendNodeId } = await chooser;
      await send("DOM.setFileInputFiles", { files: [file], backendNodeId });
    } finally {
      await send("Page.setInterceptFileChooserDialog", { enabled: false });
    }
  }
  async function shot(name) {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(out, `${name}.png`), Buffer.from(data, "base64"));
    return `${name}.png`;
  }
  // The addresses `presses` opened with window.open, caught in a list instead
  // of the system browser; window.open is put back however the presses end.
  async function opened(presses) {
    await js(`(() => { window.__e2eOpen = window.open; window.__e2eUrls = [];
      window.open = (u) => { window.__e2eUrls.push(String(u)); return null; }; return true; })()`);
    let urls = [];
    try { await presses(); } finally {
      urls = await js(`(() => { const u = window.__e2eUrls || []; if (window.__e2eOpen) window.open = window.__e2eOpen;
        delete window.__e2eOpen; delete window.__e2eUrls; return u; })()`);
    }
    return urls;
  }
  // What a failed step may leave open over the next step's buttons: the
  // ChatGPT sign-in, the Download dialog, the subtitle looks, the Help dialog,
  // the update window.
  // Each is closed the way a person closes it; returns the ones that were open.
  async function putAway() {
    const left = [];
    if (await inPage(isOpen, "#helpOverlay")) {
      left.push("#helpOverlay");
      await key("Escape");
      await waitFor("the Help dialog to close", 5000, isClosed, "#helpOverlay");
    }
    if (await inPage(isOpen, "#updateOverlay")) {
      left.push("#updateOverlay");
      await key("Escape");
      await waitFor("the update window to close", 5000, isClosed, "#updateOverlay");
    }
    if (await inPage(isOpen, "#chatgptSignInOverlay")) {
      left.push("#chatgptSignInOverlay");
      await click("#csCancel");
      await waitFor("the sign-in window to close", 5000, isClosed, "#chatgptSignInOverlay");
    }
    if (await inPage(isOpen, "#exportOverlay")) {
      left.push("#exportOverlay");
      await click("#exportCloseBtn", 120000);   // dim while a download is being saved
      await waitFor("the Download dialog to close", 5000, isClosed, "#exportOverlay");
    }
    if (await inPage(() => !document.querySelector("#videoStylePop").hidden)) {
      left.push("#videoStylePop");
      await key("Escape");
      await waitFor("the looks to close", 5000, () => document.querySelector("#videoStylePop").hidden);
    }
    return left;
  }
  // The first of the named areas that is on screen, trimmed, for a failed step's report.
  const snippet = (looks) => inPage((sels) => {
    const els = sels.map((s) => document.querySelector(s)).filter(Boolean);
    const el = els.find((e) => e.getClientRects().length > 0) || els[0];
    const html = el ? el.outerHTML.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ") : `(none of ${sels})`;
    return `screen=${document.body.dataset.screen} ${html.slice(0, 1500)}`;
  }, looks);

  await send("Page.enable");
  // The edition, as the preload stamps it on the page, and the name the page
  // calls the app: the production edition has no GitHub button, and its Help
  // opens Perso's desktop app page instead of the Help dialog.
  const page = await inPage(() => ({ lang: document.documentElement.lang || "en", width: innerWidth, height: innerHeight,
                                     visibility: document.visibilityState, screen: document.body.dataset.screen,
                                     edition: document.documentElement.dataset.edition || window.persodubShell?.edition || "opensource",
                                     name: window.persodubShell?.name || "PersoDub" }));
  const production = page.edition === "production";
  const words = page.lang === "en" ? {}
    : await (await fetch(`${origin}/i18n/ui.${page.lang}.json`, { signal: AbortSignal.timeout(10000) })).json();
  const tr = translator(words, page.name);

  return { origin, page, production, send, nextEvent, js, inPage, waitFor, api, click, key, type, choose, feed, shot, snippet, tr,
           opened, putAway, close: () => ws.close() };
}
