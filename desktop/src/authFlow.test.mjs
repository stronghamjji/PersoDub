// The whole Perso sign-in against the fake Perso (tests/fake-perso/server.mjs),
// over real HTTP: the app listens on one of its own ports, opens the authorize
// address, a scripted browser follows it, fills Perso's sign-in form when
// Perso shows one, and ends on the app's port the way a real browser does.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AUTH_FILE, authConfig, createAuth, tokenStore } from "./auth.js";
import { parseEnvFile } from "./kitEnv.js";
import { startFakePerso, FAKE_CLIENT_ID, FAKE_PASSWORD, FAKE_REDIRECTS, ACCOUNTS } from "../../tests/fake-perso/server.mjs";

let fake;
before(async () => { fake = await startFakePerso(); });
after(async () => { await fake.close(); });

// The app's ports: the ones the fake has registered for its client.
const PORTS = FAKE_REDIRECTS.map((u) => new URL(u).port).join(",");
const cfgFor = (authBase) => authConfig({ PERSODUB_AUTH_BASE: authBase, PERSODUB_AUTH_CLIENT_ID: FAKE_CLIENT_ID, PERSODUB_AUTH_REDIRECT_PORTS: PORTS });

// safeStorage's stand-in, as in src/auth.test.mjs.
const fakeSafeStorage = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`ENC:${Buffer.from(s).toString("base64")}`),
  decryptString: (b) => Buffer.from(b.toString().slice(4), "base64").toString(),
});
const kitValues = (dir) => parseEnvFile(readFileSync(join(dir, "kit.env"), "utf8"));
const getStats = async () => (await fetch(`${fake.url}/__fake/stats`)).json();
const isCallback = (u) => { try { const x = new URL(u); return x.hostname === "127.0.0.1" && x.pathname === "/callback"; } catch { return false; } };
const paramsOf = (u) => { const q = new URL(u).searchParams; return { code: q.get("code"), state: q.get("state"), error: q.get("error") }; };

// A browser with its own cookies. `typing` is the account a person would type
// into Perso's form; null means nobody does (the test fails if a form shows).
// It follows every redirect until it lands on the app's own port and asks
// that page, as a real browser does; `pages` keeps what each one said. With
// `hold` it stops short of that last request and returns its address instead.
function scriptedBrowser() {
  let cookie = "";
  const b = { typing: null, forms: 0, pages: [] };
  const remember = (res) => { const c = res.headers.get("set-cookie"); if (c) cookie = c.split(";")[0]; };
  b.open = async (start, { hold = false } = {}) => {
    let url = start;
    for (let hop = 0; hop < 10; hop++) {
      if (isCallback(url)) {
        if (hold) return url;
        const res = await fetch(url);
        b.pages.push((await res.text()).includes("Signed in to PersoDub") ? "done" : "not done");
        return url;
      }
      const res = await fetch(url, { redirect: "manual", headers: cookie ? { cookie } : {} });
      remember(res);
      if (res.status === 302) { url = new URL(res.headers.get("location"), url).href; continue; }
      const page = await res.text();
      if (res.status !== 200 || !page.includes('action="/login"')) throw new Error(`the browser stopped on HTTP ${res.status}`);
      if (!b.typing) throw new Error("Perso showed its sign-in form and nobody was there to type");
      b.forms++;
      const post = await fetch(new URL("/login", url), {
        method: "POST", redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
        body: new URLSearchParams({ email: b.typing, password: FAKE_PASSWORD, continue: new URL(url).searchParams.get("continue") }),
      });
      remember(post);
      url = new URL(post.headers.get("location"), url).href;
    }
    throw new Error("too many redirects");
  };
  b.signOutOfPerso = async () => { await fetch(`${fake.url}/logout`, { headers: { cookie } }); cookie = ""; };
  return b;
}

// The app as main.js wires it, with a browser that runs on its own once the
// app has opened it. `hold` keeps the browser's last address in `held` for the
// test to deliver itself; a browser that could not reach Perso puts its error
// in `browserErrors`.
function theApp({ userData = mkdtempSync(join(tmpdir(), "odflow-user-")), kitDir, browser, hold = false,
                  fetchFn = fetch, safe = fakeSafeStorage(), authBase = fake.authBase }) {
  const logs = [];
  const held = [];
  const browserErrors = [];
  const auth = createAuth({
    enabled: true,
    cfg: cfgFor(authBase),
    store: tokenStore(join(userData, AUTH_FILE), safe),
    fetchFn,
    openExternal: async (url) => {
      setImmediate(async () => {
        try {
          const end = await browser.open(url, { hold });
          if (hold) held.push(end);
        } catch (err) { browserErrors.push(err); }
      });
    },
    kitDir: () => kitDir,
    log: (line) => logs.push(line),
  });
  return { auth, logs, userData, held, browserErrors };
}
const until = async (check) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10)); };
const fileOf = (userData) => join(userData, AUTH_FILE);
const portOf = (logs) => Number(logs.map((l) => /listening on port (\d+)/.exec(l)?.[1]).filter(Boolean).at(-1));

function freshKit() {
  const dir = mkdtempSync(join(tmpdir(), "odflow-kit-"));
  writeFileSync(join(dir, "kit.env"), "GEMINI_API_KEY=g-keep\nPERSO_API_KEY=\nPERSO_SPACE_SEQ=\n");
  return dir;
}

test("A signs in, signs out, signs in again without typing, then B after signing out of Perso, then C with no key", async () => {
  const kitDir = freshKit();
  const browser = scriptedBrowser();
  const { auth, logs, userData } = theApp({ kitDir, browser });
  await auth.start();
  assert.equal((await auth.status()).required, true);

  // A, typed into Perso's form; the browser ends on the app's port and is told so.
  browser.typing = "a@test.local";
  assert.deepEqual(await auth.login(), { outcome: "signed_in", key: "saved" });
  assert.equal(browser.forms, 1);
  // The app's answer does not wait on the browser being told; the browser's page comes a moment later.
  await until(() => browser.pages.length);
  assert.deepEqual(browser.pages, ["done"]);
  assert.equal(kitValues(kitDir).PERSO_API_KEY, ACCOUNTS["a@test.local"].keys[0].apiKey);
  assert.deepEqual(await auth.status(), { enabled: true, required: false, signedIn: true, account: "a***@test.local", hasKey: true, waiting: false });
  // The port is closed again: the listener lives only while a sign-in waits.
  await assert.rejects(fetch(`http://127.0.0.1:${portOf(logs)}/callback`));

  // A picks a workspace, then signs out: key and workspace go, Perso is told.
  writeFileSync(join(kitDir, "kit.env"), readFileSync(join(kitDir, "kit.env"), "utf8").replace("PERSO_SPACE_SEQ=", "PERSO_SPACE_SEQ=77"));
  const signOutsBefore = (await getStats()).signOut;
  assert.deepEqual(await auth.logout(), { outcome: "signed_out" });
  assert.equal((await getStats()).signOut, signOutsBefore + 1);
  assert.deepEqual([kitValues(kitDir).PERSO_API_KEY, kitValues(kitDir).PERSO_SPACE_SEQ, kitValues(kitDir).GEMINI_API_KEY], ["", "", "g-keep"]);
  assert.equal(existsSync(join(userData, AUTH_FILE)), false);

  // Signed in again without typing: the browser still holds A's Perso session.
  browser.typing = null;
  assert.deepEqual(await auth.login(), { outcome: "signed_in", key: "saved" });
  assert.equal((await auth.status()).account, "a***@test.local");

  // Another account: sign out of Perso in the browser, sign out here, sign in as B.
  writeFileSync(join(kitDir, "kit.env"), readFileSync(join(kitDir, "kit.env"), "utf8").replace(/PERSO_SPACE_SEQ=.*/, "PERSO_SPACE_SEQ=77"));
  await browser.signOutOfPerso();
  await auth.logout();
  browser.typing = "b@test.local";
  assert.deepEqual(await auth.login(), { outcome: "signed_in", key: "saved" });
  assert.equal(browser.forms, 2);
  assert.equal(kitValues(kitDir).PERSO_API_KEY, ACCOUNTS["b@test.local"].keys[0].apiKey);
  assert.equal(kitValues(kitDir).PERSO_SPACE_SEQ, "", "A's workspace survived the change of account");
  assert.equal((await auth.status()).account, "b***@test.local");

  // C, who has no key.
  await browser.signOutOfPerso();
  await auth.logout();
  browser.typing = "c@test.local";
  assert.deepEqual(await auth.login(), { outcome: "signed_in", key: "no_key", keyReason: "none" });
  assert.equal(kitValues(kitDir).PERSO_API_KEY, "", "B's key stayed for C");
  assert.deepEqual(await auth.status(), { enabled: true, required: false, signedIn: true, account: "c***@test.local", hasKey: false, waiting: false });

  // Nothing secret in the log.
  const all = logs.join("\n");
  for (const secret of ["@test.local", "pk_test_", "test-pass"]) assert.ok(!all.includes(secret), `the log has ${secret}`);
});

test("the next launch is signed in at once; a short-lived token is refreshed by itself", async () => {
  const kitDir = freshKit();
  const browser = scriptedBrowser();
  browser.typing = "a@test.local";
  fake.setAccessTtl(61); // runs out a second after the app's one-minute margin
  try {
    const first = theApp({ kitDir, browser });
    await first.auth.start();
    assert.equal((await first.auth.login()).outcome, "signed_in");
    await new Promise((r) => setTimeout(r, 1200));

    const refreshesBefore = (await getStats()).refresh;
    const second = theApp({ kitDir, browser, userData: first.userData });
    await second.auth.start();
    assert.equal((await second.auth.status()).signedIn, true);
    assert.equal((await getStats()).refresh, refreshesBefore + 1, "the expired token was not refreshed at launch");
    // ...and the refreshed token works: the key is read with it.
    assert.deepEqual(await second.auth.connectKey(), { key: "saved" });
  } finally { fake.setAccessTtl(3600); }
});

test("after Perso forgets the refresh token, the next launch is signed out and the key is gone", async () => {
  const kitDir = freshKit();
  const browser = scriptedBrowser();
  browser.typing = "a@test.local";
  fake.setAccessTtl(1);
  try {
    const first = theApp({ kitDir, browser });
    await first.auth.start();
    assert.equal((await first.auth.login()).outcome, "signed_in");
    fake.forgetRefreshTokens();
    const second = theApp({ kitDir, browser, userData: first.userData });
    await second.auth.start();
    assert.deepEqual(await second.auth.status(), { enabled: true, required: true, signedIn: false, account: "", hasKey: false, waiting: false });
    assert.equal(kitValues(kitDir).PERSO_API_KEY, "");
  } finally { fake.setAccessTtl(3600); }
});

test("the fake Perso refuses a wrong client, an unregistered redirect, a reused code and a wrong verifier", async () => {
  const q = (o) => new URLSearchParams({ response_type: "code", client_id: FAKE_CLIENT_ID, redirect_uri: FAKE_REDIRECTS[0],
    scope: "profile email", state: "s", code_challenge: "c", code_challenge_method: "S256", ...o });
  assert.equal((await fetch(`${fake.authBase}/v2/authorize?${q({ client_id: "other" })}`, { redirect: "manual" })).status, 400);
  assert.equal((await fetch(`${fake.authBase}/v2/authorize?${q({ redirect_uri: "http://127.0.0.1:1/callback" })}`, { redirect: "manual" })).status, 400);

  const browser = scriptedBrowser();
  browser.typing = "a@test.local";
  const { createHash } = await import("node:crypto");
  const verifier = "v".repeat(43);
  // No app listens here: the browser stops short of the app's port.
  const end = await browser.open(`${fake.authBase}/v2/authorize?${q({ code_challenge: createHash("sha256").update(verifier).digest("base64url") })}`, { hold: true });
  const code = new URL(end).searchParams.get("code");
  const trade = (codeVerifier) => fetch(`${fake.authBase}/v2/token`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: FAKE_CLIENT_ID, grantType: "authorization_code",
      authorizationCodeRequest: { code, redirectUri: FAKE_REDIRECTS[0], codeVerifier, clientSecret: null } }) });
  assert.equal((await trade("w".repeat(43))).status, 400, "a wrong verifier was accepted");
  assert.equal((await trade(verifier)).status, 400, "a code was traded after it was spent");
});

// ---- When things go wrong: the fake Perso's misbehave() --------------------------

test("Perso unreachable while the browser is open: the app keeps waiting, Cancel ends it, and the next try works", async () => {
  const kitDir = freshKit();
  const browser = scriptedBrowser();
  browser.typing = "a@test.local";
  const app = theApp({ kitDir, browser });
  await app.auth.start();
  fake.misbehave({ drop: ["authorize"] });
  try {
    const first = app.auth.login();
    await until(() => app.browserErrors.length);
    assert.equal(app.browserErrors.length, 1, "the browser reached a Perso that was down");
    assert.equal((await app.auth.status()).waiting, true);
    assert.deepEqual(await app.auth.cancelLogin(), { outcome: "cancelled" });
    assert.deepEqual(await first, { outcome: "cancelled" });
  } finally { fake.misbehave({}); }
  assert.deepEqual(await app.auth.login(), { outcome: "signed_in", key: "saved" });
});

test("a sign-in started again while one waits: the first browser, arriving late, is ignored and the second signs in", async () => {
  const kitDir = freshKit();
  const browser = scriptedBrowser();
  browser.typing = "a@test.local";
  const app = theApp({ kitDir, browser, hold: true });
  await app.auth.start();
  const first = app.auth.login();
  await until(() => app.held.length === 1);
  const second = app.auth.login();
  await until(() => app.held.length === 2);
  assert.deepEqual(await first, { outcome: "cancelled" });
  const tokensBefore = (await getStats()).token;
  assert.equal(await app.auth.handleCallback(paramsOf(app.held[0])), "bad_state");
  assert.equal((await getStats()).token, tokensBefore, "the old browser's code went to Perso");
  // The second sign-in's own port answers the second browser, over HTTP.
  const res = await fetch(app.held[1]);
  assert.ok((await res.text()).includes("Signed in to PersoDub"));
  assert.deepEqual(await second, { outcome: "signed_in", key: "saved" });
});

test("the browser back twice at once (it opened the address twice): traded once, the second ignored without an error", async () => {
  const kitDir = freshKit();
  const browser = scriptedBrowser();
  browser.typing = "b@test.local";
  const app = theApp({ kitDir, browser, hold: true });
  await app.auth.start();
  const done = app.auth.login();
  await until(() => app.held.length);
  const tokensBefore = (await getStats()).token;
  const p = paramsOf(app.held[0]);
  assert.deepEqual(await Promise.all([app.auth.handleCallback(p), app.auth.handleCallback(p)]), ["signed_in", "no_pending"]);
  assert.equal((await getStats()).token, tokensBefore + 1);
  assert.deepEqual(await done, { outcome: "signed_in", key: "saved" });
  assert.equal(await app.auth.handleCallback(p), "no_pending");
});

test("a request with no code is ignored and the sign-in keeps waiting; another path is not found; Perso's refusal ends it as denied", async () => {
  const kitDir = freshKit();
  const browser = scriptedBrowser();
  browser.typing = "a@test.local";
  const app = theApp({ kitDir, browser, hold: true });
  await app.auth.start();
  const done = app.auth.login();
  await until(() => app.held.length);
  const { state } = paramsOf(app.held[0]);
  const port = new URL(app.held[0]).port;
  assert.equal((await fetch(`http://127.0.0.1:${port}/callback`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/somewhere-else?code=x&state=${state}`)).status, 404);
  assert.equal((await app.auth.status()).waiting, true);
  const refused = await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&state=${state}`);
  assert.ok((await refused.text()).includes("did not finish"));
  assert.deepEqual(await done, { outcome: "failed", error: "denied" });
  assert.equal((await app.auth.status()).required, true);
  assert.equal(kitValues(kitDir).PERSO_API_KEY, "");
});

test("the profile cut off: still signed in, with the key", async () => {
  const kitDir = freshKit();
  const browser = scriptedBrowser();
  browser.typing = "a@test.local";
  const app = theApp({ kitDir, browser });
  await app.auth.start();
  fake.misbehave({ drop: ["profile"] });
  try {
    assert.deepEqual(await app.auth.login(), { outcome: "signed_in", key: "saved" });
  } finally { fake.misbehave({}); }
  assert.equal((await app.auth.status()).signedIn, true);
  assert.equal(kitValues(kitDir).PERSO_API_KEY, ACCOUNTS["a@test.local"].keys[0].apiKey);
});

test("the API key cut off: signed in without it, and Check again once Perso is back saves it", async () => {
  const kitDir = freshKit();
  const browser = scriptedBrowser();
  browser.typing = "a@test.local";
  const app = theApp({ kitDir, browser });
  await app.auth.start();
  fake.misbehave({ drop: ["apiKeys"] });
  try {
    assert.deepEqual(await app.auth.login(), { outcome: "signed_in", key: "failed" });
    assert.deepEqual(await app.auth.connectKey(), { key: "failed" });
    assert.equal((await app.auth.status()).hasKey, false);
  } finally { fake.misbehave({}); }
  assert.deepEqual(await app.auth.connectKey(), { key: "saved" });
  assert.equal((await app.auth.status()).hasKey, true);
});

test("at launch, no network or a Perso error while refreshing keeps the sign-in and the key for next time", async () => {
  for (const how of [{ drop: ["refresh"] }, { refreshStatus: 503 }]) {
    const kitDir = freshKit();
    const browser = scriptedBrowser();
    browser.typing = "a@test.local";
    fake.setAccessTtl(1);
    const first = theApp({ kitDir, browser });
    try {
      await first.auth.start();
      assert.equal((await first.auth.login()).outcome, "signed_in");
      fake.misbehave(how);
      const second = theApp({ kitDir, browser, userData: first.userData });
      await second.auth.start();
      assert.equal((await second.auth.status()).signedIn, true, JSON.stringify(how));
      assert.equal(kitValues(kitDir).PERSO_API_KEY, ACCOUNTS["a@test.local"].keys[0].apiKey);
      assert.ok(existsSync(fileOf(first.userData)));
      // Perso is back: the next request refreshes and goes through.
      fake.misbehave({});
      fake.setAccessTtl(3600);
      assert.deepEqual(await second.auth.connectKey(), { key: "saved" });
    } finally { fake.misbehave({}); fake.setAccessTtl(3600); }
  }
});

test("a token file that is broken or from another computer reads as signed out, and the app comes up", async () => {
  for (const content of ["{not json", "ENC:" + Buffer.from("[1,2").toString("base64"), "ENC:" + Buffer.from("\"x\"").toString("base64"), "\u0000\u0001binary"]) {
    const userData = mkdtempSync(join(tmpdir(), "odflow-user-"));
    writeFileSync(fileOf(userData), content);
    const app = theApp({ kitDir: freshKit(), browser: scriptedBrowser(), userData });
    await app.auth.start();
    assert.deepEqual(await app.auth.status(), { enabled: true, required: true, signedIn: false, account: "", hasKey: false, waiting: false });
  }
});

test("after an update the same file signs in; the open-source edition on that computer leaves it alone", async () => {
  const kitDir = freshKit();
  const browser = scriptedBrowser();
  browser.typing = "a@test.local";
  const first = theApp({ kitDir, browser });
  await first.auth.start();
  assert.equal((await first.auth.login()).outcome, "signed_in");
  const kept = readFileSync(fileOf(first.userData));

  // The open-source edition, started on the same userData: nothing read, nothing changed.
  const oss = createAuth({ enabled: false, cfg: authConfig({}), store: tokenStore(fileOf(first.userData), fakeSafeStorage()),
    fetchFn: () => { throw new Error("no network in the open-source edition"); }, openExternal: async () => {}, kitDir: () => kitDir });
  await oss.start();
  assert.equal((await oss.status()).signedIn, false);
  assert.deepEqual(readFileSync(fileOf(first.userData)), kept);

  // The next version of the production edition: the same userData, still signed in.
  const updated = theApp({ kitDir, browser, userData: first.userData });
  await updated.auth.start();
  assert.equal((await updated.auth.status()).signedIn, true);
});

test("a kit remembered as production turns the sign-in on even in an open-source build, once the kit is known", async () => {
  const kitDir = freshKit();
  writeFileSync(join(kitDir, "kit.env"), readFileSync(join(kitDir, "kit.env"), "utf8") + "PERSODUB_EDITION=production\n");
  const browser = scriptedBrowser();
  browser.typing = "a@test.local";
  let known = null; // the kit, found by the boot after the app started
  const { kitEdition } = await import("./edition.js");
  const auth = createAuth({ enabled: () => (kitEdition(known) || "opensource") === "production",
    cfg: cfgFor(fake.authBase), store: tokenStore(fileOf(mkdtempSync(join(tmpdir(), "odflow-user-"))), fakeSafeStorage()), fetchFn: fetch,
    openExternal: async (url) => { setImmediate(() => browser.open(url)); }, kitDir: () => known });
  await auth.start();
  assert.equal((await auth.status()).enabled, false);
  assert.deepEqual(await auth.login(), { outcome: "disabled" });
  known = kitDir;
  assert.equal((await auth.status()).enabled, true);
  assert.deepEqual(await auth.login(), { outcome: "signed_in", key: "saved" });
});

test("Perso's answers unwrapped and in snake_case, and its key list in other shapes, still sign in", async () => {
  const kitDir = freshKit();
  const browser = scriptedBrowser();
  browser.typing = "a@test.local";
  const app = theApp({ kitDir, browser });
  await app.auth.start();
  const key = ACCOUNTS["a@test.local"].keys[0].apiKey;
  const cases = [
    [{ bare: true, snake: true }, { outcome: "signed_in", key: "saved" }],
    [{ keys: () => ({ result: { apiKey: key } }) }, { outcome: "signed_in", key: "saved" }],
    [{ keys: () => [{ id: 1, api_key: key }] }, { outcome: "signed_in", key: "saved" }],
    [{ keys: () => ({ result: [] }) }, { outcome: "signed_in", key: "no_key", keyReason: "none" }],
    [{ keys: () => ({ result: [{ apiKey: "pk_live_****1111" }] }) }, { outcome: "signed_in", key: "no_key", keyReason: "masked" }],
    [{ keys: () => ({ result: { page: 1, rows: [{ k: key }] } }) }, { outcome: "signed_in", key: "failed", keyReason: "unknown_shape" }],
  ];
  try {
    for (const [how, want] of cases) {
      await app.auth.logout();
      fake.misbehave(how);
      assert.deepEqual(await app.auth.login(), want, JSON.stringify(how));
      assert.equal(kitValues(kitDir).PERSO_API_KEY, want.key === "saved" ? key : "", JSON.stringify(how));
    }
    // The refresh answered in the other shape too.
    fake.misbehave({ bare: true, snake: true });
    fake.setAccessTtl(1);
    await app.auth.logout();
    assert.equal((await app.auth.login()).outcome, "signed_in");
    const next = theApp({ kitDir, browser, userData: app.userData });
    await next.auth.start();
    assert.equal((await next.auth.status()).signedIn, true);
  } finally { fake.misbehave({}); fake.setAccessTtl(3600); }
  const all = app.logs.join("\n");
  assert.ok(all.includes("unknown_shape (fields: page, rows)"), all);
  assert.ok(!all.includes(key));
});

test("the system refusing its key store (a Mac's Keychain denied) still signs in for this run; the next launch asks again", async () => {
  const kitDir = freshKit();
  const browser = scriptedBrowser();
  browser.typing = "a@test.local";
  const userData = mkdtempSync(join(tmpdir(), "odflow-user-"));
  writeFileSync(fileOf(userData), "an older sign-in's file");
  const denied = { isEncryptionAvailable: () => true,
    encryptString: () => { throw new Error("Error while encrypting the text provided to safeStorage.encryptString."); },
    decryptString: () => { throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString."); } };
  const app = theApp({ kitDir, browser, userData, safe: denied });
  await app.auth.start();
  assert.deepEqual(await app.auth.login(), { outcome: "signed_in", key: "saved" });
  assert.equal((await app.auth.status()).signedIn, true);
  assert.equal(app.logs.filter((l) => l === "AUTH tokens not saved (no OS encryption)").length, 1);
  assert.equal(existsSync(fileOf(userData)), false, "an older sign-in's file was left to come back next launch");

  const next = theApp({ kitDir, browser, userData, safe: denied });
  await next.auth.start();
  assert.equal((await next.auth.status()).required, true);
});

test("no network, or a Perso slower than the app waits, at the code exchange: failed as network, signed out, and the next try works", async () => {
  const kitDir = freshKit();
  const browser = scriptedBrowser();
  browser.typing = "a@test.local";
  // The app's own wait, shortened from 15 s for the test.
  const impatient = (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(150) });
  const app = theApp({ kitDir, browser, fetchFn: impatient });
  await app.auth.start();
  try {
    for (const how of [{ drop: ["token"] }, { delayMs: 400 }]) {
      fake.misbehave(how);
      assert.deepEqual(await app.auth.login(), { outcome: "failed", error: "network" }, JSON.stringify(how));
      assert.deepEqual(await app.auth.status(), { enabled: true, required: true, signedIn: false, account: "", hasKey: false, waiting: false });
      assert.equal(existsSync(fileOf(app.userData)), false);
    }
  } finally { fake.misbehave({}); }
  assert.deepEqual(await app.auth.login(), { outcome: "signed_in", key: "saved" });
});

test("an account with no e-mail is shown by its name; with neither, the account line is empty for the screen to fill", async () => {
  const kitDir = freshKit();
  const browser = scriptedBrowser();
  browser.typing = "b@test.local";
  const app = theApp({ kitDir, browser });
  await app.auth.start();
  fake.misbehave({ noEmail: true });
  try {
    assert.equal((await app.auth.login()).outcome, "signed_in");
  } finally { fake.misbehave({}); }
  assert.equal((await app.auth.status()).account, "User B");
  assert.ok(!app.logs.join("\n").includes("User B"), "the name reached the log");
});
