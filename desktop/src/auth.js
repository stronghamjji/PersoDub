import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KIT_ENV, envWithKit, writeKitValues } from "./kitEnv.js";
import { startCallbackServer } from "./authLoopback.js";

// Signing in to Perso from the production edition: the computer's own browser
// opens Perso's sign-in page (OAuth 2 authorization code with PKCE, RFC 7636),
// Perso sends the browser back to http://127.0.0.1:<port>/callback, where this
// app listens for that one request (authLoopback.js), and the app trades the
// code for tokens. The password never passes through the app. Once signed in,
// the account's active Perso API key is written into kit.env as
// PERSO_API_KEY, the line the backend reads (app/settings_env.py current_value).
//
// Nothing here runs while `enabled` is false: every request answers
// "disabled" and no file, browser, port or network is touched. Tokens, keys
// and e-mail addresses never reach a log line.

export const AUTH_FILE = "perso-auth.bin";
export const CALLBACK_PATH = "/callback";

/** Perso's addresses, PersoDub's client id, and where the browser comes back.
 * Every value can be changed with an environment variable, which is how the
 * tests point the app at the fake Perso (tests/fake-perso/server.mjs) and how
 * scripts/perso-login-check.mjs points it at a registered client. The *_PATH
 * values start at the host of AUTH_BASE: "/user/api/..." is
 * https://api.perso.ai/user/api/... */
export function authConfig(env = process.env) {
  const authBase = (env.PERSODUB_AUTH_BASE || "https://api.perso.ai/auth/api").replace(/\/+$/, "");
  const at = (path) => new URL(path, authBase).href;
  const ports = String(env.PERSODUB_AUTH_REDIRECT_PORTS || "")
    .split(",").map((p) => Number(p.trim())).filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  return {
    authBase,
    // !!! PLACEHOLDER until Perso registers PersoDub as a client. Perso must
    // register, for this client id: every redirect address below (one per
    // port), scope "profile email", client type PUBLIC.
    clientId: env.PERSODUB_AUTH_CLIENT_ID || "PERSODUB-CLIENT-ID-NOT-ISSUED-YET",
    scope: "profile email",
    redirectHost: env.PERSODUB_AUTH_REDIRECT_HOST || "127.0.0.1",
    redirectPorts: ports.length ? ports : [52290, 52291, 52292],
    authorizeUrl: `${authBase}/v2/authorize`,
    tokenUrl: `${authBase}/v2/token`,
    refreshUrl: at(env.PERSODUB_AUTH_REFRESH_PATH || "/auth/api/v1/auth/oauth2/token"),
    signOutUrl: at(env.PERSODUB_AUTH_SIGNOUT_PATH || "/auth/api/v1/auth/sign-out"),
    profileUrl: at(env.PERSODUB_AUTH_PROFILE_PATH || "/user/api/v1/users/profile"),
    apiKeysUrl: at(env.PERSODUB_AUTH_API_KEYS_PATH || "/auth/api/v1/api-keys/active"),
    keyPageUrl: env.PERSODUB_KEY_PAGE_URL || "https://developers.perso.ai/api-keys",
  };
}

/** The redirect address for one of the ports: exactly what Perso has registered. */
export const redirectUriFor = (cfg, port) => `http://${cfg.redirectHost}:${port}${CALLBACK_PATH}`;

// ---- PKCE ------------------------------------------------------------------

/** base64url(SHA-256(verifier)): the S256 code challenge. */
export const challengeFor = (verifier) => createHash("sha256").update(verifier).digest("base64url");

/** A fresh verifier (32 random bytes, 43 characters), its challenge, and a
 * state that ties the request coming back to this one sign-in. */
export function newPkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: challengeFor(verifier), state: randomBytes(16).toString("base64url") };
}

/** The page the browser opens. */
export function authorizeUrl(cfg, { challenge, state, redirectUri }) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    scope: cfg.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${cfg.authorizeUrl}?${q}`;
}

/** {code, state} or {error, state} from the request's query, or null when it
 * carries neither a code nor an error. */
export function callbackParams({ code, state, error } = {}) {
  const s = typeof state === "string" ? state : "";
  if (typeof error === "string" && error) return { error, state: s };
  if (typeof code === "string" && code) return { code, state: s };
  return null;
}

// ---- What Perso answers ------------------------------------------------------

export class AuthHttpError extends Error {
  constructor(what, status, code) {
    super(`${what} answered HTTP ${status}${code ? ` (${code})` : ""}`);
    this.status = status;
    this.code = code || "";
  }
}

export async function callJson(fetchFn, what, url, { method = "GET", token, body, timeoutMs = 15000 } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetchFn(url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON: an error page */ }
  // Only Perso's error code goes into the error, never the body: a body can
  // carry a token.
  if (!res.ok) throw new AuthHttpError(what, res.status, typeof json?.code === "string" ? json.code : "");
  return json;
}

// Field names only, for a log line about an answer this app could not read: a
// name with a digit in it could itself be a key or a token, so it is left out.
export const fieldNames = (o) => (o && typeof o === "object" && !Array.isArray(o)
  ? Object.keys(o).filter((k) => /^[A-Za-z_]{1,32}$/.test(k)) : []);

// The tokens: {result: {accessToken, refreshToken}}, as the token and the
// refresh endpoints both answer.
export function tokensFrom(json, what) {
  const r = json?.result;
  if (typeof r?.accessToken !== "string" || !r.accessToken) {
    throw new AuthHttpError(what, 200, `no-token; fields: ${fieldNames(r ?? json).join(", ") || "none"}`);
  }
  return { accessToken: r.accessToken, refreshToken: typeof r.refreshToken === "string" ? r.refreshToken : "" };
}

/** The code from the browser, traded for tokens. `redirectUri` is the one the
 * browser was sent back to: Perso checks it against the authorize request. */
export async function exchangeCode(cfg, fetchFn, { code, verifier, redirectUri }) {
  const json = await callJson(fetchFn, "token", cfg.tokenUrl, {
    method: "POST",
    body: {
      clientId: cfg.clientId,
      grantType: "authorization_code",
      authorizationCodeRequest: { code, redirectUri, codeVerifier: verifier, clientSecret: null },
    },
  });
  return tokensFrom(json, "token");
}

/** New tokens for a refresh token. A missing refreshToken in the answer means
 * the old one stays good. */
export async function refreshTokens(cfg, fetchFn, refreshToken) {
  const json = await callJson(fetchFn, "refresh", cfg.refreshUrl, {
    method: "POST",
    body: { clientId: cfg.clientId, grantType: "refresh_token", tokenReissueRequest: { refreshToken } },
  });
  const t = tokensFrom(json, "refresh");
  return { accessToken: t.accessToken, refreshToken: t.refreshToken || refreshToken };
}

/** When an access token runs out, from its JWT "exp", or null when it is not
 * a JWT. Read only to know when to refresh; Perso checks the signature. */
export function tokenExpiry(token) {
  try {
    const exp = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8")).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch { return null; }
}

/** {userId, email, name} from the profile answer:
 * {result: {userSeq, userName, email, ...}}. An account signed in through
 * Google or Microsoft may have no e-mail; the name stands in on screen. */
export function parseProfile(json) {
  const r = json?.result ?? {};
  return {
    userId: r.userSeq === undefined || r.userSeq === null ? null : String(r.userSeq),
    email: typeof r.email === "string" ? r.email : "",
    name: typeof r.userName === "string" ? r.userName.trim().slice(0, 40) : "",
  };
}

/** The usable key in the api-keys/active answer, {result: [{apiKey, ...}]}:
 * {status: "key", value}, or {status: "none", fields} with the field names
 * (never values) of what came instead, for the log. */
export function parseActiveKey(json) {
  const list = Array.isArray(json?.result) ? json.result : [];
  const item = list.find((k) => typeof k?.apiKey === "string" && k.apiKey.trim());
  if (item) return { status: "key", value: item.apiKey.trim() };
  return { status: "none", fields: [...new Set(list.flatMap(fieldNames))] };
}

/** "al***@example.com": enough to tell accounts apart on screen. */
export function maskEmail(email) {
  const at = String(email || "").lastIndexOf("@");
  if (at < 1) return "";
  const local = email.slice(0, at);
  return `${local.slice(0, local.length > 2 ? 2 : 1)}***${email.slice(at)}`;
}

// ---- Where things are kept ---------------------------------------------------

/** The tokens, encrypted with the operating system's key store (Electron
 * safeStorage: the Keychain on a Mac, DPAPI on Windows), in one file. Where
 * encryption is not available, or the system refuses it, nothing is written
 * and an older file goes, so the sign-in lasts until the app quits. */
export function tokenStore(file, safeStorage) {
  // The file and a half-written copy of it, each gone whatever the other does.
  const removeAll = () => {
    try { rmSync(file, { force: true }); } catch { /* left for the next try */ }
    try { rmSync(`${file}.tmp`, { force: true }); } catch { /* left for the next try */ }
  };
  return {
    read() {
      try {
        if (!existsSync(file)) return null;
        return JSON.parse(safeStorage.decryptString(readFileSync(file)));
      } catch { return null; }
    },
    write(data) {
      try {
        if (!safeStorage.isEncryptionAvailable()) throw new Error("no OS encryption");
        writeFileSync(`${file}.tmp`, safeStorage.encryptString(JSON.stringify(data)), { mode: 0o600 });
        renameSync(`${file}.tmp`, file);
        return true;
      } catch {
        removeAll();
        return false;
      }
    },
    clear() { removeAll(); },
  };
}

// ---- The sign-in itself --------------------------------------------------------

/**
 * One account's sign-in, for the shell. `enabled` is a boolean or a function
 * read at every request.
 * Every request answers with an object the page can read; `outcome` is one of:
 *   signed_in   the browser came back and the tokens are kept
 *   cancelled   cancelLogin, or a newer login replaced this one
 *   failed      with `error`: timeout, browser, port (no free port to listen
 *               on), denied (Perso's error), token (Perso refused the code),
 *               network (no answer, or too slow)
 *   busy        login or cancelLogin while the browser's code is being
 *               traded: nothing is started or stopped, and that sign-in
 *               answers on its own in a moment
 *   signed_out  logout
 *   disabled    not enabled
 * and a sign-in's `key` says what happened to the API key: saved, no_key
 * (the account has none), no_kit, or failed: Perso not reached, or, with
 * `keyReason: "save"`, the key could not be written into kit.env.
 */
export function createAuth({
  enabled, cfg, store, fetchFn, openExternal, kitDir, listen = startCallbackServer, appName = "PersoDub", logo = "",
  log = () => {}, onChange = () => {}, onCallback = () => {}, now = Date.now, loginTimeoutMs = 10 * 60 * 1000,
}) {
  const isOn = typeof enabled === "function" ? () => Boolean(enabled()) : () => Boolean(enabled);
  let session = null;   // {accessToken, refreshToken, userId, account, email}
  let pending = null;   // the sign-in waiting for the browser
  let trading = null;   // the sign-in whose code is being traded
  let refreshing = null;
  let loaded = false;
  const DISABLED = { outcome: "disabled" };

  const kit = () => {
    const dir = kitDir();
    return dir && existsSync(join(dir, KIT_ENV)) ? dir : null;
  };
  const expired = (token) => {
    const exp = tokenExpiry(token);
    return exp !== null && exp - 60_000 <= now();
  };

  function status() {
    const on = isOn();
    const dir = kit();
    return {
      enabled: on,
      // Not usable signed out: the page shows its sign-in screen while true.
      required: on && !session,
      signedIn: Boolean(session),
      account: session?.account || "",
      // Perso's number for the account (userSeq): the one value to key a
      // user's events by in an analytics tool. Never an e-mail.
      accountId: session?.userId || "",
      hasKey: dir ? (envWithKit(dir).PERSO_API_KEY || "").trim() !== "" : false,
      // Still waiting while the code is traded: the screen stays on "finish
      // in your browser" instead of offering Sign in again for those seconds.
      waiting: Boolean(pending || trading),
    };
  }

  /** The signed-in account for the shell's own use, never the page's: the
   * full e-mail and Perso's number for it, which Customer support's inquiry
   * carries (reporting.js accountForInquiry). Null signed out or disabled. */
  function signedInAccount() {
    if (!isOn() || !session) return null;
    return { email: session.email || "", id: session.userId || "" };
  }

  function clearKitKeys() {
    const dir = kit();
    if (!dir) return;
    try { writeKitValues(dir, { PERSO_API_KEY: "", PERSO_SPACE_SEQ: "" }); }
    catch (err) { log(`AUTH could not clear the Perso key in kit.env: ${err.message}`, "ERROR"); }
  }

  // Signed out on this computer: the tokens and the account's key go.
  function dropSession() {
    session = null;
    store.clear();
    clearKitKeys();
    onChange();
  }

  /** New tokens, once at a time. A refusal (4xx: the refresh token is spent
   * or revoked) signs out; no network, a server error, or Perso too busy
   * (408, 429) keeps the session for the next try. */
  function refresh() {
    if (!session) return Promise.resolve(false);
    refreshing ??= (async () => {
      const before = session;
      try {
        const t = await refreshTokens(cfg, fetchFn, before.refreshToken);
        if (session !== before) return false; // signed out meanwhile
        session = { ...before, ...t };
        if (!store.write(session)) log("AUTH tokens not saved (no OS encryption)", "WARN");
        log("AUTH tokens refreshed");
        return true;
      } catch (err) {
        if (err instanceof AuthHttpError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
          log(`AUTH refresh refused (${err.message}): signed out`, "WARN");
          if (session === before) dropSession();
        } else {
          log(`AUTH refresh failed, kept signed in: ${err.message}`, "WARN");
        }
        return false;
      } finally { refreshing = null; }
    })();
    return refreshing;
  }

  /** GET with the access token, refreshed first when it has run out, and
   * once more after a 401. */
  async function authedGet(what, url) {
    if (expired(session.accessToken)) await refresh();
    if (!session) throw new AuthHttpError(what, 401, "signed-out");
    try {
      return await callJson(fetchFn, what, url, { token: session.accessToken });
    } catch (err) {
      if (!(err instanceof AuthHttpError) || err.status !== 401 || !(await refresh())) throw err;
      return callJson(fetchFn, what, url, { token: session.accessToken });
    }
  }

  /** The account's active key into kit.env. A different key than the one
   * there also clears PERSO_SPACE_SEQ: the workspace picked belonged to it. */
  async function connectKey() {
    if (!session) return { key: "failed" };
    const dir = kit();
    if (!dir) return { key: "no_kit" };
    let found;
    try { found = parseActiveKey(await authedGet("api-keys", cfg.apiKeysUrl)); }
    catch (err) {
      log(`AUTH could not read the account's API key: ${err.message}`, "WARN");
      return { key: "failed" };
    }
    if (found.status !== "key") {
      log(`AUTH the account has no API key (answer fields: ${found.fields.join(", ") || "none"})`);
      return { key: "no_key" };
    }
    try {
      const before = (envWithKit(dir).PERSO_API_KEY || "").trim();
      writeKitValues(dir, found.value === before ? { PERSO_API_KEY: found.value } : { PERSO_API_KEY: found.value, PERSO_SPACE_SEQ: "" });
    } catch (err) {
      log(`AUTH could not save the API key in kit.env: ${err.message}`, "ERROR");
      // This computer's own failure, not the network's.
      return { key: "failed", keyReason: "save" };
    }
    log("AUTH the account's API key is saved in kit.env");
    onChange();
    return { key: "saved" };
  }

  function finish(waiting, result) {
    clearTimeout(waiting.timer);
    try { waiting.server.close(); } catch { /* already closed */ }
    if (pending === waiting) pending = null;
    if (trading === waiting) trading = null;
    waiting.resolve(result);
    onChange();
  }

  /** Open the browser on Perso's sign-in page, with a port of this computer
   * listening for the way back; answers once the browser comes back, the
   * user cancels, or ten minutes pass. */
  async function login() {
    if (!isOn()) return DISABLED;
    // The browser is back and its code is being traded: that sign-in ends on
    // its own in a moment, and a new one now would only open a second door.
    if (trading) return { outcome: "busy" };
    if (pending) finish(pending, { outcome: "cancelled" });
    const pkce = newPkce();
    let server;
    try {
      server = await listen({ host: cfg.redirectHost, ports: cfg.redirectPorts, path: CALLBACK_PATH, onRequest: handleCallback, appName, logo });
    } catch (err) {
      log(`AUTH no port to listen on for the sign-in: ${err.message}`, "ERROR");
      return { outcome: "failed", error: "port" };
    }
    const redirectUri = redirectUriFor(cfg, server.port);
    return new Promise((resolve) => {
      const waiting = { ...pkce, redirectUri, server, resolve };
      waiting.timer = setTimeout(() => finish(waiting, { outcome: "failed", error: "timeout" }), loginTimeoutMs);
      waiting.timer.unref?.();
      pending = waiting;
      onChange();
      log(`AUTH sign-in started: listening on port ${server.port}, opening the browser`);
      Promise.resolve()
        .then(() => openExternal(authorizeUrl(cfg, { challenge: pkce.challenge, state: pkce.state, redirectUri })))
        .catch((err) => {
          log(`AUTH could not open the browser: ${err.message}`, "ERROR");
          if (pending === waiting) finish(waiting, { outcome: "failed", error: "browser" });
        });
    });
  }

  function cancelLogin() {
    if (!isOn()) return DISABLED;
    if (trading) return { outcome: "busy" };
    if (!pending) return { outcome: "idle" };
    log("AUTH sign-in cancelled");
    finish(pending, { outcome: "cancelled" });
    return { outcome: "cancelled" };
  }

  /** The browser's request back, {code, state} or {error, state}. Answers
   * what it did with it, for the browser's page, the log and the tests; the
   * page hears through login's answer. */
  async function handleCallback(params) {
    if (!isOn()) return "disabled";
    const cb = callbackParams(params);
    if (!cb) return "not_callback";
    const waiting = pending;
    if (!waiting) { log("AUTH the browser came back with no sign-in waiting: ignored", "WARN"); return "no_pending"; }
    if (cb.state !== waiting.state) { log("AUTH the browser came back with the wrong state: ignored", "WARN"); return "bad_state"; }
    pending = null; // taken: the same request twice is not traded twice
    trading = waiting;
    // The browser is back: the ten minutes it had are over, and the trade
    // below ends this sign-in however it goes.
    clearTimeout(waiting.timer);
    onCallback();
    if (cb.error) {
      log(`AUTH Perso refused the sign-in: ${cb.error.slice(0, 60)}`, "WARN");
      finish(waiting, { outcome: "failed", error: "denied" });
      return "failed";
    }
    try {
      const tokens = await exchangeCode(cfg, fetchFn, { code: cb.code, verifier: waiting.verifier, redirectUri: waiting.redirectUri });
      session = { ...tokens, userId: null, account: "", email: "" };
      try {
        const p = parseProfile(await authedGet("profile", cfg.profileUrl));
        // The full e-mail stays in the shell (signedInAccount); the page gets the masked one.
        session = { ...session, userId: p.userId, account: maskEmail(p.email) || p.name, email: p.email };
      } catch (err) { log(`AUTH signed in, but the profile did not load: ${err.message}`, "WARN"); }
      if (!session) throw new AuthHttpError("token", 401, "refused-at-once");
      if (!store.write(session)) log("AUTH tokens not saved (no OS encryption)", "WARN");
      log("AUTH signed in");
      const key = await connectKey();
      finish(waiting, { outcome: "signed_in", ...key });
      return "signed_in";
    } catch (err) {
      log(`AUTH sign-in failed: ${err.message}`, "ERROR");
      session = null;
      finish(waiting, { outcome: "failed", error: err instanceof AuthHttpError ? "token" : "network" });
      return "failed";
    }
  }

  /** Sign out: the tokens and the account's key leave this computer first,
   * then Perso is told (and not waited on if it does not answer). */
  async function logout() {
    if (!isOn()) return DISABLED;
    if (pending) finish(pending, { outcome: "cancelled" });
    const was = session;
    dropSession();
    log("AUTH signed out");
    if (was) {
      try {
        await fetchFn(cfg.signOutUrl, {
          method: "POST", headers: { Authorization: `Bearer ${was.accessToken}` }, signal: AbortSignal.timeout(5000),
        });
      } catch (err) { log(`AUTH Perso's sign-out did not answer: ${err.message}`, "WARN"); }
    }
    return { outcome: "signed_out" };
  }

  /** The kept sign-in, read once, on the first request after the app is
   * ready (safeStorage needs that), and refreshed at once when its access
   * token has run out. Read only while enabled: a disabled run never touches
   * the file. */
  async function load() {
    if (loaded || !isOn()) return;
    loaded = true;
    session = store.read();
    if (session && !session.accessToken) session = null;
    if (session) log("AUTH signed in from the last run");
    if (session && expired(session.accessToken)) await refresh();
  }

  async function start() {
    await load();
    onChange();
  }

  const loadedFirst = (fn) => async (...args) => { await load(); return fn(...args); };
  return {
    get enabled() { return isOn(); },
    start,
    status: loadedFirst(status),
    login: loadedFirst(login),
    cancelLogin,
    logout: loadedFirst(logout),
    connectKey: loadedFirst(async () => (isOn() ? connectKey() : DISABLED)),
    handleCallback,
    signedInAccount,
    keyPageUrl: cfg.keyPageUrl,
  };
}
