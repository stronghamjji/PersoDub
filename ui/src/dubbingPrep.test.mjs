// The Before dubbing card's Processing choice, run in the page itself:
// ui/src/app.mjs on the stand-in browser of ui/testlib/stubDom.mjs. Pressing
// Perso API greys the stage rows under Advanced options and has each say that
// Perso handles it; Local model brings back what was chosen for this computer
// (owner, 2026-10-22). The server has not answered anything.
//
// One page per process: app.mjs runs once, at the import below.
//
// Run with: node --test ui/src/dubbingPrep.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { installStubDom } from "../testlib/stubDom.mjs";

const page = installStubDom(readFileSync(new URL("../../static/index.html", import.meta.url), "utf8"));
await import("./app.mjs");
await sleep(300);
const $ = (id) => document.getElementById(id);
const STAGES = ["sepSelect", "sttSelect", "translateSelect", "voiceSelect", "qualitySelect"];
const HINTS = ["sepHint", "sttHint", "translateHint", "voiceHint", "qualityHint"];

test("Perso API greys the stage rows, each saying Perso handles it, and Local model brings them back as they were", () => {
  const local = Object.fromEntries(STAGES.map((id) => [id, $(id).value]));
  const said = Object.fromEntries(HINTS.map((id) => [id, $(id).textContent]));
  assert.equal($("sepHint").textContent, "Runs on this computer, free.\nFor accuracy, use the Perso API.");
  assert.equal($("qualityHint").textContent, "One take per line. The quickest preview.");

  $("dubModePerso").click();
  assert.equal($("dubModeSelect").value, "perso");
  assert.equal($("dubModePerso").getAttribute("aria-checked"), "true");
  assert.equal($("dubModeHint").textContent,
    "Perso does the dubbing start to finish.\nSign up and the first minute is free. Credits after that.\nThe video is uploaded to Perso.");
  for (const id of HINTS) assert.equal($(id).textContent, "Perso handles this.", id);
  for (const id of STAGES) assert.equal($(id).disabled, true, `${id} is greyed`);
  assert.ok($("advancedBody").classList.contains("by-perso"), "and reads Perso (static/css/app.css)");
  // The choices made for this computer are still the dropdowns' values.
  assert.deepEqual(Object.fromEntries(STAGES.map((id) => [id, $(id).value])), local);
  assert.equal($("numSpeakers").disabled, false, "the speaker count is Perso's to ask too");

  $("dubModeLocal").click();
  assert.equal($("dubModeSelect").value, "local");
  assert.deepEqual(Object.fromEntries(HINTS.map((id) => [id, $(id).textContent])), said);
  for (const id of STAGES) assert.equal($(id).disabled, false, `${id} is live again`);
  assert.ok(!$("advancedBody").classList.contains("by-perso"));
  assert.deepEqual(Object.fromEntries(STAGES.map((id) => [id, $(id).value])), local);
});

test.after(() => page.restore());
