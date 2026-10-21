// Answers that land late. Each part of the page asks something of the app and
// draws the answer; by the time it lands the person may be on another project.
// The modules have their own tests for this (draftImport, scriptTable, draftSetup,
// pendingSave, runningScreen, timeline, agentStrip). What is left on the page
// itself is a handful of guards in the page's script (ui/src/app.mjs, and
// ui/src/subtitleOverlay.mjs, lifted out of it), which no other test runs --
// so these read the page and hold each guard in its place.
//
// Run with: node --test ui/src/races.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readPage } from "../testlib/readPage.mjs";

// The page with its script written back in (ui/testlib/readPage.mjs).
const html = readPage();
// Its functions are written one level in, inside initSubtitleOverlay.
const subtitles = readFileSync(new URL("./subtitleOverlay.mjs", import.meta.url), "utf8");

/**
 * The source of one function, up to its closing brace: a top-level one of the
 * page, or one written `indent` deep in `text`.
 */
function fn(name, text = html, indent = "") {
  const at = text.search(new RegExp(`\\n${indent}(async )?function ${name}\\(`));
  assert.ok(at >= 0, `the page has no function ${name}`);
  return text.slice(at, text.indexOf(`\n${indent}}\n`, at));
}
const before = (text, a, b, why) => {
  const i = text.indexOf(a), j = text.indexOf(b);
  assert.ok(i >= 0, `missing: ${a}`);
  assert.ok(j >= 0, `missing: ${b}`);
  assert.ok(i < j, why);
};

test("two projects clicked quickly: an answer for the first is dropped, error or not", () => {
  const body = fn("resumeJob");
  const stale = "if (myGeneration !== state.pollGeneration) return;";
  assert.equal(body.split(stale).length - 1, 2, "once after the answer, once in the catch");
  before(body, stale, "eraseScreen.openEraseJob(job)", "checked before an erase is opened");
  before(body, stale, "handleJobUpdate(job, { opened: true })", "and before the job is drawn");
  const caught = body.slice(body.indexOf("} catch (e) {"));
  before(caught, stale, "resetForNewJob()", "a stale failure must not send the person Home");
});

test("Start over and Resume do not pull the person back from wherever they went", () => {
  assert.match(html, /if \(state\.jobId === jobId\) await resumeJob\(job_id\);/);
  assert.match(html, /if \(state\.jobId === jobId\) await resumeJob\(jobId\);/);
});

test("Home's link, read after a project was opened or the field emptied, opens nothing", () => {
  assert.match(html, /const probeIsStale = \(mySeq\) => mySeq !== probeSeq \|\| document\.body\.dataset\.screen !== "home";/);
  const at = html.indexOf("const info = await probeSource(url);");
  const after = html.slice(at, html.indexOf("}, 400);", at));
  before(after, "if (probeIsStale(mySeq)) return;", "draftSetup.openDraft({ link: url", "asked before the draft is opened");
  assert.equal(after.split("probeIsStale(mySeq)").length - 1, 2, "and before the error card is drawn");
  assert.match(fn("clearLink"), /probeSeq \+= 1;/, "emptying the field makes a reading under way stale");
});

test("leaving for Home lets go of a video still coming in", () => {
  assert.match(fn("resetForNewJob"), /draftImport\.cancelImport\(\);/);
});

test("a caption style change is held with the project and the style it was made on", () => {
  const body = fn("saveSubStyle", subtitles, "  ");
  assert.match(body, /subSaver\.schedule\(subStyleJobId, subStyle\)/);
  assert.match(body, /subStyleLoaded/, "and never before the style has loaded");
  assert.doesNotMatch(html, /subStyleTimer/, "the page keeps no timer of its own for it");
  const at = subtitles.indexOf("const subSaver = pendingSave((jobId, style) => {");
  assert.ok(at >= 0);
  const send = subtitles.slice(at, subtitles.indexOf("\n  });\n", at));
  assert.match(send, /fetch\(`\/api\/dub\/jobs\/\$\{jobId\}\/subtitle_style`/, "sent to the project it was held for");
  assert.match(send, /JSON\.stringify\(style\)/);
  assert.doesNotMatch(send, /JSON\.stringify\(subStyle\)/);
});

test("a new dubbing's pane is emptied before it is shown", () => {
  const body = fn("submitDubStart");
  before(body, "runningScreen.starting();", 'showScreen("running");', "emptied first");
  before(body, "state.job = null;", 'showScreen("running");', "and the last job is no longer the open one");
  before(body, '$("logBox").textContent = "";', "runPollLoop(jobId, myGeneration);", "its log too");
});

test("a screen that goes stops its video", () => {
  const body = fn("showScreen");
  assert.match(body, /if \(v !== SCREEN_VIDEO\[name\]\) \$\(v\)\.pause\(\);/);
  const map = html.match(/const SCREEN_VIDEO = (\{[^}]*\});/);
  assert.ok(map);
  assert.deepEqual(Function(`return ${map[1]}`)(),
    { done: "doneVideo", running: "runningVideo", failed: "runningVideo", erase: "eraseVideo" });
  for (const id of ["doneVideo", "runningVideo", "eraseVideo"]) {
    assert.match(html, new RegExp(`<video[^>]*id="${id}"`), `${id} is a video on the page`);
  }
});

test("another job starts the timeline at its own beginning and the usual zoom", () => {
  assert.match(fn("renderDone"), /timeline\.resetView\(\);/);
});
