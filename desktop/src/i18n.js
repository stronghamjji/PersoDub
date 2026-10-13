import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { envWithKit } from "./kitEnv.js";

// The shell's own words (its dialogs, the bundled screens) in the user's
// language. The English sentence in the code IS the key, as on the page
// (ui/src/i18n.mjs) and in the engine (app/i18n.py): t("Restart to update")
// looks it up in desktop/i18n/desktop.<code>.json and answers the English
// itself when there is no entry.
//
// Which language: kit.env's PERSODUB_LANG ("auto", "en" or "ko", written by
// Settings > About), and for "auto" the computer's own, from app.getLocale().
// The computer's is also what the shell hands on -- to the backend as
// PERSODUB_LOCALE and to the page as persodubShell.locale -- so all three read
// "auto" the same way.

export const LANGUAGES = ["en", "ko"];
export const LANG_KEY = "PERSODUB_LANG";

const TABLE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "i18n");
const tables = {};
let language = "en";
let systemLanguage = "en";

/** "ko" for a Korean system locale (ko, ko-KR), "en" for every other. */
export function localeLanguage(osLocale) {
  return String(osLocale || "").toLowerCase().startsWith("ko") ? "ko" : "en";
}

/** What a PERSODUB_LANG setting means on a computer whose own language is `system`. */
export function resolveLanguage(setting, system) {
  const s = String(setting || "").trim().toLowerCase();
  return LANGUAGES.includes(s) ? s : system;
}

/** Read desktop/i18n/desktop.<code>.json. A table that will not read leaves
 * that language on English rather than failing what was about to be said. */
export function loadTable(code, dir = TABLE_DIR) {
  try {
    tables[code] = JSON.parse(readFileSync(join(dir, `desktop.${code}.json`), "utf8"));
  } catch {
    tables[code] ??= {};
  }
  return tables[code];
}

export function setLanguage(code) {
  language = LANGUAGES.includes(code) ? code : "en";
  if (language !== "en" && !tables[language]) loadTable(language);
}

export function currentLanguage() {
  return language;
}

/** The computer's own language, as the backend and the page are told it. */
export function systemLocale() {
  return systemLanguage;
}

/**
 * Decide the language. At launch (main.js), before any kit is known, with the
 * system locale alone; again once the boot has found the kit (bootFlow.js),
 * whose kit.env may name one; and again on every page load (windowFactory.js),
 * so a change in Settings, which starts the page again, reaches the shell's
 * words at once.
 */
export function useLanguage({ osLocale, kitDir } = {}) {
  if (osLocale !== undefined) systemLanguage = localeLanguage(osLocale);
  setLanguage(resolveLanguage(envWithKit(kitDir)[LANG_KEY], systemLanguage));
  return language;
}

/** The sentence `key` in the current language, `{name}` filled from `vars`. */
export function t(key, vars) {
  const table = tables[language];
  const text = table && Object.hasOwn(table, key) ? table[key] : key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : m));
}
