// Drives the real desktop app through the Perso sign-in over its DevTools
// port: the sign-in wall, Sign in (the real browser opens Perso), the way
// back, Settings > Account and keys, Sign out, and signing in again. Not part
// of any test suite: it needs the app running with a control port, a Perso
// account signed in to the browser, and a client Perso has registered.
//
//   cd desktop && PERSODUB_KIT_DIR=/tmp/persodub-e2e-kit \
//     PERSODUB_AUTH_CLIENT_ID=demo-pkce-client PERSODUB_AUTH_REDIRECT_HOST=localhost PERSODUB_AUTH_REDIRECT_PORTS=5173 \
//     npx electron . --remote-debugging-port=9333
//   node tests/e2e/perso-login.mjs --kit-env /tmp/persodub-e2e-kit/kit.env --out <folder>
//   node tests/e2e/perso-login.mjs --signout            # only sign out, for a clean end
//
// The payload the from-source app installs its kit from is made with
// CAMPPLUS_SRC=<campplus.onnx> PERSODUB_EDITION=production node desktop/scripts/collect-payload.mjs.
// Prints one line per step and writes NN-<step>.png into --out; never a token,
// key or e-mail value. The app shows the account's full e-mail, so the line
// says only whether one is there, and the pictures in --out show it.
import { parseArgs } from "node:util";
import { mkdirSync, readFileSync } from "node:fs";
import { connect, shown, textOf } from "./lib/cdp.mjs";

const { values: opt } = parseArgs({ options: {
  port: { type: "string", default: "9333" }, "kit-env": { type: "string" }, out: { type: "string", default: "." },
  signout: { type: "boolean", default: false } } });
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
  pressed = await step("2 Sign in with Perso opens the browser and the screen waits", async () => {
    await app.click("#signInBtn");
    await app.waitFor("the waiting face", 15000, shown, "#signInWait");
    await app.shot("02-waiting-for-browser");
  });
  if (pressed) await step("3 the browser comes back and the app opens", async () => {
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
  await step("6 signing in again (the browser still signed in to Perso) lands in the app", async () => {
    await app.click("#signInBtn");
    await app.waitFor("the app", 300000, hidden, "#signInScreen");
    await app.shot("06-signed-in-again");
    return `PERSO_API_KEY length=${keyLen()}`;
  });
}
app.close();
process.exit(failed ? 1 : 0);
