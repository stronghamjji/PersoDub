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
        textContent: "", listeners: [],
        classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
        addEventListener(ev, fn) { this.listeners.push(fn); },
        click() { for (const fn of this.listeners) fn(); },
      });
    }
    return els.get(id);
  };
  const urls = [];
  let version = "";
  const open = initFeedbackSheet({ $, to: "team@example.com", subject: () => `Perso_DesktopApp ${version} · macOS 15.1.0 · 의견/Feedback`,
                                   openUrl: (u) => urls.push(u) });
  return { $, urls, open, setVersion: (v) => { version = v; } };
}

test("the sheet shows the address and the subject, read as it opens", () => {
  const h = harness();
  h.setVersion("0.9.1");
  h.open();
  assert.equal(h.$("feedbackOverlay").classList.contains("open"), true);
  assert.equal(h.$("feedbackTo").textContent, "To: team@example.com");
  assert.equal(h.$("feedbackSubject").textContent, "Subject: Perso_DesktopApp 0.9.1 · macOS 15.1.0 · 의견/Feedback");
});

test("Write mail opens the mail app on that subject with no body and closes the sheet; Close only closes it", () => {
  const h = harness();
  h.setVersion("0.9.1");
  h.open();
  h.$("feedbackClose").click();
  assert.equal(h.$("feedbackOverlay").classList.contains("open"), false);
  assert.deepEqual(h.urls, []);
  h.open();
  h.$("feedbackWrite").click();
  assert.deepEqual(h.urls, [`mailto:team@example.com?subject=${encodeURIComponent("Perso_DesktopApp 0.9.1 · macOS 15.1.0 · 의견/Feedback")}`]);
  assert.equal(h.$("feedbackOverlay").classList.contains("open"), false);
});
