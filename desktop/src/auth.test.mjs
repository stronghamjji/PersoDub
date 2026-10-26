// The Perso browser sign-in's parts (src/auth.js, src/authLoopback.js,
// src/authIpc.js), with Perso played by a stub fetch and, in most tests, the
// loopback listener by a stub as well. The whole sign-in against the fake
// Perso server, over real HTTP on real ports, is src/authFlow.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AUTH_FILE, authConfig, authorizeUrl, callbackParams, challengeFor, createAuth, maskEmail, newPkce,
  parseActiveKey, parseProfile, redirectUriFor, refreshTokens, tokenExpiry, tokenStore,
} from "./auth.js";
import { callbackPage, startCallbackServer } from "./authLoopback.js";
import { registerAuthIpc } from "./authIpc.js";
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
function stubFetch(cfg, routes) {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    const key = `${opts.method || "GET"} ${url}`;
    const body = opts.body ? JSON.parse(opts.body) : undefined;
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

// A signed-in Perso with one account. Overrides replace single routes.
function persoRoutes({ userId = "u1", email = "someone@test.local", keys = [{ apiKey: "pk_test_K1" }], ...over } = {}) {
  return {
    [`POST ${CFG.tokenUrl}`]: () => [200, { result: { accessToken: later(), refreshToken: "r1" } }],
    [`POST ${CFG.refreshUrl}`]: () => [200, { result: { accessToken: later(), refreshToken: "r2" } }],
    [`GET ${CFG.profileUrl}`]: () => [200, { result: { userSeq: userId, userName: "", email, provider: "email" } }],
    [`GET ${CFG.apiKeysUrl}`]: () => [200, { result: keys }],
    [`POST ${CFG.signOutUrl}`]: () => [200, { result: null }],
    ...over,
  };
}

// createAuth with everything on disk in fresh temp folders, the browser
// replaced by a list of the addresses it was asked to open.
function makeAuth({ routes = persoRoutes(), enabled = true, kitDir = kitWith(), userData, safe = fakeSafeStorage(), now, listen, loginTimeoutMs, onSignOut } = {}) {
  const dir = userData || mkdtempSync(join(tmpdir(), "odauth-user-"));
  const opened = [];
  const logs = [];
  const { fetchFn, calls } = stubFetch(CFG, routes);
  const stub = stubListen();
  const auth = createAuth({
    enabled, cfg: CFG, store: tokenStore(join(dir, AUTH_FILE), safe), fetchFn, listen: listen || stub.listen,
    openExternal: async (url) => { opened.push(url); }, kitDir: () => kitDir,
    log: (line) => logs.push(line), ...(now ? { now } : {}), ...(loginTimeoutMs ? { loginTimeoutMs } : {}),
    ...(onSignOut ? { onSignOut } : {}),
  });
  return { auth, opened, logs, calls, kitDir, userData: dir, closed: stub.closed, listened: stub.listened };
}
const stateOf = (url) => new URL(url).searchParams.get("state");
const settle = () => new Promise((r) => setImmediate(r));
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
  assert.equal(live.refreshUrl, "https://api.perso.ai/auth/api/v1/auth/oauth2/token");
  assert.equal(live.signOutUrl, "https://api.perso.ai/auth/api/v1/auth/sign-out");
  assert.equal(live.profileUrl, "https://api.perso.ai/user/api/v1/users/profile");
  assert.equal(live.apiKeysUrl, "https://api.perso.ai/auth/api/v1/api-keys/active");
  // With the tail every link into Perso carries (app/perso_client.py UTM_TAIL)
  // and the button, as the key window's link (SIGNUP_LINK).
  assert.equal(live.keyPageUrl, "https://developers.perso.ai/api-keys?utm_source=desktop_app&utm_medium=desktop-app&utm_campaign=desktop_app&utm_term=v0.9.1&utm_content=signup");
  assert.equal(live.scope, "profile email");
  assert.equal(live.clientId, "PERSODUB-CLIENT-ID-NOT-ISSUED-YET");
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

test("the token answer is {result: {accessToken, refreshToken}}; anything else names its fields, never a value", async () => {
  const { fetchFn } = stubFetch(CFG, { [`POST ${CFG.refreshUrl}`]: () => [200, { result: { accessToken: "a1", refreshToken: "r9" } }] });
  assert.deepEqual(await refreshTokens(CFG, fetchFn, "r1"), { accessToken: "a1", refreshToken: "r9" });
  for (const answer of [{ accessToken: "a1", refreshToken: "r9" }, { result: { jwt: "secret-value", ttl: 5 } }, { result: null }, null]) {
    const stub = stubFetch(CFG, { [`POST ${CFG.refreshUrl}`]: () => [200, answer] });
    await assert.rejects(refreshTokens(CFG, stub.fetchFn, "r1"), (err) => /no-token/.test(err.message) && !/secret-value|a1/.test(err.message), JSON.stringify(answer));
  }
  const bare = stubFetch(CFG, { [`POST ${CFG.refreshUrl}`]: () => [200, { result: { jwt: "secret-value", ttl: 5 } }] });
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

test("the e-mail on screen is masked", () => {
  assert.equal(maskEmail("alice@example.com"), "al***@example.com");
  assert.equal(maskEmail("a@test.local"), "a***@test.local");
  assert.equal(maskEmail("ab@test.local"), "a***@test.local");
  assert.equal(maskEmail(""), "");
  assert.equal(maskEmail("nobody"), "");
});

test("an access token's expiry is read from its JWT exp, and anything else has none", () => {
  assert.equal(tokenExpiry(jwt(1700000000)), 1700000000 * 1000);
  assert.equal(tokenExpiry("opaque-token"), null);
  assert.equal(tokenExpiry(undefined), null);
});

test("the refresh request has the shape the website's refresh uses", async () => {
  const { fetchFn, calls } = stubFetch(CFG, { [`POST ${CFG.refreshUrl}`]: () => [200, { result: { accessToken: "a2" } }] });
  assert.deepEqual(await refreshTokens(CFG, fetchFn, "r1"), { accessToken: "a2", refreshToken: "r1" });
  assert.deepEqual(calls[0].body, { clientId: "cid", grantType: "refresh_token", tokenReissueRequest: { refreshToken: "r1" } });
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

test("a sign-in takes a port, opens the browser with that port's address, takes the request back, and saves the account's key", async () => {
  const { auth, opened, calls, kitDir, userData, closed } = makeAuth();
  await auth.start();
  assert.deepEqual(await auth.status(), { enabled: true, required: true, signedIn: false, account: "", accountId: "", hasKey: false, waiting: false });
  const done = auth.login();
  await settle();
  assert.equal(opened.length, 1);
  assert.equal((await auth.status()).waiting, true);
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
  assert.deepEqual(await auth.status(), { enabled: true, required: false, signedIn: true, account: "so***@test.local", accountId: "u1", hasKey: true, waiting: false });
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

test("cancel, a newer sign-in, Perso's refusal and a closed browser each end the waiting one, and each gives its port back", async () => {
  const { auth, opened, closed } = makeAuth();
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

  const stub = stubListen();
  const noBrowser = createAuth({ enabled: true, cfg: CFG, store: tokenStore(join(mkdtempSync(join(tmpdir(), "odauth-")), AUTH_FILE), fakeSafeStorage()),
    fetchFn: async () => { throw new Error("no network"); }, openExternal: async () => { throw new Error("no browser"); }, kitDir: () => null, listen: stub.listen });
  await noBrowser.start();
  assert.deepEqual(await noBrowser.login(), { outcome: "failed", error: "browser" });
  assert.equal(stub.closed.length, 1);
});

test("a sign-in nobody finishes times out", async () => {
  const auth = createAuth({ enabled: true, cfg: CFG, store: tokenStore(join(mkdtempSync(join(tmpdir(), "odauth-")), AUTH_FILE), fakeSafeStorage()),
    fetchFn: async () => { throw new Error("unused"); }, openExternal: async () => {}, kitDir: () => null, listen: stubListen().listen, loginTimeoutMs: 20 });
  await auth.start();
  assert.deepEqual(await auth.login(), { outcome: "failed", error: "timeout" });
  assert.equal((await auth.status()).waiting, false);
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
  assert.deepEqual(await auth.status(), { enabled: true, required: false, signedIn: true, account: "so***@test.local", accountId: "u1", hasKey: true, waiting: false });
  assert.equal(calls.length, 0);
});

test("an access token that ran out is refreshed quietly at launch, and the new one kept", async () => {
  const { auth, calls, userData } = await signedInStore(persoRoutes(), gone());
  await auth.start();
  assert.equal((await auth.status()).signedIn, true);
  assert.deepEqual(calls.map((c) => c.key), [`POST ${CFG.refreshUrl}`]);
  assert.equal(tokenStore(join(userData, AUTH_FILE), fakeSafeStorage()).read().refreshToken, "r2");
});

test("a 401 refreshes once and asks again", async () => {
  let seen = 0;
  const routes = persoRoutes({ [`GET ${CFG.apiKeysUrl}`]: () => (++seen === 1 ? [401, { code: "EXPIRED" }] : [200, { result: [{ apiKey: "pk_test_K1" }] }]) });
  const { auth, calls } = await signedInStore(routes, later());
  await auth.start();
  assert.deepEqual(await auth.connectKey(), { key: "saved" });
  assert.deepEqual(calls.map((c) => c.key), [`GET ${CFG.apiKeysUrl}`, `POST ${CFG.refreshUrl}`, `GET ${CFG.apiKeysUrl}`]);
});

test("a refused refresh signs out and clears the key; no network keeps the sign-in", async () => {
  const refused = await signedInStore(persoRoutes({ [`POST ${CFG.refreshUrl}`]: () => [400, { code: "A0002", message: "로그아웃된 회원입니다.", status: "BAD_REQUEST" }] }), gone());
  await refused.auth.start();
  assert.equal((await refused.auth.status()).signedIn, false);
  assert.equal((await refused.auth.status()).required, true);
  assert.equal(existsSync(join(refused.userData, AUTH_FILE)), false);
  assert.deepEqual([kitValues(refused.kitDir).PERSO_API_KEY, kitValues(refused.kitDir).PERSO_SPACE_SEQ], ["", ""]);

  const offline = await signedInStore(persoRoutes({ [`POST ${CFG.refreshUrl}`]: () => new TypeError("fetch failed") }), gone());
  await offline.auth.start();
  assert.equal((await offline.auth.status()).signedIn, true);
  assert.equal(kitValues(offline.kitDir).PERSO_API_KEY, "pk_test_K1");
});

test("Perso too busy (429) or timing out (408) on a refresh keeps the sign-in, like a server error", async () => {
  for (const status of [408, 429, 500, 503]) {
    const busy = await signedInStore(persoRoutes({ [`POST ${CFG.refreshUrl}`]: () => [status, { code: "BUSY" }] }), gone());
    await busy.auth.start();
    assert.equal((await busy.auth.status()).signedIn, true, `HTTP ${status} signed out`);
    assert.equal(kitValues(busy.kitDir).PERSO_API_KEY, "pk_test_K1");
    assert.ok(existsSync(join(busy.userData, AUTH_FILE)));
  }
  // A timeout of the app's own (AbortSignal.timeout) is no answer at all.
  const slow = await signedInStore(persoRoutes({ [`POST ${CFG.refreshUrl}`]: () => new DOMException("The operation timed out.", "TimeoutError") }), gone());
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

test("Sign in or Cancel pressed while the code is being traded answers busy: no second door, no second browser", async () => {
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
  assert.equal(opened.length, 1, "a second browser was opened while the code was traded");
  assert.deepEqual(await again, { outcome: "busy" });
  assert.deepEqual(await auth.cancelLogin(), { outcome: "busy" });
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
    assert.deepEqual(await auth.status(), { enabled: true, required: true, signedIn: false, account: "", accountId: "", hasKey: false, waiting: false });
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
  assert.deepEqual(await auth.status(), { enabled: true, required: true, signedIn: false, account: "", accountId: "", hasKey: false, waiting: false });
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
  const refused = await signedInStore(persoRoutes({ [`POST ${CFG.refreshUrl}`]: () => [400, { code: "A0002" }] }), gone(), { onSignOut });
  await refused.auth.start();
  assert.deepEqual(signedOut, ["out", "out"]);
  const offline = await signedInStore(persoRoutes({ [`POST ${CFG.refreshUrl}`]: () => new TypeError("fetch failed") }), gone(), { onSignOut });
  await offline.auth.start();
  assert.deepEqual(signedOut, ["out", "out"]);
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

test("switched off (the open-source edition) nothing happens: no browser, no file, no port, no network", async () => {
  const userData = mkdtempSync(join(tmpdir(), "odauth-user-"));
  const kitDir = kitWith("PERSO_API_KEY=pk_user_typed\nPERSO_SPACE_SEQ=42\n");
  const before = readFileSync(join(kitDir, "kit.env"), "utf8");
  const touched = [];
  const safe = { isEncryptionAvailable: () => { touched.push("safeStorage"); return true; },
    encryptString: () => touched.push("safeStorage"), decryptString: () => touched.push("safeStorage") };
  const auth = createAuth({ enabled: false, cfg: CFG, store: tokenStore(join(userData, AUTH_FILE), safe),
    fetchFn: async () => { touched.push("fetch"); }, openExternal: async () => { touched.push("browser"); }, kitDir: () => kitDir,
    listen: async () => { touched.push("port"); } });
  await auth.start();
  assert.equal(auth.enabled, false);
  assert.deepEqual(await auth.status(), { enabled: false, required: false, signedIn: false, account: "", accountId: "", hasKey: true, waiting: false });
  for (const answer of [await auth.login(), await auth.cancelLogin(), await auth.logout(), await auth.connectKey()]) {
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
  assert.equal(Object.keys(handlers).length, 6);
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
  assert.deepEqual(await auth.status(), { enabled: true, required: false, signedIn: true, account: "so***@test.local", accountId: "u1", hasKey: true, waiting: false });
});

test("the browser's page: the app's name, the logo, one language picked from the browser's, nothing to press", async () => {
  const en = callbackPage({ ok: true, lang: "en", appName: "PersoDubbing", logo: "data:image/png;base64,AAAA" });
  assert.ok(en.includes("Signed in to PersoDubbing</span></h1>") && en.includes("go back to PersoDubbing.") && en.includes('src="data:image/png;base64,AAAA"'));
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
