// The page's translations (ui/src/i18n.mjs): a sentence with no entry reads
// in English, {name} is filled, the markup's marked words change language and
// change back. Then the tables themselves (static/i18n/ui.<code>.json): every
// language has the same sentences, the English table is the sentences
// themselves, and every sentence the page asks for is in it. With the tables
// still empty those last checks have nothing to check; once the English
// table is filled they hold every later change to it.
//
// Run with: node --test ui/src/i18n.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  t, setLanguage, currentLanguage, loadTable, applyTranslations, pickLanguage, markupKey, LANGUAGES,
  languageName, pageLanguage, savedSettings, setAppName } from "./i18n.mjs";

const SRC = fileURLToPath(new URL("./", import.meta.url));
const STATIC = fileURLToPath(new URL("../../static/", import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const table = (code) => readJson(`${STATIC}i18n/ui.${code}.json`);

// A fetch that answers one table.
async function withTable(code, entries, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, `/i18n/ui.${code}.json`);
    return { ok: true, json: async () => entries };
  };
  try {
    await loadTable(code);
    await fn();
  } finally {
    globalThis.fetch = real;
    setLanguage("en");
  }
}

// Just enough of an element and a document for applyTranslations: attributes,
// the dataset over them, text, and querySelectorAll for one [attribute].
function el(attrs, text = "") {
  const a = new Map(Object.entries(attrs));
  const dataName = (key) => "data-" + key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
  return {
    attrs: a,
    textContent: text,
    getAttribute: (name) => a.get(name) ?? null,
    setAttribute: (name, value) => a.set(name, String(value)),
    dataset: new Proxy({}, {
      get: (_t, key) => a.get(dataName(key)),
      set: (_t, key, value) => { a.set(dataName(key), String(value)); return true; },
    }),
  };
}
function root(elements) {
  return {
    querySelectorAll: (selector) => {
      const name = selector.match(/^\[([\w-]+)\]$/)[1];
      return elements.filter((e) => e.attrs.has(name));
    },
  };
}

test("a sentence with no entry reads as itself", async () => {
  assert.equal(t("Start dubbing"), "Start dubbing");
  await withTable("ko", { "Start dubbing": "더빙 시작" }, () => {
    setLanguage("ko");
    assert.equal(t("Start dubbing"), "더빙 시작");
    assert.equal(t("Not in the table"), "Not in the table");
  });
});

test("English never reads the table, whatever is loaded", async () => {
  await withTable("ko", { "Start dubbing": "더빙 시작" }, () => {
    setLanguage("en");
    assert.equal(t("Start dubbing"), "Start dubbing");
  });
});

test("{name} is filled from the values, in English and in the translation", async () => {
  assert.equal(t("{n} lines remade", { n: 3 }), "3 lines remade");
  assert.equal(t("{a} of {b}", { a: 1 }), "1 of {b}", "a value not given stays as written");
  await withTable("ko", { "{n} lines remade": "{n}줄 다시 만듦" }, () => {
    setLanguage("ko");
    assert.equal(t("{n} lines remade", { n: 3 }), "3줄 다시 만듦");
  });
});

test("a language without a table is English", () => {
  setLanguage("xx");
  assert.equal(currentLanguage(), "en");
  setLanguage("ko");
  assert.equal(currentLanguage(), "ko");
  setLanguage("en");
});

test("a table that will not load leaves the sentences in English", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("offline"); };
  try {
    assert.deepEqual(await loadTable("zz"), {}, "no throw, and nothing to read");
    setLanguage("ko");
    assert.equal(t("Never translated here"), "Never translated here");
  } finally {
    globalThis.fetch = real;
    setLanguage("en");
  }
});

test("applyTranslations rewrites the marked text, title, placeholder and label, and English brings them back", async () => {
  const label = el({ "data-i18n": "" }, "\n   Language\n  ");
  const button = el({ "data-i18n-title": "Close", "data-i18n-aria-label": "Close", title: "Close" });
  const input = el({ "data-i18n-placeholder": "Not set", placeholder: "Not set" });
  const page = root([label, button, input]);
  await withTable("ko", { Language: "언어", Close: "닫기", "Not set": "설정 안 됨" }, () => {
    setLanguage("ko");
    applyTranslations(page);
    assert.equal(label.textContent, "언어");
    assert.equal(button.getAttribute("title"), "닫기");
    assert.equal(button.getAttribute("aria-label"), "닫기");
    assert.equal(input.getAttribute("placeholder"), "설정 안 됨");
    // The English is kept on the element, so the way back needs no reload.
    assert.equal(label.getAttribute("data-i18n"), "Language");
    setLanguage("en");
    applyTranslations(page);
    assert.equal(label.textContent, "Language");
    assert.equal(button.getAttribute("title"), "Close");
    assert.equal(input.getAttribute("placeholder"), "Not set");
  });
});

test("the start-up keeps the whole settings answer, and asks for it once", async () => {
  const realFetch = globalThis.fetch;
  const realDocument = globalThis.document;
  const asked = [];
  const answer = { ui_language: "en", perso_workspace_link: "https://perso.test/workspace/vt?utm_content=home" };
  globalThis.fetch = async (url) => { asked.push(url); return { ok: true, json: async () => answer }; };
  globalThis.document = { documentElement: {}, ...root([]) };
  try {
    assert.equal(savedSettings(), null, "nothing before the answer");
    assert.equal(await pageLanguage(), "en");
    await pageLanguage();
    assert.deepEqual(savedSettings(), answer);
    assert.deepEqual(asked, ["/api/settings"]);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.document = realDocument;
  }
});

test("the language: a setting of en or ko wins, else the shell's, else the browser's", () => {
  assert.equal(pickLanguage("ko", "en", "en-US"), "ko");
  assert.equal(pickLanguage("en", "ko", "ko-KR"), "en");
  assert.equal(pickLanguage("auto", "ko", "en-US"), "ko");
  assert.equal(pickLanguage("auto", "en", "ko-KR"), "en");
  assert.equal(pickLanguage("auto", undefined, "ko-KR"), "ko", "a plain browser: navigator.language");
  assert.equal(pickLanguage("", "", "ko"), "ko");
  assert.equal(pickLanguage(undefined, undefined, "fr-FR"), "en");
  assert.equal(pickLanguage(undefined, undefined, undefined), "en");
});

test("a language's name: the app's English on an English page, the browser's name for its code on another", (t) => {
  assert.equal(languageName("es", "Spanish"), "Spanish");
  assert.equal(languageName("es", "Spanish (Mexico)"), "Spanish (Mexico)");
  assert.equal(languageName("", "Script"), "Script");
  setLanguage("ko");
  t.after(() => setLanguage("en"));
  // A stand-in for the browser's table: what it is asked, and what it answers.
  const real = Intl.DisplayNames;
  const asked = [];
  Intl.DisplayNames = class {
    constructor(locales, opts) { asked.push([locales[0], opts.type, opts.languageDisplay]); }
    of(tag) {
      if (tag === "bad!") throw new RangeError("invalid");
      return { es: "스페인어", "es-MX": "스페인어(멕시코)", "en-GB": "영어(영국)" }[tag] ?? tag;
    }
  };
  t.after(() => { Intl.DisplayNames = real; });
  assert.equal(languageName("es", "Spanish"), "스페인어");
  assert.deepEqual(asked[0], ["ko", "language", "standard"]);
  // A variant Perso names without a tag of its own gets its region from the name.
  assert.equal(languageName("es", "Spanish (Mexico)"), "스페인어(멕시코)");
  assert.equal(languageName("en-GB", "English (UK)"), "영어(영국)");
  // Nothing from the browser, or a code it will not take: the English stays.
  assert.equal(languageName("dgo", "Dogri"), "Dogri");
  assert.equal(languageName("bad!", "Odd"), "Odd");
  assert.equal(languageName("xx", ""), "xx");
});

// ---- the tables -------------------------------------------------------------

// Every key the page asks for: the t("...") literals in ui/src (string
// literals only; a template with ${} in it is not a key), and the marked words
// in static/index.html -- a data-i18n element's text, a data-i18n-* value.
function literalKeys(code) {
  const keys = [];
  for (const m of code.matchAll(/(?<![\w$])t\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\$]|\\.)*`)/g)) {
    keys.push(Function(`"use strict"; return (${m[1]});`)());
  }
  return keys;
}
const decode = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
function markupKeys(html) {
  const keys = [];
  for (const m of html.matchAll(/<\w+[^>]*?\sdata-i18n(?:="([^"]*)")?(?=[\s>])[^>]*>([^<]*)</g)) {
    keys.push(m[1] ? decode(m[1]) : markupKey(decode(m[2])));
  }
  for (const m of html.matchAll(/\sdata-i18n-(?:title|placeholder|aria-label)="([^"]*)"/g)) keys.push(decode(m[1]));
  return keys;
}
function keysInPage() {
  const modules = readdirSync(SRC).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs") && f !== "i18n.mjs");
  return new Set([
    ...modules.flatMap((f) => literalKeys(readFileSync(SRC + f, "utf8"))),
    ...markupKeys(readFileSync(`${STATIC}index.html`, "utf8")),
  ]);
}

test("the key finders find what they are meant to", () => {
  assert.deepEqual(literalKeys(`t("A {x}", { x }); t('B'); t(\`C\`); split("no"); t(\`\${x}\`); x.t("D")`), ["A {x}", "B", "C", "D"]);
  assert.deepEqual(markupKeys(`<label for="a" data-i18n>\n  Two\n  lines</label><option value="auto" data-i18n>Auto</option>
    <button data-i18n-title="Close &amp; go">x</button><span data-i18n-x="no">no</span>`),
  ["Two lines", "Auto", "Close & go"]);
});

test("every language's table has the same sentences as the English one", () => {
  const en = Object.keys(table("en")).sort();
  for (const code of LANGUAGES.filter((c) => c !== "en")) {
    const other = Object.keys(table(code)).sort();
    assert.deepEqual(other.filter((k) => !en.includes(k)), [], `in ui.${code}.json but not in ui.en.json`);
    assert.deepEqual(en.filter((k) => !other.includes(k)), [], `in ui.en.json but not in ui.${code}.json`);
  }
});

test("every translation fills the same {placeholders} as its English sentence", () => {
  // {app} is the app's name, not a value: a translation may leave it out.
  const names = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((n) => n !== "app").sort();
  for (const code of LANGUAGES.filter((c) => c !== "en")) {
    const wrong = Object.entries(table(code)).filter(([key, text]) => names(key).join() !== names(text).join());
    assert.deepEqual(wrong, [], `ui.${code}.json says other {names} than the English`);
  }
});

test("the English table is the sentences themselves", () => {
  for (const [key, value] of Object.entries(table("en"))) assert.equal(value, key);
});

test("every sentence the page asks for is in the English table (once it has any)", () => {
  const en = table("en");
  if (!Object.keys(en).length) return;   // not filled yet: nothing to hold the page to
  const missing = [...keysInPage()].filter((k) => !Object.hasOwn(en, k));
  assert.deepEqual(missing, [], "asked for by the page, missing from static/i18n/ui.en.json");
});

test("{app} in a sentence is the app's name: PersoDub with no shell, the shell's name with one, in every language", async () => {
  setLanguage("en");
  assert.equal(t("Quit and reopen {app}."), "Quit and reopen PersoDub.");
  assert.equal(t("{app}"), "PersoDub");
  const hadWindow = Object.hasOwn(globalThis, "window");
  const before = globalThis.window;
  globalThis.window = { persodubShell: { name: "PersoDubbing" } };
  try {
    assert.equal(t("Quit and reopen {app}."), "Quit and reopen PersoDubbing.");
    assert.equal(t("{app} answered {status}.", { status: 500 }), "PersoDubbing answered 500.");
    await withTable("ko", { "Quit and reopen {app}.": "{app}을 껐다 켜 주세요." }, () => {
      setLanguage("ko");
      assert.equal(t("Quit and reopen {app}."), "PersoDubbing을 껐다 켜 주세요.");
      setLanguage("en");
    });
    setAppName("Other");
    assert.equal(t("{app}"), "Other");
    setAppName(null);
    assert.equal(t("{app}"), "PersoDubbing");
  } finally {
    if (hadWindow) globalThis.window = before; else delete globalThis.window;
  }
});

test("a sentence the engine sent with the app's name filled in is translated under its {app} key", async () => {
  await withTable("ko", { "Quit and reopen {app}.": "{app}을 껐다 켜 주세요." }, () => {
    setLanguage("ko");
    assert.equal(t("Quit and reopen PersoDub."), "PersoDub을 껐다 켜 주세요.");
    const hadWindow = Object.hasOwn(globalThis, "window");
    const before = globalThis.window;
    globalThis.window = { persodubShell: { name: "PersoDubbing" } };
    try {
      assert.equal(t("Quit and reopen PersoDubbing."), "PersoDubbing을 껐다 켜 주세요.");
      assert.equal(t("Quit and reopen PersoDub."), "Quit and reopen PersoDub.", "another name is not this app's");
    } finally { if (hadWindow) globalThis.window = before; else delete globalThis.window; }
    setLanguage("en");
  });
});
