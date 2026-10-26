// Run with: node --test ui/src/feedbackSheet.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { initFeedbackSheet } from "./feedbackSheet.mjs";

function harness() {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) {
      const classes = new Set();
      els.set(id, {
        value: "", selectedIndex: 0, disabled: false, focused: false, listeners: {},
        classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
        addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
        fire(ev) { for (const fn of this.listeners[ev] || []) fn(); },
        click() { this.fire("click"); },
        focus() { this.focused = true; },
      });
    }
    return els.get(id);
  };
  const urls = [];
  let version = "";
  const open = initFeedbackSheet({ $, to: "team@example.com", version: () => version, system: "macOS 15.1.0",
                                   openUrl: (u) => urls.push(u) });
  const type = (id, text) => { $(id).value = text; $(id).fire("input"); };
  return { $, urls, open, type, setVersion: (v) => { version = v; } };
}

test("the form opens on its subject, and Send waits for a subject and details", () => {
  const h = harness();
  h.open();
  assert.equal(h.$("feedbackOverlay").classList.contains("open"), true);
  assert.equal(h.$("feedbackSubjectInput").focused, true);
  assert.equal(h.$("feedbackSend").disabled, true);
  h.type("feedbackSubjectInput", "Export stops");
  assert.equal(h.$("feedbackSend").disabled, true, "no details yet");
  h.type("feedbackDetails", "   ");
  assert.equal(h.$("feedbackSend").disabled, true, "spaces are not details");
  h.type("feedbackDetails", "It stops at 90%.");
  assert.equal(h.$("feedbackSend").disabled, false);
});

test("Close keeps the draft; Send mails the form with the app and computer added, then starts empty", () => {
  const h = harness();
  h.setVersion("0.9.1");
  h.open();
  h.$("feedbackType").value = "Bug report";
  h.$("feedbackType").selectedIndex = 1;
  h.type("feedbackSubjectInput", " Export stops ");
  h.type("feedbackDetails", "It stops at 90%.\nEvery time.");
  h.$("feedbackReplyTo").value = "me@example.com";
  h.$("feedbackClose").click();
  assert.equal(h.$("feedbackOverlay").classList.contains("open"), false);
  assert.deepEqual(h.urls, []);
  h.open();
  assert.equal(h.$("feedbackSubjectInput").value, " Export stops ", "the draft is still there");
  assert.equal(h.$("feedbackSend").disabled, false);
  h.$("feedbackSend").click();
  const body = "It stops at 90%.\r\nEvery time.\r\n\r\n---\r\nType: Bug report\r\nReply-to: me@example.com\r\n"
    + "App: Perso_DesktopApp 0.9.1\r\nComputer: macOS 15.1.0";
  assert.deepEqual(h.urls, [`mailto:team@example.com?subject=${encodeURIComponent("[Perso_DesktopApp 0.9.1] [Bug report] Export stops")}`
    + `&body=${encodeURIComponent(body)}`]);
  assert.equal(h.$("feedbackOverlay").classList.contains("open"), false);
  for (const id of ["feedbackSubjectInput", "feedbackDetails", "feedbackReplyTo"]) assert.equal(h.$(id).value, "", id);
  assert.equal(h.$("feedbackType").selectedIndex, 0);
  assert.equal(h.$("feedbackSend").disabled, true);
});
