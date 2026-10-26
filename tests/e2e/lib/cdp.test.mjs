// The e2e runs' own helpers that need no app: node --test tests/e2e/lib/cdp.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { isProductionHelp, translator } from "./cdp.mjs";
import { DESKTOP_APP_URL, persoLink } from "../../../ui/src/edition.mjs";

test("a run reads the page's words with {app} as the name the page shows, PersoDub or PersoDubbing", () => {
  const ko = translator({ "What {app} does": "{app}로 할 수 있는 일", "{n} of {all}": "{all}개 중 {n}개" }, "PersoDubbing");
  assert.equal(ko("What {app} does"), "PersoDubbing로 할 수 있는 일");
  assert.equal(ko("What {app} does", { app: "Other" }), "Other로 할 수 있는 일");
  assert.equal(ko("{n} of {all}", { n: 2 }), "{all}개 중 2개", "a value not given stays as written");
  assert.equal(translator({}, "PersoDub")("What {app} does"), "What PersoDub does");
});

test("the production Help is Perso's desktop app page with the app's utm tail, as the page builds it", () => {
  const tail = "utm_source=desktop_app&utm_medium=desktop-app&utm_campaign=desktop_app&utm_term=v0.9.1";
  assert.equal(isProductionHelp(persoLink(DESKTOP_APP_URL, "help", tail)), true);
  assert.equal(isProductionHelp(persoLink(DESKTOP_APP_URL, "about", tail)), false, "the About logo's link is not Help");
  assert.equal(isProductionHelp("https://github.com/stronghamjji/PersoDub/blob/main/docs/usage.md"), false);
  assert.equal(isProductionHelp("not a link"), false);
});
