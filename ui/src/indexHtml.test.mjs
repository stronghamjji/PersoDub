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

// Korean typing sends Enter twice: once to settle the syllable being composed
// (isComposing=true), once for real. The agent input treating the first as
// "send" left the settled syllable behind in the box and -- worse -- stopped
// the running answer to send it ("해" turns ending in Stopped, 2026-09-01).
// The guard is the standard one; this pins it to the agent input's handler.
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

// The agent lives in a right-hand column and the finished screen stacks
// video over script (layout approved 2026-09-01). The grips must match:
// the agent's resizes width (x), the video/script divider resizes height (y).
test("the agent column sits beside the work and the grips point the right way", () => {
  const html = readFileSync(INDEX, "utf8");
  assert.ok(html.includes('class="mainrow"'), "work and agent need the mainrow wrapper");
  assert.match(html, /class="grip grip-x" id="gripAgent"/,
    "the agent grip must resize width");
  assert.match(html, /class="grip grip-y" id="gripPanes"/,
    "the video/script grip must resize height");
  const video = html.indexOf('id="videoPane"');
  const script = html.indexOf('id="scriptPane"');
  assert.ok(video > 0 && video < script, "the video pane must come before the script");
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
