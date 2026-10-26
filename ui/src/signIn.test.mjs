// The production edition's sign-in screen against a stand-in shell: what
// face shows for each status the shell gives, and which shell call each
// button makes. The shell's own sign-in is desktop/src/auth.js's, tested there.
//
// Run with: node --test ui/src/signIn.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
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

const SIGNED_OUT = { enabled: true, required: true, signedIn: false, account: "", hasKey: false, waiting: false };
const WAITING = { ...SIGNED_OUT, waiting: true };
const SIGNED_IN = { enabled: true, required: false, signedIn: true, account: "a***@test.local", hasKey: true, waiting: false };
const NO_KEY = { ...SIGNED_IN, account: "c***@test.local", hasKey: false };

// A shell whose answers the test sets: `status` is what authStatus says, and
// each action answers `answers[name]` (or waits for `hold[name]`).
function harness(status, answers = {}, pollMs = 5000) {
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  const calls = [];
  const shell = { status, hear: null };
  for (const name of ["authLogin", "authCancel", "authLogout", "authCheckKey", "authOpenKeyPage"]) {
    shell[name] = async () => { calls.push(name); return answers[name] ?? {}; };
  }
  shell.authStatus = async () => shell.status;
  shell.onAuthState = (cb) => { shell.hear = cb; };
  // The page under the screen: two parts, one already inert of its own.
  const body = { children: [$("signInScreen"), $("shellPart"), $("sidebar")] };
  $("sidebar").inert = true;
  const api = initSignIn({ $, shell, body, pollMs });
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

test("Open the browser again is a new sign-in", async () => {
  const h = harness(WAITING, { authLogin: { outcome: "cancelled" } });
  await h.settle();
  await h.$("signInReopen").fire("click");
  assert.deepEqual(h.calls, ["authLogin"]);
  // A sign-in replaced or cancelled says nothing about it.
  assert.equal(h.$("signInHint").textContent, "", "no line under the button: people tried to press it");
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

test("an account with no key: the key page, then Check again until it has one", async () => {
  const h = harness(NO_KEY, { authCheckKey: { key: "no_key", keyReason: "none" } });
  await h.settle();
  assert.equal(h.$("signInNoKey").hidden, false);
  assert.equal(h.$("signInAccount").textContent, "c***@test.local");
  assert.equal(h.$("signInMakeKey").focused, 1);

  await h.$("signInMakeKey").fire("click");
  await h.$("signInCheckKey").fire("click");
  assert.deepEqual(h.calls, ["authOpenKeyPage", "authCheckKey"]);
  assert.equal(h.$("signInKeyNote").textContent, "Still no API key. Make one, then check again.");
  assert.equal(h.$("signInCheckKey").disabled, false);

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
  h.shell.hear({ ...SIGNED_IN, account: "b***@test.local" });
  await h.api.logout();
  assert.deepEqual(h.calls, ["authLogout"]);
  assert.equal(heard[0], "a***@test.local");
  assert.equal(heard[1], "b***@test.local");
});

test("the no-key face has a way out: Sign out brings the sign-in back", async () => {
  const h = harness(NO_KEY);
  h.shell.authLogout = async () => { h.calls.push("authLogout"); h.shell.status = SIGNED_OUT; return { outcome: "signed_out" }; };
  await h.settle();
  assert.equal(h.$("signInNoKey").hidden, false);
  await h.$("signInSignOut").fire("click");
  assert.deepEqual(h.calls, ["authLogout"]);
  assert.equal(h.$("signInStart").hidden, false);
  assert.equal(h.$("signInNoKey").hidden, true);
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
