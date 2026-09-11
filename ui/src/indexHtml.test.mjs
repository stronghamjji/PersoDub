// The app's screens are one big HTML file with its scripts written inline as
// <script type="module"> blocks. A module that does not parse is not a
// half-working module -- the browser runs none of it, silently -- which is how
// a stray apostrophe inside one placeholder string once left the whole Dub
// Agent strip dead on screen while every other part of the page looked fine.
// Nothing else in this suite reads that file, so this is the only place such a
// mistake can be caught before it ships.
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

const INDEX = fileURLToPath(new URL("../../static/index.html", import.meta.url));
// The timeline draws its own head and lane, so their ids live in the module.
const TIMELINE = fileURLToPath(new URL("./timeline.mjs", import.meta.url));
const STRIP = fileURLToPath(new URL("./agentStrip.mjs", import.meta.url));
// The erase screen writes the box's own label, so the words live there.
const ERASE = fileURLToPath(new URL("./eraseScreen.mjs", import.meta.url));
// The running screen owns the Cancel button that asks the question.
const RUNNING = fileURLToPath(new URL("./runningScreen.mjs", import.meta.url));

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
  const blocks = moduleScripts(readFileSync(INDEX, "utf8"));
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
        `the module beginning at line ${line} of static/index.html does not parse:\n${e.stderr}`,
      );
    }
  }
});

// The saved theme has to be on <html> before the first paint, so it is a plain
// (non-module) script in the head -- a module is deferred, and the light page
// would be drawn once and swapped. moduleScripts() above cannot see it, which
// is the point, so it is pinned here instead.
test("the saved theme is read before the first paint", () => {
  const html = readFileSync(INDEX, "utf8");
  const boot = html.match(/<script>[\s\S]{0,400}?<\/script>/);
  assert.ok(boot, "the head has no plain script at all");
  assert.match(boot[0], /localStorage\.getItem\("persodub\.theme"\)/,
    "the boot script must read the saved theme");
  assert.match(boot[0], /documentElement\.dataset\.theme/,
    "the boot script must put the theme on <html>");
});

// The download-first dialog asks one question, so it must offer one answer:
// Download and Start filled, Cancel outlined, and the way out to Settings as a
// word. Three buttons of the same weight made the eye pick between three.
test("only one button in the models dialog reads as the answer", () => {
  const html = readFileSync(INDEX, "utf8");
  assert.match(html, /class="btn btn-primary" id="mnDownload"/,
    "Download and Start is the filled button");
  assert.match(html, /class="settings-link" id="mnSettings"/,
    "Open Settings is a word, not a third button");
  assert.match(html, /class="btn btn-outline" id="mnCancel"/,
    "Cancel keeps its outline");
});

// The New project dialog's own row of three. The ids are what the dialog
// module reaches for, and the classes are the decision: two ghost buttons for
// the errands that end here, one filled button for the dub that goes on. The
// progress row and the line Save clip writes belong to the same contract.
test("the New project dialog carries the three buttons, the download row and the saved line", () => {
  const html = readFileSync(INDEX, "utf8");
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
test("the erase screen has its three faces, and the rail button that opens it", () => {
  const html = readFileSync(INDEX, "utf8");
  for (const id of ["eraseToggle", "screen-erase", "eraseDrop", "eraseZone", "eraseInput",
                    "eraseBody", "erasePack", "erasePackText", "erasePackBtn",
                    "eraseTabs", "eraseStage", "eraseVideo", "eraseBox",
                    "eraseRow", "eraseState", "eraseSaved", "eraseShowWrap", "eraseShowBtn",
                    "eraseBarBox", "eraseFill", "eraseSrtBtn", "eraseSrtInput",
                    "eraseCancelBtn", "eraseBackBtn", "eraseDubBtn",
                    "eraseEst", "eraseRunBtn"]) {
    assert.ok(html.includes(`id="${id}"`), `${id} is missing from the erase screen`);
  }
  // The box has a handle at each corner, and the module drags by that name.
  for (const corner of ["nw", "ne", "sw", "se"]) {
    assert.ok(html.includes(`data-handle="${corner}"`), `the box has no ${corner} handle`);
  }
  // Its tabs are the finished screen's own, told apart by their own attribute
  // -- the two pairs must never answer each other's clicks.
  assert.match(html, /<button class="vtab" data-erase="original"/);
  assert.match(html, /<button class="vtab active" data-erase="erased"/);
  assert.match(html, /querySelectorAll\("#videoPane \.vtab"\)/,
    "the finished screen's tabs must be scoped to its own pane");
  // Every button on the screen is the app's one button box.
  assert.match(html, /class="btn btn-primary" id="eraseRunBtn"/, "Erase is the filled button");
  assert.match(html, /class="btn btn-primary" id="eraseDubBtn"/, "Start dubbing is filled");
  assert.match(html, /class="btn btn-outline" id="eraseSrtBtn"/, "Dub with my subtitles is a ghost button");
  assert.match(html, /class="btn btn-outline" id="eraseCancelBtn"/, "Cancel is a ghost button");
});

test("the erase screen says only what the mockup says", () => {
  const html = readFileSync(INDEX, "utf8");
  // "Where are the subtitles?" was the band's own line; the band now names the
  // screen and carries the estimate and the Erase button (user, 2026-09-09),
  // and the box on the picture is still labelled "Subtitles".
  // The way in reads like the home screen's since 2026-09-10: a title, a line
  // under it, and the zone's words in the home's case, singular.
  for (const words of ["Erase subtitles", "Erasing subtitles from your video",
                       "Drop a video or paste a link.", "Drop your video here",
                       "MP4 or MOV, up to 2 GB.", "Choose File…", "Subtitles",
                       "Dub with my subtitles (.srt)", "Start dubbing", "Download"]) {
    assert.ok(html.includes(`>${words}<`) || html.includes(`>${words}`),
      `the screen no longer says "${words}"`);
  }
  // "Finding subtitles…" moved off the page and into the box's own label,
  // which the module writes (user, 2026-09-10).
  assert.match(readFileSync(ERASE, "utf8"), /"Finding subtitles…" : "Subtitles"/);
});

// The two controls of an erase belong beside the picture they are about --
// first out of the top bar and into the screen's band (user, 2026-09-09), then
// out of the band and into the row under the picture, where the trim bar is:
// the button in the window's far top corner and the trim in its far bottom one
// was three things in three corners (user, 2026-09-10).
test("the estimate and the Erase button stand in the row under the picture", () => {
  const html = readFileSync(INDEX, "utf8");
  const row = html.slice(html.indexOf('id="eraseRow"'), html.indexOf('id="eraseError"'));
  assert.ok(row.includes('id="eraseEst"') && row.includes('id="eraseRunBtn"'),
    "both live in the row under the picture");
  assert.match(row, /id="eraseEst"[^]*id="eraseRunBtn"/, "the minutes, then the button");
  // A hairline between the way out and the name of the screen, the same one
  // the pane buttons stand behind at the other end of the bar. It comes and
  // goes with the house (user, 2026-09-10).
  assert.match(html, /id="topbarBack"[^]*<span class="tb-div" id="topbarHomeDiv" hidden><\/span>[^]*class="topbar-titles"/);
  assert.match(html, /\$\("topbarHomeDiv"\)\.hidden = !back;/);
  // There is no band of the screen's own any more: it said "Erase subtitles"
  // directly under a top bar saying "Erase subtitles" (user, 2026-09-10).
  assert.ok(!html.includes('id="eraseHead"') && !html.includes("erase-head"),
    "the erase screen's title band is back");
  const topbar = html.slice(html.indexOf('<div class="topbar" id="topbar">'), html.indexOf('id="screen-home"'));
  assert.ok(!topbar.includes('id="eraseRunBtn"') && !topbar.includes('id="eraseEst"'),
    "nor in the top bar");
  // Picture, trim bar and row are one column, all the width of the picture.
  assert.match(html, /<div class="erase-mid">/);
  assert.match(html, /\.erase-trim, \.erase-row \{ width: max\(var\(--erase-col, 100%\), 520px\)/);
  assert.match(html, /\.erase-stage \{[^}]*max-height: 780px/);
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
  const html = readFileSync(INDEX, "utf8");
  for (const id of ["cancelDubOverlay", "cancelDubCloseX", "cancelDubKeepBtn", "cancelDubConfirmBtn"]) {
    assert.ok(html.includes(`id="${id}"`), `${id} is missing from the stop-this-dub dialog`);
  }
  // The same head/body/foot the other alert dialogs have, and the same
  // grammar: the way out is a ghost button, the deed is the red one.
  const dlg = html.slice(html.indexOf('id="cancelDubOverlay"'), html.indexOf('id="deleteOverlay"'));
  assert.match(dlg, /class="modal-head"[^]*class="modal-body"[^]*class="modal-foot"/);
  assert.match(dlg, /class="btn btn-secondary" id="cancelDubKeepBtn"/);
  assert.match(dlg, /class="btn btn-danger" id="cancelDubConfirmBtn"/);
  // Backdrop and Escape both answer no, and the promise is settled either way
  // -- a caller left awaiting a dialog nobody answered is a dead Cancel button.
  assert.match(html, /closeCancelDub\(false\)/);
  assert.match(html, /closeCancelDub\(true\)/);
  assert.match(html, /askCancel: \(\) => askCancelDub\(\)/);
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
  const html = readFileSync(INDEX, "utf8");
  assert.match(html, /return \{ source: "Original", target: "Translated" \};/);
  assert.match(readFileSync(TIMELINE, "utf8"), /<div class="tl-name strong">Translated<\/div>/);
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

// The erase screen's one <video> wears two hats. While the box is being drawn
// it is a backdrop -- a play bar over the writing and a burst of sound would
// both be in the way -- so the markup ships it muted and bare. A finished
// erase is the thing the user came for and was still a still picture with no
// way to play it (user, 2026-09-11).
test("a finished erase is a video you can play, and the backdrop is not", () => {
  const html = readFileSync(INDEX, "utf8");
  // As it ships: no controls, muted.
  assert.match(html, /<video id="eraseVideo" playsinline muted><\/video>/);
  // And the screen turns both on for the finished face and off again after.
  const erase = readFileSync(ERASE, "utf8");
  assert.match(erase, /player\.controls = done;/);
  assert.match(erase, /player\.muted = !done;/);
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
  const html = readFileSync(INDEX, "utf8");
  for (const id of ["paneList", "paneTimeline", "paneAgent"]) {
    assert.ok(html.includes(`id="${id}"`), `${id} is missing from the topbar`);
  }
  assert.match(html, /body\.timeline-off (#timeline|\.timeline)/,
    "hiding the timeline needs a body.timeline-off rule");
});

// The agent lives in a right-hand column and the finished screen puts the
// script LEFT of the video (layout G, user 2026-09-08). The grips must match:
// the agent's resizes width (x), and so does the script/video divider. Reading
// order follows the screen, so the script comes first in the markup.
test("the agent column sits beside the work and the grips point the right way", () => {
  const html = readFileSync(INDEX, "utf8");
  assert.ok(html.includes('class="mainrow"'), "work and agent need the mainrow wrapper");
  assert.match(html, /class="grip grip-x" id="gripAgent"/,
    "the agent grip must resize width");
  assert.match(html, /class="grip grip-x" id="gripPanes"/,
    "the script/video grip must resize width");
  const video = html.indexOf('id="videoPane"');
  const script = html.indexOf('id="scriptPane"');
  assert.ok(script > 0 && script < video, "the script pane must come before the video");
});

// Timeline zoom, the aligned agent heading, and the Korean tab names
// (mockup approved 2026-09-01 afternoon).
test("timeline zoom controls, Dub Agent heading and English video tabs are in place", () => {
  const html = readFileSync(INDEX, "utf8");
  const timeline = readFileSync(TIMELINE, "utf8");
  for (const id of ["tlZoomOut", "tlZoomIn", "tlZoomFit"]) {
    assert.ok(timeline.includes(`id="${id}"`), `${id} is missing from the timeline head`);
  }
  assert.ok(html.includes(">Original<") && html.includes(">Dubbing<"),
    "the video tabs must read Original/Dubbing -- the app speaks English (user, 2026-09-02)");
  // Anchored to markup, not to the words: "Dub Agent" also appears in a CSS
  // comment and in a button's title, so `html.includes("Dub Agent")` passed
  // with the heading itself deleted.
  assert.match(html, />Dub Agent</,
    "the agent column needs its Dub Agent heading, as an element's own text");
});

// The player's subtitle overlay, its toolbar, and the timeline's subtitle lane
// with the eye toggle (mockup approved 2026-09-01 evening).
test("the subtitle overlay, toolbar and timeline lane are wired in", () => {
  const html = readFileSync(INDEX, "utf8");
  for (const id of ["subOverlay", "subToolbar", "subStyleMenu"]) {
    assert.ok(html.includes(`id="${id}"`), `${id} is missing from the player`);
  }
  const timeline = readFileSync(TIMELINE, "utf8");
  assert.ok(timeline.includes("tlSubEye"), "the timeline needs its subtitle eye toggle");
  assert.ok(timeline.includes("tl-cap"), "the timeline needs its subtitle lane blocks");
});

test("after an update the page says so in one line and keeps the What's new sheet for the link", () => {
  const html = readFileSync(INDEX, "utf8");
  // The notice is the same pill as the "Restart to update" one, in the same
  // place, and says only the version -- the list is one click away.
  assert.match(html, /id="updatedNotice"/);
  assert.match(html, /Updated to \$\{/);
  assert.match(html, /id="updatedWhatsNew"[^>]*>What(’|&#8217;)s new</);
  // The banner stays until closed: a close button, and no self-hiding timer.
  assert.match(html, /id="updatedClose"/);
  assert.doesNotMatch(html, /setTimeout\(hideUpdatedNotice/);
  // A changed version shows the notice, never the sheet on its own.
  const start = html.indexOf("async function checkWhatsNew");
  const check = html.slice(start, html.indexOf("\n}\n", start));
  assert.match(check, /showUpdatedNotice\(\)/);
  assert.doesNotMatch(check, /showWhatsNew\(\)/);
});

// The boxed subtitle's width handles sit inside the subtitle's own text box.
// Every move of a drag redraws that box, and the redraw writes the text afresh,
// which throws the handles away and makes new ones. A drag whose listeners and
// pointer capture hang on the handle itself therefore hears exactly one move:
// the handle it held is gone, and later moves land on the new one, which
// listens to nothing. On screen that was "the box widens one notch per click"
// (user, 2026-09-07). The drag has to live on the box, which survives.
test("dragging a subtitle width handle keeps following the pointer after the box is redrawn", () => {
  const html = readFileSync(INDEX, "utf8");
  const start = html.indexOf("// The side handles: drag to set the box's width");
  assert.ok(start > 0, "the width-handle drag is gone?");
  const src = html.slice(start, html.indexOf("}, true);", start) + "}, true);".length);

  // Just enough of a page: elements with listeners and a parent, events that
  // bubble to the parent, and closest() for the handle class.
  function el(name, parent = null) {
    const e = { name, parent, listeners: {}, children: [], captured: [] };
    e.addEventListener = (t, fn) => { (e.listeners[t] ||= []).push(fn); };
    e.removeEventListener = (t, fn) => {
      e.listeners[t] = (e.listeners[t] || []).filter((f) => f !== fn);
    };
    e.setPointerCapture = (pid) => { e.captured.push(pid); };
    e.closest = (sel) => (sel === ".sub-wh" && e.name === "handle" ? e : null);
    if (parent) parent.children.push(e);
    return e;
  }
  // The browser sends a pointer event to the element under (or capturing) the
  // pointer and lets it bubble; an element thrown out of the page hears nothing.
  function send(target, type, ev) {
    for (let n = target; n; n = n.parent) {
      for (const fn of [...(n.listeners[type] || [])]) fn(ev);
    }
  }
  const subOvText = el("box");
  let handle = el("handle", subOvText);
  const subStyle = { boxWidth: 80, widths: {} };
  // What updateSubtitleNow does to the handles: the old ones are gone from the
  // page, new ones take their place.
  const updateSubtitleNow = () => {
    for (const kid of subOvText.children) kid.parent = null;
    subOvText.children = [];
    handle = el("handle", subOvText);
  };
  let saved = 0, redrawn = 0;
  new Function("subOvText", "doneVideo", "subStyle", "subScope", "subNowIdx",
    "updateSubtitleNow", "saveSubStyle", "timeline", src)(
    subOvText, { getBoundingClientRect: () => ({ left: 0, width: 200 }) }, subStyle,
    "all", 0, updateSubtitleNow, () => { saved++; },
    { drawTimelineTrack() { redrawn++; } });

  const ev = (clientX) => ({
    target: handle, clientX, pointerId: 3,
    preventDefault() {}, stopPropagation() {},
  });
  // Pressed on the handle at 150 px from the picture's left edge -- and the
  // video is 200 px wide, so x = 150 means a box 50 % wide, x = 170 means 70 %.
  send(handle, "pointerdown", ev(150));
  send(handle, "pointermove", ev(150));
  send(handle, "pointermove", ev(160));
  send(handle, "pointermove", ev(170));
  assert.equal(subStyle.boxWidth, 70,
    "the box must follow every move of one drag, not just the first");
  send(handle, "pointerup", ev(170));
  assert.equal(saved, 1, "letting go remembers the width once");
  assert.equal(redrawn, 1, "letting go redraws the timeline once");
  // And letting go ends the drag: a move afterwards changes nothing.
  send(handle, "pointermove", ev(190));
  assert.equal(subStyle.boxWidth, 70, "a drag that was let go must not keep following");
});

// The player's subtitle is the ruler for the export: the page measures with
// the same font ffmpeg burns with, at the font's own line height, and sends
// the result as `layout`. These pin the CSS side of that contract to the
// module and the backend it must agree with (user, 2026-09-07).
test("the player draws subtitles in the burn's font at its natural line height", async () => {
  const html = readFileSync(INDEX, "utf8");
  const { SUB_FONT_STACK } = await import("./subtitleLayout.mjs");
  const rule = html.match(/\.sub-ov-text \{[^}]*\}/)[0];
  assert.match(rule, new RegExp(SUB_FONT_STACK.map((f) => `"${f}"`).join(", ")),
    "the overlay's font-family must list the burn's fonts in the burn's order");
  assert.match(rule, /line-height: normal/);
  assert.match(rule, /max-width: 92%/);
  assert.match(html, /const SUB_MAX_WIDTH = 0\.92;/, "the script's cap must be the CSS max-width");
  // The backend's per-platform font is one of the same three.
  const results = readFileSync(fileURLToPath(new URL("../../app/api/results.py", import.meta.url)), "utf8");
  for (const f of SUB_FONT_STACK) assert.ok(results.includes(`"${f}"`), `${f} is not a burn font`);
  // The measured layout goes out with the settings.
  assert.match(html, /subStyle\.layout = lay;/);
  // ...with the weight the look is drawn at, which the burn's presets lack.
  assert.match(html, /weight: r\.weight/);
  assert.match(html, /id="subMeasure"/);
});

// Packs (the AI engine, the translation runtime) are the desktop app's to
// install: the page hands its bridge to the models controller and, in the
// dropdown hints, names the pack before the model while the pack is missing.
test("the page hands the desktop bridge to the models controller and hints name packs first", () => {
  const html = readFileSync(INDEX, "utf8");
  assert.match(html, /shell: window\.persodubShell \|\| null/);
  assert.match(html, /function hintNeeds\(role, value\)/);
  // One line names everything the choice needs, one button fetches it all.
  assert.match(html, /Needs \$\{needs\.map\(\(r\) => r\.name\)\.join\(" \+ "\)\}/);
  assert.match(html, /models\.downloadAll\(ids\)/);
  assert.match(html, /neededPackIds/);
});

// The voice engine's pack on disk but its process down: the page asks the
// desktop app to start it and tries the dub again, once.
test("a dub refused because the voice engine is not running is retried after the desktop app starts it", () => {
  const html = readFileSync(INDEX, "utf8");
  assert.match(html, /async function restartVoiceEngine\(\)/);
  assert.match(html, /voice engine is not running\/\.test\(errorText\(e\)\) && await restartVoiceEngine\(\)/);
  assert.match(html, /keepPolling: \(\) => \$\("settingsOverlay"\)\.classList\.contains\("open"\)/);
});

test("the rail leads with the logo tile, and About shows it beside the name", () => {
  const html = readFileSync(new URL("../../static/index.html", import.meta.url), "utf8");
  assert.match(html, /<button class="rail-item brand"[^>]*>\s*(<!--[^]*?-->\s*)?<img class="rail-logo" src="\/logo.png"/);
  assert.match(html, /<img class="about-logo" src="\/logo.png"/);
});

// The three tools stand together in the rail, dubbing first, and the way home
// is a house rather than a back arrow: both are what the user asked for after
// running 0.5.5 on the mac (2026-09-09).
test("the rail leads with the tools and keeps Projects at its foot, and the top bar's way out is Home", () => {
  const html = readFileSync(INDEX, "utf8");
  const dub = html.indexOf('id="dubToggle"');
  const erase = html.indexOf('id="eraseToggle"');
  const spacer = html.indexOf('class="rail-spacer"');
  const projects = html.indexOf('id="historyToggle"');
  const settings = html.indexOf('id="settingsBtn"');
  // The tools at the top, in the order they are used; Projects and Settings
  // below the spacer, at the foot of the rail (user, 2026-09-09).
  assert.ok(dub > 0 && dub < erase && erase < spacer && spacer < projects && projects < settings,
    "the rail is Dubbing, Erase subtitles, then a gap, then Projects and Settings");
  assert.match(html, /id="dubToggle"[^>]*title="Dubbing"/);
  // Pressing it leaves the open job rather than hiding it behind another screen.
  assert.match(html, /\$\("dubToggle"\)\.addEventListener\("click", \(\) => resetForNewJob\(\)\)/);
  // Lit on every screen a dub passes through, not just the first one.
  assert.match(html, /DUB_SCREENS = new Set\(\["home", "running", "done", "failed"\]\)/);
  assert.match(html, /\$\("dubToggle"\)\.classList\.toggle\("active", DUB_SCREENS\.has\(name\)\)/);
  // The house: no tailed arrow left in the button, and it says where it goes.
  const back = html.slice(html.indexOf('id="topbarBack"'));
  const button = back.slice(0, back.indexOf("</button>"));
  assert.ok(button.includes('title="Home"') && button.includes('aria-label="Home"'),
    "the top bar button says Home");
  assert.ok(!button.includes("M19 12H5"), "the back arrow's path is gone");
});

// Cancel stands beside the stage it cancels, and the way out of an erase that
// began in the New project dialog goes back to that dialog (user, 2026-09-09).
test("Cancel sits in the progress card, and leaving an erase reopens the dialog it came from", () => {
  const html = readFileSync(INDEX, "utf8");
  const card = html.slice(html.indexOf('id="progressCard"'), html.indexOf('id="rawLogDetails"'));
  assert.ok(card.includes('id="cancelBtn"'), "Cancel is inside the progress card");
  const topbar = html.slice(html.indexOf('<div class="topbar" id="topbar">'), html.indexOf('id="screen-home"'));
  assert.ok(!topbar.includes('id="cancelBtn"'), "and no longer in the top bar");
  // At the foot of the card, not beside the percentage: a number you read and
  // a button you press sat as one lump there (user, 2026-09-10). The steps
  // come first, then the button, then the log.
  assert.match(card, /id="progressSteps"[^]*class="cancel-row"[^]*id="cancelBtn"/);
  assert.ok(!/id="progressPct"[^]*id="cancelBtn"[^]*<\/div>\s*<div class="progress-bar"/.test(card),
    "Cancel is out of the head row");
  // The stop square is gone, and the row it now lives in is what holds the
  // card's free space so the log stays at the foot with it.
  assert.ok(!html.includes("cancel-stop"), "the stop square is gone");
  assert.match(html, /\.cancel-row \{[^}]*margin-top: auto/);
  assert.match(html, /\.progress-card \.raw-log \{ margin-top: 12px/);
  // Lighter than it was, still above every other control's .18.
  assert.match(html, /\.btn-cancel \{[^}]*border: 1px solid rgba\(255, 255, 255, 0\.30\)/);
  // Leaving: the dialog goes back up only when that is where the erase began.
  assert.match(html, /const back = eraseScreen\.origin\(\);/);
  assert.match(html, /document\.body\.dataset\.screen === "erase" && back/);
  assert.match(html, /if \(fromDialog\) newProject\.openNewProject\(back\);/);
});

// A subtitle look is written to the job the moment it is changed -- there is no
// Save button and the user decided there should not be one -- so the only way
// to know it happened is the mark at the right end of the toolbar. Same words
// and same coming-and-going as the script table's own (user, 2026-09-09).
test("the subtitle toolbar says Saving, then Saved, and says so when it could not", async () => {
  const html = readFileSync(INDEX, "utf8");
  const from = html.indexOf("// The mark at the right end of the subtitle toolbar.");
  assert.ok(from > 0, "the subtitle saving mark is gone?");
  const src = html.slice(from, html.indexOf("\n}\n", html.indexOf("function saveSubStyle()", from)) + 2);

  // The toolbar is one span; the timers are held here so nothing waits on a
  // real clock -- run() is "the wait is over".
  const marks = [];
  const el = { set textContent(v) { marks.push(v); }, get textContent() { return marks.at(-1) || ""; } };
  let pending = [];
  const fake = {
    setTimeout: (fn) => { pending.push(fn); return pending.length; },
    clearTimeout: (id) => { if (id) pending[id - 1] = null; },
  };
  const run = async () => {
    const now = pending; pending = [];
    for (const fn of now) if (fn) await fn();
  };

  function build(answer) {
    return new Function("$", "subLayoutAll", "subStyle", "fetch", "setTimeout", "clearTimeout",
      'let subStyleRev = 0, subStyleTimer = null, subStyleJobId = "j1";\n'
      + src + "\nreturn { saveSubStyle };")(
      () => el, () => null, {}, answer, fake.setTimeout, fake.clearTimeout);
  }

  // A look changed: the mark says so at once, and the answer turns it to Saved.
  const good = build(async () => ({ ok: true }));
  good.saveSubStyle();
  assert.equal(el.textContent, "Saving…");
  await run();          // the 350ms settle, which sends the PUT
  await Promise.resolve();
  assert.equal(el.textContent, "Saved");
  await run();          // the 2s the mark stays up
  assert.equal(el.textContent, "");

  // The app refused it, or could not be reached: the mark says so and stays.
  const refused = build(async () => ({ ok: false }));
  refused.saveSubStyle();
  await run();
  await Promise.resolve();
  assert.equal(el.textContent, "Not saved");

  const offline = build(async () => { throw new Error("no"); });
  offline.saveSubStyle();
  await run();
  await Promise.resolve();
  assert.equal(el.textContent, "Not saved");
});

// A dub reporting its progress must not drag the screen back from wherever the
// person went; a project the person clicked must open even so. The two go
// through the same function, and the first version of the guard stopped both:
// clicking a finished project on the first screen did nothing at all
// (found on the mac, 2026-09-10).
test("progress reports leave the screen alone, but an opened project takes it", () => {
  const html = readFileSync(INDEX, "utf8");

  // The guard exists, and it lets an opened job through.
  assert.match(html, /if \(!opened && !JOB_SCREENS\.has\(document\.body\.dataset\.screen\)\)/);
  assert.match(html, /const JOB_SCREENS = new Set\(\["running", "done", "failed"\]\);/);

  // Only one of the two callers passes it. The poll must not.
  assert.match(html, /handleJobUpdate\(job, \{ opened: true \}\);/);
  assert.match(html, /onUpdate: \(job\) => \{ if \(myGeneration === state\.pollGeneration\) handleJobUpdate\(job\); \}/);
  assert.equal((html.match(/handleJobUpdate\(job, \{ opened: true \}\)/g) || []).length, 1);

  // Starting a dub shows the running screen itself rather than waiting for the
  // first report to do it -- which the guard would now swallow.
  const start = html.slice(html.indexOf("async function startDubbing"));
  assert.ok(start.slice(0, start.indexOf("runPollLoop")).includes('showScreen("running")'));
});
