// The page's words in the user's language. The English sentence in the code
// IS the key: t("Start dubbing") looks that sentence up in the language's
// table (static/i18n/ui.<code>.json, a flat {"English": "translation"}) and
// answers the English itself when there is no entry -- so a sentence nobody
// has translated yet still reads, in English, instead of showing a key name.
//
// Two kinds of words. The markup's own carry data-i18n (the element's text
// is the key) or data-i18n-title / -placeholder / -aria-label (the
// attribute's value is the key), and applyTranslations() rewrites them in
// place. Words the code writes call t() at the moment they are drawn, so the
// next render after a language change already speaks the new one.
//
// Loaded by the page and by the node:test suites alike, so nothing here may
// touch window, document or fetch before it is called.

// The languages a table can exist for; "en" needs none.
export const LANGUAGES = ["en", "ko"];

const tables = {};   // code -> its table, once loadTable has read it
let language = "en";

/** The sentence `key` in the current language, `{name}` filled from `vars`. */
// The product's name, in every sentence that says {app}: the name this
// edition shows (desktop/src/edition.js displayName, through the shell),
// "PersoDub" with no shell. Filled in every language, English too.
let appName = null;
export function setAppName(name) { appName = name || null; }
const productName = () => appName || globalThis.window?.persodubShell?.name || "PersoDub";

// A table's sentence for `key`, or the key itself. The engine fills {app}
// before it answers, so its sentence is also looked up with the name turned
// back into {app}.
function lookup(table, key) {
  if (!table) return key;
  if (Object.hasOwn(table, key)) return table[key];
  const name = productName();
  const asApp = key.includes(name) ? key.split(name).join("{app}") : key;
  return Object.hasOwn(table, asApp) ? table[asApp] : key;
}

export function t(key, vars) {
  const text = lookup(tables[language], key).replace(/\{app\}/g, productName());
  if (!vars) return text;
  // A {name} the caller gave no value for stays as written: a visible hole
  // is easier to notice than a silent "undefined".
  return text.replace(/\{(\w+)\}/g, (m, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : m));
}

export function setLanguage(code) {
  language = LANGUAGES.includes(code) ? code : "en";
}

export function currentLanguage() {
  return language;
}

/** Read static/i18n/ui.<code>.json. A table that will not load leaves that
 * language on English rather than breaking the page. */
export async function loadTable(code) {
  try {
    const r = await fetch(`/i18n/ui.${code}.json`);
    if (!r.ok) throw new Error();
    tables[code] = await r.json();
  } catch {
    tables[code] ??= {};
  }
  return tables[code];
}

// The regions in the names Perso gives a regional variant that has no tag of
// its own ("Spanish (Mexico)" is plain "es", app/perso_languages.json), as the
// region codes that let the browser name the variant too.
const REGIONS = { US: "US", UK: "GB", Brazil: "BR", Portugal: "PT", Spain: "ES", Mexico: "MX",
  Egypt: "EG", Taiwan: "TW", Australia: "AU", Canada: "CA", Argentina: "AR", Chile: "CL" };

/**
 * A language's name in the page's language, from its code ("es", "en-GB"), as
 * the browser names it (Intl.DisplayNames). `english` is the name the app has
 * always shown; an English page keeps it, and so does a code the browser
 * cannot name. For the screen only: the English name is what a dub is sent with.
 */
export function languageName(code, english) {
  const fallback = english || code || "";
  if (language === "en" || !code) return fallback;
  let tag = String(code);
  const region = /\(([^)]+)\)\s*$/.exec(english || "");
  if (!tag.includes("-") && region && REGIONS[region[1]]) tag += `-${REGIONS[region[1]]}`;
  try {
    // "standard": "Spanish (Spain)" as the list says it, not "European Spanish".
    const name = new Intl.DisplayNames([language], { type: "language", languageDisplay: "standard" }).of(tag);
    return name && name.toLowerCase() !== tag.toLowerCase() ? name : fallback;
  } catch {
    return fallback;   // a code the browser will not take
  }
}

/** The key a data-i18n element's text stands for. */
export const markupKey = (text) => String(text).replace(/\s+/g, " ").trim();

// Each attribute the markup can ask to have translated, and the data-
// attribute that holds its English key.
const ATTRS = [["title", "i18nTitle"], ["placeholder", "i18nPlaceholder"], ["aria-label", "i18nAriaLabel"]];

/**
 * Rewrite the marked words under `root` in the current language. A data-i18n
 * element's English text is kept in its own data-i18n the first time, so a
 * switch back to English (or to a third language) still knows what it said.
 * Only for elements whose text is the markup's alone: setting textContent
 * drops any child elements, and an element the code also writes into would
 * be put back to the markup's words.
 */
export function applyTranslations(root) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    // Runs of white space count as one space, so a sentence the markup wraps
    // over two lines is still the one-line key in the table.
    const key = el.dataset.i18n || markupKey(el.textContent);
    el.dataset.i18n = key;
    el.textContent = t(key);
  }
  for (const [attr, data] of ATTRS) {
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) {
      el.setAttribute(attr, t(el.dataset[data]));
    }
  }
}

/**
 * The language to speak. A setting of "en" or "ko" (Settings > About) is the
 * answer; "auto", or nothing, means the computer's own language: the one the
 * desktop shell read from the system, or in a plain browser (the development
 * run, no shell) the browser's. Korean when it is Korean, English otherwise.
 */
export function pickLanguage(setting, shellLocale, browserLanguage) {
  if (LANGUAGES.includes(setting)) return setting;
  if (LANGUAGES.includes(shellLocale)) return shellLocale;
  return String(browserLanguage || "").toLowerCase().startsWith("ko") ? "ko" : "en";
}

/** Switch the page to what `setting` means here: load the table, then redraw
 * the markup's words. The code's own words follow at their next render. */
export async function useLanguage(setting) {
  const code = pickLanguage(setting, globalThis.window?.persodubShell?.locale, globalThis.navigator?.language);
  if (code !== "en") await loadTable(code);
  setLanguage(code);
  // Named on <html lang>, for the stylesheet (static/css/app.css wraps Korean
  // between words) and for screen readers.
  document.documentElement.lang = code;
  applyTranslations(document);
  return code;
}

// The start-up's language, asked for once however many scripts wait on it:
// the saved setting from GET /api/settings (which answers 503 outside a desktop
// install, and then "auto" stands), then useLanguage. The page's scripts wait
// on it before they draw, so the first paint is already in the right language.
// Capped, because a page that never draws is worse than one in English: if the
// answer is late, the page starts in English and the markup's words change
// when it arrives.
const START_CAP_MS = 1500;
let started = null;
// The whole answer is kept for the page (the Home sidebar's perso.ai link),
// so it is asked for once; null until it has come, or when it never does.
let startSettings = null;
export const savedSettings = () => startSettings;
export function pageLanguage() {
  // The markup's {app} is filled at once, in English, without waiting on the
  // settings answer below: the first paint names the app instead of "{app}".
  if (!started) {
    try { applyTranslations(document); } catch { /* no page to fill */ }
  }
  started ??= (async () => {
    let setting = "";
    try {
      const r = await fetch("/api/settings");
      if (r.ok) {
        startSettings = await r.json();
        setting = startSettings.ui_language || "";
      }
    } catch { /* no setting: "auto" */ }
    return useLanguage(setting);
  })().catch(() => "en");
  return Promise.race([started, new Promise((done) => {
    // ref() is Node's, for the suites that run the page's start-up
    // (boot.test.mjs): their stand-in timers never hold Node open, and a
    // top-level await on a fetch that never answers would then end the run
    // instead of waiting out the cap. A browser's timer is a number; no-op.
    setTimeout(() => done(language), START_CAP_MS)?.ref?.();
  })]);
}
