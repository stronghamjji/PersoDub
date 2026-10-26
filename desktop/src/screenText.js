import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { t } from "./i18n.js";

// The bundled screens (screens/*.html) in the user's language. Each element
// marked data-i18n holds its English sentence; the shell swaps in the
// sentence from desktop/i18n/desktop.<code>.json before the window loads the
// screen, so the screens carry no table of their own and the screens' inline
// scripts read their words from those elements. The content is taken as
// written, markup and all ("... at <code id="kitDir"></code>."), with its
// whitespace collapsed: the key is the one-line sentence.
//
// The screens are small and written by hand: no marked element holds another
// of its own kind, and no attribute value carries a ">".
const MARKED = /(<(\w+)\b[^>]*\sdata-i18n(?=[\s>])[^>]*>)([\s\S]*?)(<\/\2>)/g;
const collapse = (text) => text.replace(/\s+/g, " ").trim();

/** The sentences a screen's marked elements hold: its keys. */
export function screenKeys(html) {
  return [...html.matchAll(MARKED)].map((m) => collapse(m[3]));
}

/** The screen with every marked element's sentence in the current language.
 * A sentence with no translation keeps its own bytes, so an English screen
 * comes back exactly as it went in. */
export function translateScreen(html, say = t) {
  return html.replace(MARKED, (whole, open, _tag, content, close) => {
    const key = collapse(content);
    const said = say(key);
    return said === key ? whole : open + said + close;
  });
}

/**
 * The file to load for screen `name` from `dir`: the screen itself when there
 * is nothing to translate, otherwise a translated copy written to `outDir` --
 * the screens folder sits inside app.asar in a packaged app, where nothing can
 * be written. The copy's <base> points back at `dir`, so its logo.png still
 * loads; the query string the shell adds is the copy's own, as before.
 * A copy that cannot be written to `outDir` is written to the system's temp
 * folder instead: the screens themselves say {app}, so the original is the
 * last resort. Only when neither can be written (the disk-full screen may be
 * one of these) is the original shown, rather than no screen at all.
 */
export function screenFile(dir, name, outDir, say = t) {
  const original = join(dir, name);
  let copy;
  try {
    const html = readFileSync(original, "utf8");
    const said = translateScreen(html, say);
    if (said === html) return original;
    const base = `<base href="${pathToFileURL(dir + sep).href}">`;
    // After the doctype, which must stay first or the screen renders in quirks mode.
    copy = said.replace(/^<!doctype html>/i, (doctype) => doctype + base);
  } catch {
    return original;
  }
  for (const folder of [outDir, join(tmpdir(), "persodub-screens")]) {
    try {
      const out = join(folder, name);
      mkdirSync(folder, { recursive: true });
      writeFileSync(out, copy);
      return out;
    } catch { /* the next folder */ }
  }
  return original;
}
