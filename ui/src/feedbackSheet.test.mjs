// Run with: node --test ui/src/feedbackSheet.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initFeedbackSheet, PRIVACY_URL } from "./feedbackSheet.mjs";
import { loadTable, setLanguage } from "./i18n.mjs";

// The form's elements, the shell's sendInquiry answering `answer`, the
// page's language, and the signed-in account's line (an e-mail, or a name).
function harness({ answer = { id: "7C2E91AB" }, language = "ko", account = "a@test.local" } = {}) {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) {
      const classes = new Set();
      els.set(id, {
        value: "", selectedIndex: 0, checked: false, disabled: false, hidden: false, focused: false, textContent: "", listeners: {},
        classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
        addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
        async fire(ev, e = {}) { for (const fn of this.listeners[ev] || []) await fn(e); },
        click() { return this.fire("click", { preventDefault() {} }); },
        focus() { this.focused = true; },
      });
    }
    return els.get(id);
  };
  $("feedbackType").value = "problem";
  const sent = [], urls = [], steps = [];
  const open = initFeedbackSheet({ $, language: () => language, openUrl: (u) => urls.push(u), account: () => account,
                                   send: async (form) => { sent.push(form); return answer; },
                                   record: (name, props) => steps.push([name, props]) });
  const type = (id, text) => { $(id).value = text; $(id).fire("input"); };
  const agree = (on = true) => { $("feedbackConsent").checked = on; $("feedbackConsent").fire("change"); };
  return { $, sent, urls, open, type, agree, steps };
}

test("the form opens on its subject, and Send waits for a subject, details and the consent", () => {
  const h = harness();
  h.open();
  assert.equal(h.$("feedbackOverlay").classList.contains("open"), true);
  assert.equal(h.$("feedbackSubjectInput").focused, true);
  assert.equal(h.$("feedbackSend").disabled, true);
  h.type("feedbackSubjectInput", "Export stops");
  h.type("feedbackDetails", "   ");
  h.agree();
  assert.equal(h.$("feedbackSend").disabled, true, "spaces are not details");
  h.type("feedbackDetails", "It stops at 90%.");
  assert.equal(h.$("feedbackSend").disabled, false);
  h.agree(false);
  assert.equal(h.$("feedbackSend").disabled, true, "no consent, no Send");
});

test("only a bug report says it sends the logs", () => {
  const h = harness();
  h.open();
  assert.equal(h.$("feedbackLogsNote").hidden, true);
  h.$("feedbackType").value = "bug";
  h.$("feedbackType").fire("change");
  assert.equal(h.$("feedbackLogsNote").hidden, false);
});

// An account with no e-mail has no address to answer at: the line under
// Reply-to would promise one (re-test, 2026-10-27).
test("the line under Reply-to says an empty one is answered at the account's address only when the account has an e-mail", () => {
  for (const [account, hidden] of [["a@test.local", false], ["Perso user", true], ["", true]]) {
    const h = harness({ account });
    h.open();
    assert.equal(h.$("feedbackReplyToHint").hidden, hidden, JSON.stringify(account));
  }
});

test("the privacy policy opens in the browser in the page's language", () => {
  const ko = harness();
  ko.$("feedbackPrivacy").click();
  const en = harness({ language: "en" });
  en.$("feedbackPrivacy").click();
  assert.deepEqual([...ko.urls, ...en.urls], [PRIVACY_URL.ko, PRIVACY_URL.en]);
  assert.match(PRIVACY_URL.ko, /^https:\/\/info\.perso\.ai\/policy-perso-saas\/policy\/privacy-policy\/docs\/260619\.html$/);
  assert.match(PRIVACY_URL.en, /^https:\/\/info\.perso\.ai\/policy-perso-saas\/policy\/privacy-policy-en\/docs\/260619\.html$/);
});

async function fillAndSend(h) {
  h.open();
  h.$("feedbackType").value = "bug";
  h.$("feedbackType").selectedIndex = 1;
  h.type("feedbackSubjectInput", " Export stops ");
  h.type("feedbackDetails", "It stops at 90%.\nEvery time.");
  h.$("feedbackReplyTo").value = " me@example.com ";
  h.agree();
  await h.$("feedbackSend").click();
}

test("Send hands the shell the form, trimmed, then says the reference and starts empty", async () => {
  const h = harness();
  await fillAndSend(h);
  assert.deepEqual(h.sent, [{ type: "bug", subject: "Export stops", details: "It stops at 90%.\nEvery time.",
                              replyTo: "me@example.com", locale: "ko" }]);
  assert.equal(h.$("feedbackStatus").textContent, "Received. Reference 7C2E91AB");
  for (const id of ["feedbackSubjectInput", "feedbackDetails", "feedbackReplyTo"]) assert.equal(h.$(id).value, "", id);
  assert.equal(h.$("feedbackConsent").checked, false);
  assert.equal(h.$("feedbackType").selectedIndex, 0);
  assert.equal(h.$("feedbackSend").disabled, true);
  h.open();
  assert.equal(h.$("feedbackStatus").textContent, "", "the line goes when it opens again");
});

// The support web app's id is already the reference a person reads out.
test("the reference is the web app's id as it came, neither cut nor capitalised", async () => {
  const h = harness({ answer: { id: "ab12cd34ef" } });
  await fillAndSend(h);
  assert.equal(h.$("feedbackStatus").textContent, "Received. Reference ab12cd34ef");
});

test("one the shell keeps for later says it goes next launch; one it could not keep stays in the form", async () => {
  const later = harness({ answer: { queued: true } });
  await fillAndSend(later);
  assert.equal(later.$("feedbackStatus").textContent, "Could not send it now. It is saved and goes the next time the app opens.");
  assert.equal(later.$("feedbackSubjectInput").value, "");

  const lost = harness({ answer: null });
  await fillAndSend(lost);
  assert.equal(lost.$("feedbackStatus").textContent, "Could not send it. Try again in a moment.");
  assert.equal(lost.$("feedbackSubjectInput").value, " Export stops ", "kept to send again");
  assert.equal(lost.$("feedbackSend").disabled, false);
});

test("asked for an address (no Reply-to and an account with no e-mail), it says so in the page's language and keeps the form", async () => {
  const ko = JSON.parse(readFileSync(new URL("../../static/i18n/ui.ko.json", import.meta.url), "utf8"));
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ko });
  try {
    await loadTable("ko");
    for (const [language, line] of [["en", "Add an email so we can answer."], ["ko", "답장 받을 이메일을 적어 주세요."]]) {
      setLanguage(language);
      const h = harness({ answer: { needReplyTo: true }, language });
      await fillAndSend(h);
      assert.equal(h.$("feedbackStatus").textContent, line);
      assert.equal(h.$("feedbackSubjectInput").value, " Export stops ", "kept to send again");
      assert.equal(h.$("feedbackConsent").checked, true);
      assert.equal(h.$("feedbackReplyTo").focused, true);
      assert.equal(h.$("feedbackSend").disabled, false);
    }
  } finally {
    globalThis.fetch = real;
    setLanguage("en");
  }
});

test("Close keeps the draft and sends nothing", () => {
  const h = harness();
  h.open();
  h.type("feedbackSubjectInput", "Export stops");
  h.$("feedbackClose").click();
  assert.equal(h.$("feedbackOverlay").classList.contains("open"), false);
  assert.deepEqual(h.sent, []);
  h.open();
  assert.equal(h.$("feedbackSubjectInput").value, "Export stops");
});

// The charts' inquiry steps (ui/src/events.mjs): the kind and whether it went
// now, never the subject, the details or the address.
test("an inquiry sent, kept for later, or not sent is a step with its kind and nothing it says", async () => {
  const outcomes = [];
  for (const answer of [{ id: "7C2E91AB" }, { queued: true }, { needReplyTo: true }, null]) {
    const h = harness({ answer });
    h.open();
    h.$("feedbackType").value = "bug";
    h.type("feedbackSubjectInput", "Export stops");
    h.type("feedbackDetails", "It stops at 90% on my wedding video.");
    h.$("feedbackReplyTo").value = "me@test.local";
    h.agree();
    await h.$("feedbackSend").click();
    outcomes.push(...h.steps);
    assert.ok(!JSON.stringify(h.steps).match(/wedding|Export stops|test\.local/), "nothing typed in a step");
  }
  assert.deepEqual(outcomes, [
    ["inquiry_sent", { kind: "bug", queued: false }], ["inquiry_sent", { kind: "bug", queued: true }],
    ["inquiry_failed", { reason: "need_reply_to" }], ["inquiry_failed", { reason: "failed" }],
  ]);
});
