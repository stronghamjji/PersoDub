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

export const SCREEN_EVENT = "app_screen";
const PRESSABLE = "button, a, summary, input[type=checkbox], input[type=radio], [role=tab], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox]";
const MAX_BATCH = 500;

/** snake_case out of an id or a few words, at most `max` long; "" when nothing is left. */
export function slug(text, max = 40) {
  return String(text || "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").slice(0, max).replace(/^_+|_+$/g, "");
}

// A name has to start with a letter (GA4's rule for what it charts).
const named = (s) => (/^[a-z]/.test(s) ? s : "");

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
 * empty batch is how the page asks.
 */
export function createCollector({ send, now = Date.now }) {
  let on = false;
  let batch = [];
  async function flush() {
    const out = on ? batch : [];
    batch = [];
    try { on = !!(await send(out))?.on; } catch { on = false; }
  }
  function record(name, screen) {
    if (!on || !name) return;
    batch.push({ name, screen: slug(screen, 32), t: now() });
    if (batch.length >= MAX_BATCH) void flush();
  }
  return { record, flush, isOn: () => on };
}

let current = null;

/** Start recording, when the page runs inside the desktop shell. */
export function startEvents({ doc = document, win = window, shell = win.persodubShell, every = 30000 } = {}) {
  if (!shell || !shell.sendEvents) return null;
  const collector = createCollector({ send: (list) => shell.sendEvents(list) });
  current = collector;
  // Capture: a handler that stops the click from going further must not hide it.
  doc.addEventListener("click", (e) => collector.record(pressedName(e.target), doc.body.dataset.screen), true);
  let screen = doc.body.dataset.screen;
  new win.MutationObserver(() => {
    if (doc.body.dataset.screen === screen) return;
    screen = doc.body.dataset.screen;
    collector.record(SCREEN_EVENT, screen);
  }).observe(doc.body, { attributes: true, attributeFilter: ["data-screen"] });
  win.setInterval(() => void collector.flush(), every);
  win.addEventListener("pagehide", () => void collector.flush());
  doc.addEventListener("visibilitychange", () => { if (doc.visibilityState === "hidden") void collector.flush(); });
  // The first ask: is recording on? Then the screen the page opened on.
  void collector.flush().then(() => { if (screen) collector.record(SCREEN_EVENT, screen); });
  return collector;
}

/** Send what is held and ask again: Settings calls it once the switch is saved. */
export const refreshEvents = () => (current ? current.flush() : Promise.resolve());
