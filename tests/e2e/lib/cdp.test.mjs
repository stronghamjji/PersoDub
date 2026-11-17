// The e2e runs' own helpers that need no app: node --test tests/e2e/lib/cdp.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { translator } from "./cdp.mjs";

test("a run reads the page's words with {app} as the name the page shows", () => {
  const ko = translator({ "What {app} does": "{app}로 할 수 있는 일", "{n} of {all}": "{all}개 중 {n}개" }, "PersoDub");
  assert.equal(ko("What {app} does"), "PersoDub로 할 수 있는 일");
  assert.equal(ko("What {app} does", { app: "Other" }), "Other로 할 수 있는 일");
  assert.equal(ko("{n} of {all}", { n: 2 }), "{all}개 중 2개", "a value not given stays as written");
  assert.equal(translator({}, "PersoDub")("What {app} does"), "What PersoDub does");
});
