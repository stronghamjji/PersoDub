// The bundled screens in the user's language (src/screenText.js): the marked
// sentences are swapped, nothing else is touched, an English screen is loaded
// as it is, and a translated one is a copy that still finds its logo.
//
// Run with: node --test desktop/src/screenText.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { screenKeys, translateScreen, screenFile } from "./screenText.js";
import { LANGUAGES, loadTable, setLanguage, t } from "./i18n.js";

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCREENS = join(DESKTOP, "screens");
const screens = readdirSync(SCREENS).filter((f) => f.endsWith(".html"));
const english = (key) => key;
const shout = (key) => key.toUpperCase();

const SAMPLE = `<!doctype html><title data-i18n>PersoDub: Ready</title>
<h2 id="title" data-i18n>Starting
  engines</h2>
<p data-i18n-title="Not text">Left alone</p>
<p data-i18n>Found at <code id="kitDir"></code>.</p>`;

test("the marked sentences are the keys, one line each, markup and all", () => {
  assert.deepEqual(screenKeys(SAMPLE), ["PersoDub: Ready", "Starting engines", 'Found at <code id="kitDir"></code>.']);
});

test("only the marked elements' content changes; their tags and everything else stay", () => {
  assert.equal(translateScreen(SAMPLE, shout), `<!doctype html><title data-i18n>PERSODUB: READY</title>
<h2 id="title" data-i18n>STARTING ENGINES</h2>
<p data-i18n-title="Not text">Left alone</p>
<p data-i18n>FOUND AT <CODE ID="KITDIR"></CODE>.</p>`);
});

test("in English every screen comes back byte for byte", () => {
  for (const name of screens) {
    const html = readFileSync(join(SCREENS, name), "utf8");
    assert.equal(translateScreen(html, english), html, name);
  }
});

test("an English screen is loaded from where it is, and nothing is written", () => {
  const out = join(mkdtempSync(join(tmpdir(), "pd-screens-")), "screens");
  for (const name of screens) assert.equal(screenFile(SCREENS, name, out, english), join(SCREENS, name));
  assert.equal(existsSync(out), false);
});

test("a translated screen is a copy whose <base> points back at the screens, right after the doctype", () => {
  const out = join(mkdtempSync(join(tmpdir(), "pd-screens-")), "screens");
  const file = screenFile(SCREENS, "loading.html", out, shout);
  assert.equal(file, join(out, "loading.html"));
  const html = readFileSync(file, "utf8");
  assert.ok(html.startsWith(`<!doctype html><base href="${pathToFileURL(SCREENS + sep).href}">`), html.slice(0, 200));
  assert.ok(pathToFileURL(SCREENS + sep).href.endsWith("/"), "a base without its slash would resolve logo.png one folder up");
  assert.match(html, /<h2 data-i18n>STARTING ENGINES…<\/h2>/);
});

// The system's temp folder moved for the length of `fn`: os.tmpdir() reads
// TMPDIR (TEMP and TMP on Windows) at every call.
function withTempFolder(path, fn) {
  const names = ["TMPDIR", "TMP", "TEMP"];
  const saved = names.map((name) => [name, process.env[name]]);
  for (const name of names) process.env[name] = path;
  try { return fn(); } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

test("a copy that cannot be written where it goes is written to the system's temp folder, translated", () => {
  const blocker = join(mkdtempSync(join(tmpdir(), "pd-screens-")), "a-file");
  writeFileSync(blocker, "");   // a file where the folder should go: mkdir fails
  const temp = mkdtempSync(join(tmpdir(), "pd-screens-temp-"));
  const named = (key) => key.replaceAll("{app}", "PersoDubbing");
  const file = withTempFolder(temp, () => screenFile(SCREENS, "error.html", join(blocker, "screens"), named));
  assert.equal(file, join(temp, "persodub-screens", "error.html"));
  const html = readFileSync(file, "utf8");
  assert.match(html, /<h2 id="title" data-i18n>PersoDubbing could not start<\/h2>/);
  assert.ok(html.startsWith(`<!doctype html><base href="${pathToFileURL(SCREENS + sep).href}">`), html.slice(0, 200));
});

test("a copy that cannot be written there either shows the screen as it is", () => {
  const blocker = join(mkdtempSync(join(tmpdir(), "pd-screens-")), "a-file");
  writeFileSync(blocker, "");   // a file where the folder should go: mkdir fails
  const file = withTempFolder(join(blocker, "temp"), () => screenFile(SCREENS, "error.html", join(blocker, "screens"), shout));
  assert.equal(file, join(SCREENS, "error.html"));
});

test("every language keeps a screen sentence's markup, and the screens keep every id their scripts look up", (ctx) => {
  ctx.after(() => setLanguage("en"));
  const keys = new Set(screens.flatMap((name) => screenKeys(readFileSync(join(SCREENS, name), "utf8"))));
  const tags = (s) => (s.match(/<[^>]+>/g) || []).sort();
  const ids = (s) => (s.match(/\sid="[^"]*"/g) || []).sort();
  for (const code of LANGUAGES.filter((c) => c !== "en")) {
    const table = loadTable(code);
    for (const key of keys) if (Object.hasOwn(table, key)) assert.deepEqual(tags(table[key]), tags(key), `${code}: ${key}`);
    setLanguage(code);
    for (const name of screens) {
      const html = readFileSync(join(SCREENS, name), "utf8");
      assert.deepEqual(ids(translateScreen(html, t)), ids(html), `${code}: ${name}`);
    }
  }
});
