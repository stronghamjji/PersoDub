// The shell's language (src/i18n.js): a Korean computer reads Korean, kit.env's
// PERSODUB_LANG overrides it, a sentence with no entry reads in English and
// {name} is filled. Then the tables (desktop/i18n/desktop.<code>.json): the
// same sentences in every language, the English table the sentences
// themselves, and every t("...") in the shell present in it -- checks with
// nothing to check while the tables are empty.
//
// Run with: node --test desktop/src/i18n.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LANGUAGES, localeLanguage, resolveLanguage, loadTable, setLanguage, currentLanguage, systemLocale, useLanguage, t, setAppName } from "./i18n.js";
import { screenKeys } from "./screenText.js";
import { builderConfig } from "../electron-builder.js";

const SRC = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(SRC, "..");
const table = (code) => JSON.parse(readFileSync(join(DESKTOP, "i18n", `desktop.${code}.json`), "utf8"));

function kitWith(text) {
  const dir = mkdtempSync(join(tmpdir(), "pd-i18n-"));
  writeFileSync(join(dir, "kit.env"), text);
  return dir;
}

test("a Korean system locale is Korean, every other is English", () => {
  for (const l of ["ko", "ko-KR", "KO-kr"]) assert.equal(localeLanguage(l), "ko", l);
  for (const l of ["en-US", "en", "ja", "fr-FR", "", undefined]) assert.equal(localeLanguage(l), "en", String(l));
});

test("PERSODUB_LANG of en or ko wins; auto, nothing or nonsense is the computer's", () => {
  assert.equal(resolveLanguage("ko", "en"), "ko");
  assert.equal(resolveLanguage("en", "ko"), "en");
  assert.equal(resolveLanguage("auto", "ko"), "ko");
  assert.equal(resolveLanguage(undefined, "ko"), "ko");
  assert.equal(resolveLanguage("klingon", "en"), "en");
});

test("the kit's setting is laid over the computer's language, which is what the others are told", (ctx) => {
  const prior = process.env.PERSODUB_LANG;
  delete process.env.PERSODUB_LANG;
  ctx.after(() => {
    if (prior !== undefined) process.env.PERSODUB_LANG = prior;
    useLanguage({ osLocale: "en-US" });
  });
  assert.equal(useLanguage({ osLocale: "ko-KR" }), "ko", "no kit yet: the computer's");
  assert.equal(useLanguage({ kitDir: kitWith("PERSODUB_LANG=en\n") }), "en", "the kit says English");
  assert.equal(systemLocale(), "ko", "the backend and the page are still told the computer's");
  assert.equal(useLanguage({ kitDir: kitWith("PERSODUB_LANG=auto\n") }), "ko");
  assert.equal(useLanguage({ osLocale: "en-US", kitDir: kitWith("PERSODUB_LANG=ko\n") }), "ko");
});

test("a sentence with no entry reads as itself, and {name} is filled", (ctx) => {
  ctx.after(() => setLanguage("en"));
  const dir = mkdtempSync(join(tmpdir(), "pd-i18n-table-"));
  writeFileSync(join(dir, "desktop.ko.json"), JSON.stringify({ "Version {v} is ready": "{v} 버전이 준비됐어요" }));
  loadTable("ko", dir);
  assert.equal(t("Version {v} is ready", { v: "0.9.0" }), "Version 0.9.0 is ready", "English until told");
  setLanguage("ko");
  assert.equal(currentLanguage(), "ko");
  assert.equal(t("Version {v} is ready", { v: "0.9.0" }), "0.9.0 버전이 준비됐어요");
  assert.equal(t("Not in the table"), "Not in the table");
  assert.equal(t("{a} of {b}", { a: 1 }), "1 of {b}");
});

test("a table that will not read leaves the language on English words", () => {
  assert.deepEqual(loadTable("zz", join(tmpdir(), "no-such-folder")), {});
});

// ---- the tables -------------------------------------------------------------

// Every t("...") string literal in the shell's code (main.js and src/, tests
// and this module aside); a template with ${} in it is not a key. And every
// sentence the bundled screens mark with data-i18n (screens/*.html), as
// src/screenText.js reads them.
function literalKeys(code) {
  const keys = [];
  for (const m of code.matchAll(/(?<![\w$])t\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\$]|\\.)*`)/g)) {
    keys.push(Function(`"use strict"; return (${m[1]});`)());
  }
  return keys;
}
function keysInShell() {
  const files = [join(DESKTOP, "main.js"),
    ...readdirSync(SRC).filter((f) => f.endsWith(".js") && f !== "i18n.js").map((f) => join(SRC, f))];
  const screens = readdirSync(join(DESKTOP, "screens")).filter((f) => f.endsWith(".html")).map((f) => join(DESKTOP, "screens", f));
  return new Set([
    ...files.flatMap((f) => literalKeys(readFileSync(f, "utf8"))),
    ...screens.flatMap((f) => screenKeys(readFileSync(f, "utf8"))),
  ]);
}

test("the key finder finds string literals passed to t()", () => {
  assert.deepEqual(literalKeys(`t("A {x}", { x }); t('B'); t(\`C\`); split("no"); t(\`\${x}\`)`), ["A {x}", "B", "C"]);
});

test("every language's table has the same sentences as the English one", () => {
  const en = Object.keys(table("en")).sort();
  for (const code of LANGUAGES.filter((c) => c !== "en")) {
    const other = Object.keys(table(code)).sort();
    assert.deepEqual(other.filter((k) => !en.includes(k)), [], `in desktop.${code}.json but not in desktop.en.json`);
    assert.deepEqual(en.filter((k) => !other.includes(k)), [], `in desktop.en.json but not in desktop.${code}.json`);
  }
});

test("every translation fills the same {placeholders} as its English sentence", () => {
  // {app} is the app's name, not a value: a translation may leave it out.
  const names = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((n) => n !== "app").sort();
  for (const code of LANGUAGES.filter((c) => c !== "en")) {
    const wrong = Object.entries(table(code)).filter(([key, text]) => names(key).join() !== names(text).join());
    assert.deepEqual(wrong, [], `desktop.${code}.json says other {names} than the English`);
  }
});

test("the English table is the sentences themselves", () => {
  for (const [key, value] of Object.entries(table("en"))) assert.equal(value, key);
});

test("every sentence the shell says is in the English table (once it has any)", () => {
  const en = table("en");
  if (!Object.keys(en).length) return;   // not filled yet: nothing to hold the shell to
  const missing = [...keysInShell()].filter((k) => !Object.hasOwn(en, k));
  assert.deepEqual(missing, [], "said by the shell, missing from desktop/i18n/desktop.en.json");
});

test("the tables ship with the app", () => {
  for (const edition of ["opensource", "production"]) {
    assert.ok(builderConfig(edition).files.includes("i18n/**"), `desktop/electron-builder.js files leaves desktop/i18n out (${edition})`);
  }
});

test("{app} in a sentence is the name the edition shows, PersoDub until it is set", () => {
  setLanguage("en");
  setAppName(null);
  assert.equal(t("{app} could not start"), "PersoDub could not start");
  setAppName("PersoDubbing");
  assert.equal(t("Updating {app}"), "Updating PersoDubbing");
  assert.equal(t("{app}: {what}", { what: "Installing" }), "PersoDubbing: Installing");
  setAppName(null);
});
