// The production edition's sign-in screen against a stand-in shell: what
// face shows for each status the shell gives, and which shell call each
// button makes. The shell's own sign-in is desktop/src/auth.js's, tested there.
//
// Run with: node --test ui/src/signIn.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initSignIn, signInFace } from "./signIn.mjs";

function makeEl(id) {
  const classes = new Set();
  return {
    id, textContent: "", hidden: false, disabled: false, inert: false, listeners: {}, focused: 0,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    focus() { this.focused += 1; },
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    async fire(ev) { for (const fn of this.listeners[ev] || []) await fn(); },
  };
}

const SIGNED_OUT = { enabled: true, required: true, signedIn: false, account: "", hasKey: false, waiting: false, where: "" };
const WAITING = { ...SIGNED_OUT, waiting: true, where: "window" };
const SIGNED_IN = { enabled: true, required: false, signedIn: true, account: "a@test.local", hasKey: true, waiting: false, where: "" };
const NO_KEY = { ...SIGNED_IN, account: "c@test.local", hasKey: false };

// The window and the document as far as the screen listens to them: their
// events, fired by the test, and the document's visibilityState.
function eventTarget(more = {}) {
  const listeners = {};
  return {
    ...more,
    addEventListener(ev, fn) { (listeners[ev] ||= []).push(fn); },
    async fire(ev) { for (const fn of listeners[ev] || []) await fn(); },
  };
}

// A shell whose answers the test sets: `status` is what authStatus says, and
// each action answers `answers[name]` (or waits for `hold[name]`). `page` is
// the window and document the screen listens to: none, as on Node, unless given.
function harness(status, answers = {}, pollMs = 5000, page = {}) {
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  const calls = [];
  const shell = { status, hear: null, args: {} };
  for (const name of ["authLogin", "authCancel", "authShow", "authLogout", "authCheckKey", "authOpenKeyPage"]) {
    shell[name] = async (...args) => { calls.push(name); (shell.args[name] ||= []).push(args); return answers[name] ?? {}; };
  }
  shell.authStatus = async () => shell.status;
  shell.onAuthState = (cb) => { shell.hear = cb; };
  // The page under the screen: two parts, one already inert of its own.
  const body = { children: [$("signInScreen"), $("shellPart"), $("sidebar")] };
  $("sidebar").inert = true;
  const api = initSignIn({ $, shell, body, pollMs, ...page });
  const settle = () => new Promise((r) => setImmediate(r));
  return { $, api, shell, calls, settle };
}

test("each status has its face: signed out, waiting on the browser, no key, and none", () => {
  assert.equal(signInFace(SIGNED_OUT), "start");
  assert.equal(signInFace(WAITING), "wait");
  assert.equal(signInFace(NO_KEY), "nokey");
  assert.equal(signInFace(SIGNED_IN), "");
  assert.equal(signInFace({ enabled: false, required: false }), "");
  assert.equal(signInFace(null), "");
});

test("the open-source edition shows nothing and holds nothing back", async () => {
  const h = harness({ enabled: false, required: false, signedIn: false, account: "", hasKey: false, waiting: false });
  await h.settle();
  assert.equal(h.$("signInScreen").hidden, true);
  assert.equal(h.$("shellPart").inert, false);
  assert.deepEqual(h.calls, []);
});

test("a plain browser, with no shell, never asks", () => {
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  const api = initSignIn({ $, shell: null, body: { children: [] } });
  assert.equal(api.status().enabled, false);
  assert.equal($("signInBtn").listeners.click, undefined);
});

test("signed out: the sign-in face, over a page that cannot be reached", async () => {
  const h = harness(SIGNED_OUT);
  await h.settle();
  assert.equal(h.$("signInScreen").hidden, false);
  assert.equal(h.$("signInStart").hidden, false);
  assert.equal(h.$("signInWait").hidden, true);
  assert.equal(h.$("signInNoKey").hidden, true);
  assert.equal(h.$("signInBtn").textContent, "Sign in with Perso");
  assert.equal(h.$("signInHint").textContent, "", "no line under the button: people tried to press it");
  assert.equal(h.$("signInBtn").focused, 1);
  assert.equal(h.$("shellPart").inert, true);
  assert.equal(h.$("signInScreen").inert, false);

  // Signed in with a key: the app, and the page given back -- but not the
  // part that was inert before the screen came.
  h.shell.hear(SIGNED_IN);
  assert.equal(h.$("signInScreen").hidden, true);
  assert.equal(h.$("shellPart").inert, false);
  assert.equal(h.$("sidebar").inert, true);
});

test("Sign in asks the shell, waits on the browser, and lands in the app", async () => {
  let finish;
  const h = harness(SIGNED_OUT);
  h.shell.authLogin = () => { h.calls.push("authLogin"); return new Promise((r) => { finish = r; }); };
  await h.settle();
  const pressed = h.$("signInBtn").fire("click");
  h.shell.hear(WAITING);
  assert.equal(h.$("signInWait").hidden, false);
  assert.equal(h.$("signInReopen").focused, 1);

  await h.$("signInCancel").fire("click");
  assert.ok(h.calls.includes("authCancel"));

  h.shell.status = SIGNED_IN;
  finish({ outcome: "signed_in", key: "saved" });
  await pressed;
  assert.equal(h.$("signInScreen").hidden, true);
  assert.deepEqual(h.calls, ["authLogin", "authCancel"]);
});

test("Open again brings the waiting sign-in's window forward, with no new sign-in", async () => {
  const h = harness(WAITING, { authShow: { outcome: "shown" } });
  await h.settle();
  await h.$("signInReopen").fire("click");
  assert.deepEqual(h.calls, ["authShow"]);
  assert.equal(h.$("signInWait").hidden, false);
  assert.equal(h.$("signInHint").textContent, "", "no line under the button: people tried to press it");
});

test("a sign-in cancelled by closing its window says nothing about it", async () => {
  const h = harness(SIGNED_OUT, { authLogin: { outcome: "cancelled" } });
  await h.settle();
  await h.$("signInBtn").fire("click");
  assert.equal(h.$("signInHint").textContent, "");
  assert.equal(h.$("signInBtn").textContent, "Sign in with Perso");
});

// Perso's sign-in is in a window of the app's own since 2026-10-27, and
// Google and Microsoft go on in the computer's browser from there: the
// waiting face says which, in English and in Korean.
test("the waiting face says where the sign-in goes on: the sign-in window, or the browser after Google or Microsoft", async () => {
  const h = harness(WAITING, { authShow: { outcome: "shown" } });
  await h.settle();
  assert.equal(h.$("signInWaitTitle").textContent, "Finish signing in in the sign-in window");
  assert.equal(h.$("signInReopen").textContent, "Open the sign-in window again");
  assert.equal(h.$("signInWaitNote").hidden, true, "the browser's line under the window's title");
  h.shell.hear({ ...WAITING, where: "browser" });
  assert.equal(h.$("signInWait").hidden, false);
  assert.equal(h.$("signInWaitTitle").textContent, "Finish signing in in your browser");
  assert.equal(h.$("signInWaitNote").hidden, false);
  assert.equal(h.$("signInWaitNote").textContent, "Finish signing in with Google or Microsoft in your browser. If you are done and nothing happens here, press Continue.");
  assert.equal(h.$("signInReopen").textContent, "Continue");
  // The same face: its button already has the keyboard.
  assert.equal(h.$("signInReopen").focused, 1);
  // Continue is the same call: the shell runs Perso's Google or Microsoft start in the browser again.
  await h.$("signInReopen").fire("click");
  assert.deepEqual(h.calls, ["authShow"]);
  // Back in the window (a sign-in started again): the line goes.
  h.shell.hear(WAITING);
  assert.equal(h.$("signInWaitNote").hidden, true);

  const ko = JSON.parse(readFileSync(new URL("../../static/i18n/ui.ko.json", import.meta.url), "utf8"));
  assert.equal(ko["Finish signing in in the sign-in window"], "로그인 창에서 로그인을 마쳐요");
  assert.equal(ko["Open the sign-in window again"], "로그인 창 다시 열기");
  assert.equal(ko["Finish signing in in your browser"], "브라우저에서 로그인을 마쳐요");
  assert.equal(ko["Continue"], "계속하기");
  assert.equal(ko["Finish signing in with Google or Microsoft in your browser. If you are done and nothing happens here, press Continue."],
    "브라우저에서 Google 또는 Microsoft 로그인을 마쳐요. 마쳤는데 여기서 아무 일도 없으면 계속하기를 눌러요.");
  assert.equal(ko["Couldn't open the sign-in window."], "로그인 창을 열지 못했어요.");
  // The screen writes these three, so the markup's translation must not write them back.
  const html = readFileSync(new URL("../../static/index.html", import.meta.url), "utf8");
  const wait = html.slice(html.indexOf('id="signInWait"'), html.indexOf('id="signInNoKey"'));
  for (const id of ["signInWaitTitle", "signInWaitNote", "signInReopen"]) {
    const tag = new RegExp(`<[^>]*id="${id}"[^>]*>`).exec(wait)?.[0];
    assert.ok(tag && !tag.includes("data-i18n"), `${id}: ${tag}`);
  }
});

test("a failed sign-in says why in one line, and its button tries again", async () => {
  const h = harness(SIGNED_OUT, { authLogin: { outcome: "failed", error: "timeout" } });
  await h.settle();
  await h.$("signInBtn").fire("click");
  assert.equal(h.$("signInHint").textContent, "Sign-in took too long.");
  assert.ok(h.$("signInHint").classList.contains("danger"));
  assert.equal(h.$("signInBtn").textContent, "Try again");

  h.shell.authLogin = async () => ({ outcome: "failed", error: "token" });
  await h.$("signInBtn").fire("click");
  assert.equal(h.$("signInHint").textContent, "Couldn't sign in.");

  h.shell.authLogin = async () => { throw new Error("no shell"); };
  await h.$("signInBtn").fire("click");
  assert.equal(h.$("signInHint").textContent, "Couldn't sign in.");
});

// The app restored signed in to an account with no key showed the no-key face without the key page (2026-10-27).
test("an account with no key: the key page opens once as the face comes, then Check again until it has one", async () => {
  const h = harness(NO_KEY, { authCheckKey: { key: "no_key", keyReason: "none" } });
  await h.settle();
  assert.equal(h.$("signInNoKey").hidden, false);
  assert.equal(h.$("signInAccount").textContent, "c@test.local");
  assert.equal(h.$("signInMakeKey").focused, 1);
  assert.deepEqual(h.calls, ["authOpenKeyPage"]);
  // The same face painted again opens nothing more.
  h.shell.hear(NO_KEY);
  h.shell.hear({ ...NO_KEY });
  assert.deepEqual(h.calls, ["authOpenKeyPage"]);

  // Check again that still finds no key keeps the face, and opens nothing.
  await h.$("signInCheckKey").fire("click");
  assert.deepEqual(h.calls, ["authOpenKeyPage", "authCheckKey"]);
  assert.equal(h.$("signInKeyNote").textContent, "Still no API key. Make one, then check again.");
  assert.equal(h.$("signInCheckKey").disabled, false);
  // Make a key still opens it.
  await h.$("signInMakeKey").fire("click");
  assert.deepEqual(h.calls, ["authOpenKeyPage", "authCheckKey", "authOpenKeyPage"]);

  h.shell.authCheckKey = async () => ({ key: "failed" });
  await h.$("signInCheckKey").fire("click");
  assert.equal(h.$("signInKeyNote").textContent, "Couldn't check the key. Check your connection.");

  h.shell.authCheckKey = async () => ({ key: "saved" });
  h.shell.status = { ...NO_KEY, hasKey: true };
  await h.$("signInCheckKey").fire("click");
  assert.equal(h.$("signInKeyNote").textContent, "");
  assert.equal(h.$("signInScreen").hidden, true);
});

test("signing out from anywhere brings the sign-in back", async () => {
  const h = harness(SIGNED_IN);
  await h.settle();
  assert.equal(h.$("signInScreen").hidden, true);
  h.shell.hear(SIGNED_OUT);
  assert.equal(h.$("signInScreen").hidden, false);
  assert.equal(h.$("signInStart").hidden, false);
});

test("the page hears every status, and logout goes through the shell", async () => {
  const h = harness(SIGNED_IN, { authLogout: { outcome: "signed_out" } });
  const heard = [];
  h.api.onChange((s) => heard.push(s.account));
  await h.settle();
  h.shell.hear({ ...SIGNED_IN, account: "b@test.local" });
  await h.api.logout();
  assert.deepEqual(h.calls, ["authLogout"]);
  assert.equal(heard[0], "a@test.local");
  assert.equal(heard[1], "b@test.local");
});

test("the no-key face has a way out: Sign out brings the sign-in back", async () => {
  const h = harness(NO_KEY);
  h.shell.authLogout = async () => { h.calls.push("authLogout"); h.shell.status = SIGNED_OUT; return { outcome: "signed_out" }; };
  await h.settle();
  assert.equal(h.$("signInNoKey").hidden, false);
  await h.$("signInSignOut").fire("click");
  assert.deepEqual(h.calls, ["authOpenKeyPage", "authLogout"]);
  assert.equal(h.$("signInStart").hidden, false);
  assert.equal(h.$("signInNoKey").hidden, true);
  // Back on the no-key face later: the key page opens again, once.
  h.shell.hear(NO_KEY);
  h.shell.hear(NO_KEY);
  assert.deepEqual(h.calls, ["authOpenKeyPage", "authLogout", "authOpenKeyPage"]);
});

test("signed in to an account with no key: the key page opens by itself, and a key made later is taken without a press", async () => {
  const h = harness(SIGNED_OUT, {}, 5);
  h.shell.authLogin = async () => { h.calls.push("authLogin"); h.shell.status = NO_KEY; return { outcome: "signed_in", key: "no_key" }; };
  h.shell.authCheckKey = async () => { h.calls.push("authCheckKey"); return { key: "no_key" }; };
  await h.settle();
  await h.$("signInBtn").fire("click");
  assert.deepEqual(h.calls, ["authLogin", "authOpenKeyPage"]);
  assert.equal(h.$("signInNoKey").hidden, false);
  // The account gets a key on the site: the next look finds it and the screen goes.
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(h.calls.filter((c) => c === "authCheckKey").length >= 1, "the keys were not looked at again");
  h.shell.authCheckKey = async () => { h.calls.push("authCheckKey"); h.shell.status = { ...NO_KEY, hasKey: true }; return { key: "saved" }; };
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.$("signInScreen").hidden, true);
  // ...and the looking stops with the face.
  const looked = h.calls.filter((c) => c === "authCheckKey").length;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.filter((c) => c === "authCheckKey").length, looked);
});

test("coming back to the app on the no-key face looks for a key once, quietly", async () => {
  const win = eventTarget();
  const doc = eventTarget({ visibilityState: "visible" });
  // A slow timer: only the way back to the app looks here.
  const h = harness(NO_KEY, { authCheckKey: { key: "no_key" } }, 60_000, { win, doc });
  await h.settle();
  assert.deepEqual(h.calls, ["authOpenKeyPage"]);
  await win.fire("focus");
  assert.deepEqual(h.calls, ["authOpenKeyPage", "authCheckKey"], "the window's focus did not look exactly once");
  assert.equal(h.$("signInKeyNote").textContent, "", "a look nobody pressed for says nothing");
  // In view again: one more look. Going out of view is no reason to look.
  doc.visibilityState = "hidden";
  await doc.fire("visibilitychange");
  assert.deepEqual(h.calls, ["authOpenKeyPage", "authCheckKey"]);
  doc.visibilityState = "visible";
  await doc.fire("visibilitychange");
  assert.deepEqual(h.calls, ["authOpenKeyPage", "authCheckKey", "authCheckKey"]);
  // A key found that way moves the screen on; after that, focus looks for nothing.
  h.shell.authCheckKey = async () => { h.calls.push("authCheckKey"); h.shell.status = SIGNED_IN; return { key: "saved" }; };
  await win.fire("focus");
  assert.equal(h.$("signInScreen").hidden, true);
  await win.fire("focus");
  assert.equal(h.calls.length, 4);
});

// The person decides when the browser opens again (2026-10-27).
test("waiting in the browser, coming back to the app opens nothing by itself; Continue does, with nothing more to say", async () => {
  const win = eventTarget();
  const doc = eventTarget({ visibilityState: "visible", hasFocus: () => true });
  const h = harness({ ...WAITING, where: "browser" }, { authShow: { outcome: "shown" } }, 5, { win, doc });
  await h.settle();
  await win.fire("focus");
  await doc.fire("visibilitychange");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(h.calls, []);
  await h.$("signInReopen").fire("click");
  assert.deepEqual(h.calls, ["authShow"]);
  assert.deepEqual(h.shell.args.authShow, [[]]);
});

test("the slow look waits while the app is out of view", async () => {
  const doc = eventTarget({ visibilityState: "hidden" });
  const h = harness(NO_KEY, { authCheckKey: { key: "no_key" } }, 5, { doc });
  await h.settle();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(h.calls, ["authOpenKeyPage"], "the keys were looked at while the app was hidden");
  doc.visibilityState = "visible";
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(h.calls.includes("authCheckKey"), "the keys were not looked at once the app was in view");
  h.shell.status = SIGNED_IN;   // the face goes, and the looking with it
  h.shell.hear(SIGNED_IN);
});

test("a key this computer could not save says so, on Check again and after signing in", async () => {
  const h = harness(NO_KEY, { authCheckKey: { key: "failed", keyReason: "save" } });
  await h.settle();
  await h.$("signInCheckKey").fire("click");
  assert.equal(h.$("signInKeyNote").textContent, "Couldn't save the key on this computer.");

  const s = harness(SIGNED_OUT);
  s.shell.authLogin = async () => { s.shell.status = NO_KEY; return { outcome: "signed_in", key: "failed", keyReason: "save" }; };
  await s.settle();
  await s.$("signInBtn").fire("click");
  assert.equal(s.$("signInNoKey").hidden, false);
  assert.equal(s.$("signInKeyNote").textContent, "Couldn't save the key on this computer.");
});

test("no free port on this computer says so under the button", async () => {
  const h = harness(SIGNED_OUT, { authLogin: { outcome: "failed", error: "port" } });
  await h.settle();
  await h.$("signInBtn").fire("click");
  assert.equal(h.$("signInHint").textContent, "Couldn't start the sign-in. Try again.");
});

test("no answer from Perso says to check the connection; a key that could not be read after signing in says so on the no-key face", async () => {
  const h = harness(SIGNED_OUT, { authLogin: { outcome: "failed", error: "network" } });
  await h.settle();
  await h.$("signInBtn").fire("click");
  assert.equal(h.$("signInHint").textContent, "Couldn't reach Perso. Check your connection.");
  assert.equal(h.$("signInBtn").textContent, "Try again");

  h.shell.authLogin = async () => { h.shell.status = NO_KEY; return { outcome: "signed_in", key: "failed" }; };
  await h.$("signInBtn").fire("click");
  assert.equal(h.$("signInNoKey").hidden, false);
  assert.equal(h.$("signInKeyNote").textContent, "Couldn't check the key. Check your connection.");
});

test("an account with nothing to show it by reads as Perso account, never an empty line", async () => {
  const h = harness({ ...NO_KEY, account: "" });
  await h.settle();
  assert.equal(h.$("signInAccount").textContent, "Perso account");
});

test("Home shows the signed-in account under the brand, and nothing when signed out or in the open-source edition", async () => {
  const h = harness(SIGNED_IN);
  await h.settle();
  assert.equal(h.$("homeAccount").hidden, false);
  assert.equal(h.$("homeAccountName").textContent, "a@test.local");
  assert.equal(h.$("homeAccount").title, "signed in as a@test.local");
  h.shell.hear(SIGNED_OUT);
  assert.equal(h.$("homeAccount").hidden, true);
  assert.equal(h.$("homeAccountName").textContent, "");
  h.shell.hear({ ...SIGNED_IN, account: "" });
  assert.equal(h.$("homeAccountName").textContent, "Perso account");
  const oss = harness({ enabled: false, required: false, signedIn: false, account: "", hasKey: true, waiting: false });
  await oss.settle();
  assert.equal(oss.$("homeAccount").hidden, true);
});

// The charts' sign_in_shown (ui/src/events.mjs): who stops at the sign-in, on which face, once a face.
test("each face the sign-in screen comes to is a step, once while it stays; the app itself is none", async () => {
  const steps = [];
  const h = harness(SIGNED_OUT, {}, 5000, { record: (name, props) => steps.push([name, props]) });
  await h.settle();
  h.shell.hear(SIGNED_OUT);
  h.shell.hear(WAITING);
  h.shell.hear(NO_KEY);
  h.shell.hear(SIGNED_IN);
  h.shell.hear(SIGNED_OUT);
  assert.deepEqual(steps, [["sign_in_shown", { face: "start" }], ["sign_in_shown", { face: "wait" }],
    ["sign_in_shown", { face: "nokey" }], ["sign_in_shown", { face: "start" }]]);
});
