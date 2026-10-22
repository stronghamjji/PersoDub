// The Before dubbing card's Processing choice, run in the page itself:
// ui/src/app.mjs on the stand-in browser of ui/testlib/stubDom.mjs. Pressing
// Perso API greys the stage rows under Advanced options and has each say that
// Perso handles it; Local model brings back what was chosen for this computer
// (owner, 2026-10-22). And the Video card's Replace and Remove. The server
// has not answered anything.
//
// One page per process: app.mjs runs once, at the import below.
//
// Run with: node --test ui/src/dubbingPrep.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { installStubDom } from "../testlib/stubDom.mjs";
import { getDraft, setDraft } from "./draft.mjs";

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

// Replace opens the very picker the Import block opens; Remove asks "Delete
// this draft?" as the Home card's Delete does, and yes leaves the empty
// project: the Import block, New project on the top bar, nothing to export,
// and no Draft card kept for Home (owner, 2026-10-22).
test("Replace opens the Import block's picker, and Remove asks first and leaves the empty project", () => {
  let picked = 0;
  $("draftFileInput").addEventListener("click", () => { picked += 1; });
  $("dubbingZone").click();
  assert.equal(picked, 1, "the Import block's picker");
  setDraft({ downloadId: "abcdef12", name: "street.mp4", duration: 24, videoUrl: "/v" });
  assert.equal($("draftSetup").hidden, false);
  assert.equal($("topbarTitle").textContent, "street");
  const kept = () => JSON.parse(localStorage.getItem("persodub.drafts") || "[]").map((k) => k.downloadId);
  assert.deepEqual(kept(), ["abcdef12"]);
  $("draftReplaceBtn").click();
  assert.equal(picked, 2, "Replace opens the same one");

  $("draftRemoveBtn").click();
  assert.ok($("deleteOverlay").classList.contains("open"));
  assert.equal($("deleteTitle").textContent, "Delete this draft?");
  $("deleteCancelBtn").click();
  assert.equal(getDraft().downloadId, "abcdef12", "No keeps it");

  $("draftRemoveBtn").click();
  $("deleteConfirmBtn").click();
  assert.equal(getDraft(), null);
  assert.ok(!$("deleteOverlay").classList.contains("open"));
  assert.equal($("draftSetup").hidden, true);
  assert.equal($("dubbingImport").hidden, false);
  assert.equal(document.body.dataset.screen, "done");
  assert.equal($("topbarTitle").textContent, "New project");
  assert.equal($("exportBtn").disabled, true);
  assert.deepEqual(kept(), []);
});

// No fold (owner, 2026-10-22, remark 2): the card shows the six stage rows
// under their heading the moment it is up, with nothing pressed.
test("Before dubbing shows the six stage rows under Dubbing step settings without a press", () => {
  assert.equal($("advancedBtn"), null, "no fold button on the page");
  setDraft({ downloadId: "fedcba21", name: "steps.mp4", duration: 24, videoUrl: "/v" });
  assert.equal($("draftSetup").hidden, false);
  for (const id of ["stageHead", "advancedBody"]) {
    assert.equal($(id).parentElement, $("draftOptionsSlot"), `${id} is in the card`);
    assert.equal($(id).hidden, false, `${id} is in sight`);
  }
  assert.equal($("stageHead").textContent, "Dubbing step settings");
  // The two rows that stay dropdowns are on show; the four stages are buttons
  // in their selects' place (ui/src/stagePicker.test.mjs).
  for (const id of ["qualitySelect", "numSpeakers"]) assert.equal($(id).hidden, false, id);
  for (const id of ["sepSelect", "sttSelect", "translateSelect", "voiceSelect"]) assert.equal($(id).hidden, true, id);
});

test.after(() => page.restore());
