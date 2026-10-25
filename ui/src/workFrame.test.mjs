// The work screen's tab row, kept in step with the screen's name, and the
// Export button in the tab row of the video panel that name shows.
//
// Run with: node --test ui/src/workFrame.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { initWorkFrame } from "./workFrame.mjs";

function harness({ screen = "home", tab = "dubbing" } = {}) {
  const state = { screen, tab, left: 0 };
  const captions = { disabled: false, dataset: { tab: "captions" } };
  let onClick = null;
  const row = {
    querySelector: () => captions,
    addEventListener: (ev, fn) => { if (ev === "click") onClick = fn; },
  };
  const tabs = { show: (name) => { state.tab = name; }, current: () => state.tab };
  // The other ids are the video panels' tab rows; Export starts in the
  // finished panel's, where the markup puts it.
  const exportBtn = { row: "videoTabsNormal" };
  const els = { leftTabs: row, exportBtn };
  const $ = (id) => (els[id] ||= { append: (node) => { node.row = id; } });
  const api = initWorkFrame({
    $, tabs, getScreen: () => state.screen,
    onLeaveErase: () => { state.left += 1; },
  });
  const go = (name) => { state.screen = name; api.onScreen(name); };
  // The row's own listener shows the body first; this one runs after it.
  // Erase and Save video show no body of their own: the tab on show stays.
  const press = (name) => {
    if (name !== "erase" && name !== "save") state.tab = name;
    onClick({ target: { closest: () => ({ dataset: { tab: name } }) } });
  };
  return { state, captions, go, press, exportRow: () => exportBtn.row };
}

// People looked for Export beside the video, not in the top bar (owner,
// 2026-10-22): one button, moved to the row of whichever video panel is up.
test("Export stands in the tab row of the video panel each screen shows", () => {
  const h = harness();
  for (const [screen, row] of [["done", "videoTabsNormal"], ["running", "runTabs"], ["failed", "runTabs"],
                               ["done", "videoTabsNormal"], ["erase", "eraseTabs"], ["running", "runTabs"]]) {
    h.go(screen);
    assert.equal(h.exportRow(), row, `on the ${screen} screen`);
  }
});

test("a draft's screen is the finished panel's, and Home leaves Export where it was", () => {
  const h = harness({ screen: "erase" });
  assert.equal(h.exportRow(), "eraseTabs", "a frame that starts on a screen places it at once");
  h.go("home");
  assert.equal(h.exportRow(), "eraseTabs");
  h.go("done");   // a draft, before any dub, and a finished job alike
  assert.equal(h.exportRow(), "videoTabsNormal");
});

test("a job opened from the first screen starts on the Dubbing tab", () => {
  const h = harness({ tab: "save" });
  h.go("running");
  assert.equal(h.state.tab, "dubbing");
});

test("a dub's reports leave the tab the user went to alone", () => {
  const h = harness();
  h.go("running");
  h.press("captions");
  h.go("running");
  h.go("running");
  assert.equal(h.state.tab, "captions");
  // And it is still there when the dub is done.
  h.go("done");
  assert.equal(h.state.tab, "captions");
});

test("a dub that starts while Captions is up moves to Dubbing", () => {
  const h = harness({ screen: "done", tab: "captions" });
  h.go("running");
  assert.equal(h.state.tab, "dubbing");
});

// Save video's body is only for a project with no video (owner, 2026-10-24).
test("a dub that starts while Save video's link field is up moves to Dubbing", () => {
  const h = harness({ screen: "done", tab: "save" });
  h.go("running");
  assert.equal(h.state.tab, "dubbing");
});

test("the erase screen lights the Erase tab, and leaving it puts Dubbing back", () => {
  const h = harness({ screen: "done" });
  h.go("erase");
  assert.equal(h.state.tab, "erase");
  h.go("done");
  assert.equal(h.state.tab, "dubbing");
});

test("going home leaves the row as it is", () => {
  const h = harness({ screen: "done" });
  h.press("captions");
  h.go("home");
  assert.equal(h.state.tab, "captions");
});

test("another tab pressed on the erase screen is the way back to the job", () => {
  const h = harness({ screen: "done" });
  h.go("erase");
  h.press("dubbing");
  assert.equal(h.state.left, 1);
  // Erase pressed again is not a way out, nor Save video (it saves what is
  // on screen), nor Burn in subtitles (it starts from that video), and
  // neither is a tab pressed on any other screen.
  h.press("erase");
  assert.equal(h.state.left, 1);
  h.go("done");
  h.go("erase");
  h.press("save");
  assert.equal(h.state.left, 1);
  h.press("captions");
  assert.equal(h.state.left, 1);
  h.go("done");
  h.press("captions");
  assert.equal(h.state.left, 1);
});
