// The buttons pressed and the screens shown, for the product's charts. One
// listener on the document, held in memory and handed to the desktop shell
// every 30 seconds and as the page goes away; the shell adds the computer's
// facts and sends them (desktop/src/events.js), or keeps nothing when the
// Settings > Privacy switch is off -- and then this records nothing either.
//
// An event is {name, screen, t}. The name is the pressed element's id, or the
// English words the markup gave it (data-i18n), or "in_" and the id of the
// nearest element that has one -- never its text, its aria-label or a field's
// value: those hold project names, titles and links.
//
// A step of a person's way through the app (record: a video brought in, a
// dubbing started, a popup shown...) also has `props`, a few words, numbers
// and true-or-false values the app chose, never text; the relay keeps only
// the ones it lists for that step (relay/events-logic.js STEPS). A file
// picked or dropped is a step too, by its kind (video or audio), never its name.

export const SCREEN_EVENT = "app_screen";
const PRESSABLE = "button, a, summary, input[type=checkbox], input[type=radio], [role=tab], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox]";
const MAX_BATCH = 500;
// A step's property: a short key, and true or false, a number, or one word.
const PROP_KEY = /^[a-z][a-z0-9_]{0,23}$/;
const PROP_WORD = /^[a-z0-9][a-z0-9_.-]{0,31}$/;
// Links whose press is a step of its own, beside the press.
const LINK_STEPS = {
  draft_recharge_link: ["recharge_opened", { from: "draft" }],
  perso_recharge_link: ["recharge_opened", { from: "settings" }],
  perso_signup_link: ["signup_link_opened", { from: "settings" }],
  key_link: ["signup_link_opened", { from: "key_window" }],
};

/** snake_case out of an id or a few words, at most `max` long; "" when nothing is left. */
export function slug(text, max = 40) {
  return String(text || "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").slice(0, max).replace(/^_+|_+$/g, "");
}

// A name has to start with a letter (GA4's rule for what it charts).
const named = (s) => (/^[a-z]/.test(s) ? s : "");

/** A step's props in the shape they may have: anything else left out. */
export function cleanProps(props) {
  const out = {};
  for (const [k, v] of Object.entries(props || {})) {
    if (!PROP_KEY.test(k)) continue;
    if (typeof v === "boolean" || (typeof v === "string" && PROP_WORD.test(v))) out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = Math.round(v);
  }
  return out;
}

/** "video" or "audio" for a file by its type, or "" for anything else (a
 *  subtitle file, an image). Never its name. */
export function mediaKind(file) {
  const type = String((file && file.type) || "");
  return type.startsWith("video/") ? "video" : type.startsWith("audio/") ? "audio" : "";
}

/** The name a press on `target` is recorded under, or null when it was not on something pressable. */
export function pressedName(target) {
  const el = target && target.closest ? target.closest(PRESSABLE) : null;
  if (!el) return null;
  const own = named(slug(el.id)) || named(slug(el.dataset?.i18n)) || named(slug(el.dataset?.i18nAriaLabel))
    || named(slug(el.querySelector?.("[data-i18n]")?.dataset.i18n));
  if (own) return own;
  const holder = el.parentElement?.closest?.("[id]");
  return holder ? named(slug(`in_${holder.id}`)) || null : null;
}

/**
 * The batch and the switch. `send(list)` is the shell's sendEvents: it takes
 * the batch and answers {on}. Nothing is kept while the answer is off, and an
 * empty batch is how the page asks. What is recorded before the first answer
 * waits for it -- a step taken as the page loads -- and goes, or is dropped,
 * with it.
 */
export function createCollector({ send, now = Date.now }) {
  let on = false;
  let asked = false;
  let batch = [];
  async function flush() {
    const out = on ? batch : [];
    if (asked || on) batch = [];
    try { on = !!(await send(out))?.on; } catch { on = false; }
    if (!asked) {
      asked = true;
      if (!on) batch = [];
      else if (batch.length) void flush();
    }
  }
  function record(name, screen, props) {
    if ((asked && !on) || !name) return;
    batch.push({ name, screen: slug(screen, 32), t: now(), ...(props ? { props: cleanProps(props) } : {}) });
    if (batch.length >= MAX_BATCH) void flush();
  }
  return { record, flush, isOn: () => on };
}

let current = null;
let currentDoc = null;

/** A step of a person's way through the app, on the screen they are on: one
 *  of relay/events-logic.js STEPS and its props. Nothing outside the shell,
 *  or while recording is off. */
export function record(name, props = {}) {
  if (current) current.record(name, currentDoc.body.dataset.screen, props || {});
}

/** Start recording, when the page runs inside the desktop shell. */
export function startEvents({ doc = document, win = window, shell = win.persodubShell, every = 30000, now = Date.now } = {}) {
  if (!shell || !shell.sendEvents) return null;
  const collector = createCollector({ send: (list) => shell.sendEvents(list), now });
  current = collector;
  currentDoc = doc;
  // Capture: a handler that stops the click from going further must not hide it.
  doc.addEventListener("click", (e) => {
    const name = pressedName(e.target);
    collector.record(name, doc.body.dataset.screen);
    if (LINK_STEPS[name]) record(...LINK_STEPS[name]);
  }, true);
  // A video picked or dropped, whichever part of the app takes it: by its kind alone.
  const brought = (files, source) => {
    for (const f of Array.from(files || []).slice(0, 20)) {
      const kind = mediaKind(f);
      if (kind) record("media_added", { source, kind });
    }
  };
  doc.addEventListener("change", (e) => {
    if (e.target && e.target.type === "file") brought(e.target.files, "file");
  }, true);
  doc.addEventListener("drop", (e) => brought(e.dataTransfer && e.dataTransfer.files, "drop"), true);
  // A screen change says the screen before it and how long it was up.
  let screen = doc.body.dataset.screen;
  let since = now();
  new win.MutationObserver(() => {
    if (doc.body.dataset.screen === screen) return;
    const previous = screen;
    screen = doc.body.dataset.screen;
    collector.record(SCREEN_EVENT, screen,
      { previous_screen: slug(previous, 32), seconds_on_previous: Math.round((now() - since) / 1000) });
    since = now();
  }).observe(doc.body, { attributes: true, attributeFilter: ["data-screen"] });
  win.setInterval(() => void collector.flush(), every);
  win.addEventListener("pagehide", () => void collector.flush());
  doc.addEventListener("visibilitychange", () => { if (doc.visibilityState === "hidden") void collector.flush(); });
  // The first ask: is recording on? Then the screen the page opened on.
  void collector.flush().then(() => { if (screen) collector.record(SCREEN_EVENT, screen, {}); });
  return collector;
}

/** Send what is held and ask again: Settings calls it once the switch is saved. */
export const refreshEvents = () => (current ? current.flush() : Promise.resolve());
