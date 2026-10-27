// Drives the real desktop app through the Perso sign-in over its DevTools
// port: the sign-in wall, Sign in (the app's own sign-in window opens Perso,
// desktop/src/signInWindow.js), the way back, Settings > Account and keys,
// Sign out, and signing in again, which must show Perso's form again: the
// window's cookies go at the sign-out. Not part of any test suite: it needs
// the app running with a control port, and a person to type a Perso account
// into the sign-in window, twice, with a client Perso has registered (the
// app's own, perso-dubbing-desktop, unless PERSODUB_AUTH_CLIENT_ID says
// another). With --fake-account against the fake Perso it types by itself:
//
//   cd desktop && PERSODUB_KIT_DIR=/tmp/persodub-e2e-kit npx electron . --remote-debugging-port=9333
//   node tests/e2e/perso-login.mjs --kit-env /tmp/persodub-e2e-kit/kit.env --out <folder>
//   node tests/e2e/perso-login.mjs --signout            # only sign out, for a clean end
//
//   node tests/fake-perso/server.mjs --port 8765
//   cd desktop && PERSODUB_KIT_DIR=/tmp/persodub-e2e-kit PERSODUB_AUTH_BASE=http://127.0.0.1:8765/auth/api \
//     PERSODUB_AUTH_CLIENT_ID=persodub-fake-client PERSODUB_AUTH_REDIRECT_PORTS=52380,52381,52382 \
//     npx electron . --remote-debugging-port=9333
//   node tests/e2e/perso-login.mjs --kit-env /tmp/persodub-e2e-kit/kit.env --out <folder> --fake-account a@test.local
//
// The payload the from-source app installs its kit from is made with
// CAMPPLUS_SRC=<campplus.onnx> PERSODUB_EDITION=production node desktop/scripts/collect-payload.mjs.
// Prints one line per step and writes NN-<step>.png into --out; never a token,
// key or e-mail value. The app shows the account's full e-mail, so the line
// says only whether one is there, and the pictures in --out show it.
import { parseArgs } from "node:util";
import { mkdirSync, readFileSync } from "node:fs";
import { connect, shown, sleep, textOf } from "./lib/cdp.mjs";
import { FAKE_PASSWORD } from "../fake-perso/server.mjs";

const { values: opt } = parseArgs({ options: {
  port: { type: "string", default: "9333" }, "kit-env": { type: "string" }, out: { type: "string", default: "." },
  signout: { type: "boolean", default: false }, "fake-account": { type: "string" } } });
mkdirSync(opt.out, { recursive: true });
const app = await connect({ port: opt.port, out: opt.out });
const say = (...a) => console.log(...a);
const hidden = (s) => document.querySelector(s).hidden;
const settingsOpen = (s) => document.querySelector(s).classList.contains("open");
const keyLen = () => {
  if (!opt["kit-env"]) return "?";
  try { const m = /^PERSO_API_KEY=(.*)$/m.exec(readFileSync(opt["kit-env"], "utf8")); return m ? m[1].trim().length : -1; } catch { return -2; }
};
async function openAccountTab() {
  // Home has its own Settings button in the sidebar; the top bar's is for the work screens.
  if (!(await app.inPage(settingsOpen, "#settingsOverlay"))) {
    await app.click((await app.inPage(shown, "#homeNavSettings")) ? "#homeNavSettings" : "#settingsBtn");
  }
  await app.click("#settingsTab-keys");
}
// The sign-in window is a page of its own on the same control port, the one
// not on the app's address. Waits until it shows Perso's form (its address
// has /login in it) and answers where, without the query; null when the app
// signed in with no form shown, which is what a kept cookie does.
async function signInForm(ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    const pages = await fetch(`http://127.0.0.1:${opt.port}/json`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
    const form = pages.find((p) => p.type === "page" && /^https?:/.test(p.url) && !p.url.startsWith(app.origin) && new URL(p.url).pathname.includes("/login"));
    if (form) return form;
    if (!(await app.inPage(shown, "#signInScreen"))) return null;
  }
  throw new Error(`no sign-in window with Perso's form in ${ms / 1000} s`);
}
const where = (page) => { const u = new URL(page.url); return `${u.host}${u.pathname}`; };
// The fake Perso's form, filled and sent the way a person would, in the sign-in window.
async function typeIntoFake(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error("cannot reach the sign-in window")); });
  const expression = `document.querySelector("[name=email]").value = ${JSON.stringify(opt["fake-account"])};
    document.querySelector("[name=password]").value = ${JSON.stringify(FAKE_PASSWORD)}; document.querySelector("form").submit(); true`;
  await new Promise((ok) => { ws.onmessage = ok; ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression } })); });
  ws.close();
}
// Perso's form in the sign-in window, then the account typed: by this run
// with --fake-account, or by the person at the computer.
async function signInThroughForm() {
  const form = await signInForm(30000);
  if (!form) throw new Error("signed in without Perso's form: the sign-in window kept a cookie");
  if (opt["fake-account"]) await typeIntoFake(form);
  else say("     type the Perso account into the sign-in window");
  return where(form);
}

let failed = 0;
async function step(name, fn) {
  try { const v = await fn(); say(`OK   ${name}${v !== undefined ? ` -> ${v}` : ""}`); return true; }
  catch (e) { failed++; say(`FAIL ${name}: ${e.message}`); try { await app.shot(`fail-${name.slice(0, 2).trim()}`); } catch { /* no shot */ } return false; }
}

if (opt.signout) {
  if (await app.inPage(shown, "#signInStart")) say("already signed out");
  else {
    await openAccountTab();
    await app.click("#persoSignOutBtn");
    await app.waitFor("the sign-in screen", 15000, shown, "#signInStart");
    say("signed out: the wall is up");
  }
  app.close();
  process.exit(0);
}

say(`page: ${JSON.stringify(app.page)}`);
const wallUp = await app.inPage(shown, "#signInStart");
say(wallUp ? "state: signed out, the wall is up" : `state: already signed in (PERSO_API_KEY length=${keyLen()})`);
let pressed = !wallUp;
if (wallUp) {
  await step("1 sign-in wall is up and the app behind it is inert", async () => {
    const inert = await app.inPage(() => !!document.getElementById("settingsBtn")?.closest("[inert]") && !!document.querySelector("#settingsOverlay[inert]"));
    await app.shot("01-sign-in-wall");
    return `inert=${inert}, PERSO_API_KEY length=${keyLen()}`;
  });
  pressed = await step("2 Sign in with Perso opens the sign-in window on Perso's form and the screen waits", async () => {
    await app.click("#signInBtn");
    await app.waitFor("the waiting face", 15000, shown, "#signInWait");
    await app.shot("02-waiting-for-sign-in-window");
    return signInThroughForm();
  });
  if (pressed) await step("3 the sign-in window comes back and the app opens", async () => {
    await app.waitFor("the app", 300000, hidden, "#signInScreen");
    await app.shot("03-signed-in");
    return `PERSO_API_KEY length=${keyLen()}`;
  });
}
if (pressed) {
  await step("4 Settings > Account and keys shows the account", async () => {
    await openAccountTab();
    await app.waitFor("the account row", 10000, shown, "#persoAccountRow");
    await app.shot("04-settings-account");
    const account = await app.inPage(textOf, "#persoAccountMail");
    return `tab="${await app.inPage(textOf, "#settingsTab-keys")}" account=${account.includes("@") ? "an e-mail" : "no e-mail"} `
      + `chip="${await app.inPage(textOf, "#persoKeyChip")}" pasted-key row hidden=${await app.inPage(hidden, "#persoKeyRow")}`;
  });
  await step("5 Sign out brings the wall back and clears the key", async () => {
    await app.click("#persoSignOutBtn");
    await app.waitFor("the sign-in screen", 15000, shown, "#signInStart");
    await app.shot("05-signed-out");
    return `PERSO_API_KEY length=${keyLen()}`;
  });
  await step("6 signing in again shows Perso's form again (the window's cookies went at the sign-out) and lands in the app", async () => {
    await app.click("#signInBtn");
    const form = await signInThroughForm();
    await app.waitFor("the app", 300000, hidden, "#signInScreen");
    await app.shot("06-signed-in-again");
    return `form at ${form}, PERSO_API_KEY length=${keyLen()}`;
  });
}
app.close();
process.exit(failed ? 1 : 0);
