// The app's screens are one big HTML file whose scripts load as
// <script type="module"> blocks. A module that does not parse is not a
// half-working module -- the browser runs none of it, silently -- which is how
// a stray apostrophe inside one placeholder string once left the whole Dub
// Agent strip dead on screen while every other part of the page looked fine.
// Nothing else in this suite reads that file, so this is the only place such a
// mistake can be caught before it ships.
//
// The page's own script is ui/src/app.mjs now, and its stylesheets are
// static/css/*.css (both lifted out unchanged, 2026-10-10). These tests read
// the page through ui/testlib/readPage.mjs, which writes each back where the
// page loads it, so what they pin is what they pinned when it was written there.
// The parts of the script lifted on into modules of their own follow it there,
// so a check that something is absent from the page still covers them; a check
// that pins a line of one of them reads that module itself.
//
// It also reads ui/src/timeline.mjs and ui/src/agentStrip.mjs: the ids of the
// timeline's head and the agent input's Enter guard moved into those modules
// when the page was split up (2026-09-06), and the markup contract they are
// part of is still one contract -- so the checks stayed together here rather
// than being scattered by which file the id happens to live in today.
//
// Run with: node --test ui/src/indexHtml.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readPage } from "../testlib/readPage.mjs";
import { lucide } from "./icons.mjs";

// The timeline draws its own head and lane, so their ids live in the module.
const TIMELINE = fileURLToPath(new URL("./timeline.mjs", import.meta.url));
const STRIP = fileURLToPath(new URL("./agentStrip.mjs", import.meta.url));
// The erase screen writes the box's own label, so the words live there.
const ERASE = fileURLToPath(new URL("./eraseScreen.mjs", import.meta.url));
// The running screen owns the Cancel button that asks the question.
const RUNNING = fileURLToPath(new URL("./runningScreen.mjs", import.meta.url));
const DRAFT_IMPORT = fileURLToPath(new URL("./draftImport.mjs", import.meta.url));
// The subtitles on the player and the work of the Captions tab's tools.
const SUBTITLES = fileURLToPath(new URL("./subtitleOverlay.mjs", import.meta.url));
// The finished screen's player: its buttons, clock and Original / Dubbing tabs.
const PLAYER = fileURLToPath(new URL("./donePlayer.mjs", import.meta.url));
// The window that asks for an API key or a Perso workspace.
const KEY_WINDOW = fileURLToPath(new URL("./keyWindow.mjs", import.meta.url));
// The stop, delete and full-disk questions.
const CONFIRMS = fileURLToPath(new URL("./confirmDialogs.mjs", import.meta.url));
// The "Updated to" notice and the What's new sheet.
const WHATS_NEW = fileURLToPath(new URL("./whatsNew.mjs", import.meta.url));

// The line number comes along so a failure says where in the page to look --
// the block itself starts a couple of thousand lines in.
function moduleScripts(html) {
  const blocks = [];
  for (const m of html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)) {
    blocks.push({ code: m[1], line: html.slice(0, m.index).split("\n").length });
  }
  return blocks;
}

test("every inline module in static/index.html parses", () => {
  const blocks = moduleScripts(readPage());
  // Were the tag ever written differently, this check would find nothing and
  // pass on an empty list -- which is the same as not having it at all.
  assert.ok(blocks.length >= 2, `expected the page's inline modules, found ${blocks.length}`);

  for (const { code, line } of blocks) {
    try {
      // Parse only: --check never runs a line of it, so nothing the page does
      // at load happens here.
      execFileSync(process.execPath, ["--input-type=module", "--check", "-"], {
        input: code,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      assert.fail(
        `the module beginning at line ${line} of the page (static/index.html with ui/src/app.mjs `
        + `written into its loader block) does not parse:\n${e.stderr}`,
      );
    }
  }
});

// One dark sheet (user, 2026-09-29): no light sheet, nothing that switches to
// one, and the type comes from the app's own files rather than the network.
test("there is one dark theme, and its fonts are the app's own", () => {
  const html = readPage();
  assert.ok(!html.includes("data-theme"), "a light sheet or a theme switch is back");
  assert.ok(!html.includes('id="themeSelect"'), "Settings still offers a theme");
  assert.ok(!/<script>[^<]*persodub\.theme/.test(html), "the boot script still reads a theme");
  assert.match(html, /<link rel="stylesheet" href="\/fonts\/fonts\.css">/);
  assert.ok(!/fonts\.googleapis|fonts\.gstatic/.test(html), "fonts must not come from the network");
  assert.match(html, /font-family: "Twemoji Country Flags", Onest, "Noto Sans KR",/);
  // The palette's anchors, on the names every rule already uses.
  for (const [name, value] of [["desk", "#0e131b"], ["background", "#1c2129"],
    ["head-bg", "#252a33"], ["foreground", "#eaf0fd"], ["primary", "#166CFB"],
    ["primary-ink", "#7aacf6"], ["timeline-fit", "#49a072"], ["destructive", "#f47b74"]]) {
    assert.match(html, new RegExp(`--${name}: ${value};`), `--${name} is not ${value}`);
  }
  // Timeline bars that fit are green now, never the old violet.
  assert.ok(!/#8B5CF6/i.test(html), "the violet timeline colour is back");
  // Burned-in subtitles keep the font ffmpeg draws with.
  assert.match(html, /\.sub-ov-text \{[^}]*font-family: "Apple SD Gothic Neo"/);
});

// The shell's icons are Lucide lines that stay 1.5px on screen at any size
// (mockup, user 2026-09-29): one rule for all of them, and the player's play
// button drawn by the same helper as the timeline's.
test("Lucide icons keep a 1.5px line at every size", () => {
  const html = readPage();
  assert.match(html, /\.lu \{[^}]*stroke: currentColor; stroke-width: 1\.5;/);
  assert.match(html, /\.lu \* \{ vector-effect: non-scaling-stroke; \}/);
  assert.match(readFileSync(PLAYER, "utf8"), /const SMALL_PLAY = lucide\("play", 12\.8, true\);/);
  assert.match(readFileSync(TIMELINE, "utf8"), /lucide\("zoom-in", 16\.8\)/);
});

// The download-first dialog asks one question, so it must offer one answer:
// Download and Start filled, Cancel outlined, and the way out to Settings as a
// word. Three buttons of the same weight made the eye pick between three.
test("only one button in the models dialog reads as the answer", () => {
  const html = readPage();
  assert.match(html, /class="btn btn-primary" id="mnDownload"/,
    "Download and Start is the filled button");
  assert.match(html, /class="settings-link mn-settings-link" id="mnSettings"/,
    "Open Settings is a word, not a third button -- above the buttons now (mockup 2026-09-29)");
  assert.match(html, /class="btn btn-secondary" id="mnCancel"/,
    "Cancel is the grey button of every dialog's foot");
});

// The New project dialog's own row of three. The ids are what the dialog
// module reaches for, and the classes are the decision: two ghost buttons for
// the errands that end here, one filled button for the dub that goes on. The
// progress row and the line Save clip writes belong to the same contract.
test("the New project dialog carries the three buttons, the download row and the saved line", () => {
  const html = readPage();
  for (const id of ["dlRow", "dlFill", "dlPercent", "projectSaved"]) {
    assert.ok(html.includes(`id="${id}"`), `${id} is missing from the New project dialog`);
  }
  assert.match(html, /class="btn btn-outline" id="saveClipBtn"/, "Save clip is a ghost button");
  assert.match(html, /class="btn btn-outline" id="eraseBtn"/, "Erase subtitles is a ghost button");
  assert.match(html, /class="btn btn-primary" id="startBtn"/,
    "Start dubbing is the one filled button, in the app's one button box");
  // "Saved to Downloads · Show" -- the second half only in the desktop app.
  assert.match(html, /id="projectShowWrap" hidden>· <button type="button" class="show-link" id="projectShow"/);
});

// Korean typing sends Enter twice: once to settle the syllable being composed
// (isComposing=true), once for real. The agent input treating the first as
// "send" left the settled syllable behind in the box and -- worse -- stopped
// the running answer to send it ("해" turns ending in Stopped, 2026-09-01).
// The guard is the standard one; this pins it to the agent input's handler.
test("the Erase tab has its faces, and the left tab that opens it", () => {
  const html = readPage();
  assert.match(html, /<button class="left-tab" type="button" role="tab" data-tab="erase"/,
    "the left panel's Erase tab is the way in");
  // The tab comes back as it was left, or on the new project's video; only
  // the first screen's card opens it empty (eraseScreen.openErase).
  assert.match(html, /initLeftTabs\(\{ \$, onErase: \(\) => \{[^}]*openEraseForProject\(\);\s*\},/);
  // An open dub's Erase tab starts from that project's own video; anything
  // else (a draft, no project) opens the tab the way it always did.
  assert.match(html, /const src = await dubAgainSource\(jid\);[^]*?eraseScreen\.openEraseOn\(\{ downloadId: src\.download_id,/);
  assert.match(html, /if \(!ownDub \|\| [^]*?\{\n    eraseScreen\.openEraseTab\(\);\n    return;/);
  // There is no erase screen of its own: the tab's body is in the left panel,
  // the video in the center one, and the bar in the timeline's place.
  assert.ok(!html.includes('id="screen-erase"'), "the separate erase screen is back");
  const left = html.slice(html.indexOf('id="tabErase"'), html.indexOf('id="videoPane"'));
  // #eraseZone and #eraseLinkInput are the shared Import block's, drawn into
  // #eraseImportSlot by ui/src/eraseScreen.mjs.
  for (const id of ["eraseDrop", "eraseImportSlot", "eraseInput", "eraseDlRow", "eraseDropError",
                    "eraseBody", "erasePack", "erasePackText", "erasePackBtn", "eraseNoGpu",
                    "erasePartCard", "erasePartKey", "erasePartRange", "erasePct", "erasePartNote",
                    "eraseAreaCard", "eraseAreaNote", "eraseAreaTip", "eraseBigBox", "eraseResetBtn",
                    "eraseRow", "eraseState", "eraseSaved", "eraseShowWrap", "eraseShowBtn",
                    "eraseBarBox", "eraseFill", "eraseError", "eraseLogDetails", "eraseLogBox",
                    "eraseWait", "eraseAgainBtn",
                    "eraseCancelBtn", "eraseBackBtn", "eraseRetryBtn", "eraseDubBtn",
                    "eraseDoneLabel",
                    "eraseEst", "eraseRunBtn"]) {
    assert.ok(left.includes(`id="${id}"`), `${id} is missing from the Erase tab`);
  }
  const center = html.slice(html.indexOf('id="erasePane"'), html.indexOf('id="agentStrip"'));
  for (const id of ["eraseTabs", "eraseMid", "eraseStage", "eraseVideo", "eraseBox",
                    "eraseTime", "erasePlay", "eraseFs"]) {
    assert.ok(center.includes(`id="${id}"`), `${id} is missing from the Erase tab's video panel`);
  }
  // The way in is the one Import block every empty state shares: no words of
  // its own here, and the format limits are said by the error line.
  for (const gone of ["Drop your video here", "Choose File…", "MP4 or MOV, up to 2 GB.", "erase-dropzone", "erase-linkin"]) {
    assert.ok(!left.includes(gone), `"${gone}" is back on the Erase tab`);
  }
  // The part is what the timeline's cuts kept: the tab draws on the one
  // timeline the dub and the draft use, not a strip of its own.
  assert.ok(!html.includes('id="eraseTimeline"'), "the Erase tab's own strip is back");
  assert.match(html, /body:not\(\[data-screen="done"\]\):not\(\[data-screen="erase"\]\) #timeline/);
  assert.match(html, /showTimeline: \(info\) => timeline\.showErase\(info\)/);
  assert.match(html, /leaveEraseTimeline = \(\) => timeline\.showErase\(null\);/);
  // The box has a handle at each corner, and the module drags by that name.
  for (const corner of ["nw", "ne", "sw", "se"]) {
    assert.ok(html.includes(`data-handle="${corner}"`), `the box has no ${corner} handle`);
  }
  // Its tabs are the finished screen's own, told apart by their own attribute
  // -- the two pairs must never answer each other's clicks.
  // Erased has nothing behind it until the erase is done.
  assert.match(html, /<button class="vtab active" data-erase="original"/);
  assert.match(html, /<button class="vtab" data-erase="erased" type="button" disabled title="After erasing">/);
  assert.match(readFileSync(PLAYER, "utf8"), /querySelectorAll\("#videoPane \.vtab"\)/,
    "the finished screen's tabs must be scoped to its own pane");
  // Every button on the screen is the app's one button box.
  assert.match(html, /class="btn btn-primary btn-sm" id="eraseRunBtn"/, "Erase is the filled button");
  assert.match(html, /class="btn btn-primary btn-sm" id="eraseDubBtn"/, "Dubbing is filled");
  assert.ok(!html.includes('id="eraseSaveBtn"'), "saving is the top bar's Export");
  assert.match(html, /class="btn btn-outline btn-sm" id="eraseCancelBtn"/, "Cancel is a ghost button");
});

test("the erase screen says only what the mockup says", () => {
  const html = readPage();
  // "Where are the subtitles?" was the band's own line; the band now names the
  // screen and carries the estimate and the Erase button (user, 2026-09-09),
  // and the box on the picture is still labelled "Subtitles".
  // The way in is the tab's own drop zone (mockup 2026-09-29): the panel has
  // no room for the home screen's headline over it.
  for (const words of ["Erase subtitles", "Subtitles",
                       "Area", "Box over the subtitles", "Reset", "Erase another part",
                       "Dubbing", "Other edits wait until this is done",
                       "Download", "Try again", "Back"]) {
    assert.ok(html.includes(`>${words}<`) || html.includes(`>${words}`),
      `the screen no longer says "${words}"`);
  }
  // "Finding subtitles…" moved off the page and into the box's own label,
  // which the module writes (user, 2026-09-10).
  const erase = readFileSync(ERASE, "utf8");
  assert.match(erase, /"Finding subtitles…" : "Subtitles"/);
  for (const words of ["Part to erase", "Erasing", "Erased", "Locked while erasing",
                       "Compare in the Original and Erased tabs"]) {
    assert.ok(erase.includes(words), `the Erase tab no longer says "${words}"`);
  }
  // The Area card's two tips (owner, 2026-09-30), kept in ui/src/eraseArea.mjs.
  assert.match(erase, /AREA_TIPS\[0\]/);
  assert.match(erase, /AREA_TIPS\[1\]/);
});

// Placing the box, one card right under the Area card says what the erase
// makes, in the room the line under the cards had: the column at 1280x800 has
// none to spare (owner, 2026-10-22). ui/src/eraseScreen.mjs shows it.
test("the Erase tab says what it makes in one card under the Area card, in the help line's room", () => {
  const html = readPage();
  const body = html.slice(html.indexOf('id="eraseBody"'), html.indexOf('id="eraseRow"'));
  assert.match(body, new RegExp('id="eraseResetBtn" type="button">Reset</button>\\s*</div>\\s*(<!--[^]*?-->\\s*)?'
    + '<div class="erase-card result-box" id="eraseResult" hidden>\\s*<div data-i18n class="k">What you get</div>\\s*'
    + '<div data-i18n class="m">The video with its subtitles erased</div>\\s*</div>'), "the card is not right under the Area card");
  assert.ok(body.indexOf('id="eraseResult"') < body.indexOf('id="eraseTip"'));
  // No margins of its own here: the column has exactly its height left.
  assert.match(html, /#tabErase \.result-box \{ margin: 0; \}/);
  const ko = JSON.parse(readFileSync(new URL("../../static/i18n/ui.ko.json", import.meta.url), "utf8"));
  assert.equal(ko["The video with its subtitles erased"], "자막을 지운 영상이 나와요");
  // The line it replaced is said nowhere now.
  const gone = "Dub after erasing and the translated subtitles won't overlap. Fit the box, then play to check the subtitles stay in it from start to end.";
  assert.ok(!html.includes(gone) && !readFileSync(ERASE, "utf8").includes(gone), "the placing line is back");
  for (const code of ["en", "ko"]) {
    const table = JSON.parse(readFileSync(new URL(`../../static/i18n/ui.${code}.json`, import.meta.url), "utf8"));
    assert.ok(!Object.hasOwn(table, gone), `ui.${code}.json still has the placing line`);
  }
});

// The two controls of an erase belong beside the picture they are about --
// first out of the top bar and into the screen's band (user, 2026-09-09), then
// out of the band and into the row under the picture, where the trim bar is:
// the button in the window's far top corner and the trim in its far bottom one
// was three things in three corners (user, 2026-09-10).
test("the estimate and the Erase button stand at the foot of the Erase tab", () => {
  const html = readPage();
  const row = html.slice(html.indexOf('id="eraseRow"'), html.indexOf('id="videoPane"'));
  assert.ok(row.includes('id="eraseEst"') && row.includes('id="eraseRunBtn"'),
    "both live in the tab's foot");
  assert.match(row, /id="eraseEst"[^]*id="eraseRunBtn"/, "the minutes, then the button");
  // Home comes and goes with the job: there is no hairline beside it now,
  // the name sits alone in the middle of the bar (mockup 2026-09-29).
  assert.ok(!html.includes("topbarHomeDiv"), "the hairline beside the way out is gone");
  assert.match(html, /\$\("homeBtn"\)\.hidden = !back;/);
  // There is no band of the screen's own any more: it said "Erase subtitles"
  // directly under a top bar saying "Erase subtitles" (user, 2026-09-10).
  assert.ok(!html.includes('id="eraseHead"') && !html.includes("erase-head"),
    "the erase screen's title band is back");
  const topbar = html.slice(html.indexOf('<div class="topbar" id="topbar">'), html.indexOf('id="screen-home"'));
  assert.ok(!topbar.includes('id="eraseRunBtn"') && !topbar.includes('id="eraseEst"'),
    "nor in the top bar");
  // The picture fills the center panel's body, letterboxed.
  assert.match(html, /<div class="erase-mid" id="eraseMid">/);
  assert.match(html, /\.erase-stage \{ position: relative; flex: 1; align-self: stretch;/);
  // The box says whether the app is still looking.
  assert.match(html, /\.erase-zone\.finding \{ --zone-now: var\(--destructive\); \}/);
  assert.match(html, /\.erase-zone\.found \{ --zone-now: var\(--success\); \}/);
});

// Stopping a dub used to be asked with window.confirm(). That freezes every
// event in the Electron shell while it is up, and Chromium writes its buttons
// in the machine's own language -- an English question answered by Korean
// buttons (found on Windows, 2026-09-10). It is the app's own dialog now, and
// no confirm() is left anywhere on the page.
test("stopping a dub is asked in the app's own dialog, not the browser's", () => {
  const html = readPage();
  for (const id of ["cancelDubOverlay", "cancelDubCloseX", "cancelDubKeepBtn", "cancelDubConfirmBtn"]) {
    assert.ok(html.includes(`id="${id}"`), `${id} is missing from the stop-this-dub dialog`);
  }
  // The same head/body/foot the other alert dialogs have, and the same
  // grammar: the way out is a ghost button, the deed is the app's own blue
  // (mockup 2026-09-29: no red fill on a destructive answer, like the mockup's).
  const dlg = html.slice(html.indexOf('id="cancelDubOverlay"'), html.indexOf('id="deleteOverlay"'));
  assert.match(dlg, /class="modal-head"[^]*class="modal-body"[^]*class="modal-foot"/);
  assert.match(dlg, /class="btn btn-secondary" id="cancelDubKeepBtn"/);
  assert.match(dlg, /class="btn btn-primary" id="cancelDubConfirmBtn"/);
  // Backdrop and Escape both answer no, and the promise is settled either way
  // -- a caller left awaiting a dialog nobody answered is a dead Cancel button.
  // The dialog itself is ui/src/confirmDialogs.mjs's.
  const confirms = readFileSync(CONFIRMS, "utf8");
  assert.match(confirms, /closeCancelDub\(false\)/);
  assert.match(confirms, /closeCancelDub\(true\)/);
  assert.match(html, /askCancel: \(\) => confirmDialogs\.askCancelDub\(\)/);
  // Not one confirm() left on the page or in the running screen.
  assert.ok(!/[^.\w]confirm\(/.test(html.replace(/closeCancelDub/g, "")),
    "window.confirm() is back somewhere on the page");
  assert.ok(!/[^.\w]confirm\(/.test(readFileSync(RUNNING, "utf8")),
    "window.confirm() is back in the running screen");
});

// The script table's two columns of words are named for what they are, not
// for the languages in them: "Korean" next to "Original" read as a language
// column rather than as the other half of a translation, and the languages
// are in the top bar anyway (user, 2026-09-11). The timeline's lane beside it
// says the same word.
test("the script's two columns are Original and Translated, and so is the lane", () => {
  const html = readPage();
  assert.match(html, /return \{ source: "Original", target: "Translated" \};/);
  assert.match(readFileSync(TIMELINE, "utf8"), /name\("tl-name-dub", "volume-2", 11, "Translated"\)/);
  // The heading starts where its column starts -- at the play button, the way
  // Original starts at its first letter.
  assert.match(html, /\.sc-h-dst \{ grid-column: 5 \/ 7; \}/);
});

// A step that reports trouble and a step that finished must not wear the same
// mark: "Codex is not signed in" under a green tick reads as a thing that
// worked (Windows saw it, 2026-09-11).
test("the agent's two settled marks are different shapes", () => {
  const strip = readFileSync(STRIP, "utf8");
  const done = strip.match(/const MARK_DONE = '([^']+)'/);
  const note = strip.match(/const MARK_NOTE = '([^']+)'/);
  assert.ok(done && note, "one of the two marks is gone");
  assert.notEqual(done[1], note[1]);
  // The tick turns a corner; the dash does not.
  assert.match(done[1], /M5 13l4 4L19 7/);
  assert.match(note[1], /M6 12h12/);
});

// The Erase tab's one <video> wears two hats. While the box is being drawn
// it is a backdrop -- a burst of sound would be in the way -- so the markup
// ships it muted. A finished erase is the thing the user came for, and is
// heard (user, 2026-09-11). The way to play either is the panel's own player
// row under the picture, never a play bar over the writing.
test("a finished erase is a video you can hear, and the backdrop is not", () => {
  const html = readPage();
  // As it ships: no controls, muted.
  assert.match(html, /<video id="eraseVideo" playsinline muted><\/video>/);
  const erase = readFileSync(ERASE, "utf8");
  assert.ok(!erase.includes(".controls ="), "the browser's own play bar is back over the picture");
  assert.match(erase, /\$\("eraseVideo"\)\.muted = !done;/);
  assert.match(html, /initPlayerFoot\(\{ video: \$\("eraseVideo"\), time: \$\("eraseTime"\), play: \$\("erasePlay"\),/);
});

// A dub that is running, one that stopped and the Erase tab are the work
// screen under other names (mockup 2026-09-29): one section, and the name on
// <body> picks the panels.
test("running, failed and erase wear the work screen's frame", () => {
  const html = readPage();
  assert.match(html, /const SCREEN_SECTION = \{ failed: "done", running: "done", erase: "done" \};/);
  assert.ok(!html.includes('id="screen-running"'), "the separate running screen is back");
  assert.match(html, /<div class="done" id="doneLayout">/, "the frame is laid out for all of them");
  // Left panel: the progress card and the failure card, under the Dubbing tab.
  const left = html.slice(html.indexOf('id="scriptPane"'), html.indexOf('id="videoPane"'));
  for (const id of ["runBody", "progressCard", "progressTitle", "progressPct", "progressFill",
                    "progressSteps", "runNote", "jobNotice", "runFoot", "cancelBtn", "cancelLabel",
                    "rawLogDetails", "logBox",
                    "doneFail", "doneFailBody", "doneFailMark", "doneFailWhy", "doneFailActions",
                    "doneResume", "doneRetry", "doneRetryError"]) {
    assert.ok(left.includes(`id="${id}"`), `${id} is missing from the left panel`);
  }
  assert.match(html, /body\[data-screen="running"\] #leftTabs:has\(\[data-tab="dubbing"\]\.on\) ~ #runBody \{ display: flex; \}/);
  assert.match(html, /body\[data-screen="running"\] #tabDubbing, body\[data-screen="failed"\] #tabDubbing \{ display: none; \}/);
  // Center panel: the original, playable, and the trim's caption under it.
  const center = html.slice(html.indexOf('id="runPane"'), html.indexOf('id="erasePane"'));
  for (const id of ["runStage", "runningVideo", "runningTrim", "runTime", "runPlay", "runFs"]) {
    assert.ok(center.includes(`id="${id}"`), `${id} is missing from the running dub's video panel`);
  }
  assert.match(center, /<button class="vtab active" type="button">Original<\/button>\s*<button class="vtab" type="button" disabled title="After dubbing">Dubbed<\/button>/);
  // In the timeline's place, one line.
  assert.match(html, /<div class="tl-wait">The timeline appears when dubbing is done<\/div>/);
  // Export is there and dim until there is something to hand back.
  assert.match(html, /\$\("exportBtn"\)\.hidden = !done && !back;\n/);
  // Lit for a finished job, and for a draft with a video on its timeline --
  // unless the screen says for itself (the erase screen does).
  assert.match(html, /\$\("exportBtn"\)\.disabled = exportable !== undefined \? !exportable\n    : !done && !\(back && !state\.jobId && !!\(getDraft\(\) \|\| \{\}\)\.downloadId\);/);
  // The tab row follows the screen's name, and a press on another tab is the
  // way back from the Erase tab to the job.
  assert.match(html, /if \(workFrame\) workFrame\.onScreen\(name\);/);
  assert.match(html, /onLeaveErase: \(\) => \{\n    if \(state\.job && state\.job\.id === state\.jobId\) handleJobUpdate\(state\.job, \{ opened: true \}\);/);
  // An erase opened from Home has no draft: its other tabs go on to dubbing
  // the erased video, or stay on Erase while there is none.
  assert.match(html, /else if \(!getDraft\(\) && eraseScreen\.hasJob\(\)\) \{\n      leftTabs\.show\("erase"\);\n      if \(eraseScreen\.erasedJob\(\)\) \$\("eraseDubBtn"\)\.click\(\);/);
  // The failure card's video is the running screen's, painted by its module.
  assert.match(html, /runningScreen\.paintStopped\(job\);/);
  // Never a time left on a running dub.
  assert.ok(!/min left|time left/i.test(readFileSync(RUNNING, "utf8").replace(/\/\/.*$/gm, "")),
    "the running dub promises a time again");
});

test("the agent input ignores Enter pressed mid-composition", () => {
  const html = readFileSync(STRIP, "utf8");
  const handler = html.match(/input\.addEventListener\("keydown"[\s\S]{0,600}/);
  assert.ok(handler, "the agent input's keydown handler is gone?");
  assert.match(handler[0], /isComposing/,
    "keydown must return early while the IME is still composing");
});

// The topbar's three pane buttons (list / timeline / agent), sitting right of
// Export. The timeline is the one pane with no fold of its own, so its CSS
// off-switch is pinned here too (mockup approved 2026-09-01).
test("the topbar carries the three pane buttons and the timeline off-switch", () => {
  const html = readPage();
  for (const id of ["paneList", "paneTimeline", "paneAgent"]) {
    assert.ok(html.includes(`id="${id}"`), `${id} is missing from the topbar`);
  }
  assert.match(html, /body\.timeline-off (#timeline|\.timeline)/,
    "hiding the timeline needs a body.timeline-off rule");
});

// Hidden, the left panel used to leave the video at the width its grip was
// dragged to and the middle of the row empty (owner, 2026-10-10). Whenever the
// left panel is hidden the center panel takes the row, and the grip goes.
test("hiding the left panel lets the video take the whole row", () => {
  const html = readPage();
  assert.match(html, /\.done-main:has\(> \.script-pane\[hidden\]\) > \.video-pane \{ flex: 1 1 0; \}/,
    "the center panel grows into the left panel's room");
  assert.match(html, /\.done-main:has\(> \.script-pane\[hidden\]\) \.grip-panes \{ display: none; \}/,
    "the grip between the panels goes while there is nothing to share");
});

// The track's sideways scrollbar takes room at its foot wherever scrollbars do
// not float (Windows, or a Mac set to always show them), and the lanes are
// centred in what is left. The names have to give up the same room, or a tall
// strip sets every name half a scrollbar below its lane and a short one tucks
// the last lane under the bar (Windows, 2026-10-10).
test("the lane names give up the same room as the track's scrollbar", () => {
  const html = readPage();
  assert.match(html, /\.tl-names::after \{ content: ""; flex: none; overflow-x: scroll; visibility: hidden; \}/,
    "an unseen scroller of the track's own kind sits at the foot of the names");
  assert.match(html, /\.tl-names \{[^}]*padding-bottom: 6px;/,
    "its 6px gap and 6px of padding make the track's 12px");
});

// A model folder put back, or taken away, outside the app: the "Needs …" lines
// under the choices were read again only when Settings opened, and stayed
// after the model was back (checklist C13, Windows 2026-10-06 and 2026-10-10).
// Coming back to the window reads the models again.
test("coming back to the window reads the models again", () => {
  const html = readPage();
  assert.match(html, /window\.addEventListener\("focus", \(\) => \{ models\.refreshModels\(\)\.catch\(\(\) => \{\}\); \}\);/);
});

// A rename changed the top bar and the project list, while the video clip on
// the timeline kept the old name until the project was opened again (Windows
// test G4, 2026-10-10). The strip is drawn again with the new one.
test("a renamed project's video clip on the timeline takes the new name", () => {
  const html = readPage();
  assert.match(html, /\$\("topbarTitle"\)\.textContent = jobLabel\(state\.job \|\| \{\}\);\n    timeline\.redraw\(\);[^\n]*\n    projects\.renderHistory\(\)/);
});

// An empty erase screen lit Export for a draft still held from before, and
// pressing it saved that video, which was nowhere on the screen (Windows test
// E9, 2026-10-01 and 2026-10-10). The screen says whether its video is the draft.
test("an erase screen exports only the video it shows", () => {
  const html = readPage();
  assert.match(html, /exportable = undefined \}\) \{/);
  assert.match(html, /\$\("exportBtn"\)\.disabled = exportable !== undefined \? !exportable/);
  assert.match(html, /if \(document\.body\.dataset\.screen === "erase" && !eraseScreen\.exportsDraft\(\)\) return null;/);
  assert.match(html, /projectOpen: \(\) => !!state\.jobId,/);
});

// The agent lives in a right-hand column and the finished screen puts the
// script LEFT of the video (layout G, user 2026-09-08). The grips must match:
// the agent's resizes width (x), and so does the script/video divider. Reading
// order follows the screen, so the script comes first in the markup.
test("the agent column sits beside the work and the grips point the right way", () => {
  const html = readPage();
  assert.ok(html.includes('class="mainrow"'), "work and agent need the mainrow wrapper");
  assert.match(html, /class="grip grip-x" id="gripAgent"/,
    "the agent grip must resize width");
  assert.match(html, /class="grip grip-x grip-panes" id="gripPanes"/,
    "the script/video grip must resize width");
  const video = html.indexOf('id="videoPane"');
  const script = html.indexOf('id="scriptPane"');
  assert.ok(script > 0 && script < video, "the script pane must come before the video");
});

// Timeline zoom, the aligned agent heading, and the Korean tab names
// (mockup approved 2026-09-01 afternoon).
test("timeline zoom controls, Agent heading and English video tabs are in place", () => {
  const html = readPage();
  const timeline = readFileSync(TIMELINE, "utf8");
  for (const id of ["tlZoomOut", "tlZoomIn", "tlZoomFit"]) {
    assert.ok(timeline.includes(`id="${id}"`), `${id} is missing from the timeline head`);
  }
  assert.ok(html.includes(">Original<") && html.includes(">Dubbing<"),
    "the video tabs must read Original/Dubbing -- the app speaks English (user, 2026-09-02)");
  // Anchored to markup, not to the words: "Agent" is in comments and titles
  // all over the page. The right panel says "Agent" (mockup 2026-09-29).
  assert.match(html, /<span class="agent-title">Dub Agent<\/span>/,
    "the agent column needs its Agent heading, as an element's own text");
});

// The player's subtitle overlay, its toolbar, and the timeline's subtitle lane
// with the eye toggle (mockup approved 2026-09-01 evening).
test("the subtitle overlay, toolbar and timeline lane are wired in", () => {
  const html = readPage();
  for (const id of ["subOverlay", "subToolbar", "subStyleMenu"]) {
    assert.ok(html.includes(`id="${id}"`), `${id} is missing from the player`);
  }
  const timeline = readFileSync(TIMELINE, "utf8");
  assert.ok(timeline.includes("tlSubEye"), "the timeline needs its subtitle eye toggle");
  assert.ok(timeline.includes("tl-cap"), "the timeline needs its subtitle lane blocks");
});

// The subtitle tools left the video for the Captions tab (mockup editorc,
// user 2026-09-29): same ids, so everything that presses them still finds
// them, and nothing floats over the picture any more.
test("the subtitle tools live in the Captions tab and the video stays clean", () => {
  const html = readPage();
  const tab = html.slice(html.indexOf('id="tabCaptions"'), html.indexOf('id="runBody"'));
  for (const id of ["subToolbar", "subSmaller", "subSizeLv", "subBigger", "subScopeSep", "subScopeSeg",
                    "subScopeAll", "subScopeOne", "subShow", "subStyleBtn", "subSaved", "subStyleMenu",
                    "capEmpty", "capMain", "capHint"]) {
    assert.ok(tab.includes(`id="${id}"`), `${id} is not in the Captions tab`);
  }
  const video = html.slice(html.indexOf('id="videoPane"'), html.indexOf('id="videoUnder"'));
  assert.ok(!video.includes('id="subToolbar"') && !video.includes('id="subStyleMenu"'),
    "nothing of the subtitle tools floats over the video");
  // The tools' work is ui/src/subtitleOverlay.mjs's.
  const subs = readFileSync(SUBTITLES, "utf8");
  assert.ok(!html.includes("placeSubToolbar"), "the floating bar's placement is gone");
  // Show is the timeline's eye, pressed -- one switch, not two that can disagree.
  assert.match(subs, /onShow: \(\) => \$\("tlSubEye"\)\?\.click\(\)/);
  // Size 50..300 in tens, and the save settles for 350ms before the PUT.
  assert.match(subs, /Math\.min\(300, \(subStyle\.size == null \? 100 : subStyle\.size\) \+ 10\)/);
  assert.match(subs, /Math\.max\(50, \(subStyle\.size == null \? 100 : subStyle\.size\) - 10\)/);
  assert.match(subs, /const subSaver = pendingSave\(\(jobId, style\) => \{[^]*?method: "PUT"/);
  // Selecting a subtitle brings the tab up; a block in the timeline's
  // subtitle lane selects its line, but its trim handles stay the timeline's.
  assert.match(subs, /leftTabs\.show\("captions"\);/);
  assert.match(subs, /if \(!cap \|\| e\.target\.closest\("\.tl-hdl, \.tl-exdot"\)\) return;/);
  // The tab follows the screen: a dub starting or a draft opening empties it.
  assert.match(subs, /new MutationObserver\(paintSubToolbar\)\.observe\(document\.body, \{ attributeFilter: \["data-screen"\] \}\);/);
  // One block of the page's CSS is this area's.
  assert.equal(html.split("/* === captions === */").length, 2);
});

// Under the looks, one card says what the tab makes (owner, 2026-10-22). It
// is the tab's own: inside #capMain, so an empty tab has none either.
test("the Subtitle style tab says what it makes, in one card under the looks", () => {
  const html = readPage();
  const tab = html.slice(html.indexOf('id="capMain"'), html.indexOf('id="runBody"'));
  assert.match(tab, new RegExp('<div class="cap-grid" id="subStyleMenu"></div>\\s*(<!--[^]*?-->\\s*)?'
    + '<div class="erase-card result-box" id="capResult">\\s*<div data-i18n class="k">What you get</div>\\s*'
    + '<div data-i18n class="m">The video with subtitles burned in, and the subtitle file</div>\\s*</div>\\s*</div>'),
    "the card is not the last thing under the looks");
  const ko = JSON.parse(readFileSync(new URL("../../static/i18n/ui.ko.json", import.meta.url), "utf8"));
  assert.equal(ko["The video with subtitles burned in, and the subtitle file"], "자막을 입힌 영상과 자막 파일이 나와요");
  // The looks scroll above it; the card keeps the grid's side room.
  assert.match(html, /\.cap-content \.result-box \{ margin: 0 12px 12px; \}/);
});

test("after an update the page says so in one line and keeps the What's new sheet for the link", () => {
  const html = readPage();
  // The notice and the sheet are ui/src/whatsNew.mjs's, written one level in.
  const whatsNew = readFileSync(WHATS_NEW, "utf8");
  // The notice is the same pill as the "Restart to update" one, in the same
  // place, and says only the version -- the list is one click away.
  assert.match(html, /id="updatedNotice"/);
  assert.match(whatsNew, /t\("Updated to \{version\}", \{ version: whatsNew\.version \}\)/);
  assert.match(html, /id="updatedWhatsNew"[^>]*>What(’|&#8217;)s new</);
  // The banner stays until closed: a close button, and no self-hiding timer.
  assert.match(html, /id="updatedClose"/);
  assert.doesNotMatch(html, /setTimeout\(hideUpdatedNotice/);
  // A changed version shows the notice, never the sheet on its own.
  const start = whatsNew.indexOf("async function checkWhatsNew");
  const check = whatsNew.slice(start, whatsNew.indexOf("\n  }\n", start));
  assert.match(check, /showUpdatedNotice\(\)/);
  assert.doesNotMatch(check, /showWhatsNew\(\)/);
});

// The small confirms are the exception to the dialog rule (user, 2026-09-30):
// the warning sign with the app's badge on top, the question, at most one
// short line, and the answers as equal halves.
test("every small confirm wears the warning sign, a question and at most one short line", () => {
  const html = readPage();
  const ids = ["modelsNeededOverlay", "settingsDiscardOverlay", "creditOverlay", "cancelDubOverlay",
               "deleteOverlay", "mediaReplaceOverlay", "spaceOverlay"];
  for (const id of ids) {
    const start = html.indexOf(`<div class="modal-overlay" id="${id}">`);
    const dlg = html.slice(start, html.indexOf("\n</div>\n", start));
    assert.match(dlg, /<div class="modal modal-alert"/, id);
    assert.match(dlg, /class="modal-body">\s*<div class="alert-icon"><svg class="alert-tri"[^]*class="alert-badge"><img src="\/logo\.png"[^]*<h2/, id);
    assert.doesNotMatch(dlg, /modal-inner/, id);
    // One message line at most (the delete dialog's second <p> is its error).
    assert.ok((dlg.match(/<p(?![^>]*delete-error)\b/g) || []).length <= 1, id);
  }
  assert.match(html, /<h2 id="cancelDubTitle">Stop dubbing\?<\/h2>\s*<\/div>/);                       // no line: a cloud dubbing cannot resume
  assert.match(html, /id="settingsDiscardTitle">Discard changes\?<\/h2>\s*<\/div>/);
  assert.match(html, /<h2 id="deleteTitle">Delete this project\?<\/h2>\s*<p id="deleteMessage">This can&#8217;t be undone\.<\/p>/);
  // A kept draft is asked about by its own name, in as few words. The
  // question is ui/src/confirmDialogs.mjs's.
  const confirms = readFileSync(CONFIRMS, "utf8");
  assert.match(confirms, /\$\("deleteTitle"\)\.textContent = job\.draftId \? t\("Delete this draft\?"\) : t\("Delete this project\?"\);/);
  // Its one line says how many languages go with a project of several
  // (ui/src/languageRow.mjs deleteLine), and nothing else; asked about a base
  // program in Settings > Models, the one line the asker hands it.
  assert.equal((html.match(/\$\("deleteMessage"\)\.textContent/g) || []).length, 2);
  assert.match(confirms, /\$\("deleteMessage"\)\.textContent = deleteLine\(job\.draftId \? 1 : projectLanguages\(members\)\.length\);/);
  assert.match(confirms, /\$\("deleteMessage"\)\.textContent = line;/);
  assert.match(html, /<h2>Replace this video\?<\/h2>\s*<p>Cuts are reset\.<\/p>/);
  assert.match(html, /id="cancelDubKeepBtn" type="button">Keep going<[^]*?id="cancelDubConfirmBtn" type="button">Stop</);
  assert.match(html, /\.modal\.modal-alert \{ width: 280px;/);
  assert.match(html, /\.modal-alert \.modal-foot \.btn \{ flex: 1;/);
});

test("the update window's restart is the big button in its left column, and the foot has only Close", () => {
  const html = readPage();
  const start = html.indexOf('<div class="modal-overlay" id="updateOverlay">');
  const upd = html.slice(start, html.indexOf("\n</div>\n", start));
  const left = upd.slice(upd.indexOf('class="upd-left"'), upd.indexOf('class="upd-right"'));
  assert.match(left, /<button class="btn btn-primary" id="updGo" type="button" hidden>Restart to update<\/button>/);
  const foot = upd.slice(upd.indexOf('class="modal-foot"'));
  assert.equal((foot.match(/<button/g) || []).length, 1);
  assert.match(foot, /id="updClose" type="button">Close</);
});

test("the update's dot is on the What's new card, not in the top bar; the key window ends in a foot", () => {
  const html = readPage();
  assert.ok(!html.includes('id="updateBtn"'), "the top bar's update icon is gone (2026-10-21)");
  assert.match(html, /#homeWhatsNew\.live::after \{ content: ""; position: absolute;/);
  assert.match(html, /wireUpdates\(\{ \$, shell: window\.persodubShell \|\| null, releases: `\$\{REPO_URL\}\/releases` \}\);/);
  for (const id of ["updateOverlay", "updClose", "updTitle", "updCurrent", "updNext", "updGo", "updRunning", "updNotesBox", "updNotes", "updNotesLink"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  // The old bottom pill that the window replaces is gone.
  assert.doesNotMatch(html, /updateBannerView|id = "updateBanner"/);
  // Key window: title, field, link, error, two buttons -- no sentence under the title.
  const start = html.indexOf('<div class="modal-overlay" id="keyOverlay">');
  const key = html.slice(start, html.indexOf("\n</div>\n", start));
  assert.match(key, /class="modal-foot key-foot"/);
  assert.doesNotMatch(key, /<p\b/);
  assert.equal(html.split("/* === dialogs === */").length, 2);
});

// The width handles' drag and the Captions tab's save mark run for real in
// ui/src/subtitleOverlay.test.mjs, against the module that holds them.

// The player's subtitle is the ruler for the export: the page measures with
// the same font ffmpeg burns with, at the font's own line height, and sends
// the result as `layout`. These pin the CSS side of that contract to the
// module and the backend it must agree with (user, 2026-09-07).
test("the player draws subtitles in the burn's font at its natural line height", async () => {
  const html = readPage();
  const { SUB_FONT_STACK } = await import("./subtitleLayout.mjs");
  const rule = html.match(/\.sub-ov-text \{[^}]*\}/)[0];
  assert.match(rule, new RegExp(SUB_FONT_STACK.map((f) => `"${f}"`).join(", ")),
    "the overlay's font-family must list the burn's fonts in the burn's order");
  assert.match(rule, /line-height: normal/);
  assert.match(rule, /max-width: 92%/);
  // The measuring is ui/src/subtitleOverlay.mjs's.
  const subs = readFileSync(SUBTITLES, "utf8");
  assert.match(subs, /const SUB_MAX_WIDTH = 0\.92;/, "the script's cap must be the CSS max-width");
  // The backend's per-platform font is one of the same three.
  const results = readFileSync(fileURLToPath(new URL("../../app/api/results.py", import.meta.url)), "utf8");
  for (const f of SUB_FONT_STACK) assert.ok(results.includes(`"${f}"`), `${f} is not a burn font`);
  // The measured layout goes out with the settings.
  assert.match(subs, /subStyle\.layout = lay;/);
  // ...with the weight the look is drawn at, which the burn's presets lack.
  assert.match(subs, /weight: r\.weight/);
  assert.match(html, /id="subMeasure"/);
});

// Packs (the Python + PyTorch, the translation runtime) are the desktop app's to
// install: the page hands its bridge to the models controller and, in the
// dropdown hints, names the pack before the model while the pack is missing.
test("the page hands the desktop bridge to the models controller and hints name packs first", () => {
  const html = readPage();
  assert.match(html, /shell: window\.persodubShell \|\| null/);
  // What each line lists, pack first and each thing once, is
  // ui/src/modelsUi.mjs stageNeeds (its own tests hold the order).
  assert.match(html, /stageNeeds\(STAGE_FIELDS\.map\(\(\[role, sel\]\) => \[role, \$\(sel\)\.value\]\), models\.modelRow\)/);
  // One line names everything the choice needs, one button fetches it all.
  assert.match(html, /t\("Needs \{names\} · \{size\} GB", \{ names: needs\.map\(\(r\) => r\.name\)\.join\(" \+ "\)/);
  assert.match(html, /models\.downloadAll\(ids\)/);
});

// The voice engine's pack on disk but its process down: the page asks the
// desktop app to start it and tries the dub again, once.
test("a dub refused because the voice engine is not running is retried after the desktop app starts it", () => {
  const html = readPage();
  assert.match(html, /async function restartVoiceEngine\(errorEl\)/);
  // serverText: the engine's English, which the refusal is known by (ui/src/format.mjs).
  assert.match(html, /voice engine is not running\/\.test\(serverText\(e\)\)\) \{\n\s*const restart = await restartVoiceEngine\(errorEl\);/);
  // When it does not come back, why is said under the refusal, not thrown away
  // -- or alone, when the memory ran out again and it says all of it (A37).
  assert.match(html, /errorEl\.textContent = restart\.alone \? restart\.why : \[errorText\(e\), restart\.why\]\.filter\(Boolean\)\.join\("\\n"\);/);
  // And it is scrolled into view: under the advanced options it was below the fold.
  const start = html.slice(html.indexOf("async function submitDubStart"));
  const refused = start.slice(start.indexOf("} catch (e) {"), start.indexOf("return false;"));
  assert.match(refused, /if \(errorEl\.textContent\) errorEl\.scrollIntoView\(\{ block: "nearest" \}\);\n\s*$/);
  // Into view above the Start bar stuck over the card's foot, not behind it
  // (H29): the card keeps the bar's height clear at its bottom.
  const card = html.slice(html.indexOf("  .draft-setup {"), html.indexOf("  .draft-label {"));
  assert.match(card, /scroll-padding-bottom: 67px;/);
  assert.match(html, /keepPolling: \(\) => \$\("settingsOverlay"\)\.classList\.contains\("open"\)/);
});

test("there is no rail, and the logo in Settings > About is the way to the project's page", () => {
  const html = readPage();
  assert.ok(!/class="rail|id="(dubToggle|eraseToggle|historyToggle)"/.test(html),
    "the rail and its buttons are gone (mockup 2026-09-29)");
  assert.match(html, /<button class="about-logo-btn" id="brandBtn"[^>]*title="PersoDub on GitHub"[^>]*><img class="about-logo" src="\/logo.png"/);
  assert.match(html, /\$\("brandBtn"\)\.addEventListener\("click", \(\) => window\.open\(REPO_URL, "_blank", "noopener"\)\)/);
});

// Which repository the project's links open is the shell's to say: the build's
// edition (desktop/src/edition.js), handed over as persodubShell.repo. A plain
// browser has no shell and opens the public repository.
test("the project's page is the repository the shell names, or the public one without a shell", () => {
  const html = readPage();
  assert.match(html, /const REPO_URL = `https:\/\/github\.com\/\$\{window\.persodubShell\?\.repo \|\| "stronghamjji\/PersoDub"\}`;/);
});

// The new-layout frame (mockup, user 2026-09-29): one bar with Home at the
// left, the name in the middle, then Settings and the three pane buttons
// (Export left it for the video panel's tab row, 2026-10-22); under it three
// panels in a row and the timeline under all three.
test("the top bar is the name, then Settings and the pane buttons; Home and New project are in the tab row", () => {
  const html = readPage();
  const bar = html.slice(html.indexOf('<div class="topbar" id="topbar">'), html.indexOf('<div class="shell">'));
  const at = (s) => bar.indexOf(s);
  for (const id of ["topbarWays", "topbarTitle", "settingsBtn", "paneList", "paneTimeline", "paneAgent"]) {
    assert.ok(at(`id="${id}"`) > 0, `${id} is not in the top bar`);
  }
  assert.ok(at('id="topbarWays"') < at('id="topbarTitle"') && at('id="topbarTitle"') < at('id="settingsBtn"')
    && at('id="settingsBtn"') < at('id="paneList"') && at('id="paneList"') < at('id="paneTimeline"')
    && at('id="paneTimeline"') < at('id="paneAgent"'),
    "name, Settings, list, timeline, agent");
  assert.ok(at('id="exportBtn"') < 0, "Export is in the video panel's tab row, not the bar");
  assert.ok(at('id="homeBtn"') < 0 && at('id="newProjectBtn"') < 0, "the two are not written into the bar");
  // Home is a house over its word, first in the left panel's tab row; New
  // project is last. Buttons dressed as tabs: no data-tab, so no "on" state.
  const row = html.slice(html.indexOf('id="leftTabs"'), html.indexOf('id="tabDubbing"'));
  const order = ['id="homeBtn"', 'class="left-sep"', 'data-tab="dubbing"',
                 'data-tab="erase"', 'data-tab="captions"', 'data-tab="save"', 'id="newProjectBtn"'].map((s) => row.indexOf(s));
  assert.ok(order.every((n, i) => n > 0 && (i === 0 || n > order[i - 1])), "Home, a hairline, the four tabs, New project");
  const home = row.slice(row.indexOf('id="homeBtn"'), row.indexOf("</button>"));
  assert.ok(home.includes("M15 21v-8a1 1 0 0 0-1-1h-4") && home.includes("<span>Home</span>") && !home.includes("data-tab"),
    "Home is the Lucide house with its word");
  assert.match(html, /<button class="left-tab way-out way-new" id="newProjectBtn"[^>]*>[^]*?<span>New project<\/span><\/button>/);
  assert.match(html, /\.left-tabs \.way-new \{ margin-left: auto; \}/, "New project stands at the row's far end");
  assert.match(html, /@container lefttabs \(max-width: 340px\) \{ \.left-tabs \.way-new span \{ display: none; \} \}/);
  // With the left panel hidden the two move to the bar as icon buttons.
  assert.match(html, /if \(inBar\) \$\("topbarWays"\)\.append\(home, fresh\);\n  else \{ \$\("leftTabs"\)\.prepend\(home\); \$\("leftTabs"\)\.append\(fresh\); \}/);
  assert.match(html, /\.topbar \.way-out span \{ display: none; \}/);
  assert.match(html, /\$\("homeBtn"\)\.addEventListener\("click", \(\) => \{\n[^]*?resetForNewJob\(\);/);
  assert.ok(!html.includes('id="topbarBack"'), "the Back arrow is gone -- Home is the way out");
  // 36px, the name centred in 12px dim, Export 22px high.
  assert.match(html, /\.topbar \{[^}]*height: 36px;/);
  assert.match(html, /\.topbar-titles \{ position: absolute; left: 50%; transform: translateX\(-50%\);/);
  assert.match(html, /\.topbar-title \{ font-size: 11px; font-weight: 400; color: var\(--muted-foreground\);/);
  assert.match(html, /#exportBtn \{ height: 22px;/);
});

test("the finished screen is three panels in a row at 866 : 861 : 801, the timeline under all three", () => {
  const html = readPage();
  assert.match(html, /\.script-pane \{ position: relative;\n    flex: 866 1 0;/);
  assert.match(html, /\.video-pane \{ position: relative; flex: var\(--video-flex, 861 1 0\);/);
  assert.match(html, /\.agent \{ position: relative; flex: 801 1 0;/);
  assert.match(html, /\.work \{ flex: 1734 1 0;/, "the work holds the left and center shares and the gap");
  assert.match(html, /\.mainrow \{ position: relative; flex: 1; min-height: 0; display: flex; gap: 7px; \}/);
  assert.match(html, /\.done-main \{[^}]*gap: 7px; \}/);
  assert.match(html, /\.app \{ height: 100vh; display: flex; flex-direction: column; padding: 0 9px 9px;/);
  // The timeline is out of the finished screen, under the row the agent is in,
  // 294px with a 32px toolbar, and only on a finished job.
  const shell = html.slice(html.indexOf('<div class="mainrow">'));
  assert.match(shell, /<\/aside>[^]*id="gripTimeline"[^]*<\/div>\s*<!--[^]*?-->\s*<div class="timeline" id="timeline"><\/div>/);
  assert.ok(html.indexOf('id="timeline"') > html.indexOf('id="agentStrip"'), "the timeline comes after the agent");
  assert.match(html, /\.timeline \{ flex: 0 0 auto; height: clamp\(240px, 100vh - 560px, 294px\);/);
  assert.match(html, /\.tl-head \{ box-sizing: border-box; height: 32px;/);
  assert.match(html, /body:not\(\[data-screen="done"\]\):not\(\[data-screen="erase"\]\) #timeline/);
  // the mockup's timeline (mockup 2026-09-29): 168px of lane names plus the track's 6px lead-in, a 29px ruler,
  // the lanes in the middle of the space under it and 6px apart, the video lane 74px (a name row,
  // a 39px film strip, the waveform), a draft's chosen clip ringed in white.
  assert.match(html, /\/\* === timeline === \*\//);
  assert.match(html, /\.tl-body \{ flex: 1; min-height: 0; display: grid; grid-template-columns: 168px 1fr;/);
  assert.match(html, /\.tl-ruler \{ position: relative; height: 29px;/);
  assert.match(html, /\.tl-lanes \{ display: flex; flex-direction: column; gap: 6px; margin: auto 0; \}/);
  assert.match(html, /\.tl-vclip \{ position: absolute; top: 0; height: 74px;/);
  assert.match(html, /\.tl-film \{ position: relative; height: 39px;/);
  assert.match(html, /\.tl-cut\.sel \{ outline: 2px solid #fff;/);
  assert.match(html, /\.tl-tool, \.tl-zbtn \{ width: 24px; height: 24px;/);
  assert.match(html, /getMedia: \(\) => \(state\.job \? \{ kind: "job", id: state\.job\.id/,
    "the video lane is told whose film strip to fetch");
  // Panel headers are 42px.
  for (const rule of [/\.left-tabs \{[^}]*height: 42px;/, /\.video-tabs \{[^}]*height: 42px;/, /\.agent-head \{[^}]*height: 42px;/]) {
    assert.match(html, rule);
  }
});

test("the left panel is a row of tabs, each over a body of its own", () => {
  const html = readPage();
  const pane = html.slice(html.indexOf('id="scriptPane"'), html.indexOf('id="videoPane"'));
  const tabs = [...pane.matchAll(/data-tab="(\w+)"/g)].map((m) => m[1]);
  // One project holds one video: there is no Media tab to keep it in
  // (owner, 2026-09-30).
  // Home's order (owner, 2026-10-23): Burn in subtitles is the tool that
  // burns a subtitle file in, not a dub's style, and Save video comes last.
  // Separate audio is no tool of its own (owner, 2026-10-23).
  assert.deepEqual(tabs, ["dubbing", "erase", "captions", "save"]);
  const captions = pane.slice(pane.indexOf('data-tab="captions"'));
  assert.ok(captions.slice(0, captions.indexOf("</button>")).endsWith("</svg>Burn in subtitles"));
  assert.ok(!captions.slice(0, captions.indexOf(">")).includes("disabled"), "never dimmed: it starts a project anywhere");
  const save = pane.slice(pane.indexOf('data-tab="save"'));
  assert.ok(save.slice(0, save.indexOf("</button>")).endsWith("</svg>Save video"));
  const words = readFileSync(new URL("./markupWords.mjs", import.meta.url), "utf8");
  assert.match(words, /\['#leftTabs \[data-tab="captions"\]', t\("Burn in subtitles"\)\]/);
  assert.match(words, /\['#leftTabs \[data-tab="save"\]', t\("Save video"\)\]/);
  // It opens the Download dialog with the project's own video alone.
  assert.match(html, /const row = state\.jobId && document\.body\.dataset\.screen !== "erase" \? \["original"\] : \["video"\];\n\s*exportDialog\.open\(row, row\);/);
  assert.ok(!/tabMedia|mediaTab|media-thumb|mediaSearch|mediaImpBtn/.test(html), "nothing of the Media tab is left");
  assert.ok(!html.includes('id="tabAudio"'), "no Audio tab body");
  assert.match(pane, /<button class="left-tab on"[^>]*data-tab="dubbing" aria-selected="true">/, "Dubbing is on to begin with");
  // Captions holds the subtitle tools (its own test below); Dubbing holds
  // the Import block for a project with no video yet, then the script.
  assert.match(pane, /<div class="tab-body cap-tab" id="tabCaptions" role="tabpanel" hidden>/);
  const dubbing = pane.slice(pane.indexOf('id="tabDubbing"'), pane.indexOf('id="tabCaptions"'));
  for (const id of ["dubbingImport", "dubbingImportSlot", "dubbingImportStatus",
                    "scriptCount", "retranslateBtn", "doneNotice", "scriptBox", "scriptSaving"]) {
    assert.ok(dubbing.includes(`id="${id}"`), `${id} left the Dubbing tab`);
  }
  // The tab labels: 10px, weight 500; the one on show in the accent colour.
  assert.match(html, /\.left-tab \{[^}]*font-size: 10px; font-weight: 500;/);
  assert.match(html, /\.left-tab\.on \{ color: var\(--primary-ink\); \}/);
  // The notice line goes back into the Dubbing tab, not above the tabs.
  assert.match(html, /moveInto\(\$\("doneNotice"\), \$\("tabDubbing"\), true\);/);
});

test("the video panel's foot is the clock, play in the middle, and full screen", () => {
  const html = readPage();
  const foot = html.slice(html.indexOf('id="videoUnder"'), html.indexOf('id="gripPanes"'));
  assert.match(foot, /id="videoTime"[^]*id="playToggle"[^]*id="fullscreenBtn"/);
  assert.match(html, /\.video-under \.video-play \{ position: absolute; left: 50%; transform: translateX\(-50%\); \}/);
  assert.match(readFileSync(PLAYER, "utf8"), /\$\("videoWrap"\)\.requestFullscreen\(\)/);
});

// Cancel stands beside the stage it cancels, and the way out of an erase that
// began in the New project dialog goes back to that dialog (user, 2026-09-09).
test("Cancel sits in the progress card, and leaving an erase reopens the dialog it came from", () => {
  const html = readPage();
  const card = html.slice(html.indexOf('id="progressCard"'), html.indexOf('id="doneFail"'));
  assert.ok(card.includes('id="cancelBtn"'), "Cancel is inside the progress card");
  const topbar = html.slice(html.indexOf('<div class="topbar" id="topbar">'), html.indexOf('id="screen-home"'));
  assert.ok(!topbar.includes('id="cancelBtn"'), "and no longer in the top bar");
  // At the foot of the card, not beside the percentage: a number you read and
  // a button you press sat as one lump there (user, 2026-09-10). The steps
  // come first, then the foot: the log's fold at its left, the button at its
  // right (mockup 2026-09-29).
  assert.match(card, /id="progressSteps"[^]*class="cancel-row" id="runFoot"[^]*id="cancelBtn"[^]*id="rawLogDetails"/);
  assert.match(html, /moveInto\(\$\("rawLogDetails"\), \$\("runFoot"\)\);/);
  assert.ok(!/id="progressPct"[^]*id="cancelBtn"[^]*<\/div>\s*<div class="progress-bar"/.test(card),
    "Cancel is out of the head row");
  // The stop square is gone, and the row it now lives in is what holds the
  // card's free space so the log stays at the foot with it.
  assert.ok(!html.includes("cancel-stop"), "the stop square is gone");
  assert.match(html, /\.cancel-row \{[^}]*margin-top: auto/);
  assert.match(html, /\.run-body \.cancel-row \{ position: sticky; bottom: 0;/);
  // Lighter than it was, still above every other control's .18.
  assert.match(html, /\.btn-cancel \{[^}]*border: 1px solid rgba\(255, 255, 255, 0\.30\)/);
  // Leaving: the dialog goes back up only when that is where the erase began.
  assert.match(html, /const back = eraseScreen\.origin\(\);/);
  assert.match(html, /document\.body\.dataset\.screen === "erase" && back/);
  assert.match(html, /if \(fromDialog\) newProject\.openNewProject\(\{ \.\.\.back, fromErase: true \}\);/);
});

// A dub reporting its progress must not drag the screen back from wherever the
// person went; a project the person clicked must open even so. The two go
// through the same function, and the first version of the guard stopped both:
// clicking a finished project on the first screen did nothing at all
// (found on the mac, 2026-09-10).
test("progress reports leave the screen alone, but an opened project takes it", () => {
  const html = readPage();

  // The guard exists, and it lets an opened job through.
  assert.match(html, /if \(!opened && !JOB_SCREENS\.has\(document\.body\.dataset\.screen\)\)/);
  assert.match(html, /const JOB_SCREENS = new Set\(\["running", "done", "failed"\]\);/);

  // Only one of the two callers passes it. The poll must not.
  assert.match(html, /handleJobUpdate\(job, \{ opened: true \}\);/);
  assert.match(html, /onUpdate: \(job\) => \{ if \(myGeneration === state\.pollGeneration\) handleJobUpdate\(job\); \}/);
  assert.equal((html.match(/handleJobUpdate\(job, \{ opened: true \}\)/g) || []).length, 1);

  // Starting a dub shows the running screen itself rather than waiting for the
  // first report to do it -- which the guard would now swallow. Both
  // startDubbing (the New project dialog) and a draft's own Start dubbing
  // (ui/src/draftSetup.mjs) go through this one function to do it.
  const start = html.slice(html.indexOf("async function submitDubStart"));
  assert.ok(start.slice(0, start.indexOf("runPollLoop")).includes('showScreen("running")'));
  assert.match(html, /async function startDubbing\(\)/);
  assert.match(html, /submitDubStart\(\{\s*\n\s*fd, label, errorEl: \$\("projectError"\), retry: \(\) => startDubbing\(\),/);
});

test("a project's script arriving redraws the subtitle on the video", () => {
  // The style can land before the script; without this the overlay kept the
  // previously opened project's line (Mac and Windows full test, 2026-09-25).
  const html = readPage();
  const cb = html.slice(html.indexOf("renderTimeline: (lines, duration) => {"));
  const body = cb.slice(0, cb.indexOf("},"));
  assert.match(body, /timeline\.renderTimeline\(lines, duration\)/);
  assert.match(body, /updateSubtitleNow\(\)/);
});

test("the video's resize grip sits inside the pane, where its clipping cannot cut it off", () => {
  // .video-pane clips its overflow for its rounded corners; a grip at a
  // negative left was clipped away and the video could not be resized
  // (Mac and Windows full test, 2026-09-25).
  const html = readPage();
  const rule = html.match(/\.grip-panes \{ left: (-?\d+)(?:px)?;/);
  assert.ok(rule, "no .grip-panes left rule found");
  assert.ok(Number(rule[1]) >= 0, `#gripPanes left is ${rule[1]}px`);
});

test("in a narrow agent column the model button takes its own line above the box", () => {
  // Beside the box at 260px it left 47px for typing (Windows, 2026-09-25).
  const html = readPage();
  assert.match(html, /\.agent \{ container: agentcol \/ inline-size; \}/);
  const q = html.slice(html.indexOf("@container agentcol (max-width: 299px)"));
  assert.ok(q.length > 0, "no narrow-column rule");
  const body = q.slice(0, q.indexOf("\n  }"));
  assert.match(body, /\.assistant-foot \{ flex-wrap: wrap;/);
  assert.match(body, /\.assistant-modelwrap \{ order: -1; flex-basis: 100%; \}/);
});

test("a start that restarted the voice engine tries once more, never in a loop", () => {
  // 0.6.5 reset its guard before retrying, so a 422 that kept coming back
  // restarted the engine 2,676 times in 13 seconds (issue #117, 2026-09-28).
  // The guard now lives in submitDubStart, shared by the New project
  // dialog's Start and a draft's own (ui/src/draftSetup.mjs), so neither has
  // to carry it separately.
  const html = readPage();
  const branch = html.match(/else if \(([^\n]*voice engine is not running[^\n]*)\) \{\n[^\n]*restartVoiceEngine[^\n]*\n\s*if \(restart\.ok\) \{\n\s*(return submitDubStart\([^;]*\));/);
  assert.ok(branch, "the voice-engine retry branch is where it was");
  assert.match(branch[1], /^!retried && /);
  assert.equal(branch[2], "return submitDubStart({ fd, label, errorEl, retry, retried: true })");
});

test("a Perso key is asked for with its workspace, and a missing workspace is asked for at the start", () => {
  const html = readPage();
  const keyWindow = readFileSync(KEY_WINDOW, "utf8");
  assert.match(html, /id="keySpace"/);
  assert.match(keyWindow, /\/api\/perso\/spaces\/preview/);
  // Both starts (one video, several) answer the workspace refusal with the window.
  assert.equal((html.match(/Select a Perso workspace\/\.test\(serverText\(e\)\)\) \{\n\s*\/\/ A key with several workspaces/g) || []).length, 2);
  // The old banner that sent people to Settings for a key is gone.
  assert.doesNotMatch(html, /Perso and Gemini need an API key/);
});

// Settings in the mockup's shape (user 2026-09-29): five tabs over one panel each,
// and every control the long sheet had is still there under the same id.
test("Settings is five tabs, each with its panel, and keeps every control it had", () => {
  const html = readPage();
  const from = html.indexOf('<div class="modal-overlay" id="settingsOverlay">');
  const sheet = html.slice(from, html.indexOf('id="settingsSaveBtn"', from) + 200);
  assert.match(sheet, /<div class="set-tabs" id="settingsTabs" role="tablist"/);
  const names = ["models", "keys", "storage", "privacy", "about"];
  const tabs = [...sheet.matchAll(/id="settingsTab-(\w+)"[^>]*role="tab"[^>]*aria-controls="settingsPanel-(\w+)"[^>]*>([^<]+)</g)];
  assert.deepEqual(tabs.map((m) => m[1]), names);
  assert.deepEqual(tabs.map((m) => m[2]), names);
  assert.deepEqual(tabs.map((m) => m[3]), ["Models", "API keys", "Storage", "Privacy", "About"]);
  assert.equal((sheet.match(/aria-selected="true"/g) || []).length, 1, "one tab is selected in the markup");
  // Each control sits in the panel of its own tab.
  const panel = (name) => {
    const a = sheet.indexOf(`id="settingsPanel-${name}" role="tabpanel" aria-labelledby="settingsTab-${name}"`);
    assert.ok(a > 0, `${name} has a panel`);
    const next = sheet.indexOf('<div class="set-panel"', a);
    return sheet.slice(a, next < 0 ? sheet.indexOf('<div class="modal-foot">') : next);
  };
  const home = {
    models: ["modelsFold", "modelsSummary", "modelsList", "modelsError"],
    keys: ["persoKeyInput", "persoKeyHint", "persoSignupLink", "persoSpaceSelect", "persoSpaceWarning", "geminiKeyInput",
           "geminiKeyHint", "chatgptState", "chatgptSignInBtn", "chatgptHint", "showKeysToggle"],
    storage: ["revealOutputBtn", "storageHint"],
    privacy: ["analyticsToggle", "analyticsHint", "reportsToggle", "reportsHint"],
    about: ["brandBtn", "aboutVersion", "ackToggle", "ackList"],
  };
  for (const [name, ids] of Object.entries(home)) {
    for (const id of ids) assert.ok(panel(name).includes(`id="${id}"`), `${id} is in the ${name} tab`);
  }
  for (const id of ["settingsCloseBtn", "settingsChanges", "settingsCancelBtn", "settingsSaveBtn"]) {
    assert.equal(sheet.split(`id="${id}"`).length, 2, `${id} is there once`);
  }
  // The buttons are outside the scrolling panels, Cancel before Save, Save resting.
  const foot = sheet.slice(sheet.indexOf('<div class="modal-foot">'));
  assert.ok(foot.indexOf('id="settingsChanges"') < foot.indexOf('id="settingsCancelBtn"')
    && foot.indexOf('id="settingsCancelBtn"') < foot.indexOf('id="settingsSaveBtn"'));
  assert.match(foot, /id="settingsSaveBtn" type="button" disabled>Save</);
  // The window keeps one size whichever tab shows, and only a panel scrolls.
  assert.match(html, /#settingsOverlay \.modal \{ width: min\(512px, 92vw\); height: min\(594px, 90vh\);/);
  assert.match(html, /\.set-panel \{ flex: 1; min-height: 0; overflow-y: auto; padding: 6px 20px; border-radius: 8px;/);
  // Measured again (2026-09-29): 24 at the panel's sides, and a 22 field.
  assert.match(html, /\.set-panel \{ padding: 6px 24px; \}/);
  assert.match(html, /\.set-panel input\[type="password"\], \.set-panel input\[type="text"\], \.set-panel select \{ height: 22px; \}/);
  // The ways in that know what they came for say which tab.
  assert.match(html, /onOpenSettings: \(\) => settings\.openSettings\("models"\)/);
  assert.match(html, /onOpenSettings: \(\) => settings\.openSettings\("keys"\)/);
});

// Settings > Models: each group is a band the eye finds among the rows. A
// heading in the rows' grey, then a band one shade off the panel, both went
// unseen (owner, 2026-10-22, 12), so the step is held to a number: the band
// at least 10 points of lightness (CIELAB L*) over the panel the rows sit on.
test("a model group's band stands at least 10 points of lightness above its rows", () => {
  const html = readPage();
  const band = html.match(/\.set-panel \.model-group-head \{[^}]*\}/)[0];
  assert.match(band, /background: var\(--secondary\)/);
  assert.match(band, /border-top: 1px solid var\(--divider\)/);
  assert.match(band, /font-size: 13px; font-weight: 600/);
  // Edge to edge: out by the panel's own 24px sides (the Settings test above).
  assert.match(band, /margin: 12px -24px 0; padding: 9px 24px/);
  assert.match(html, /\.set-panel \{ flex: 1;[^}]*background: var\(--field\); \}/);
  const token = (name) => html.match(new RegExp(`--${name}: #([0-9a-f]{6});`))[1];
  const lightness = (hex) => {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y;
  };
  const step = lightness(token("secondary")) - lightness(token("field"));
  assert.ok(step >= 10, `the band is only ${step.toFixed(1)} points over the rows`);
});

// The models dialog's line is two lines, the sentence and then the room left
// with the memory (ui/src/modelsDialog.mjs joins them with a line break). The
// stylesheet keeps that break, and the dialog is wider than the other confirms
// so the second line fits whole in either language (owner, 2026-10-22, 5).
test("the models dialog keeps its line break, and is wider than the other confirms", () => {
  const html = readPage();
  assert.match(html.match(/#mnLine \{[^}]*\}/)[0], /white-space: pre-line/);
  const confirm = Number(html.match(/\.modal\.modal-alert \{ width: (\d+)px;/)[1]);
  const en = Number(html.match(/\n\s*#modelsNeededOverlay \.modal\.modal-alert \{ width: (\d+)px; \}/)[1]);
  const ko = Number(html.match(/html:lang\(ko\) #modelsNeededOverlay \.modal\.modal-alert \{ width: (\d+)px; \}/)[1]);
  assert.equal(confirm, 280);
  // Measured in Chrome with the app's fonts: the second line with four figures
  // of room left is 351px of English and 299 of Korean, and the sides take 34.
  assert.ok(en >= 351 + 34 && ko >= 299 + 34, `${en} and ${ko} are too narrow`);
});

// Settings > Privacy, Send job logs: what goes and where, for how long, what
// never goes, and what it is for, a sentence a line (owner, 2026-10-22, 9).
// It used to call the failed jobs stopped ones, and said nothing of where.
test("Send job logs says what goes where, what never goes and why, a sentence a line", () => {
  const html = readPage();
  const hint = html.match(/<div class="settings-hint" id="reportsHint">([\s\S]*?)<\/div>/)[1];
  const sentences = [...hint.matchAll(/<span data-i18n>([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(sentences, [
    "Keeps a record of finished and failed jobs (masked logs, time per step, device ID) on a private dashboard for 30 days.",
    "Only failed jobs go into a public GitHub issue, as a summary of the cause.",
    "Titles, file names, links and dialogue are not sent.",
    "What you send helps make PersoDub better.",
  ]);
  const ko = JSON.parse(readFileSync(new URL("../../static/i18n/ui.ko.json", import.meta.url), "utf8"));
  assert.deepEqual(sentences.map((s) => ko[s]), [
    "끝난 작업과 실패한 작업의 기록(가린 로그, 단계별 시간, 기기 번호)을 비공개 대시보드에 30일 보관해요.",
    "실패한 작업만 깃헙 공개 이슈에 원인 요약으로 올라가요.",
    "제목·파일 이름·링크·대사는 안 보내요.",
    "보내 주시면 PersoDub을 더 좋게 만드는 데 써요.",
  ]);
  // Each sentence starts a line of its own, and the label stays by the switch.
  assert.match(html, /#reportsHint > span \{ display: block; \}/);
  assert.match(html, /\.set-row:has\(> \.set-ctl > #reportsHint\) \{ align-items: start; \}/);
  const old = "Keeps the logs of finished and failed jobs for 30 days. Only failed jobs go into a public issue.";
  for (const code of ["en", "ko"]) {
    const table = JSON.parse(readFileSync(new URL(`../../static/i18n/ui.${code}.json`, import.meta.url), "utf8"));
    assert.equal(Object.hasOwn(table, old), false, `the old sentence is still in ui.${code}.json`);
  }
});

// Which step each key and the ChatGPT sign-in is for, a small grey line under
// each like the Privacy tab's (owner, 2026-10-21). And the translator's own
// lines point the local ones at the Gemini API, which says where its key goes.
test("each API key and the ChatGPT sign-in say which step uses them", () => {
  const html = readPage();
  const keys = html.slice(html.indexOf('id="settingsPanel-keys"'), html.indexOf('id="settingsPanel-storage"'));
  assert.match(keys, /id="persoKeyInput"[^>]*>\s*<!--[^]*?-->\s*<div data-i18n class="settings-hint" id="persoKeyHint">Used when Choose a model, Voice separation or Speech-to-text is set to Perso API\. Uses Perso credits\.<\/div>/);
  assert.match(keys, /id="geminiKeyInput"[^>]*>\s*<div data-i18n class="settings-hint" id="geminiKeyHint">Used only when Translation is set to Gemini API\. Uses your own Google API quota\.<\/div>/);
  // ChatGPT's state and button stay on one line, and its line goes under them.
  assert.match(keys, /<span>ChatGPT<\/span>\s*<div class="set-ctl">\s*<div class="set-ctl set-inline">\s*<span class="settings-hint" id="chatgptState"[^]*?id="chatgptSignInBtn"[^]*?<\/button>\s*<\/div>\s*<div data-i18n class="settings-hint" id="chatgptHint">Used when Translation is ChatGPT \(the default on a new install\)\. The Dub Agent's Codex uses this sign-in too\.<\/div>\s*<\/div>/);
  assert.match(html, /get hunyuan\(\) \{ return \[t\("Runs on this computer, free and fastest\."\), t\("For accuracy, use the Gemini API\."\)\]; \}/);
  assert.match(html, /get gemma\(\) \{ return \[t\("Runs on this computer, free\."\), t\("For accuracy, use the Gemini API\."\)\]; \}/);
  assert.match(html, /get gemini\(\) \{ return \[t\("Most accurate\."\), t\("Needs a Google \(Gemini\) key in Settings > API keys\."\)\]; \}/);
  assert.match(html, /get chatgpt\(\) \{ return \[t\("Free within a ChatGPT account's limit\. Sign in once, no download\."\)\]; \}/,
    "ChatGPT's line is as it was");
  assert.ok(!html.includes('t("Needs an API key.")'));
});

// "Use the API" said which API to nobody: separation and speech-to-text point
// at the Perso API, the translator at the Gemini API (owner, 2026-10-21).
test("Audio separation and Speech-to-text on this computer point at the Perso API", () => {
  const html = readPage();
  assert.match(html, /sep: \{ get local\(\) \{ return \[t\("Runs on this computer, free\."\), t\("For accuracy, use the Perso API\."\)\]; \},/);
  assert.match(html, /stt: \{ get local\(\) \{ return \[t\("Runs on this computer, free\."\), t\("For accuracy, use the Perso API\."\)\]; \},/);
});

// The dubbing's own step that splits the voice from the background is Voice
// separation, so it no longer reads as the Separate audio tab (owner, 2026-10-22):
// in Korean on the running screen's steps and the finished dubbing's engine
// line too ("Separating audio" and "Separation" are only ever that step).
test("the dubbing step is Voice separation, and Separate audio is no tool of its own", () => {
  const html = readPage();
  assert.match(html, /<label data-i18n for="sepSelect">Voice separation<\/label>/);
  assert.ok(!html.includes('data-tab="audio"') && !html.includes('id="homeAudioCard"') && !html.includes('id="homeNavAudio"'));
  const ko = JSON.parse(readFileSync(new URL("../../static/i18n/ui.ko.json", import.meta.url), "utf8"));
  assert.equal(ko["Voice separation"], "목소리 분리");
  assert.equal(ko["Separating audio"], "목소리 분리");
  assert.equal(ko.Separation, "목소리 분리");
  assert.equal(ko["Separate audio"], "오디오 분리");
  // And the failure card of a dubbing that stopped on that step.
  assert.ok(ko["It stopped while separating the audio. Press Resume to go on from where it stopped. "
    + "If it stops again, you can try the Perso API."].startsWith("목소리를 분리하다가 멈췄어요."));
});

test("the sentence that named no API is gone from the page and from both tables", () => {
  assert.ok(!readPage().includes("For accuracy, use the API."));
  for (const code of ["en", "ko"]) {
    const table = JSON.parse(readFileSync(new URL(`../../static/i18n/ui.${code}.json`, import.meta.url), "utf8"));
    assert.ok(!Object.hasOwn(table, "For accuracy, use the API."), `ui.${code}.json still has it`);
  }
});

// The dialogs finished to the mockup (2026-09-29). What is pinned is what
// other files lean on: the ids, the box the options block goes home to, and
// the classes the block carries with it when a draft borrows it.
test("the New project dialog is two columns, and its options carry their own look", () => {
  const html = readPage();
  const from = html.indexOf('<div class="modal-overlay" id="projectOverlay">');
  const dlg = html.slice(from, html.indexOf("<!-- ============ EXPORT DIALOG", from));
  const at = (s) => { const i = dlg.indexOf(s); assert.ok(i >= 0, `${s} is in the dialog`); return i; };
  // Left: the picture, the long-video note, the download row, the trim bar.
  const left = at('class="project-left"'), right = at('class="project-right"'), foot = at('class="modal-foot project-actions"');
  for (const id of ["projectThumb", "projectVideo", "projectDur", "projectReplace", "projectLongHint", "dlRow", "trimBox"]) {
    const i = at(`id="${id}"`);
    assert.ok(left < i && i < right, `${id} is in the left column`);
  }
  // Right: the one box that scrolls holds the block; the error and the saved
  // line sit under it, outside the scroll.
  const box = at('class="project-options" id="projectOptions"');
  const error = at('id="projectError"');
  for (const id of ["langGrid", "stageHead", "advancedBody"]) {
    const i = at(`id="${id}"`);
    assert.ok(box < i && i < error, `${id} is home in #projectOptions`);
  }
  assert.ok(error < at('id="projectSaved"') && at('id="projectSaved"') < foot);
  // The footer: the length, then the three buttons, Start last.
  assert.ok(foot < at('id="projectLength"') && at('id="projectLength"') < at('id="saveClipBtn"')
    && at('id="saveClipBtn"') < at('id="eraseBtn"') && at('id="eraseBtn"') < at('id="startBtn"'));
  // The look travels on the moved nodes themselves.
  assert.match(dlg, /<div class="opt-panel" id="langGrid">/);
  assert.match(dlg, /<div class="opt-panel advanced-body" id="advancedBody">/);
  assert.equal((dlg.match(/<div class="field opt-row">/g) || []).length, 9, "Choose a model, two languages and six options, each a row");
  // Voice separation offers Demucs, Mel-Band RoFormer and Perso API, the RoFormer before it is downloaded too.
  assert.match(dlg, /<select id="sepSelect"><option value="local" selected>Demucs<\/option><option value="roformer">Mel-Band RoFormer<\/option><option value="perso">Perso API<\/option><\/select>/);
  for (const id of ["sourceLangSelect", "targetLangSelect", "dubModeSelect", "sepSelect", "sttSelect",
                    "translateSelect", "voiceSelect", "qualitySelect", "numSpeakers",
                    "dubModeHint", "sepHint", "sepModelHint", "sttHint", "sttModelHint", "translateHint", "translateModelHint",
                    "voiceHint", "voiceModelHint", "qualityHint"]) at(`id="${id}"`);
  assert.doesNotMatch(html, /\.project-(modal|right|options) \.opt-/, "no option rule depends on the dialog around it");
  assert.match(html, /\.project-modal \{ width: min\(720px, 92vw\);/);
  assert.match(html, /grid-template-columns: 320px minmax\(0, 1fr\); gap: 16px; padding: 16px; \}/);
  // Scrolling, the dialog keeps its stuck 55 foot clear the way the draft card does (H29).
  assert.match(html, /@media \(max-width: 759px\) \{\n    \.project-modal \{ overflow-y: auto; scroll-padding-bottom: 55px; \}/);
});

// The Advanced options fold is gone: the six stage rows are always in sight
// under a plain heading in the type the fold's button had, with no arrow, and
// the card they are in scrolls with Start stuck at its foot (owner,
// 2026-10-22, remark 2). ui/src/dubbingPrep.test.mjs runs it in the page.
test("the six stage rows are always in sight under Dubbing step settings, with no fold to open", () => {
  const html = readPage();
  const block = html.slice(html.indexOf('id="engineWarning"'), html.indexOf('id="projectError"'));
  assert.match(block, /<div data-i18n class="stage-head" id="stageHead">Dubbing step settings<\/div>\s*<div class="opt-panel advanced-body" id="advancedBody">/);
  const rows = block.slice(block.indexOf('id="advancedBody"'));
  assert.deepEqual([...rows.matchAll(/<label data-i18n for="(\w+)">/g)].map((m) => m[1]),
    ["sepSelect", "sttSelect", "translateSelect", "voiceSelect", "qualitySelect", "numSpeakers"], "six rows, in order");
  for (const gone of ["advancedBtn", "advanced-btn"]) assert.ok(!html.includes(gone), `no ${gone} left`);
  assert.doesNotMatch(html, /data-i18n[^>]*>\s*Advanced options\s*</, "no fold's name on screen");
  assert.match(html, /\.stage-head \{ padding: 10px 0 8px; font-size: 11\.5px; font-weight: 500; color: var\(--foreground\); \}/);
  // The card scrolls, and Start stays stuck at its foot.
  assert.match(html, /\.draft-setup \{ flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 10px;\n    padding: 14px 12px; overflow: auto;/);
  assert.match(html, /position: sticky; bottom: -14px;/);
  assert.match(readFileSync(fileURLToPath(new URL("./newProject.mjs", import.meta.url)), "utf8"),
    /container\.appendChild\(\$\("engineWarning"\)\);\n    container\.appendChild\(\$\("stageHead"\)\);\n    container\.appendChild\(\$\("advancedBody"\)\);/);
  const table = (code) => JSON.parse(readFileSync(new URL(`../../static/i18n/ui.${code}.json`, import.meta.url), "utf8"));
  assert.equal(table("ko")["Dubbing step settings"], "더빙 단계별 설정");
  assert.equal(table("en")["Dubbing step settings"], "Dubbing step settings");
  assert.ok(!Object.hasOwn(table("ko"), "Advanced options"), "the fold's name is out of the table");
});

// Choose a model (처리 방식 until the owner named it 모델 선택, 2026-10-22,
// remark 2 나, the Audio tab's words for its own choice) and the Dubbing
// model sit above the languages, outside the stage rows, because the
// languages follow both (owner, 2026-10-22). Choose a model is two halves,
// Local model and Perso API, over the hidden #dubModeSelect.
test("Choose a model and the Dubbing model come first in the options block, above the languages", () => {
  const html = readPage();
  const grid = html.slice(html.indexOf('<div class="opt-panel" id="langGrid">'), html.indexOf('id="engineWarning"'));
  const order = ['id="dubModeLabel"', 'id="dubModeSeg"', 'id="dubModeSelect"', 'id="persoModelRow"',
                 'id="sourceLangSelect"', 'id="targetLangSelect"'].map((s) => grid.indexOf(s));
  assert.ok(order.every((n, i) => n > 0 && (i === 0 || n > order[i - 1])), "Choose a model, the Dubbing model, then the two languages");
  assert.match(grid, /<label data-i18n id="dubModeLabel">Choose a model<\/label><div class="mode-seg" id="dubModeSeg" role="radiogroup" aria-labelledby="dubModeLabel"><button type="button" role="radio" id="dubModeLocal" aria-checked="true" data-i18n>Local model<\/button><button type="button" role="radio" id="dubModePerso" aria-checked="false">Perso API<\/button><\/div><select id="dubModeSelect" hidden>/);
  const advanced = html.slice(html.indexOf('id="advancedBody"'), html.indexOf('id="projectError"'));
  assert.ok(!advanced.includes("dubModeSelect") && !advanced.includes("persoModelRow"), "neither is among the stage rows");
  assert.ok(!html.includes(">On this computer<"), "the old name of the choice is gone");
  assert.match(html, /\.opt-row > \.mode-seg \{ grid-column: 2; grid-row: 1; display: flex; height: 24px;/);
  assert.match(html, /\.mode-seg button\[aria-checked="true"\] \{ background: var\(--primary\); color: var\(--primary-foreground\); \}/);
  const ko = JSON.parse(readFileSync(new URL("../../static/i18n/ui.ko.json", import.meta.url), "utf8"));
  assert.deepEqual([ko["Choose a model"], ko["Local model"]], ["모델 선택", "로컬 모델"]);
  // "Model" alone is the Dub Agent's picker, 모델 (ui/src/agentStrip.mjs).
  assert.equal(ko.Model, "모델");
  assert.ok(!Object.hasOwn(ko, "On this computer"));
  assert.ok(!Object.hasOwn(ko, "Processing"), "the old name is out of the table");
});

// The Target language is a list with a search field, in the Dubbing model's
// dress, over the hidden #targetLangSelect (owner, 2026-10-22).
// ui/src/newProject.test.mjs runs it.
test("the Target language is a list with a search on top, not a bare dropdown", () => {
  const html = readPage();
  assert.match(html, /<label data-i18n id="targetLangLabel">Target language<\/label><div class="model-pick" id="targetLangPick"><\/div><select id="targetLangSelect" hidden><\/select>/);
  assert.match(html, /\.lang-search \{ display: flex; align-items: center; gap: 7px; height: 28px;/);
  assert.match(html, /\.lang-opts \{ position: relative; display: flex; flex-direction: column; gap: 1px; max-height: 240px; overflow-y: auto; \}/);
  const ko = JSON.parse(readFileSync(new URL("../../static/i18n/ui.ko.json", import.meta.url), "utf8"));
  assert.equal(ko["Search languages"], "언어 검색");
  assert.equal(ko["{shown} of {all}"], "{all}개 중 {shown}개");
});

// The Video card's two ways out, words at its top right in the erase card's
// Reset dress, and the line under it for a video taking its place (owner,
// 2026-10-22). ui/src/draftSetup.test.mjs, draftImport.test.mjs and
// dubbingPrep.test.mjs run them.
test("the Video card has Replace · Remove at its top right, and a line under it only when it has something to say", () => {
  const html = readPage();
  assert.match(html, /<div class="draft-part">\s*<div class="draft-card video-card" id="draftPartCard"><\/div>\s*<span class="vc-acts"><button data-i18n class="erase-link" id="draftReplaceBtn" type="button">Replace<\/button><span aria-hidden="true">·<\/span><button data-i18n class="erase-link vc-del" id="draftRemoveBtn" type="button">Remove<\/button><\/span>\s*<\/div>\s*<div class="import-status draft-import-status" id="draftImportStatus"><\/div>/);
  assert.match(html, /\.draft-part \{ position: relative; \}/);
  assert.match(html, /\.draft-part \.vc-acts \{ position: absolute; right: 13px; top: 11px;/);
  assert.match(html, /\.draft-part \.vc-del \{ color: var\(--destructive\); \}/);
  assert.match(html, /\.draft-import-status:empty \{ display: none; \}/);
  // A replaced video's Draft card leaves Home, as one an erase started on does.
  assert.match(html, /onReplaced: \(downloadId\) => forgetDraft\(downloadId\),/);
  const ko = JSON.parse(readFileSync(new URL("../../static/i18n/ui.ko.json", import.meta.url), "utf8"));
  assert.equal(ko.Replace, "바꾸기");
  assert.equal(ko.Remove, "삭제");
});

// Under the last choice, what the dubbing hands back, in the erase card's
// dress: a label and one line, the same for both ways of dubbing (owner,
// 2026-10-22, remarks 10+11). ui/src/dubbingPrep.test.mjs runs it in the page.
test("Before dubbing says what you get under the last choice: dubbed video, subtitles and audio files", () => {
  const html = readPage();
  const card = html.slice(html.indexOf('<div class="draft-setup" id="draftSetup" hidden>'), html.indexOf('id="dubbingPaneHead"'));
  assert.match(card, /<div id="draftOptionsSlot"><\/div>\s*<!--[^]*?-->\s*<div class="erase-card draft-result" id="draftResult"><div data-i18n class="k">What you get<\/div><div class="m"><span data-i18n>Dubbed video, subtitles and audio files<\/span><\/div><\/div>\s*<div class="form-error" id="draftError"><\/div>\s*<div class="draft-foot">/);
  assert.match(html, /\.draft-result \{ margin: 12px 0 10px; \}\n  \.draft-result \.m \{ line-height: 1\.5; \}/);
  // Nothing in the page's code writes over it, in either mode.
  assert.ok(!html.includes('$("draftResult")'));
  const table = (code) => JSON.parse(readFileSync(new URL(`../../static/i18n/ui.${code}.json`, import.meta.url), "utf8"));
  assert.equal(table("ko")["What you get"], "이 작업을 하면 이렇게 나와요");
  assert.equal(table("ko")["Dubbed video, subtitles and audio files"], "더빙 영상, 자막, 오디오 파일로 나와요");
  assert.equal(table("en")["What you get"], "What you get");
  assert.equal(table("en")["Dubbed video, subtitles and audio files"], "Dubbed video, subtitles and audio files");
});

// With Perso API the stage rows read "Perso" over the dropdowns' own words,
// which stay their values; only the words are hidden, so the arrow stays
// (owner, 2026-10-22, the 2-1 picture). ui/src/dubbingPrep.test.mjs runs it.
// The four stages are buttons that say Perso themselves (ui/src/stagePicker.test.mjs);
// the word is painted only over a dropdown still on screen, so never twice.
test("a Perso dubbing's greyed stage rows read Perso, and say Perso handles them", () => {
  const html = readPage();
  assert.match(html, /\.advanced-body\.by-perso \.opt-row > select \{ -webkit-text-fill-color: transparent; \}/);
  assert.match(html, /\.advanced-body\.by-perso \.opt-row:has\(> select:not\(\[hidden\]\)\)::after \{ content: "Perso"; grid-column: 2; grid-row: 1;/);
  assert.match(html, /\$\("advancedBody"\)\.classList\.toggle\("by-perso", cloud\);/);
  const ko = JSON.parse(readFileSync(new URL("../../static/i18n/ui.ko.json", import.meta.url), "utf8"));
  assert.equal(ko["Perso handles this."], "Perso가 처리해요.");
  assert.equal(ko["The video is uploaded to Perso."], "영상이 Perso로 올라가요.");
});

test("the confirms keep their corner X for its listeners, but hidden", () => {
  const html = readPage();
  for (const id of ["creditCloseX", "cancelDubCloseX", "deleteCloseX", "spaceCloseX"]) {
    assert.match(html, new RegExp(`<button class="modal-close" id="${id}" type="button" aria-label="Close" data-i18n-aria-label="Close" hidden>`));
  }
  // The dialog rule (2026-09-30): no dialog shows a corner X. The ones that
  // had one on screen keep the element, hidden, where a listener reaches it;
  // New project's two windows wear the id on their foot's Cancel instead.
  for (const id of ["exportCloseX", "settingsCloseBtn", "mediaReplaceCloseX"]) {
    assert.match(html, new RegExp(`<button class="modal-close" id="${id}"[^>]* hidden>`));
  }
  for (const id of ["projectClose", "newProjClose"]) {
    assert.match(html, new RegExp(`<button class="btn btn-(outline|secondary)" id="${id}" type="button">Cancel</button>`));
  }
  assert.ok(!html.includes("upd-close"), "the update window's red dot is back");
});

// People looked for Export beside the video, not among the window's own
// buttons (feedback sheet, 2026-10-21; owner 4-1 가, 2026-10-22). The one
// button stands at the right end of the finished panel's tab row in the
// markup, and each of the three video panels' rows has an id to move it to
// (ui/src/workFrame.mjs, which is tested there).
test("Download is one button, at the right end of the video panel's tab row", () => {
  const html = readPage();
  assert.equal(html.match(/id="exportBtn"/g).length, 1, "one Export button on the page");
  const pane = (id, next) => html.slice(html.indexOf(`<div class="video-pane" id="${id}">`), html.indexOf(next));
  const done = pane("videoPane", 'id="runPane"');
  const row = done.slice(done.indexOf('<div class="video-tabs" id="videoTabsNormal">'), done.indexOf('<div class="video-body">'));
  assert.match(row, /id="vtabDubbed">Dubbed<\/button>\s*<!--[^]*?-->\s*<button data-i18n class="btn btn-primary" id="exportBtn" type="button" hidden>Download<\/button>\s*<\/div>/,
    "last in the finished panel's tab row, after Original and Dubbed");
  assert.match(pane("runPane", 'id="erasePane"'), /<div class="video-tabs" id="runTabs">\s*<button class="vtab active" type="button">Original<\/button>/);
  assert.match(pane("erasePane", "<!-- ============ AGENT PANEL"), /<div class="video-tabs erase-tabs" id="eraseTabs">/);
  // Pushed to the row's right end, in the middle of its height.
  assert.match(html, /\.video-tabs #exportBtn \{ align-self: center; margin: 0 9px 0 auto; \}/);
  assert.match(html, /\.video-tabs \{ flex: 0 0 auto; box-sizing: border-box; height: 42px; display: flex;/);
});

// The Subtitle style tab's looks moved into the dub's last step (owner,
// 2026-10-22, 지적 14 가): a button just left of Download in the finished
// panel's tab row opens the same twelve over the top of the picture, in two
// rows of six with what they make under them (mock 지적 시안 C). The tab
// itself stays for now. The button's work is ui/src/captionsTab.mjs's.
// Over a dub's picture (owner, 2026-10-23): no button beside Download, a
// chip just above the subtitle that opens the same looks above it.
test("the Subtitle style chip sits in the subtitle overlay and opens the looks, Download alone in the row", () => {
  const html = readPage();
  const done = html.slice(html.indexOf('<div class="video-pane" id="videoPane">'), html.indexOf('<div class="video-under"'));
  const row = done.slice(0, done.indexOf("</div>"));
  assert.ok(!html.includes('id="videoStyleBtn"'), "no Subtitle style button in the tab row");
  assert.ok(row.indexOf('id="vtabDubbed"') < row.indexOf('id="exportBtn"'));
  assert.match(done, /<div class="sub-overlay" id="subOverlay" hidden>\s*<span class="sub-ov-text" id="subOverlayText"><\/span>\s*<button class="sub-style-chip" id="subStyleChip" type="button" aria-haspopup="dialog"\s+aria-expanded="false" hidden><svg[^]*?<\/svg><span data-i18n>Subtitle style<\/span><\/button>\s*<\/div>/);
  // Its looks: shut to begin with, the tab's own label and tiles, and the
  // line that says what comes out.
  const pop = done.slice(done.indexOf('<div class="video-style-pop" id="videoStylePop"'));
  assert.match(pop, /^<div class="video-style-pop" id="videoStylePop" role="dialog" aria-label="Subtitle style"\s+data-i18n-aria-label="Subtitle style" hidden>/);
  assert.match(pop, /<div class="cap-label"><span data-i18n>Styles · 12<\/span><\/div>\s*<div class="cap-grid" id="videoStyleGrid"><\/div>/);
  assert.match(pop, /<div class="erase-card video-style-result"><div data-i18n class="k">What you get<\/div>\s*<div class="m"><span data-i18n>The video with subtitles burned in, and the subtitle file<\/span><\/div><\/div>/);
  const ko = JSON.parse(readFileSync(new URL("../../static/i18n/ui.ko.json", import.meta.url), "utf8"));
  assert.equal(ko["What you get"], "이 작업을 하면 이렇게 나와요");
  assert.equal(ko["The video with subtitles burned in, and the subtitle file"], "자막을 입힌 영상과 자막 파일이 나와요");
  assert.equal(ko["Abc 123"], "가나다 ABC");
  // The looks 560px wide, placed by script, never wider or taller than the
  // panel; the tiles carry no frame of the video.
  assert.match(html, /\.video-style-pop \{ position: absolute; z-index: 6;[^}]*width: min\(560px, calc\(100% - 16px\)\); max-height: calc\(100% - 47px\); overflow-y: auto;/);
  assert.match(html, /\.video-style-pop \.cap-grid \{ grid-template-columns: repeat\(6, minmax\(0, 1fr\)\);/);
  assert.match(html, /\.cap-pv \{[^}]*background: none;/);
  assert.match(html, /\.sub-style-chip \{ position: absolute;[^}]*background: rgba\(0, 0, 0, 0\.6\);/);
  // Download's subtitled video asks for the look the player shows.
  assert.match(html, /const \{ preset: subPreset, query: posQ \} = subtitles\.exportParams\(\);/);
  assert.match(html, /subtitled: \{ href: `\/api\/dub\/result\/\$\{job\.id\}\/subtitled\?preset=\$\{subPreset\}\$\{posQ\}&download=1\$\{mark\}`,/);
});

test("the Download dialog is rows to tick and a foot with Cancel and Download", () => {
  const html = readPage();
  // The rows themselves are ui/src/exportDialog.mjs, tested there; the page
  // opens the one dialog from the one button.
  assert.match(html, /\$\("exportBtn"\)\.addEventListener\("click", \(\) => exportDialog\.open\(\)\);/);
  assert.match(html, /\/\* === export === \*\//);
  assert.match(html, /<button class="btn btn-secondary" id="exportCloseBtn" type="button">Cancel<\/button>\s*<button class="btn btn-primary" id="exportGoBtn" type="button">Download<\/button>/);
});

// The feature is called Download on screen (owner, 2026-10-22), 다운로드 in
// Korean: the button, the dialog's title and its own button, the Audio tab's
// way into it, the sentences it says while it works, and Help. The ids and
// the code's names kept "export".
test("Download is the feature's name on screen: its buttons, its dialog, its sentences and Help", () => {
  const html = readPage();
  for (const id of ["exportBtn", "exportGoBtn"]) {
    assert.match(html, new RegExp(`id="${id}" type="button"(?: hidden)?>Download</button>`), id);
  }
  assert.match(html, /<div class="modal export-modal"[^>]*>\s*<div class="modal-head">\s*<h2 data-i18n>Download<\/h2>/);
  assert.doesNotMatch(html, />\s*Export\s*</, "no element says Export");
  const words = readFileSync(new URL("./markupWords.mjs", import.meta.url), "utf8");
  assert.ok(words.includes('["#exportGoBtn", t("Download")]'));
  const help = "Paste a YouTube, TikTok or Reels link. The video is fetched to this computer; Download saves it, or dub it or erase it from there.";
  assert.ok(html.includes(`<p>${help}</p>`) && words.includes(`t("${help}")`), "Help says Download");
  const ko = JSON.parse(readFileSync(new URL("../../static/i18n/ui.ko.json", import.meta.url), "utf8"));
  assert.equal(ko.Download, "다운로드");
  for (const key of ["Downloading {i} of {n}…", "Could not download this file", "Nothing to download yet", help,
                     "Paste a link and the video is fetched to this computer. Then Download saves it."]) {
    assert.match(ko[key], /다운로드/, key);
  }
  for (const gone of ["Export", "Exporting {i} of {n}…", "Could not export this file", "Nothing to export yet"]) {
    assert.ok(!Object.hasOwn(ko, gone), `"${gone}" is said nowhere any more`);
  }
});

// qa-fixes 3: a 1280px window with the Dub Agent open left the script pane
// about 427px, narrower than the 590px tier's row was ever shrunk to fit --
// its last button (stuck to the right edge) poked 3px out of #scriptBox. This
// deeper tier keeps the row inside its pane down to 380px, no sideways
// scroll, without touching the 975/668/590 tiers above it (index.html
// ~1350-1393, ui/src/scriptTable.test.mjs covers those already).
test("the script row keeps shrinking below the 590px tier, down to a 380px pane", () => {
  const html = readPage();
  assert.match(html,
    /@container scriptpane \(max-width: 460px\) \{[^}]*\.sc-row \{ grid-template-columns: 36px 30px 62px 22px minmax\(80px, 1fr\) 114px;/);
  // Tracks + five 4px gaps + 8px each side: exactly the 380px floor.
  assert.equal(36 + 30 + 62 + 22 + 80 + 114 + 5 * 4 + 2 * 8, 380);
});

// "cut 0.3s" is 56px wide and the clock "00:00:00.5" is 61: narrower tracks
// put their ends under the button beside them (seen at 1280x800, 2026-09-30).
test("no narrow tier gives the length verdict under 58px or the clock under 62px", () => {
  const html = readPage();
  const tiers = html.slice(html.indexOf("@container scriptpane (max-width: 975px)"), html.indexOf("/* === work === */"));
  const verdicts = [...tiers.matchAll(/\.sc-tools \{ grid-template-columns: (\d+)px 22px 22px;/g)].map((m) => Number(m[1]));
  assert.equal(verdicts.length, 3);
  for (const w of verdicts) assert.ok(w >= 58, `verdict track ${w}px`);
  const clocks = [...tiers.matchAll(/\.sc-row \{ grid-template-columns: \d+px \d+px (\d+)px/g)].map((m) => Number(m[1]));
  assert.equal(clocks.length, 4);
  for (const w of clocks) assert.ok(w >= 62, `clock track ${w}px`);
});

// Clicking the subtitle drawn on the video opens Captions (subSelect) and makes
// "This line" the scope -- but only for a click, never at the end of a drag,
// and only on a burn-in project: a dub's subtitles are not styled line by line.
test("a click on the video's subtitle picks 'This line', and nothing drags it up or down", () => {
  const subs = readFileSync(SUBTITLES, "utf8");
  assert.match(subs, /subSelect\(true\);\n[^\n]*\n\s*if \(burnIn\(\)\) \{ subScope = "one"; paintSubToolbar\(\); \}/);
  assert.ok(!/subStyle\.pos = Math/.test(subs), "the position is SUB_POS, never the pointer's");
});

// Editing before dubbing, the same on every tab (mockup edit-flow, user
// 2026-09-30): no + step, each tab's foot is the way on. Another language of
// the same video is + Add language in the row at the panel's foot (mockup
// script-buttons, 2026-10-01): there is no New dubbing button any more.
test("the edit flow: per-tab foots, no preview strip, and Add language on a dub's screens", () => {
  const html = readPage();
  assert.ok(!html.includes('id="mediaPreviewBar"'), "an import is on the timeline at once");
  assert.ok(!html.includes('id="draftSaveClipBtn"'), "saving is the top bar's Export");
  assert.ok(!html.includes(">New dubbing<"), "New project is the only other way to start");
  assert.ok(!/dubAgainBtn|initDubAgain|\.dub-again/.test(html));
  // The row is the left panel's last child, after the running and failure cards.
  const pane = html.slice(html.indexOf('id="scriptPane"'), html.indexOf('id="videoPane"'));
  assert.ok(pane.indexOf('id="langRow"') > pane.indexOf('id="doneFail"'));
  assert.match(html, /#leftTabs:has\(\[data-tab="dubbing"\]:not\(\.on\)\) ~ \.lang-row/);
  assert.match(html, /openDraft: openDraftHere,/);
  // A project's delete reaches every language (ui/src/confirmDialogs.mjs), and
  // the draft's Back forgets the project.
  assert.match(readFileSync(CONFIRMS, "utf8"), /for \(const id of ids\) \{\n\s*const r = await fetch\(`\/api\/dub\/jobs\/\$\{id\}\/workspace`/);
  assert.match(html, /state\.draftFromJob = null;\n\s*state\.draftProject = null;/);
  // An erased video opens a new project on its Dubbing tab.
  // The Erase tab carries the same video card.
  for (const id of ["eraseVideoCard", "draftPartCard"]) {
    assert.ok(html.includes(`id="${id}"`), `#${id} is gone`);
  }
  assert.match(html, /onDub: \(held\) => openDraftHere\(\{[^}]*\}, \{ tab: "dubbing" \}\)/);
  // Home's Dubbing card and item open an empty project on its Dubbing tab,
  // whose Import block takes a link too, not the bare file picker (owner, 2026-10-09).
  assert.match(html, /onDubbing: \(\) => draftSetup\.openDraft\(null, \{ tab: "dubbing" \}\),/);
  assert.equal((html.match(/\/\* === flow === \*\//g) || []).length, 1, "one CSS block");
});

// The folded-away project list is still in the page; without `inert` the Tab
// key walked through its twelve hidden buttons before reaching Home's own.
test("the old project list takes no keyboard focus, and every kind of button has an off look", () => {
  const html = readPage();
  assert.match(html, /<div class="history-sidebar collapsed" id="historySidebar" inert>/);
  assert.match(html, /\.btn-secondary:disabled, \.btn-cancel:disabled, \.btn-danger:disabled \{ opacity: 0\.5; cursor: not-allowed; \}/);
  assert.match(html, /select:disabled \{ opacity: 0\.45; cursor: not-allowed; \}/);
});

// Leaving a draft with Home keeps it (owner, 2026-09-30): ui/src/keptDrafts.mjs
// remembers it, ui/src/homeScreen.mjs draws its card, and the page says when.
test("a draft is kept when it changes and when it is left, and let go when it is dubbed or deleted", () => {
  const html = readPage();
  assert.match(html, /onDraftChange\(rememberDraft\);/);
  assert.match(html, /function resetForNewJob\(\) \{\n[^}]*?rememberDraft\(\);\n[^}]*?if \(state\.jobId && getDraft\(\)\) clearDraft\(\);/,
    "kept before the screen is left; a video held beside a project goes with that project");
  // Not a draft: the video an open project's Erase tab holds, nor one whose
  // erase was started this run (that job's card stands for it, 2026-10-21).
  assert.match(html, /if \(!d \|\| !d\.downloadId \|\| state\.jobId \|\| startedOn\.has\(d\.downloadId\)\) return;/);
  assert.match(html, /function draftBecameJob\(downloadId\) \{\n  startedOn\.add\(downloadId\);\n  forgetDraft\(downloadId\);\n\}/);
  assert.match(html, /onEraseStarted: draftBecameJob,/);
  // Kept with the tab it is on, and opened there again; Home keeps the one it had.
  assert.match(html, /const tab = screen === "erase" \? "erase" : screen === "home"\n    \? \(keptDrafts\.find\(\(k\) => k\.downloadId === d\.downloadId\) \|\| \{\}\)\.tab : leftTabs\.current\(\);\n  keptDrafts = keepDraft\(localStorage, \{ \.\.\.d, tab \}, keptDrafts\);/);
  assert.match(html, /if \(kept\.tab === "erase"\) \{ eraseScreen\.openEraseTab\(\); return; \}\n  draftSetup\.showDraftScreen\(\);\n  leftTabs\.show\(kept\.tab\);\n\}/);
  assert.match(html, /const started = await submitDubStart\(o\);\n    if \(started && d\) forgetDraft\(d\.downloadId\);/);
  // The delete question is ui/src/confirmDialogs.mjs's, written one level in.
  assert.match(readFileSync(CONFIRMS, "utf8"), /if \(job\.draftId\) \{\n      forgetDraft\(job\.draftId\);/);
  // Reopened: held again first (the app forgets what it holds when it restarts).
  assert.match(html, /await holdDownload\(downloadId, \{ title: kept\.name, duration: kept\.duration \}\);/);
  assert.match(html, /onOpenDraft: \(id\) => reopenDraft\(id\),/);
  // Made again from what was kept, it starts on the remembered choices, as a
  // new draft does: after a restart nothing else had put them back, and the
  // card opened on English, ChatGPT and Fast mode (Windows test B7, 2026-10-10).
  assert.match(html, /setRanges\(kept\.ranges\);\n[^}]*?newProject\.startOnDefaults\(\)\.then\(draftSetup\.paint, \(\) => \{\}\);\n  \}/,
    "a draft made again from its card starts on the remembered choices");
});

test("a resumed dub's failure card goes when the dub is running again", () => {
  const html = readPage();
  assert.match(html, /if \(running\) \{\n[^}]*\$\("doneFail"\)\.hidden = true;\n    runningScreen\.paintRunning\(job\);/);
});

// The owner's complaint (2026-09-30): the three tabs with no video were three
// different screens, and the Erase tab changed the panels' widths and the
// player's foot. One frame and one empty state.
test("the three center panels are one panel: one width, one grip, one foot", () => {
  const html = readPage();
  const timeline = readFileSync(TIMELINE, "utf8");
  // No panel is given a width by id: the dragged width is a variable on the row.
  assert.match(timeline, /\$\("doneMain"\)\.style\.setProperty\("--video-flex", `0 0 \$\{w\}px`\)/);
  assert.ok(!/\$\("videoPane"\)\.style\.flex/.test(timeline + html), "the finished video has a width of its own again");
  assert.ok(!/#(erasePane|runPane|videoPane)\s*\{[^}]*\b(flex|flex-basis|width):/.test(html), "a center panel has a size of its own");
  const panes = { videoPane: "runPane", runPane: "erasePane", erasePane: "agentStrip" };
  for (const [id, next] of Object.entries(panes)) {
    const pane = html.slice(html.indexOf(`<div class="video-pane" id="${id}">`), html.indexOf(`id="${next}"`));
    assert.ok(pane.length > 100, `${id} is not where it was`);
    assert.equal((pane.match(/class="grip grip-x grip-panes"/g) || []).length, 1, `${id} has no grip`);
    // The foot: the clock, play, Preview, Ratio, full screen, in that order.
    const foot = pane.slice(pane.indexOf('class="video-under"'));
    const order = ['class="video-time"', 'class="video-play"', 'class="preview-btn"', 'class="ratio-btn"', 'class="video-fs"']
      .map((c) => foot.indexOf(c));
    assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `${id}'s foot is not the shared row: ${order}`);
  }
  // Where Preview and Ratio do nothing they are off, not missing.
  for (const id of ["runPane", "erasePane"]) {
    const pane = html.slice(html.indexOf(`id="${id}"`), html.indexOf(`id="${panes[id]}"`));
    assert.match(pane, /class="preview-btn" type="button" disabled/);
    assert.match(pane, /class="ratio-btn" type="button" disabled/);
  }
});

test("Dubbing, Erase, Burn in subtitles and Save video with no video draw one empty state", async () => {
  const html = readPage();
  const { emptyTabHtml, EMPTY_TABS } = await import("./importBlock.mjs");
  assert.deepEqual(EMPTY_TABS, {
    dubbing: ["Dubbing", "Voice a video in another language."],
    erase: ["Erase subtitles", "Takes burned-in subtitles out."],
    // Burn in subtitles starting a project (owner, 2026-10-22, 2026-10-23).
    captions: ["Burn in subtitles", "Burns subtitles into a video."],
    // Save video saves a video from a link (owner, 2026-10-24).
    save: ["Save video", "Saves a video from a link."],
  });
  // The same three pieces in the same order, whatever the tab.
  const shape = (tab) => emptyTabHtml(tab, "z", "l")
    .replace(EMPTY_TABS[tab][0], "H").replace(EMPTY_TABS[tab][1], "S");
  assert.equal(shape("erase"), shape("dubbing"));
  assert.equal(shape("captions"), shape("dubbing"));
  assert.match(shape("dubbing"), /^<div class="tab-empty-title">H<\/div><div class="tab-empty-sub">S<\/div><div class="import-block" id="z"/);
  // Save video's block is the link field alone: no Import head, no drop line,
  // nothing that opens the file picker.
  assert.match(shape("save"), /^<div class="tab-empty-title">H<\/div><div class="tab-empty-sub">S<\/div><div class="import-block link-only" id="z"><label class="import-link" id="lRow">/);
  assert.ok(!/import-head|import-sub|tabindex/.test(shape("save")));
  // Each tab's face is the one frame: the group, the slot the module fills,
  // and what an import says hung under it.
  for (const [face, slot, says] of [["dubbingImport", "dubbingImportSlot", "dubbingImportStatus"],
                                    ["eraseDrop", "eraseImportSlot", "eraseDropError"],
                                    ["saveImport", "saveImportSlot", "saveImportStatus"]]) {
    const at = html.indexOf(`<div class="tab-empty" id="${face}"`);
    assert.ok(at > 0, `${face} is not the shared empty state`);
    const body = html.slice(at, html.indexOf(`id="${says}"`, at));
    assert.match(body, new RegExp(`<div class="tab-empty-group">\\s*(<!--[^]*?-->\\s*)?<div id="${slot}"></div>`));
    assert.ok(body.includes('<div class="tab-empty-under">'), `${face}'s status line is in the group's flow`);
  }
  for (const [file, tab] of [[DRAFT_IMPORT, "dubbing"], [ERASE, "erase"],
                             [fileURLToPath(new URL("./captionsTab.mjs", import.meta.url)), "captions"]]) {
    assert.match(readFileSync(file, "utf8"), new RegExp(`outerHTML = emptyTabHtml\\("${tab}", `));
  }
  assert.match(readFileSync(DRAFT_IMPORT, "utf8"), /outerHTML = emptyTabHtml\("save", /);
  // Centred both ways, and the tab's small top-left name gives way to it.
  assert.match(html, /\.tab-empty \{[^}]*align-items: center; justify-content: center;/);
  assert.match(html, /\.erase-content:has\(> \.tab-empty:not\(\[hidden\]\)\) > :is\(\.erase-label, \.erase-desc\) \{ display: none; \}/);
});

test("with no video there is no play sign over the panel and the foot's play is off", async () => {
  const html = readPage();
  assert.match(html, /\.video-wrap:has\(> video:not\(\[src\]\)\) \.video-bigplay \{ display: none; \}/);
  assert.match(readFileSync(PLAYER, "utf8"), /btn\.disabled = !doneVideo\.getAttribute\("src"\);/);
  const { initPlayerFoot } = await import("./playerFoot.mjs");
  const on = {};
  const video = { paused: true, ended: false, src: "", getAttribute: () => video.src,
                  addEventListener: (e, fn) => { on[e] = fn; }, currentTime: 0, duration: NaN };
  const btn = () => ({ addEventListener() {}, setAttribute() {} });
  const play = btn();
  initPlayerFoot({ video, time: {}, play, fullscreen: btn(), stage: {}, doc: {} });
  assert.equal(play.disabled, true);
  video.src = "/v.mp4";
  on.loadstart();
  assert.equal(play.disabled, false);
  video.src = "";
  on.emptied();
  assert.equal(play.disabled, true);
});

// The script's three buttons (mockup script-one-ui): always in one place, in
// one order, each with its hover text (scriptTable.mjs writes it: what each
// does depends on the lines); no menu, and no "Proofread" on screen. Beside
// the line count, what translated the script (B15).
test("the Script pane's head has Retranslate unfit lines, Remake voices and All at once, and no menu", () => {
  const html = readPage();
  const head = html.slice(html.indexOf('id="dubbingPaneHead"'), html.indexOf('id="doneNotice"'));
  assert.match(head, /<span class="m" id="scriptCount"><\/span>\s*<span class="sc-model" id="scriptModel"><\/span>/);
  assert.match(head, /id="retranslateBtn" type="button">[^]*Retranslate unfit lines<\/button>[^]*id="remakeVoicesBtn" type="button" disabled>[^]*Remake voices<span id="remakeVoicesCount"><\/span><\/button>[^]*id="allAtOnceBtn" type="button">[^]*All at once<\/button>/);
  assert.match(head, /id="scriptChanged" hidden/, "the strip under the head");
  assert.ok(!html.includes("retranslateMenu") && !html.includes("retr-menu"), "no menu");
  const table = readFileSync(new URL("./scriptTable.mjs", import.meta.url), "utf8");
  for (const [name, text] of [["index.html", html], ["scriptTable.mjs", table]]) {
    assert.ok(!/Proofread/.test(text.replace(/\/\/.*|\/\*[^]*?\*\/|<!--[^]*?-->/g, "")), `${name} says Proofread`);
  }
});

// A line pressed in the script table (owner, 2026-10-21): the video stops just
// inside its start, the clock, row and playhead follow, the strip scrolls to
// it; the line wears a bar down its left edge.
test("a script line pressed stops the video at its start and the strip is brought to it", () => {
  const html = readPage();
  assert.match(html, /onSeekLine: \(start\) => \{\n    cancelRange\(doneVideo\);\n    doneVideo\.currentTime = start \+ 0\.001;\n    donePlayer\.paintPlayhead\(\);\n    timeline\.revealTime\(start\);\n  \},/);
  assert.match(html, /\.sc-row\.sc-sel \{ box-shadow: inset 3px 0 0 var\(--primary\); \}/);
});

// Help (owner, 2026-10-09): one button above Send feedback, and one dialog
// that says what each tool does and where it runs, in the sidebar's order,
// with the guide and the FAQ under them and OK as its only way out.
// Home's four tools, the same four in the same order on the cards and in the
// sidebar (owner, 2026-10-23), and the banner's line naming what a video
// can be made into.
test("Home's cards and sidebar are Dubbing, Erase subtitles, Burn in subtitles and Save video", () => {
  const html = readPage();
  const cards = html.slice(html.indexOf('<div class="home-cards">'), html.indexOf('id="linkCard"'));
  assert.deepEqual([...cards.matchAll(/id="home(\w+)Card"/g)].map((m) => m[1]), ["Agent", "Dub", "Erase", "Captions", "Save"]);
  const side = html.slice(html.indexOf('<aside class="home-side"'), html.indexOf("</aside>"));
  assert.deepEqual([...side.matchAll(/id="homeNav(\w+)"/g)].map((m) => m[1]), ["Dub", "Erase", "Captions", "Save", "Settings"]);
  assert.match(cards, /id="homeCaptionsCard" type="button">\s*<span class="home-card-icon"><svg class="icon" viewBox="0 0 24 24"><rect width="18" height="14" x="3" y="5" rx="2" ry="2"\/>[^]*?<div data-i18n class="home-card-title">Burn in subtitles<\/div>\s*<div data-i18n class="home-card-desc">Put a subtitle file on a video in the style you choose<\/div>/);
  assert.match(cards, /<div data-i18n class="home-card-desc">Saves a video from a link<\/div>/);
  assert.match(html, /<span data-i18n class="home-banner-title">Create project<\/span>/);
  assert.match(html, /<div data-i18n class="home-banner-sub">Upload a video to dub it, erase or burn in subtitles, or save it from a link\. Drop it here or click to choose<\/div>/);
  assert.match(html, /onCaptions: \(\) => draftSetup\.openDraft\(null, \{ tab: "captions" \}\),/);
  const ko = JSON.parse(readFileSync(new URL("../../static/i18n/ui.ko.json", import.meta.url), "utf8"));
  assert.equal(ko["Upload a video to dub it, erase or burn in subtitles, or save it from a link. Drop it here or click to choose"],
    "영상을 올리면 더빙 · 자막 지우기 · 자막 입히기 · 링크 저장을 할 수 있어요. 끌어 놓거나 눌러서 골라 주세요");
  assert.equal(ko["Burn in subtitles"], "자막 입히기");
  assert.equal(ko["Put a subtitle file on a video in the style you choose"], "영상과 자막 파일을 넣으면 원하는 스타일로 자막을 입혀요");
  assert.equal(ko["Saves a video from a link"], "링크로 올린 영상을 저장해요");
});

test("Home's Help sits above Send feedback and opens its tools and the Dub Agent in order", () => {
  const html = readPage();
  const side = html.slice(html.indexOf('class="home-grow"'), html.indexOf('id="homeWhatsNew"'));
  assert.match(side, /<button class="home-fb" id="homeHelp" type="button"><svg class="icon" viewBox="0 0 24 24">[^]*?<\/svg>Help<\/button>\s*<button class="home-fb" id="homeFeedback"/);
  assert.match(html, /onHelp: \(\) => openHelp\(\),/);
  const at = html.indexOf('<div class="modal-overlay" id="helpOverlay">');
  assert.ok(at > 0, "the Help dialog is in the page");
  const dialog = html.slice(at, html.indexOf('<div class="modal-overlay"', at + 1));
  assert.match(dialog, /aria-labelledby="helpTitle"[^>]*>\s*<div class="modal-head"><h2 id="helpTitle">What PersoDub does<\/h2>/);
  const names = [...dialog.matchAll(/<div class="help-item"><b>([^<]+)<\/b>(?:<p>[^<]+<\/p>)+<div class="help-where">[^<]+<\/div><\/div>/g)].map((m) => m[1]);
  // Separate audio is no tool of its own (owner, 2026-10-23).
  assert.deepEqual(names, ["Dubbing", "Erase subtitles", "Save video", "Dub Agent"]);
  assert.match(dialog, /<p class="help-links"><a href="#" id="helpGuide">User guide<\/a> · <a href="#" id="helpFaq">FAQ<\/a><\/p>/);
  assert.match(dialog, /<div class="modal-foot"><button class="btn btn-primary" id="helpOk" type="button">OK<\/button><\/div>/);
  assert.ok(!dialog.includes("modal-close"), "no corner X");
  assert.ok(!dialog.includes("—"), "no em dash in the copy");
  // The links open the repo's docs and stay off the page's own "#".
  assert.match(html, /\[\["helpGuide", "usage"\], \["helpFaq", "faq"\]\]/);
  assert.match(html, /e\.preventDefault\(\);\n    window\.open\(`\$\{REPO_URL\}\/blob\/main\/docs\/\$\{doc\}\.md`, "_blank", "noopener"\);/);
});

// Help's Erase subtitles says why, how and how long, a line each (owner,
// 2026-10-22): the markup, the words it is painted with, and the Korean as
// approved.
test("Help's Erase subtitles item says why, how and how long", () => {
  const lines = ["Why: Original subtitles left in the video overlap the translated ones.",
                 "How: Fit the box → Erase subtitles → Dubbing → Burn in subtitles.",
                 "Time: About 10 min for a 10-second video (Local model)."];
  assert.ok(readPage().includes(`<div class="help-item"><b>Erase subtitles</b><p>${lines[0]}</p><p>${lines[1]}</p><div class="help-where">${lines[2]}</div></div>`));
  const words = readFileSync(new URL("./markupWords.mjs", import.meta.url), "utf8");
  for (const [at, line] of [["p:nth-of-type(1)", lines[0]], ["p:nth-of-type(2)", lines[1]], [".help-where", lines[2]]]) {
    assert.ok(words.includes(`["#helpOverlay .help-item:nth-child(2) ${at}", t("${line}")]`), at);
  }
  const ko = JSON.parse(readFileSync(new URL("../../static/i18n/ui.ko.json", import.meta.url), "utf8"));
  assert.deepEqual(lines.map((l) => ko[l]), ["왜: 원래 자막이 남아 있으면 번역 자막과 겹쳐요.",
    "어떻게: 상자 맞추기 → 자막 지우기 → 더빙 → 자막 입히기.", "시간: 10초 영상에 약 10분 (로컬 모델)."]);
});

// Home's Erase subtitles card says what erasing is for, in its small line
// (owner, 2026-10-22), and the Korean reads as approved.
test("Home's Erase subtitles card says what erasing is for", () => {
  const html = readPage();
  const line = "Erases burned-in subtitles. Dub the erased video for clean subtitles in the new language.";
  assert.ok(html.includes(`<div data-i18n class="home-card-title">Erase subtitles</div>\n              <div data-i18n class="home-card-desc">${line}</div>`));
  const ko = JSON.parse(readFileSync(new URL("../../static/i18n/ui.ko.json", import.meta.url), "utf8"));
  assert.equal(ko[line], "영상에 새겨진 자막을 지워요. 지운 영상으로 더빙하면 새 언어 자막을 깨끗하게 입힐 수 있어요.");
});

// Help's "100+" is every dubbing model's languages together, and the line under
// the Dubbing model choice says the chosen one's own count (owner, 2026-10-21):
// the markup and the words it is painted with say the same sentence.
test("Help says the Perso API's 100+ languages depend on the dubbing model", () => {
  const where = "Local model (10 languages, free) or Perso API (100+ languages in all, depending on the dubbing model; credits).";
  assert.ok(readPage().includes(`<div class="help-where">${where}</div>`));
  const words = readFileSync(new URL("./markupWords.mjs", import.meta.url), "utf8");
  assert.ok(words.includes(`["#helpOverlay .help-item:nth-child(1) .help-where", t("${where}")]`));
});

// Windows drew Chromium's stock scrollbar wherever a pane scrolls -- a 17px grey
// trough with arrow buttons at both ends -- and the system's white title bar over
// the dark app; the Mac floats a thin bar that goes away and its title bar is
// left alone (W26, 2026-10-14). Everything here hangs off the data-platform the
// preload stamps on the page, so the Mac's scrollbars are never styled: styling
// ::-webkit-scrollbar at all pins them on screen.
test("on Windows the page draws its own scrollbars and is moved by its top bar; the Mac's stay the system's", () => {
  const html = readPage();
  // A rule pinned word for word, the stylesheet's own characters escaped.
  const rule = (css) => new RegExp(css.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const win = ':root[data-platform="win32"]';
  assert.match(html, rule(`${win} ::-webkit-scrollbar { width: 8px; height: 8px; }`));
  assert.match(html, rule(`${win} ::-webkit-scrollbar-track { background: transparent; }`));
  assert.match(html, rule(`${win} ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }`));
  assert.match(html, rule(`${win} ::-webkit-scrollbar-button { display: none; width: 0; height: 0; }`));
  assert.doesNotMatch(html, /^\s*::-webkit-scrollbar/m, "the Mac's scrollbars are never styled");
  // The bar is what the window is moved by; what is pressed in it still takes
  // the click; and it stops short of the window buttons the shell lays over it.
  assert.match(html, rule(`${win} .topbar { -webkit-app-region: drag;\n    padding-right: calc(100vw - env(titlebar-area-width, 100vw) + 12px); }`));
  assert.match(html, rule(`${win} .topbar :is(button, input, #topbarTitle) { -webkit-app-region: no-drag; }`));
  // No system says PersoDub over Home any more (one-line title bar, 2026-10-21).
  assert.ok(!html.includes(`${win} body[data-screen="home"] .topbar-titles`), "Home's bar names nothing on Windows either");
  assert.match(html, rule('body[data-screen="home"] .topbar-titles { visibility: hidden; }'));
});

// One 36px bar on both systems (2026-10-21): the window's own buttons sit in
// it -- the Mac's lights at the left, Windows' three at the right -- and the
// stylesheet orders one row of buttons two ways. Home's bar holds neither
// Settings nor the pane buttons.
test("the Mac's bar starts after its lights and ends Settings, panes; Windows' starts panes, Settings", () => {
  const html = readPage();
  const rule = (css) => new RegExp(css.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const mac = ':root[data-platform="darwin"]';
  const win = ':root[data-platform="win32"]';
  assert.match(html, rule(`${mac} .topbar { -webkit-app-region: drag; padding-left: 80px; }`));
  assert.match(html, rule(`${mac} .topbar :is(button, input, #topbarTitle) { -webkit-app-region: no-drag; }`));
  // The bar's row, as written: Settings, then the panes. Export is not in it
  // (the video panel's tab row, 2026-10-22).
  const bar = html.slice(html.indexOf('<div class="topbar" id="topbar">'), html.indexOf('<div class="shell">'));
  assert.ok(bar.indexOf('id="settingsBtn"') < bar.indexOf('class="panes"') && !bar.includes('id="exportBtn"'));
  // Mac: Settings and the panes after everything at order 0.
  assert.match(html, rule(`${mac} .topbar :is(#settingsBtn, .panes) { order: 1; }`));
  // Windows: the panes, then Settings, ahead of everything else.
  assert.match(html, rule(`${win} .topbar .panes { order: -2; }`));
  assert.match(html, rule(`${win} .topbar #settingsBtn { order: -1; }`));
  assert.match(html, rule('body[data-screen="home"] .topbar :is(#settingsBtn, .panes) { display: none; }'));
  // The download chip and the way back into a job stay in the bar for Home.
  assert.ok(bar.includes('id="topbarDl"') && bar.includes('id="topbarForward"'));
});

// A bare arrow on Home read as "next" (2026-10-21). The same button now wears
// the arrow that curls back and the name of the job it reopens.
test("the way back into a job is the curled-back arrow and the job's name, cut short at 200px", () => {
  const html = readPage();
  const at = html.indexOf('<button class="topbar-back" id="topbarForward"');
  const btn = html.slice(at, html.indexOf("</button>", at));
  assert.ok(btn.includes(`${lucide("undo-2", 16)}<span id="topbarForwardName"></span>`));
  assert.ok(!btn.includes('d="m12 5 7 7-7 7"'), "the bare arrow is gone");
  assert.equal(html.match(/id="topbarForward"/g).length, 1, "the same button, not a second one");
  assert.match(html, /\.topbar-back \{ border: none; cursor: pointer; padding: 0 8px; max-width: 200px; height: 26px;\n    flex: 0 0 auto; border-radius: 999px; display: inline-flex; align-items: center; gap: 5px;\n    background: var\(--secondary\);/);
  assert.match(html, /#topbarForwardName \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
});

test("the way back names the job on the button and 'Reopen <name>' on its tip", () => {
  const html = readPage();
  const at = html.indexOf("function paintForward() {");
  const body = html.slice(at, html.indexOf("\n}\n", at));
  assert.match(body, /\$\("topbarForwardName"\)\.textContent = lastJobName \|\| t\("Last project"\);/);
  assert.match(body, /const what = lastJobName \? t\("Reopen \{name\}", \{ name: lastJobName \}\) : t\("Reopen the last project"\);\n  btn\.setAttribute\("aria-label", what\);\n  btn\.title = what;/);
  // The owner's words (2026-10-21).
  const ko = JSON.parse(readFileSync(new URL("../../static/i18n/ui.ko.json", import.meta.url), "utf8"));
  assert.equal(ko["Reopen {name}"], "{name} 다시 열기");
  assert.equal(ko["Last project"], "보던 프로젝트");
});

// The Dub Agent card heads with the mascot in place of the speech bubble
// (2026-10-21), as tall as the bubble was; app/api/misc.py serves the picture.
test("the Dub Agent card heads with the mascot, the bubble's height", () => {
  const html = readPage();
  assert.match(html, /<div class="home-agent-head"><img src="\/mascot\.png" alt="">Dub Agent<\/div>/);
  assert.match(html, /\.home-agent-head img \{ height: 18px; width: auto; display: block; \}/);
});

// Projects left the Home sidebar's Management group (2026-10-21).
test("Home's Management group holds Settings alone", () => {
  const html = readPage();
  const side = html.slice(html.indexOf('<aside class="home-side"'), html.indexOf('class="home-grow"'));
  const group = side.slice(side.lastIndexOf('class="home-grp"'));
  assert.match(group, />Management</);
  assert.deepEqual([...group.matchAll(/id="(homeNav\w+)"/g)].map((m) => m[1]), ["homeNavSettings"]);
  assert.ok(!html.includes("homeNavProjects"), "nothing is left of the Projects item");
});

// Save video read as doing nothing (2026-10-21): the banner's link field
// blinks white twice (a still ring with less motion asked for), and the link
// read next opens Export by itself, Video ticked, once that link's own video
// is in. The press is for that visit to Home: Home clears it.
test("Save video points at the banner's link field, and the link read next opens Export once its video is in", () => {
  const html = readPage();
  assert.match(html, /onSaveVideo: \(\) => \{ pointAtLink\(\$\); saveVideoNext = true; \},/);
  assert.equal(html.match(/saveVideoNext = true/g).length, 1, "nothing else raises it");
  assert.match(html, /const save = saveVideoNext;\n\s*saveVideoNext = false;\n\s*draftSetup\.openDraft\(\{ link: url, onReady: save \? \(\) => exportDialog\.open\(\["video"\]\) : null \}\);/);
  const home = html.slice(html.indexOf("function showHome() {"), html.indexOf("async function openLastScreen()"));
  assert.match(home, /\n  saveVideoNext = false;\n/);
  // The same blink for an empty project's Import block (New project, below).
  assert.match(html, /\.home-banner-linkin\.link-field\.ask, \.import-link\.ask \{ animation: link-ask 0\.5s ease-in-out 2; \}/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\) \{\n    \.home-banner-linkin\.link-field\.ask, \.import-link\.ask \{ animation: none; box-shadow: 0 0 0 2px rgba\(11, 18, 32, 0\.5\), 0 0 0 5px #ffffff; \}/);
});

// New project on an empty project opened the same Import block again in a
// window over it (2026-10-21). The block on screen is pointed at instead: the
// erase screen by its name, and none under a hidden panel, tab or face.
test("New project on an empty project points at the Import block on screen", () => {
  const html = readPage();
  assert.match(html, /openNewProject: \(source\) => newProject\.openNewProject\(source\),\n  emptyImport: emptyImportLink,\n\}\);/);
  const at = html.indexOf("function emptyImportLink() {");
  const body = html.slice(at, html.indexOf("\n}\n", at));
  assert.match(body, /if \(state\.jobId\) return null;/);
  assert.doesNotMatch(body, /getDraft\(\)/, "an empty Erase tab can stand beside an older draft still held");
  assert.match(body, /const tab = document\.body\.dataset\.screen === "erase" \? "erase" : leftTabs\.current\(\);/);
  assert.match(body, /\{ dubbing: "dubbingLink", erase: "eraseLink", captions: "capLink" \}\[tab\]/);
  assert.match(body, /return id && \$\(`\$\{id\}Input`\)\.offsetParent \? id : null;/);
  // Each of those is a link field the shared block draws, under that name.
  assert.match(readFileSync(DRAFT_IMPORT, "utf8"), /emptyTabHtml\("dubbing", "dubbingZone", "dubbingLink"\)/);
  assert.match(readFileSync(ERASE, "utf8"), /emptyTabHtml\("erase", "eraseZone", "eraseLink"\)/);
});

// A card's menu in the bottom row of Home opened under the "Updated" banner,
// which hid its Delete (Windows, 1280x800, 2026-10-24).
test("a project card's menu is drawn over the update banner", () => {
  const html = readPage();
  const z = (sel) => Number(new RegExp(sel.replace(".", "\\.") + " \\{[^}]*z-index: (\\d+)").exec(html)[1]);
  assert.ok(z(".proj-menu") > z(".update-banner"));
});
