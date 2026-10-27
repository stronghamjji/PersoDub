// The Perso sign-in's parts (src/auth.js, src/authLoopback.js, src/authIpc.js,
// src/signInWindow.js), with Perso played by a stub fetch, the sign-in window
// by a stub and, in most tests, the loopback listener by a stub as well. The
// whole sign-in against the fake Perso server, over real HTTP on real ports,
// is src/authFlow.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AUTH_FILE, authConfig, authorizeUrl, callbackParams, challengeFor, createAuth, newPkce,
  parseActiveKey, parseProfile, redirectUriFor, refreshTokens, tokenExpiry, tokenStore,
} from "./auth.js";
import { callbackPage, startCallbackServer } from "./authLoopback.js";
import { registerAuthIpc } from "./authIpc.js";
import { SIGN_IN_PARTITION, clearSignInStorage, signInWindowFactory } from "./signInWindow.js";
import { parseEnvFile } from "./kitEnv.js";

// safeStorage's stand-in: reversible, and never the plain text on disk.
const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`ENC:${Buffer.from(s).toString("base64")}`),
  decryptString: (b) => {
    const s = b.toString();
    if (!s.startsWith("ENC:")) throw new Error("not ours");
    return Buffer.from(s.slice(4), "base64").toString();
  },
});

const jwt = (exp) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;
const later = () => jwt(Math.floor(Date.now() / 1000) + 3600);
const gone = () => jwt(Math.floor(Date.now() / 1000) - 10);

function kitWith(text = "GEMINI_API_KEY=g-keep\nPERSO_API_KEY=\nPERSO_SPACE_SEQ=\n") {
  const dir = mkdtempSync(join(tmpdir(), "odauth-kit-"));
  writeFileSync(join(dir, "kit.env"), text);
  return dir;
}
const kitValues = (dir) => parseEnvFile(readFileSync(join(dir, "kit.env"), "utf8"));

// A stub Perso: `routes` maps "METHOD url" to (body, headers) => [status, json].
// A form's key ends in " (form)": the refresh is one, sent to the same
// address as the code exchange's JSON (REFRESH below).
function stubFetch(cfg, routes) {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    const form = opts.headers?.["Content-Type"] === "application/x-www-form-urlencoded";
    const key = `${opts.method || "GET"} ${url}${form ? " (form)" : ""}`;
    const body = !opts.body ? undefined : form ? Object.fromEntries(new URLSearchParams(opts.body)) : JSON.parse(opts.body);
    calls.push({ key, body, auth: opts.headers?.Authorization || "" });
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ code: "NOT_FOUND" }), { status: 404 });
    const answer = await route(body, opts.headers || {});
    if (answer instanceof Error) throw answer;
    const [status, json] = answer;
    return new Response(JSON.stringify(json), { status });
  };
  return { fetchFn, calls };
}

// Two ports of this test's own, apart from the flow test's (52380-52382).
const CFG = authConfig({ PERSODUB_AUTH_BASE: "https://fake.test/auth/api", PERSODUB_AUTH_CLIENT_ID: "cid", PERSODUB_AUTH_REDIRECT_PORTS: "52390,52391" });
const REDIRECT_URI = redirectUriFor(CFG, 52390);
const REFRESH = `POST ${CFG.refreshUrl} (form)`;

// The listener's stand-in: no port is opened, and the test hands the browser's
// request to auth.handleCallback itself. `listened` counts the doors opened,
// `closed` the sign-ins that ended.
function stubListen() {
  const closed = [];
  const listened = [];
  return {
    closed, listened,
    listen: async ({ ports }) => { listened.push(ports[0]); return { port: ports[0], close: () => closed.push(ports[0]) }; },
  };
}

// The sign-in window's stand-in: `opened` is each window's address, `windows`
// what it was given (url, navigation, onClosed, onFailed) and how often it was
// brought forward (shown) or closed.
function stubWindows() {
  const opened = [];
  const windows = [];
  const make = (w) => {
    const win = { ...w, shown: 0, closed: 0 };
    windows.push(win);
    opened.push(w.url);
    return { show: () => { win.shown++; }, close: () => { win.closed++; } };
  };
  return { opened, windows, make };
}

// A signed-in Perso with one account. Overrides replace single routes.
function persoRoutes({ userId = "u1", email = "someone@test.local", keys = [{ apiKey: "pk_test_K1" }], ...over } = {}) {
  return {
    [`POST ${CFG.tokenUrl}`]: () => [200, { result: { accessToken: later(), refreshToken: "r1" } }],
    [REFRESH]: () => [200, { access_token: later(), refresh_token: "r2", token_type: "Bearer", expires_in: 1800 }],
    [`GET ${CFG.profileUrl}`]: () => [200, { result: { userSeq: userId, userName: "", email, provider: "email" } }],
    [`GET ${CFG.apiKeysUrl}`]: () => [200, { result: keys }],
    [`POST ${CFG.signOutUrl}`]: () => [200, { result: null }],
    ...over,
  };
}

// createAuth with everything on disk in fresh temp folders, the sign-in
// window replaced by stubWindows.
function makeAuth({ routes = persoRoutes(), enabled = true, kitDir = kitWith(), userData, safe = fakeSafeStorage(), now, listen, loginTimeoutMs, onSignOut, clearSignInSession } = {}) {
  const dir = userData || mkdtempSync(join(tmpdir(), "odauth-user-"));
  const { opened, windows, make } = stubWindows();
  const logs = [];
  const { fetchFn, calls } = stubFetch(CFG, routes);
  const stub = stubListen();
  const auth = createAuth({
    enabled, cfg: CFG, store: tokenStore(join(dir, AUTH_FILE), safe), fetchFn, listen: listen || stub.listen,
    makeSignInWindow: make, kitDir: () => kitDir,
    log: (line) => logs.push(line), ...(now ? { now } : {}), ...(loginTimeoutMs ? { loginTimeoutMs } : {}),
    ...(onSignOut ? { onSignOut } : {}), ...(clearSignInSession ? { clearSignInSession } : {}),
  });
  return { auth, opened, windows, logs, calls, kitDir, userData: dir, closed: stub.closed, listened: stub.listened };
}
const stateOf = (url) => new URL(url).searchParams.get("state");
const settle = () => new Promise((r) => setImmediate(r));
const until = async (check) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5)); };
// The browser back, as the listener would hand it over.
const back = (opened, code = "c1") => ({ code, state: stateOf(opened.at(-1)) });

// ---- PKCE and the authorize address -----------------------------------------

test("the S256 challenge matches RFC 7636's own example", () => {
  assert.equal(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("a fresh verifier is 43 unreserved characters, and every sign-in gets new values", () => {
  const a = newPkce();
  const b = newPkce();
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(a.challenge, challengeFor(a.verifier));
  assert.match(a.state, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(a.state, b.state);
});

test("the authorize address carries what Perso's PKCE demo sends, with the port's redirect address", () => {
  const url = new URL(authorizeUrl(CFG, { challenge: "ch", state: "st", redirectUri: REDIRECT_URI }));
  assert.equal(`${url.origin}${url.pathname}`, "https://fake.test/auth/api/v2/authorize");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    response_type: "code", client_id: "cid", redirect_uri: "http://127.0.0.1:52390/callback", scope: "profile email",
    state: "st", code_challenge: "ch", code_challenge_method: "S256",
  });
});

test("Perso's addresses default to api.perso.ai, the ports to three of this computer's, and each can be changed by the environment", () => {
  const live = authConfig({}, "0.9.1");
  assert.equal(live.authorizeUrl, "https://api.perso.ai/auth/api/v2/authorize");
  assert.equal(live.tokenUrl, "https://api.perso.ai/auth/api/v2/token");
  assert.equal(live.refreshUrl, "https://api.perso.ai/auth/api/v2/token");
  assert.equal(live.signOutUrl, "https://api.perso.ai/auth/api/v1/auth/sign-out");
  assert.equal(live.profileUrl, "https://api.perso.ai/user/api/v1/users/profile");
  assert.equal(live.apiKeysUrl, "https://api.perso.ai/auth/api/v1/api-keys/active");
  // With the tail every link into Perso carries (app/perso_client.py UTM_TAIL)
  // and the button, as the key window's link (SIGNUP_LINK).
  assert.equal(live.keyPageUrl, "https://developers.perso.ai/api-keys?utm_source=desktop_app&utm_medium=desktop-app&utm_campaign=desktop_app&utm_term=v0.9.1&utm_content=signup");
  assert.equal(live.scope, "profile email");
  assert.equal(live.clientId, "perso-dubbing-desktop");
  assert.deepEqual(live.redirectPorts, [52290, 52291, 52292]);
  assert.equal(redirectUriFor(live, 52290), "http://127.0.0.1:52290/callback");

  const own = authConfig({ PERSODUB_AUTH_BASE: "http://127.0.0.1:9/auth/api/", PERSODUB_AUTH_CLIENT_ID: "mine",
    PERSODUB_AUTH_REFRESH_PATH: "/r", PERSODUB_AUTH_PROFILE_PATH: "/p", PERSODUB_AUTH_API_KEYS_PATH: "/k", PERSODUB_AUTH_SIGNOUT_PATH: "/o",
    PERSODUB_KEY_PAGE_URL: "http://keys.test/?from=x", PERSODUB_AUTH_REDIRECT_HOST: "localhost", PERSODUB_AUTH_REDIRECT_PORTS: " 5173, x, 70000, 0 " }, "0.9.1");
  assert.equal(own.authorizeUrl, "http://127.0.0.1:9/auth/api/v2/authorize");
  assert.equal(own.tokenUrl, "http://127.0.0.1:9/auth/api/v2/token");
  assert.deepEqual([own.refreshUrl, own.profileUrl, own.apiKeysUrl, own.signOutUrl], ["http://127.0.0.1:9/r", "http://127.0.0.1:9/p", "http://127.0.0.1:9/k", "http://127.0.0.1:9/o"]);
  assert.equal(own.clientId, "mine");
  assert.equal(own.keyPageUrl, "http://keys.test/?from=x&utm_source=desktop_app&utm_medium=desktop-app&utm_campaign=desktop_app&utm_term=v0.9.1&utm_content=signup");
  assert.deepEqual(own.redirectPorts, [5173]);
  assert.equal(redirectUriFor(own, 5173), "http://localhost:5173/callback");
  assert.deepEqual(authConfig({ PERSODUB_AUTH_REDIRECT_PORTS: "nonsense" }).redirectPorts, [52290, 52291, 52292]);
});

test("the browser's request back is read for its code or Perso's error, and anything else is nothing", () => {
  assert.deepEqual(callbackParams({ code: "c1", state: "s1" }), { code: "c1", state: "s1" });
  assert.deepEqual(callbackParams({ code: "c1", state: null }), { code: "c1", state: "" });
  assert.deepEqual(callbackParams({ error: "access_denied", state: "s1" }), { error: "access_denied", state: "s1" });
  assert.deepEqual(callbackParams({ error: "access_denied", code: "c1", state: "s1" }), { error: "access_denied", state: "s1" });
  for (const bad of [{ state: "s" }, { code: "", state: "s" }, { code: null, state: null, error: null }, {}, undefined]) {
    assert.equal(callbackParams(bad), null, JSON.stringify(bad));
  }
});

// ---- Perso's answers ------------------------------------------------------------

test("the API key answer: the first key with a value, else none with the field names of what came", () => {
  assert.deepEqual(parseActiveKey({ result: [{ seq: 1, apiKey: "pk_live_abc", apiKeyName: "A", status: "ACTIVE" }] }), { status: "key", value: "pk_live_abc" });
  assert.deepEqual(parseActiveKey({ result: [{ seq: 1, apiKey: " pk_live_e " }] }), { status: "key", value: "pk_live_e" });
  assert.deepEqual(parseActiveKey({ result: [{ seq: 1, apiKey: "" }, { seq: 2, apiKey: "pk_live_g" }] }), { status: "key", value: "pk_live_g" });
  assert.deepEqual(parseActiveKey({ result: [] }), { status: "none", fields: [] });
  assert.deepEqual(parseActiveKey({ result: null }), { status: "none", fields: [] });
  assert.deepEqual(parseActiveKey(null), { status: "none", fields: [] });
  assert.deepEqual(parseActiveKey({ result: { apiKey: "pk_live_b" } }), { status: "none", fields: [] });
  // No key field: the field names only, never a value, and no name with a digit (a key can be a name).
  assert.deepEqual(parseActiveKey({ result: [{ seq: 1, apiKeyName: "old", pk_live_x9: 1 }] }), { status: "none", fields: ["seq", "apiKeyName"] });
});

test("the refresh answer is RFC 6749's {access_token, refresh_token}; anything else names its fields, never a value", async () => {
  const { fetchFn } = stubFetch(CFG, { [REFRESH]: () => [200, { access_token: "a1", refresh_token: "r9", token_type: "Bearer", expires_in: 1800 }] });
  assert.deepEqual(await refreshTokens(CFG, fetchFn, "r1"), { accessToken: "a1", refreshToken: "r9" });
  for (const answer of [{ result: { accessToken: "a1", refreshToken: "r9" } }, { accessToken: "a1" }, { access_token: "" }, { jwt: "secret-value", ttl: 5 }, null]) {
    const stub = stubFetch(CFG, { [REFRESH]: () => [200, answer] });
    await assert.rejects(refreshTokens(CFG, stub.fetchFn, "r1"), (err) => /no-token/.test(err.message) && !/secret-value|a1/.test(err.message), JSON.stringify(answer));
  }
  const bare = stubFetch(CFG, { [REFRESH]: () => [200, { jwt: "secret-value", ttl: 5 }] });
  await assert.rejects(refreshTokens(CFG, bare.fetchFn, "r1"), /jwt, ttl/);
});

test("a key list with no usable key says no_key, logs the field names only, and leaves kit.env alone", async () => {
  const { auth, opened, kitDir, logs } = makeAuth({
    routes: persoRoutes({ [`GET ${CFG.apiKeysUrl}`]: () => [200, { result: [{ token: "pk_live_secret", label: "mine" }] }] }),
    kitDir: kitWith("PERSO_API_KEY=pk_before\n"),
  });
  await auth.start();
  const done = auth.login();
  await settle();
  await auth.handleCallback(back(opened));
  assert.deepEqual(await done, { outcome: "signed_in", key: "no_key" });
  assert.equal(kitValues(kitDir).PERSO_API_KEY, "pk_before");
  const line = logs.find((l) => l.includes("no API key"));
  assert.ok(line && line.includes("token, label"), logs.join("\n"));
  assert.ok(!logs.join("\n").includes("pk_live_secret"));
});

test("the profile answer gives the account's id, e-mail and name as Perso names them", () => {
  assert.deepEqual(parseProfile({ result: { userSeq: 7, userName: "Kim", email: "x@y.z", provider: "email" } }), { userId: "7", email: "x@y.z", name: "Kim" });
  // Signed in through Google: no e-mail, the name stands in.
  assert.deepEqual(parseProfile({ result: { userSeq: 5, userName: " Kim ", email: null, provider: "google" } }), { userId: "5", email: "", name: "Kim" });
  assert.deepEqual(parseProfile({ result: {} }), { userId: null, email: "", name: "" });
  assert.deepEqual(parseProfile({}), { userId: null, email: "", name: "" });
  assert.deepEqual(parseProfile(null), { userId: null, email: "", name: "" });
});

// The owner saw the real sign-in and wants the account shown in full
// (2026-10-27): the e-mail as Perso has it, the name for an account with none.
test("the account on screen is the full e-mail, a kept sign-in's included, and the name without one", async () => {
  const userData = mkdtempSync(join(tmpdir(), "odauth-user-"));
  // What a sign-in of the first 0.9.1 builds kept: the e-mail masked beside it in full.
  tokenStore(join(userData, AUTH_FILE), fakeSafeStorage()).write({ accessToken: later(), refreshToken: "r1", userId: "u1",
    account: "so***@test.local", email: "someone@test.local" });
  const kept = makeAuth({ userData });
  assert.equal((await kept.auth.status()).account, "someone@test.local");

  const named = makeAuth({ routes: persoRoutes({ email: null, [`GET ${CFG.profileUrl}`]: () => [200, { result: { userSeq: "u3", userName: "Kim", email: null } }] }) });
  await named.auth.start();
  const done = named.auth.login();
  await settle();
  await named.auth.handleCallback(back(named.opened));
  await done;
  assert.equal((await named.auth.status()).account, "Kim");
});

test("an access token's expiry is read from its JWT exp, and anything else has none", () => {
  assert.equal(tokenExpiry(jwt(1700000000)), 1700000000 * 1000);
  assert.equal(tokenExpiry("opaque-token"), null);
  assert.equal(tokenExpiry(undefined), null);
});

// Perso's answer to a JSON refresh at v2/token is a 500 (2026-10-27): only
// the form is read there.
test("the refresh is a form to v2/token, as RFC 6749 asks, and an answer with no refresh_token keeps the old one", async () => {
  const { fetchFn, calls } = stubFetch(CFG, { [REFRESH]: () => [200, { access_token: "a2", token_type: "Bearer", expires_in: 1800 }] });
  assert.deepEqual(await refreshTokens(CFG, fetchFn, "r+1/="), { accessToken: "a2", refreshToken: "r+1/=" });
  assert.equal(calls[0].key, "POST https://fake.test/auth/api/v2/token (form)");
  assert.deepEqual(calls[0].body, { grant_type: "refresh_token", client_id: "cid", refresh_token: "r+1/=" });
});

// ---- Where the tokens are kept ------------------------------------------------------

test("the tokens are written encrypted, read back, and deleted", () => {
  const file = join(mkdtempSync(join(tmpdir(), "odauth-store-")), AUTH_FILE);
  const store = tokenStore(file, fakeSafeStorage());
  assert.equal(store.read(), null);
  assert.equal(store.write({ accessToken: "secret-access", refreshToken: "secret-refresh" }), true);
  assert.ok(!readFileSync(file, "utf8").includes("secret-access"), "the token is on disk in plain text");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(store.read(), { accessToken: "secret-access", refreshToken: "secret-refresh" });
  store.clear();
  assert.equal(existsSync(file), false);
  assert.equal(store.read(), null);
  store.clear(); // twice is fine
});

test("clearing the tokens also deletes a copy a write left half-done", () => {
  const file = join(mkdtempSync(join(tmpdir(), "odauth-store-")), AUTH_FILE);
  const store = tokenStore(file, fakeSafeStorage());
  assert.equal(store.write({ accessToken: "secret-access", refreshToken: "secret-refresh" }), true);
  writeFileSync(`${file}.tmp`, "ENC:half-written");
  store.clear();
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(`${file}.tmp`), false, "the half-written copy was left behind");
});

test("without the system's encryption nothing is written, and a file that does not decrypt reads as signed out", () => {
  const file = join(mkdtempSync(join(tmpdir(), "odauth-store-")), AUTH_FILE);
  assert.equal(tokenStore(file, fakeSafeStorage(false)).write({ accessToken: "a" }), false);
  assert.equal(existsSync(file), false);
  writeFileSync(file, "garbage");
  assert.equal(tokenStore(file, fakeSafeStorage()).read(), null);
});

// ---- The sign-in ------------------------------------------------------------------

test("a sign-in takes a port, opens the sign-in window with that port's address, takes the request back, and saves the account's key", async () => {
  const { auth, opened, calls, kitDir, userData, closed } = makeAuth();
  await auth.start();
  assert.deepEqual(await auth.status(), { enabled: true, required: true, signedIn: false, account: "", accountId: "", hasKey: false, waiting: false, where: "" });
  const done = auth.login();
  await settle();
  assert.equal(opened.length, 1);
  assert.equal((await auth.status()).waiting, true);
  assert.equal((await auth.status()).where, "window");
  const url = new URL(opened[0]);
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT_URI);
  assert.equal(await auth.handleCallback(back(opened)), "signed_in");
  assert.deepEqual(await done, { outcome: "signed_in", key: "saved" });
  // The code went with the verifier whose challenge the browser carried, and
  // with the address the browser came back to.
  const exchange = calls.find((c) => c.body?.grantType === "authorization_code").body;
  assert.equal(challengeFor(exchange.authorizationCodeRequest.codeVerifier), url.searchParams.get("code_challenge"));
  assert.deepEqual(exchange, { clientId: "cid", grantType: "authorization_code",
    authorizationCodeRequest: { code: "c1", redirectUri: REDIRECT_URI, codeVerifier: exchange.authorizationCodeRequest.codeVerifier, clientSecret: null } });
  assert.equal(kitValues(kitDir).PERSO_API_KEY, "pk_test_K1");
  assert.equal(kitValues(kitDir).GEMINI_API_KEY, "g-keep");
  // The account in full on screen (owner, 2026-10-27).
  assert.deepEqual(await auth.status(), { enabled: true, required: false, signedIn: true, account: "someone@test.local", accountId: "u1", hasKey: true, waiting: false, where: "" });
  assert.ok(existsSync(join(userData, AUTH_FILE)));
  assert.deepEqual(closed, [52390], "the port was not given back when the sign-in ended");
});

test("a sign-in without the system's encryption still works, and the log says the tokens were not kept", async () => {
  const { auth, opened, logs, userData } = makeAuth({ safe: fakeSafeStorage(false) });
  await auth.start();
  const done = auth.login();
  await settle();
  assert.equal(await auth.handleCallback(back(opened)), "signed_in");
  assert.equal((await done).outcome, "signed_in");
  assert.ok(logs.includes("AUTH tokens not saved (no OS encryption)"));
  assert.equal(existsSync(join(userData, AUTH_FILE)), false);
});

test("a request with the wrong state is ignored and the real one still works; the same request twice is traded once", async () => {
  const { auth, opened, calls } = makeAuth();
  await auth.start();
  const done = auth.login();
  await settle();
  assert.equal(await auth.handleCallback({ code: "evil", state: "forged" }), "bad_state");
  assert.equal(calls.length, 0, "a forged request reached Perso");
  assert.equal((await auth.status()).waiting, true);
  assert.equal(await auth.handleCallback(back(opened)), "signed_in");
  assert.equal((await done).outcome, "signed_in");
  assert.equal(await auth.handleCallback(back(opened)), "no_pending");
  assert.equal(calls.filter((c) => c.body?.grantType === "authorization_code").length, 1);
});

test("a request with nothing waiting, or with no code, changes nothing", async () => {
  const { auth, calls } = makeAuth();
  await auth.start();
  assert.equal(await auth.handleCallback({ code: "c", state: "s" }), "no_pending");
  assert.equal(await auth.handleCallback({ state: "s" }), "not_callback");
  assert.equal(await auth.handleCallback({}), "not_callback");
  assert.equal(calls.length, 0);
  assert.equal((await auth.status()).signedIn, false);
});

test("cancel, a newer sign-in, Perso's refusal and a window that does not open each end the waiting one, and each gives its port back and closes its window", async () => {
  const { auth, opened, windows, closed } = makeAuth();
  await auth.start();
  const first = auth.login();
  await settle();
  const second = auth.login();
  assert.deepEqual(await first, { outcome: "cancelled" });
  await settle();
  assert.deepEqual(await auth.cancelLogin(), { outcome: "cancelled" });
  assert.deepEqual(await second, { outcome: "cancelled" });
  assert.deepEqual(await auth.cancelLogin(), { outcome: "idle" });
  const third = auth.login();
  await settle();
  assert.equal(await auth.handleCallback({ error: "access_denied", state: stateOf(opened.at(-1)) }), "failed");
  assert.deepEqual(await third, { outcome: "failed", error: "denied" });
  assert.equal(closed.length, 3);
  assert.deepEqual(windows.map((w) => w.closed), [1, 1, 1]);

  const stub = stubListen();
  const noWindow = createAuth({ enabled: true, cfg: CFG, store: tokenStore(join(mkdtempSync(join(tmpdir(), "odauth-")), AUTH_FILE), fakeSafeStorage()),
    fetchFn: async () => { throw new Error("no network"); }, makeSignInWindow: () => { throw new Error("no window"); }, kitDir: () => null, listen: stub.listen });
  await noWindow.start();
  assert.deepEqual(await noWindow.login(), { outcome: "failed", error: "window" });
  assert.equal(stub.closed.length, 1);
  assert.equal((await noWindow.status()).waiting, false);
});

test("the sign-in window is closed once the code is traded, not before", async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const { auth, opened, windows } = makeAuth({ routes: persoRoutes({ [`POST ${CFG.tokenUrl}`]: async () => { await held; return [200, { result: { accessToken: later(), refreshToken: "r1" } }]; } }) });
  await auth.start();
  const done = auth.login();
  await settle();
  assert.equal(windows.length, 1);
  const url = new URL(windows[0].url);
  assert.equal(`${url.origin}${url.pathname}`, "https://fake.test/auth/api/v2/authorize");
  const trading = auth.handleCallback(back(opened));
  await settle();
  assert.equal(windows[0].closed, 0, "the window went while the code was still being traded");
  release();
  assert.equal(await trading, "signed_in");
  assert.deepEqual(await done, { outcome: "signed_in", key: "saved" });
  assert.equal(windows[0].closed, 1);
});

test("closing the sign-in window cancels the sign-in as Cancel does; closed while the code is traded, it changes nothing", async () => {
  const { auth, opened, windows, closed, logs } = makeAuth();
  await auth.start();
  const first = auth.login();
  await settle();
  windows[0].onClosed();
  assert.deepEqual(await first, { outcome: "cancelled" });
  assert.deepEqual(closed, [52390], "the port was not given back");
  assert.equal((await auth.status()).waiting, false);
  assert.ok(logs.some((l) => l.includes("window closed")), logs.join("\n"));
  windows[0].onClosed(); // twice is nothing
  assert.deepEqual(await auth.cancelLogin(), { outcome: "idle" });

  let release;
  const held = new Promise((r) => { release = r; });
  const slow = makeAuth({ routes: persoRoutes({ [`POST ${CFG.tokenUrl}`]: async () => { await held; return [200, { result: { accessToken: later(), refreshToken: "r1" } }]; } }) });
  await slow.auth.start();
  const second = slow.auth.login();
  await settle();
  const trading = slow.auth.handleCallback(back(slow.opened));
  await settle();
  slow.windows[0].onClosed();
  release();
  assert.equal(await trading, "signed_in");
  assert.deepEqual(await second, { outcome: "signed_in", key: "saved" });
  assert.equal(opened.length, 1);
});

test("Open again brings the waiting sign-in's window forward: no second window, no second port", async () => {
  const { auth, windows, listened } = makeAuth();
  await auth.start();
  assert.deepEqual(await auth.showLogin(), { outcome: "idle" });
  const done = auth.login();
  await settle();
  assert.deepEqual(await auth.showLogin(), { outcome: "shown" });
  assert.deepEqual(await auth.showLogin(), { outcome: "shown" });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].shown, 2);
  assert.equal(listened.length, 1);
  assert.equal((await auth.status()).waiting, true);
  await auth.cancelLogin();
  assert.deepEqual(await done, { outcome: "cancelled" });
  assert.deepEqual(await auth.showLogin(), { outcome: "idle" });
});

test("a sign-in window that cannot load Perso's page ends the sign-in as network, and closes", async () => {
  const { auth, windows, closed } = makeAuth();
  await auth.start();
  const done = auth.login();
  await settle();
  windows[0].onFailed();
  assert.deepEqual(await done, { outcome: "failed", error: "network" });
  assert.equal(windows[0].closed, 1);
  assert.deepEqual(closed, [52390]);
  windows[0].onFailed(); // a late one changes nothing
  assert.equal((await auth.status()).waiting, false);
});

test("the sign-in window keeps Perso's pages and this sign-in's way back, hands Google and Microsoft to the browser, opens another https page there, and denies the rest", async () => {
  const { auth, windows } = makeAuth();
  await auth.start();
  const done = auth.login();
  await settle();
  const go = windows[0].navigation;
  for (const url of [
    "https://perso.ai/en/login?continue=x", "https://api.perso.ai/auth/api/v2/authorize?client_id=x", "https://developers.perso.ai/api-keys",
    "https://fake.test/somewhere", // where the authorize address is: the fake Perso in the flow tests
    "https://perso.ai/auth/oauth2/authorization/google", // Perso's site, not its sign-in server
    "http://127.0.0.1:52390/callback?code=c&state=s",
  ]) assert.equal(go(url), "allow", url);
  // Perso's Google and Microsoft buttons start at its sign-in server (perso.ai/login,
  // 2026-10-27); Google refuses a sign-in inside an app's window. The providers'
  // own pages are handed over too, should one be reached another way.
  for (const url of [
    "https://api.perso.ai/auth/oauth2/authorization/google?redirect_uri=https%3A%2F%2Fperso.ai%2Fx&callbackUrl=y",
    "https://api.perso.ai/auth/oauth2/authorization/azure?redirect_uri=x",
    "https://fake.test/auth/oauth2/authorization/google?callbackUrl=y",
    "https://accounts.google.com/o/oauth2/v2/auth?x", "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", "https://login.live.com/oauth20_authorize.srf",
  ]) assert.equal(go(url), "hand-off", url);
  for (const url of ["https://example.com/terms", "https://perso.ai.evil.test/login", "https://evilperso.ai/", "https://perso.ai@evil.test/", "https://accounts.google.com.evil.test/",
    "https://api.perso.ai.evil.test/auth/oauth2/authorization/google"]) {
    assert.equal(go(url), "browser", url);
  }
  for (const url of ["http://perso.ai/login", "http://api.perso.ai/auth/oauth2/authorization/google", "http://accounts.google.com/o/oauth2/v2/auth",
    "http://127.0.0.1:52391/callback", "http://localhost:52390/callback", "http://127.0.0.1:5001/",
    "file:///etc/hosts", "javascript:alert(1)", "data:text/html,x", "persodub://signed-in", "about:blank", "not an address"]) {
    assert.equal(go(url), "deny", url);
  }
  await auth.cancelLogin();
  await done;
});

test("handed to the browser, the sign-in keeps waiting there: its window closing is no cancel, Open again opens the browser again, and the way back signs in", async () => {
  const { auth, opened, windows, closed, logs } = makeAuth();
  await auth.start();
  const done = auth.login();
  await settle();
  const google = "https://api.perso.ai/auth/oauth2/authorization/google?redirect_uri=x&callbackUrl=y";
  // What the window does at a hand-off (signInWindow.js): the browser opened
  // on the window's first address, this sign-in's own, then it closes.
  windows[0].onHandOff(google);
  windows[0].onClosed();
  assert.equal((await auth.status()).where, "browser");
  assert.equal((await auth.status()).waiting, true);
  assert.deepEqual(closed, [], "the port was given back while the browser was still on its way");
  assert.ok(logs.includes("AUTH Google or Microsoft in the sign-in window (api.perso.ai/auth/oauth2/authorization/google): "
    + "the whole sign-in goes on in the computer's browser at fake.test/auth/api/v2/authorize"), logs.join("\n"));
  // That first address is this sign-in's: the state the way back must carry.
  assert.equal(new URL(windows[0].url).pathname, "/auth/api/v2/authorize");
  assert.equal(stateOf(windows[0].url), stateOf(opened[0]));
  assert.deepEqual(await auth.showLogin(), { outcome: "shown" });
  assert.equal(windows[0].shown, 1);
  assert.equal(await auth.handleCallback(back(opened)), "signed_in");
  assert.deepEqual(await done, { outcome: "signed_in", key: "saved" });
  assert.equal((await auth.status()).where, "");
  windows[0].onHandOff(google); // late: changes nothing
  assert.equal((await auth.status()).where, "");

  // Cancel still ends one handed to the browser, and gives its port back.
  const next = auth.login();
  await settle();
  windows[1].onHandOff(google);
  windows[1].onClosed();
  assert.deepEqual(await auth.cancelLogin(), { outcome: "cancelled" });
  assert.deepEqual(await next, { outcome: "cancelled" });
  assert.equal(closed.length, 2);
  assert.equal((await auth.status()).where, "");
});

test("a sign-in nobody finishes times out, and its window closes", async () => {
  const { windows, make } = stubWindows();
  const auth = createAuth({ enabled: true, cfg: CFG, store: tokenStore(join(mkdtempSync(join(tmpdir(), "odauth-")), AUTH_FILE), fakeSafeStorage()),
    fetchFn: async () => { throw new Error("unused"); }, makeSignInWindow: make, kitDir: () => null, listen: stubListen().listen, loginTimeoutMs: 20 });
  await auth.start();
  assert.deepEqual(await auth.login(), { outcome: "failed", error: "timeout" });
  assert.equal((await auth.status()).waiting, false);
  assert.equal(windows[0].closed, 1);
});

test("a code Perso refuses leaves the app signed out", async () => {
  const { auth, opened, kitDir } = makeAuth({ routes: persoRoutes({ [`POST ${CFG.tokenUrl}`]: () => [400, { code: "INVALID_PKCE" }] }) });
  await auth.start();
  const done = auth.login();
  await settle();
  await auth.handleCallback(back(opened, "c"));
  assert.deepEqual(await done, { outcome: "failed", error: "token" });
  assert.equal((await auth.status()).signedIn, false);
  assert.equal(kitValues(kitDir).PERSO_API_KEY, "");
});

test("an account with no key answers no_key and leaves kit.env's key alone", async () => {
  const { auth, opened, kitDir } = makeAuth({ routes: persoRoutes({ keys: [] }), kitDir: kitWith("PERSO_API_KEY=\n") });
  await auth.start();
  const done = auth.login();
  await settle();
  await auth.handleCallback(back(opened));
  assert.deepEqual(await done, { outcome: "signed_in", key: "no_key" });
  assert.equal(kitValues(kitDir).PERSO_API_KEY, "");
  assert.equal((await auth.status()).hasKey, false);
});

test("checking for the key again finds one made after the sign-in", async () => {
  let keys = [];
  const { auth, opened, kitDir } = makeAuth({ routes: persoRoutes({ [`GET ${CFG.apiKeysUrl}`]: () => [200, { result: keys }] }) });
  await auth.start();
  const done = auth.login();
  await settle();
  await auth.handleCallback(back(opened));
  assert.equal((await done).key, "no_key");
  keys = [{ apiKey: "pk_live_new" }];
  assert.deepEqual(await auth.connectKey(), { key: "saved" });
  assert.equal(kitValues(kitDir).PERSO_API_KEY, "pk_live_new");
});

// A folder made read-only stops nothing on Windows, nor for root.
const cannotLockFolders = process.platform === "win32" || process.getuid?.() === 0;

test("a key that cannot be written into kit.env answers keyReason save, not a network failure", { skip: cannotLockFolders && "no read-only folders here" }, async () => {
  const { auth, kitDir, logs } = await signedInStore(persoRoutes({ keys: [{ apiKey: "pk_test_K9" }] }), later());
  await auth.start();
  chmodSync(kitDir, 0o500);
  let answer;
  try { answer = await auth.connectKey(); } finally { chmodSync(kitDir, 0o700); }
  assert.deepEqual(answer, { key: "failed", keyReason: "save" });
  assert.equal(kitValues(kitDir).PERSO_API_KEY, "pk_test_K1", "kit.env changed");
  assert.equal(existsSync(join(kitDir, "kit.env.tmp")), false);
  assert.ok(logs.some((l) => l.includes("could not save the API key")), logs.join("\n"));
  assert.ok(!logs.join("\n").includes("pk_test_K9"));
});

test("a new key clears the workspace picked for the old one; the same key keeps it", async () => {
  const run = async (kitText) => {
    const { auth, opened, kitDir } = makeAuth({ kitDir: kitWith(kitText) });
    await auth.start();
    const done = auth.login();
    await settle();
    await auth.handleCallback(back(opened));
    await done;
    return kitValues(kitDir);
  };
  assert.equal((await run("PERSO_API_KEY=pk_old\nPERSO_SPACE_SEQ=42\n")).PERSO_SPACE_SEQ, "");
  assert.equal((await run("PERSO_API_KEY=pk_test_K1\nPERSO_SPACE_SEQ=42\n")).PERSO_SPACE_SEQ, "42");
});

test("without a kit the sign-in still works and says the key had nowhere to go", async () => {
  const { auth, opened } = makeAuth({ kitDir: null });
  await auth.start();
  const done = auth.login();
  await settle();
  await auth.handleCallback(back(opened));
  assert.deepEqual(await done, { outcome: "signed_in", key: "no_kit" });
});

// ---- The real door: a port of this computer ------------------------------------------

const occupy = (port) => new Promise((resolve, reject) => {
  const s = createServer((_req, res) => { res.writeHead(503); res.end(); });
  s.once("error", reject);
  s.listen(port, "127.0.0.1", () => resolve(() => new Promise((done) => s.close(done))));
});

test("the first free port of the list is taken, a busy one skipped, and the browser's request over HTTP signs in", async () => {
  const release = await occupy(52390);
  try {
    const { auth, opened, logs } = makeAuth({ listen: startCallbackServer });
    await auth.start();
    const done = auth.login();
    await settle();
    assert.equal(new URL(opened[0]).searchParams.get("redirect_uri"), "http://127.0.0.1:52391/callback");
    assert.ok(logs.some((l) => l.includes("listening on port 52391")), logs.join("\n"));
    const res = await fetch(`http://127.0.0.1:52391/callback?code=c1&state=${stateOf(opened[0])}`);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes("Signed in to PersoDub"));
    assert.deepEqual(await done, { outcome: "signed_in", key: "saved" });
    // Over: the port is given back.
    await assert.rejects(fetch("http://127.0.0.1:52391/callback"));
  } finally { await release(); }
});

test("with no free port the sign-in fails as port, opens no browser, and the next try after a port frees works", async (t) => {
  // Both ports are given back however the test ends, a failed assertion
  // included (an occupied port would hold the run open); closing one twice is
  // harmless.
  const releases = [];
  t.after(() => Promise.all(releases.map((release) => release())));
  for (const port of [52390, 52391]) releases.push(await occupy(port));
  const { auth, opened } = makeAuth({ listen: startCallbackServer });
  await auth.start();
  assert.deepEqual(await auth.login(), { outcome: "failed", error: "port" });
  assert.equal(opened.length, 0);
  assert.equal((await auth.status()).waiting, false);
  await releases[0]();
  const done = auth.login();
  await settle();
  assert.equal(new URL(opened[0]).searchParams.get("redirect_uri"), REDIRECT_URI);
  await fetch(`${REDIRECT_URI}?code=c1&state=${stateOf(opened[0])}`);
  assert.equal((await done).outcome, "signed_in");
});

test("the door answers only its own path, and a request with the wrong state keeps the sign-in waiting", async () => {
  const { auth, opened } = makeAuth({ listen: startCallbackServer });
  await auth.start();
  const done = auth.login();
  await settle();
  assert.equal((await fetch("http://127.0.0.1:52390/somewhere?code=c1&state=x")).status, 404);
  const wrong = await fetch("http://127.0.0.1:52390/callback?code=c1&state=forged");
  assert.ok((await wrong.text()).includes("did not finish"));
  assert.equal((await auth.status()).waiting, true);
  assert.deepEqual(await auth.cancelLogin(), { outcome: "cancelled" });
  assert.deepEqual(await done, { outcome: "cancelled" });
  assert.equal((await fetch(`${REDIRECT_URI}?code=c1&state=${stateOf(opened[0])}`).catch(() => "closed")), "closed");
});

// ---- Signed in from the last run, and refreshing ----------------------------------

async function signedInStore(routes, accessToken, more = {}) {
  const userData = mkdtempSync(join(tmpdir(), "odauth-user-"));
  tokenStore(join(userData, AUTH_FILE), fakeSafeStorage()).write({ accessToken, refreshToken: "r1", userId: "u1", account: "so***@test.local" });
  return makeAuth({ routes, userData, kitDir: kitWith("PERSO_API_KEY=pk_test_K1\nPERSO_SPACE_SEQ=42\n"), ...more });
}

test("the next launch is signed in at once, with no request to Perso", async () => {
  const { auth, calls } = await signedInStore(persoRoutes(), later());
  await auth.start();
  assert.deepEqual(await auth.status(), { enabled: true, required: false, signedIn: true, account: "so***@test.local", accountId: "u1", hasKey: true, waiting: false, where: "" });
  assert.equal(calls.length, 0);
});

test("an access token that ran out is refreshed quietly at launch, and the new one kept", async () => {
  const { auth, calls, userData } = await signedInStore(persoRoutes(), gone());
  await auth.start();
  assert.equal((await auth.status()).signedIn, true);
  assert.deepEqual(calls.map((c) => c.key), [REFRESH]);
  assert.equal(tokenStore(join(userData, AUTH_FILE), fakeSafeStorage()).read().refreshToken, "r2");
});

test("a 401 refreshes once and asks again", async () => {
  let seen = 0;
  const routes = persoRoutes({ [`GET ${CFG.apiKeysUrl}`]: () => (++seen === 1 ? [401, { code: "EXPIRED" }] : [200, { result: [{ apiKey: "pk_test_K1" }] }]) });
  const { auth, calls } = await signedInStore(routes, later());
  await auth.start();
  assert.deepEqual(await auth.connectKey(), { key: "saved" });
  assert.deepEqual(calls.map((c) => c.key), [`GET ${CFG.apiKeysUrl}`, REFRESH, `GET ${CFG.apiKeysUrl}`]);
});

test("a refused refresh signs out and clears the key; no network keeps the sign-in", async () => {
  const refused = await signedInStore(persoRoutes({ [REFRESH]: () => [400, { error: "invalid_grant" }] }), gone());
  await refused.auth.start();
  assert.equal((await refused.auth.status()).signedIn, false);
  assert.equal((await refused.auth.status()).required, true);
  assert.equal(existsSync(join(refused.userData, AUTH_FILE)), false);
  assert.deepEqual([kitValues(refused.kitDir).PERSO_API_KEY, kitValues(refused.kitDir).PERSO_SPACE_SEQ], ["", ""]);

  const offline = await signedInStore(persoRoutes({ [REFRESH]: () => new TypeError("fetch failed") }), gone());
  await offline.auth.start();
  assert.equal((await offline.auth.status()).signedIn, true);
  assert.equal(kitValues(offline.kitDir).PERSO_API_KEY, "pk_test_K1");
});

test("Perso too busy (429) or timing out (408) on a refresh keeps the sign-in, like a server error", async () => {
  for (const status of [408, 429, 500, 503]) {
    const busy = await signedInStore(persoRoutes({ [REFRESH]: () => [status, { code: "BUSY" }] }), gone());
    await busy.auth.start();
    assert.equal((await busy.auth.status()).signedIn, true, `HTTP ${status} signed out`);
    assert.equal(kitValues(busy.kitDir).PERSO_API_KEY, "pk_test_K1");
    assert.ok(existsSync(join(busy.userData, AUTH_FILE)));
  }
  // A timeout of the app's own (AbortSignal.timeout) is no answer at all.
  const slow = await signedInStore(persoRoutes({ [REFRESH]: () => new DOMException("The operation timed out.", "TimeoutError") }), gone());
  await slow.auth.start();
  assert.equal((await slow.auth.status()).signedIn, true);
});

test("while the code is being traded the sign-in still shows as waiting, and a second request then is ignored", async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const { auth, opened } = makeAuth({ routes: persoRoutes({ [`POST ${CFG.tokenUrl}`]: async () => { await held; return [200, { result: { accessToken: later(), refreshToken: "r1" } }]; } }) });
  await auth.start();
  const done = auth.login();
  await settle();
  const trading = auth.handleCallback(back(opened, "c"));
  await settle();
  assert.equal((await auth.status()).waiting, true, "the screen went back to Sign in while the code was traded");
  assert.equal(await auth.handleCallback(back(opened, "c")), "no_pending");
  release();
  assert.equal(await trading, "signed_in");
  assert.deepEqual(await done, { outcome: "signed_in", key: "saved" });
  assert.equal((await auth.status()).waiting, false);
});

test("Sign in, Cancel or Open again pressed while the code is being traded answers busy: no second door, no second window", async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const { auth, opened, listened, closed } = makeAuth({ routes: persoRoutes({ [`POST ${CFG.tokenUrl}`]: async () => { await held; return [200, { result: { accessToken: later(), refreshToken: "r1" } }]; } }) });
  await auth.start();
  const done = auth.login();
  await settle();
  const trading = auth.handleCallback(back(opened, "c"));
  await settle();
  const again = auth.login();
  await settle();
  assert.equal(listened.length, 1, "a second door was opened while the code was traded");
  assert.equal(opened.length, 1, "a second window was opened while the code was traded");
  assert.deepEqual(await again, { outcome: "busy" });
  assert.deepEqual(await auth.cancelLogin(), { outcome: "busy" });
  assert.deepEqual(await auth.showLogin(), { outcome: "busy" });
  assert.equal((await auth.status()).waiting, true);
  release();
  assert.equal(await trading, "signed_in");
  assert.deepEqual(await done, { outcome: "signed_in", key: "saved" });
  assert.deepEqual(closed, [52390]);
});

test("the sign-in's time limit stops once the browser is back: a slow trade still signs in, never as a timeout", async () => {
  const { auth, opened } = makeAuth({
    loginTimeoutMs: 50,
    routes: persoRoutes({ [`POST ${CFG.tokenUrl}`]: async () => {
      await new Promise((r) => setTimeout(r, 120));
      return [200, { result: { accessToken: later(), refreshToken: "r1" } }];
    } }),
  });
  await auth.start();
  const done = auth.login();
  await settle();
  const trading = auth.handleCallback(back(opened, "c"));
  assert.deepEqual(await done, { outcome: "signed_in", key: "saved" });
  assert.equal(await trading, "signed_in");
  assert.equal((await auth.status()).signedIn, true);
});

test("no network or no answer while trading the code says network, not a refusal", async () => {
  for (const answer of [() => new TypeError("fetch failed"), () => new DOMException("The operation timed out.", "TimeoutError")]) {
    const { auth, opened } = makeAuth({ routes: persoRoutes({ [`POST ${CFG.tokenUrl}`]: answer }) });
    await auth.start();
    const done = auth.login();
    await settle();
    await auth.handleCallback(back(opened, "c"));
    assert.deepEqual(await done, { outcome: "failed", error: "network" });
    assert.deepEqual(await auth.status(), { enabled: true, required: true, signedIn: false, account: "", accountId: "", hasKey: false, waiting: false, where: "" });
  }
});

// ---- Signing out -----------------------------------------------------------------------

test("signing out tells Perso, deletes the tokens and clears the key and workspace", async () => {
  const { auth, calls, kitDir, userData } = await signedInStore(persoRoutes(), later());
  await auth.start();
  assert.deepEqual(await auth.logout(), { outcome: "signed_out" });
  assert.equal(existsSync(join(userData, AUTH_FILE)), false);
  assert.deepEqual([kitValues(kitDir).PERSO_API_KEY, kitValues(kitDir).PERSO_SPACE_SEQ], ["", ""]);
  const signOut = calls.find((c) => c.key === `POST ${CFG.signOutUrl}`);
  assert.match(signOut.auth, /^Bearer h\./);
  assert.deepEqual(await auth.status(), { enabled: true, required: true, signedIn: false, account: "", accountId: "", hasKey: false, waiting: false, where: "" });
});

// kit.env.bak is the file as it was before each write: the sign-out's own
// write would leave the account's key in it, beside the cleared kit.env.
test("signing out leaves no copy of the key in kit.env.bak", async () => {
  const { auth, kitDir } = await signedInStore(persoRoutes(), later());
  await auth.start();
  await auth.logout();
  const bak = join(kitDir, "kit.env.bak");
  const kept = existsSync(bak) ? readFileSync(bak, "utf8") : "";
  assert.ok(!kept.includes("pk_test_K1"), "the backup still holds the account's key");
  assert.equal(parseEnvFile(kept).PERSO_API_KEY || "", "");
  if (process.platform !== "win32" && existsSync(bak)) assert.equal(statSync(bak).mode & 0o777, 0o600);
});

// What the shell keeps for the account beside the tokens -- an inquiry still
// waiting holds its full e-mail (reporting.js dropInquiries) -- goes with it.
test("every sign-out, pressed or a refused refresh, tells the shell; a refresh lost on the network does not", async () => {
  const signedOut = [];
  const onSignOut = () => signedOut.push("out");
  const pressed = await signedInStore(persoRoutes(), later(), { onSignOut });
  await pressed.auth.start();
  assert.deepEqual(signedOut, []);
  await pressed.auth.logout();
  assert.deepEqual(signedOut, ["out"]);
  const refused = await signedInStore(persoRoutes({ [REFRESH]: () => [400, { error: "invalid_grant" }] }), gone(), { onSignOut });
  await refused.auth.start();
  assert.deepEqual(signedOut, ["out", "out"]);
  const offline = await signedInStore(persoRoutes({ [REFRESH]: () => new TypeError("fetch failed") }), gone(), { onSignOut });
  await offline.auth.start();
  assert.deepEqual(signedOut, ["out", "out"]);
});

// Perso keeps a person signed in by a cookie and cannot be asked for the
// password again (no prompt=login): the sign-in window's cookies are the only
// thing that makes the next sign-in ask (Perso's auth team, 2026-10-27).
test("every sign-out, pressed or a refused refresh, clears the sign-in window's cookies before it answers; a refresh lost on the network does not", async () => {
  const cleared = [];
  let release;
  const clearSignInSession = () => new Promise((r) => { cleared.push("asked"); release = () => { cleared.push("done"); r(); }; });
  const pressed = await signedInStore(persoRoutes(), later(), { clearSignInSession });
  await pressed.auth.start();
  let answered = false;
  const out = pressed.auth.logout().then((r) => { answered = true; return r; });
  await settle();
  assert.deepEqual(cleared, ["asked"]);
  assert.equal(answered, false, "the sign-out answered before the window's cookies were cleared");
  release();
  assert.deepEqual(await out, { outcome: "signed_out" });
  assert.deepEqual(cleared, ["asked", "done"]);

  const refused = await signedInStore(persoRoutes({ [REFRESH]: () => [400, { error: "invalid_grant" }] }), gone(), { clearSignInSession });
  let started = false;
  const up = refused.auth.start().then(() => { started = true; });
  await until(() => cleared.length === 3);
  assert.equal(started, false, "the refused refresh's sign-out went on before the cookies were cleared");
  release();
  await up;
  assert.equal((await refused.auth.status()).signedIn, false);
  assert.deepEqual(cleared, ["asked", "done", "asked", "done"]);

  const offline = await signedInStore(persoRoutes({ [REFRESH]: () => new TypeError("fetch failed") }), gone(), { clearSignInSession });
  await offline.auth.start();
  assert.equal(cleared.length, 4);
});

test("cookies that cannot be cleared still sign out, and the log says so", async () => {
  const { auth, userData, logs } = await signedInStore(persoRoutes(), later(), { clearSignInSession: async () => { throw new Error("busy"); } });
  await auth.start();
  assert.deepEqual(await auth.logout(), { outcome: "signed_out" });
  assert.equal(existsSync(join(userData, AUTH_FILE)), false);
  assert.ok(logs.some((l) => l.includes("could not clear the sign-in window")), logs.join("\n"));
});

test("the sign-in window's storage is its own partition's, cookies and cache, each waited for", async () => {
  const done = [];
  const later = (what) => () => new Promise((r) => setTimeout(() => { done.push(what); r(); }, 5));
  const asked = [];
  const session = { fromPartition: (name) => { asked.push(name); return { clearStorageData: later("storage"), clearCache: later("cache") }; } };
  await clearSignInStorage(session);
  assert.deepEqual(asked, ["persist:perso-sign-in"]);
  assert.deepEqual(done, ["storage", "cache"]);
});

test("signing out finishes on this computer even when Perso does not answer", async () => {
  const { auth, kitDir, userData } = await signedInStore(persoRoutes({ [`POST ${CFG.signOutUrl}`]: () => new TypeError("fetch failed") }), later());
  await auth.start();
  assert.deepEqual(await auth.logout(), { outcome: "signed_out" });
  assert.equal(existsSync(join(userData, AUTH_FILE)), false);
  assert.equal(kitValues(kitDir).PERSO_API_KEY, "");
});

test("signing out and in again as another account is a plain sign-in, with that account's key", async () => {
  const { auth, opened, kitDir } = await signedInStore(persoRoutes({ userId: "u2", keys: [{ apiKey: "pk_test_K2" }] }), later());
  await auth.start();
  await auth.logout();
  assert.equal(kitValues(kitDir).PERSO_SPACE_SEQ, "");
  const done = auth.login();
  await settle();
  await auth.handleCallback(back(opened, "c"));
  assert.deepEqual(await done, { outcome: "signed_in", key: "saved" });
  assert.equal(kitValues(kitDir).PERSO_API_KEY, "pk_test_K2");
});

test("no token, key or e-mail ever reaches a log line", async () => {
  const { auth, opened, logs } = makeAuth({ routes: persoRoutes({ email: "private@test.local" }) });
  await auth.start();
  const done = auth.login();
  await settle();
  await auth.handleCallback(back(opened, "c"));
  await done;
  await auth.logout();
  const all = logs.join("\n");
  assert.ok(logs.length >= 4);
  for (const secret of ["private", "pk_test_K1", "h.", stateOf(opened[0])]) assert.ok(!all.includes(secret), `the log has ${secret}`);
});

// ---- Switched off ------------------------------------------------------------------------

test("Make a key on the sign-in screen opens the key page with the app's version and utm_content=signup", async () => {
  const { createShellAuth } = await import("./authIpc.js");
  const opened = [];
  const shell = { openExternal: async (u) => { opened.push(u); } };
  const auth = createShellAuth({ app: { getPath: () => mkdtempSync(join(tmpdir(), "odauth-user-")), getVersion: () => "0.9.1" },
    shell, safeStorage: fakeSafeStorage(), net: { fetch: async () => { throw new Error("no network here"); } },
    ctx: { kitDir: kitWith(), win: null }, edition: "production", shellLog: () => {}, env: {} });
  const handlers = {};
  registerAuthIpc({ ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, shell, auth });
  await handlers["shell:auth-open-key-page"]();
  assert.deepEqual(opened, ["https://developers.perso.ai/api-keys?utm_source=desktop_app&utm_medium=desktop-app&utm_campaign=desktop_app&utm_term=v0.9.1&utm_content=signup"]);
});

test("switched off (the open-source edition) nothing happens: no window, no file, no port, no network", async () => {
  const userData = mkdtempSync(join(tmpdir(), "odauth-user-"));
  const kitDir = kitWith("PERSO_API_KEY=pk_user_typed\nPERSO_SPACE_SEQ=42\n");
  const before = readFileSync(join(kitDir, "kit.env"), "utf8");
  const touched = [];
  const safe = { isEncryptionAvailable: () => { touched.push("safeStorage"); return true; },
    encryptString: () => touched.push("safeStorage"), decryptString: () => touched.push("safeStorage") };
  const auth = createAuth({ enabled: false, cfg: CFG, store: tokenStore(join(userData, AUTH_FILE), safe),
    fetchFn: async () => { touched.push("fetch"); }, makeSignInWindow: () => { touched.push("window"); }, kitDir: () => kitDir,
    listen: async () => { touched.push("port"); } });
  await auth.start();
  assert.equal(auth.enabled, false);
  assert.deepEqual(await auth.status(), { enabled: false, required: false, signedIn: false, account: "", accountId: "", hasKey: true, waiting: false, where: "" });
  for (const answer of [await auth.login(), await auth.cancelLogin(), await auth.showLogin(), await auth.logout(), await auth.connectKey()]) {
    assert.deepEqual(answer, { outcome: "disabled" });
  }
  assert.equal(await auth.handleCallback({ code: "c", state: "s" }), "disabled");
  assert.equal(auth.signedInAccount(), null, "no account for an inquiry");
  assert.deepEqual(touched, []);
  assert.equal(readFileSync(join(kitDir, "kit.env"), "utf8"), before);
  assert.equal(existsSync(join(userData, AUTH_FILE)), false);

  // The page's channels still answer, so its calls never hang -- with "disabled".
  const handlers = {};
  const opened = [];
  registerAuthIpc({ ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, shell: { openExternal: (u) => opened.push(u) }, auth });
  assert.equal(Object.keys(handlers).length, 7);
  assert.deepEqual(await handlers["shell:auth-show"](), { outcome: "disabled" });
  assert.deepEqual(await handlers["shell:auth-login"](), { outcome: "disabled" });
  assert.equal(await handlers["shell:auth-open-key-page"](), undefined);
  assert.deepEqual(opened, []);
});

test("`enabled` as a function is asked at every request, so a kit found after the start switches the sign-in on", async () => {
  let on = false;
  const userData = mkdtempSync(join(tmpdir(), "odauth-user-"));
  tokenStore(join(userData, AUTH_FILE), fakeSafeStorage()).write({ accessToken: later(), refreshToken: "r1", userId: "u1", account: "so***@test.local" });
  const { auth } = makeAuth({ enabled: () => on, userData, kitDir: kitWith("PERSO_API_KEY=pk_test_K1\n") });
  await auth.start();
  assert.equal((await auth.status()).enabled, false);
  assert.equal((await auth.status()).signedIn, false, "the token file was read while switched off");
  on = true;
  assert.deepEqual(await auth.status(), { enabled: true, required: false, signedIn: true, account: "so***@test.local", accountId: "u1", hasKey: true, waiting: false, where: "" });
});

test("the way-back page: the app's name, the logo, one language picked from the window's, nothing to press", async () => {
  const en = callbackPage({ ok: true, lang: "en", appName: "PersoDubbing", logo: "data:image/png;base64,AAAA" });
  assert.ok(en.includes("Signed in to PersoDubbing</span></h1>") && en.includes("Close this tab and go back to PersoDubbing.") && en.includes('src="data:image/png;base64,AAAA"'));
  // Only a browser shows it: the app's own window is closed before the page comes (auth.js finish).
  assert.ok(!/window/.test(en), "the page speaks of a window");
  assert.ok(!/<(button|a|input|form)\b/.test(en), "nothing to press on the page");
  const ko = callbackPage({ ok: false, lang: "ko", appName: "PersoDubbing", logo: "" });
  assert.ok(ko.includes("로그인이 끝나지 않았어요") && ko.includes("PersoDubbing에서 다시 해 봐요.") && !ko.includes("<img"));
  assert.ok(callbackPage({ ok: true, lang: "ko", appName: "PersoDubbing", logo: "" }).includes("이 탭을 닫고 PersoDubbing으로 돌아가면 돼요."));
  assert.ok(callbackPage({ ok: true, lang: "en", appName: "<b>x</b>", logo: "" }).includes("&#60;b&#62;x&#60;/b&#62;"), "the name is escaped");

  // Over HTTP: the browser's Accept-Language picks the language.
  const server = await startCallbackServer({ ports: [52390, 52391], onRequest: async () => "signed_in", appName: "PersoDubbing", logo: "data:image/png;base64,AAAA" });
  try {
    const url = `http://127.0.0.1:${server.port}/callback?code=c&state=s`;
    const korean = await (await fetch(url, { headers: { "accept-language": "ko-KR,ko;q=0.9,en;q=0.8" } })).text();
    assert.ok(korean.includes('<html lang="ko">') && korean.includes("PersoDubbing에 로그인했어요") && korean.includes("base64,AAAA"));
    const english = await (await fetch(url)).text();
    assert.ok(english.includes('<html lang="en">') && english.includes("Signed in to PersoDubbing"));
  } finally { server.close(); }
});

// ---- The sign-in window itself (src/signInWindow.js), on a stand-in BrowserWindow --------

const event = () => ({ prevented: false, preventDefault() { this.prevented = true; } });

// A stand-in for Electron's BrowserWindow: the options it was made with, the
// handlers it was given, and what was done to it. `fire` plays an event.
function fakeWindows() {
  const made = [];
  const external = [];
  class BrowserWindow {
    constructor(options) {
      Object.assign(this, { options, handlers: {}, loaded: [], did: [], destroyed: false, permissions: null, openHandler: null });
      const win = this;
      this.webContents = {
        on: (name, fn) => { win.handlers[`wc:${name}`] = fn; },
        setWindowOpenHandler: (fn) => { win.openHandler = fn; },
        session: { setPermissionRequestHandler: (fn) => { win.permissions = fn; } },
      };
      made.push(this);
    }
    on(name, fn) { this.handlers[name] = fn; }
    fire(name, ...args) { const e = event(); this.handlers[name](e, ...args); return e; }
    loadURL(url) { this.loaded.push(url); return Promise.reject(new Error("ERR_ABORTED")); }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return true; }
    restore() { this.did.push("restore"); }
    show() { this.did.push("show"); }
    focus() { this.did.push("focus"); }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.handlers.closed?.(); }
  }
  const parent = { isDestroyed: () => false, getBounds: () => ({ x: 100, y: 40, width: 1280, height: 800 }) };
  const make = signInWindowFactory({ BrowserWindow, shell: { openExternal: (u) => external.push(u) }, parent: () => parent, title: "PersoDubbing" });
  return { made, external, parent, make };
}
const openOne = (f, { navigation = () => "allow" } = {}) => {
  const seen = { closed: 0, failed: 0, handedOff: [] };
  const handle = f.make({ url: "https://api.perso.ai/auth/api/v2/authorize?x=1", navigation,
    onClosed: () => { seen.closed++; }, onFailed: () => { seen.failed++; }, onHandOff: (to) => { seen.handedOff.push(to); } });
  return { handle, seen, win: f.made.at(-1) };
};

test("the sign-in window: cookies of its own, sandboxed, no preload, over the app's window, named for the edition", () => {
  const f = fakeWindows();
  const { win } = openOne(f);
  assert.equal(SIGN_IN_PARTITION, "persist:perso-sign-in");
  assert.deepEqual(win.options.webPreferences, { partition: "persist:perso-sign-in", sandbox: true, contextIsolation: true, nodeIntegration: false });
  assert.equal(win.options.parent, f.parent);
  assert.equal(win.options.modal, undefined, "a modal window would leave the app's Cancel and Open again unpressable");
  assert.deepEqual([win.options.width, win.options.height, win.options.x, win.options.y], [520, 720, 480, 80]);
  assert.equal(win.options.title, "PersoDubbing");
  assert.ok(win.fire("page-title-updated").prevented, "Perso's page renamed the window");
  assert.deepEqual(win.loaded, ["https://api.perso.ai/auth/api/v2/authorize?x=1"]);
  const answers = [];
  win.permissions(null, "media", (ok) => answers.push(ok));
  win.permissions(null, "notifications", (ok) => answers.push(ok));
  assert.deepEqual(answers, [false, false]);
});

test("the sign-in window goes only where navigation lets it: the browser gets what navigation sends there, and nothing else leaves", () => {
  const f = fakeWindows();
  const answer = { "https://perso.ai/login": "allow", "https://example.com/terms": "browser", "file:///etc/hosts": "deny" };
  const { win } = openOne(f, { navigation: (url) => answer[url] });
  for (const name of ["wc:will-navigate", "wc:will-redirect"]) {
    assert.equal(win.fire(name, "https://perso.ai/login").prevented, false, name);
    assert.equal(win.fire(name, "https://example.com/terms").prevented, true, name);
    assert.equal(win.fire(name, "file:///etc/hosts").prevented, true, name);
  }
  assert.deepEqual(f.external, ["https://example.com/terms", "https://example.com/terms"]);
  // A new window from the page is never opened in the app: an http(s) one goes to the browser.
  assert.deepEqual(win.openHandler({ url: "https://perso.ai/terms" }), { action: "deny" });
  assert.deepEqual(win.openHandler({ url: "file:///etc/hosts" }), { action: "deny" });
  assert.deepEqual(f.external.slice(2), ["https://perso.ai/terms"]);
});

// Perso's sign-in page keeps where it goes on after Google in the window
// that shows it, not in Google's address: given only that address, the
// browser ended on Perso's home (2026-10-27). So the whole sign-in goes.
test("a hand-off: the window does not go, the browser opens the window's own first address (this sign-in's authorize address), not Google's, the window closes after the event, and Open again opens that address again", async () => {
  const google = "https://api.perso.ai/auth/oauth2/authorization/google?redirect_uri=x&callbackUrl=y";
  const start = "https://api.perso.ai/auth/api/v2/authorize?x=1";
  for (const name of ["wc:will-navigate", "wc:will-redirect"]) {
    const f = fakeWindows();
    const { win, seen, handle } = openOne(f, { navigation: (url) => (url === google ? "hand-off" : "allow") });
    assert.equal(win.fire(name, google).prevented, true, name);
    assert.deepEqual(f.external, [start], name);
    assert.deepEqual(seen.handedOff, [google], name);
    // Not inside the navigation's own event, which Electron is still handling.
    assert.equal(win.destroyed, false, name);
    // A second press before it closes opens no second tab.
    assert.equal(win.fire(name, google).prevented, true, name);
    await settle();
    assert.equal(win.destroyed, true, name);
    assert.equal(seen.closed, 1, name);
    assert.deepEqual(f.external, [start], name);
    handle.show();
    assert.deepEqual(f.external, [start, start], name);
    assert.deepEqual(win.did, [], name);
    handle.close();
    assert.equal(seen.closed, 1, name);
  }
});

test("Esc, the window's close button or the shell closing it: onClosed once, and a page asking to stay cannot keep it open", () => {
  const f = fakeWindows();
  const one = openOne(f);
  assert.equal(one.win.fire("wc:before-input-event", { type: "keyDown", key: "a" }).prevented, false);
  assert.equal(one.win.fire("wc:will-prevent-unload").prevented, true);
  assert.equal(one.seen.closed, 0);
  assert.equal(one.win.fire("wc:before-input-event", { type: "keyDown", key: "Escape" }).prevented, true);
  assert.equal(one.win.destroyed, true);
  assert.equal(one.seen.closed, 1);
  one.handle.close();
  one.handle.show();
  assert.equal(one.seen.closed, 1);
  assert.deepEqual(one.win.did, []);

  const two = openOne(f);
  two.handle.show();
  assert.deepEqual(two.win.did, ["restore", "show", "focus"]);
  two.handle.close();
  assert.deepEqual([two.win.destroyed, two.seen.closed], [true, 1]);
});

test("a page of the sign-in window that does not load says onFailed; a load stopped on purpose, or a frame inside the page, does not", () => {
  const f = fakeWindows();
  const { win, seen } = openOne(f);
  win.fire("wc:did-fail-load", -3, "ERR_ABORTED", "https://example.com/", true);
  win.fire("wc:did-fail-load", -106, "ERR_INTERNET_DISCONNECTED", "https://www.googletagmanager.com/", false);
  assert.equal(seen.failed, 0);
  win.fire("wc:did-fail-load", -106, "ERR_INTERNET_DISCONNECTED", "https://api.perso.ai/auth/api/v2/authorize", true);
  assert.equal(seen.failed, 1);
});
