import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KIT_ENV, envWithKit, writeKitValues } from "./kitEnv.js";
import { startCallbackServer } from "./authLoopback.js";
import { handOffUrl } from "./signInWindow.js";

// Perso sign-in for the production edition (the model is atop signInWindow.js); off unless enabled; no token, key or e-mail in a log line.

export const AUTH_FILE = "perso-auth.bin";
export const CALLBACK_PATH = "/callback";

/** Perso's addresses, PersoDub's client id, and where the sign-in comes back.
 * Every value can be changed with an environment variable, which is how the
 * tests point the app at the fake Perso (tests/fake-perso/server.mjs) and how
 * scripts/perso-login-check.mjs points it at a registered client. The *_PATH
 * values start at the host of AUTH_BASE: "/user/api/..." is
 * https://api.perso.ai/user/api/... `version` is the app's, for the key
 * page's utm tail. */
export function authConfig(env = process.env, version = "") {
  const authBase = (env.PERSODUB_AUTH_BASE || "https://api.perso.ai/auth/api").replace(/\/+$/, "");
  const at = (path) => new URL(path, authBase).href;
  const ports = String(env.PERSODUB_AUTH_REDIRECT_PORTS || "")
    .split(",").map((p) => Number(p.trim())).filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  return {
    authBase,
    version,
    // Perso's registration of PersoDub (dev, qa and prod): a PUBLIC client
    // (PKCE), scope "profile email", redirect http://127.0.0.1/callback.
    // Perso ignores the port of a loopback redirect (RFC 8252), so any of the
    // ports below is accepted, but the host must be 127.0.0.1, never localhost.
    clientId: env.PERSODUB_AUTH_CLIENT_ID || "perso-dubbing-desktop",
    scope: "profile email",
    redirectHost: env.PERSODUB_AUTH_REDIRECT_HOST || "127.0.0.1",
    redirectPorts: ports.length ? ports : [52290, 52291, 52292],
    authorizeUrl: `${authBase}/v2/authorize`,
    tokenUrl: `${authBase}/v2/token`,
    refreshUrl: at(env.PERSODUB_AUTH_REFRESH_PATH || "/auth/api/v2/token"),
    signOutUrl: at(env.PERSODUB_AUTH_SIGNOUT_PATH || "/auth/api/v1/auth/sign-out"),
    profileUrl: at(env.PERSODUB_AUTH_PROFILE_PATH || "/user/api/v1/users/profile"),
    apiKeysUrl: at(env.PERSODUB_AUTH_API_KEYS_PATH || "/auth/api/v1/api-keys/active"),
    keyPageUrl: withUtm(env.PERSODUB_KEY_PAGE_URL || "https://developers.perso.ai/api-keys", version, "signup"),
  };
}

/** A link into Perso with the tail every one carries (app/perso_client.py
 * UTM_TAIL) and the button as utm_content: the sign-in screen's Make a key
 * is "signup", as the key window's link is (SIGNUP_LINK). */
export const utmTail = (version, content) => `utm_source=desktop_app&utm_medium=desktop-app&utm_campaign=desktop_app&utm_term=v${version}&utm_content=${content}`;
export function withUtm(url, version, content) {
  return `${url}${url.includes("?") ? "&" : "?"}${utmTail(version, content)}`;
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

/** The page the sign-in window opens, with the utm tail after Perso's own parameters. */
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
  return withUtm(`${cfg.authorizeUrl}?${q}`, cfg.version, "sign_in");
}

// Google refuses an app's own window ("400 malformed"): Perso's Google and Microsoft starts, and their own pages, go to the browser.
const SOCIAL_START = "/auth/oauth2/authorization/";
const SIGN_IN_PROVIDERS = ["accounts.google.com", "login.microsoftonline.com", "login.live.com"];

// "allow" (Perso over https, the authorize origin, this way back), "hand-off" (Google, Microsoft), "browser" (other https), else "deny".
function signInNavigation(url, { authorizeUrl: start, redirectUri }) {
  let u;
  try { u = new URL(url); } catch { return "deny"; }
  if (u.origin === new URL(redirectUri).origin) return "allow";
  const persoServer = u.origin === "https://api.perso.ai" || u.origin === new URL(start).origin;
  if (persoServer && u.pathname.startsWith(SOCIAL_START)) return "hand-off";
  if (u.origin === new URL(start).origin) return "allow";
  if (u.protocol !== "https:") return "deny";
  const host = u.hostname;
  if (SIGN_IN_PROVIDERS.includes(host)) return "hand-off";
  return host === "perso.ai" || host.endsWith(".perso.ai") ? "allow" : "browser";
}

// Which sign-in the window handed to the browser, "google", "microsoft" or "other", for the charts (events.js track).
export function signInProvider(url) {
  let u;
  try { u = new URL(url); } catch { return "other"; }
  const social = u.pathname.startsWith(SOCIAL_START) ? u.pathname.slice(SOCIAL_START.length).split("/")[0] : "";
  if (social === "google" || u.hostname === "accounts.google.com") return "google";
  if (social === "azure" || u.hostname === "login.microsoftonline.com" || u.hostname === "login.live.com") return "microsoft";
  return "other";
}

// The browser's address for a hand-off to `to` (handOffUrl), with the utm tail when it is Perso's Google or Microsoft
// start; Google's or Microsoft's own page goes as it is.
function handOffAddress(cfg, to, back) {
  const address = handOffUrl(to, back);
  return new URL(to).pathname.startsWith(SOCIAL_START) ? withUtm(address, cfg.version, `sign_in_${signInProvider(to)}`) : address;
}

// Perso's own name for signInProvider's google and microsoft, in its social sign-in.
const PERSO_PROVIDERS = { google: "google", microsoft: "azure" };

// The charts' new_account: the profile's createDate within ten minutes, read as UTC and as Korean time (it has no zone).
export function isNewAccount(json, now = Date.now()) {
  const made = json?.result?.createDate;
  if (typeof made !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(made)) return false;
  const zoned = /(Z|[+-]\d\d:?\d\d)$/.test(made);
  const at = zoned ? [Date.parse(made)] : [Date.parse(`${made}Z`), Date.parse(`${made}+09:00`)];
  return at.some((t) => Number.isFinite(t) && Math.abs(now - t) <= 10 * 60 * 1000);
}

// {code, state} or {error, state} from the way back's query, or null with neither.
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

/** A request to Perso, its answer read as JSON. `body` goes as JSON, `form`
 * as a form (application/x-www-form-urlencoded). */
export async function callJson(fetchFn, what, url, { method = "GET", token, body, form, timeoutMs = 15000 } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form !== undefined) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetchFn(url, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs) });
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

// The tokens: {result: {accessToken, refreshToken}}, as the token endpoint
// answers the code exchange's JSON.
export function tokensFrom(json, what) {
  const r = json?.result;
  if (typeof r?.accessToken !== "string" || !r.accessToken) {
    throw new AuthHttpError(what, 200, `no-token; fields: ${fieldNames(r ?? json).join(", ") || "none"}`);
  }
  return { accessToken: r.accessToken, refreshToken: typeof r.refreshToken === "string" ? r.refreshToken : "" };
}

/** The code from the sign-in window, traded for tokens. `redirectUri` is the
 * one the window was sent back to: Perso checks it against the authorize request. */
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

/** New tokens for a refresh token: a form to v2/token, as RFC 6749 asks
 * (Perso answers JSON there with a 500), answered {access_token,
 * refresh_token, expires_in, token_type}. Perso does not rotate this
 * client's refresh token: an answer without one keeps the old one. */
export async function refreshTokens(cfg, fetchFn, refreshToken) {
  const json = await callJson(fetchFn, "refresh", cfg.refreshUrl, {
    method: "POST",
    form: { grant_type: "refresh_token", client_id: cfg.clientId, refresh_token: refreshToken },
  });
  if (typeof json?.access_token !== "string" || !json.access_token) {
    throw new AuthHttpError("refresh", 200, `no-token; fields: ${fieldNames(json).join(", ") || "none"}`);
  }
  return { accessToken: json.access_token, refreshToken: (typeof json.refresh_token === "string" && json.refresh_token) || refreshToken };
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

// One account's sign-in. {outcome}: signed_in, cancelled, failed (error), busy, shown, idle, signed_out, disabled; {key}: saved, no_key, no_kit, failed.
export function createAuth({
  enabled, cfg, store, fetchFn, makeSignInWindow, clearSignInSession = async () => {}, openExternal = () => {}, kitDir, listen = startCallbackServer, appName = "PersoDub", logo = "",
  log = () => {}, onChange = () => {}, onCallback = () => {}, onSignOut = () => {}, now = Date.now, loginTimeoutMs = 10 * 60 * 1000,
  track = () => {}, // the sign-in's steps for the charts (events.js track)
}) {
  const isOn = typeof enabled === "function" ? () => Boolean(enabled()) : () => Boolean(enabled);
  let session = null;   // {accessToken, refreshToken, userId, account, email}
  let sessionId = 0;    // a new one at every sign-in and sign-out; a token refresh keeps it
  let pending = null;   // the sign-in waiting for its window
  let trading = null;   // the sign-in whose code is being traded
  let refreshing = null;
  let loaded = false;
  // Whether the last look at the account's keys found one: key_fetched is
  // recorded when that changes, not at every quiet look of the no-key screen.
  let keyFound = null;
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
    const open = pending || trading;
    return {
      enabled: on,
      // Not usable signed out: the page shows its sign-in screen while true.
      required: on && !session,
      signedIn: Boolean(session),
      // The account in full on screen (owner, 2026-10-27): its e-mail, or its name; never in a log line.
      account: session?.email || session?.account || "",
      // Perso's userSeq; the button events carry only a one-way hash of it (events.js eventsUserId).
      accountId: session?.userId || "",
      hasKey: dir ? (envWithKit(dir).PERSO_API_KEY || "").trim() !== "" : false,
      // Still waiting while the code is traded, so the screen does not offer Sign in again meanwhile.
      waiting: Boolean(open),
      // Where the waiting sign-in goes on: "window", "browser" after a Google or Microsoft hand-off, or "".
      where: open ? open.where : "",
    };
  }

  // The full e-mail and Perso number for Customer support's inquiry (reporting.js); null signed out or disabled.
  function signedInAccount() {
    if (!isOn() || !session) return null;
    return { email: session.email || "", id: session.userId || "" };
  }

  // kit.env.bak takes the cleared text too, so no copy of the key stays behind.
  function clearKitKeys() {
    const dir = kit();
    if (!dir) return;
    try {
      writeKitValues(dir, { PERSO_API_KEY: "", PERSO_SPACE_SEQ: "" });
      copyFileSync(join(dir, KIT_ENV), join(dir, `${KIT_ENV}.bak`));
    } catch (err) { log(`AUTH could not clear the Perso key in kit.env: ${err.message}`, "ERROR"); }
  }

  // Signed out here: tokens, key, the shell's account data and the window's cookies, before the screen hears of it.
  async function dropSession() {
    session = null;
    sessionId++;
    keyFound = null;
    store.clear();
    clearKitKeys();
    try { onSignOut(); } catch (err) { log(`AUTH could not tidy up after the sign-out: ${err.message}`, "ERROR"); }
    try { await clearSignInSession(); } catch (err) { log(`AUTH could not clear the sign-in window's cookies: ${err.message}`, "ERROR"); }
    onChange();
  }

  // New tokens, once at a time; a 4xx other than 408/429 signs out, anything else keeps the session for the next try.
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
          if (session === before) {
            track("sign_out", { reason: "refresh_refused" });
            await dropSession();
          }
        } else {
          log(`AUTH refresh failed, kept signed in: ${err.message}`, "WARN");
        }
        return false;
      } finally { refreshing = null; }
    })();
    return refreshing;
  }

  // GET with the access token, refreshed first when it has run out, and once more after a 401.
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

  // The tokens for the key window's Perso cookies, refreshed first within a minute of running out; null signed out or disabled.
  async function sessionCookies() {
    if (!isOn() || !session) return null;
    if (expired(session.accessToken)) await refresh();
    return session ? { accessToken: session.accessToken, refreshToken: session.refreshToken } : null;
  }

  // The account's active key into kit.env; a different key also clears PERSO_SPACE_SEQ, the old key's workspace.
  async function connectKey() {
    if (!session) return { key: "failed" };
    const dir = kit();
    if (!dir) return { key: "no_kit" };
    const id = sessionId;
    let found;
    try { found = parseActiveKey(await authedGet("api-keys", cfg.apiKeysUrl)); }
    catch (err) {
      log(`AUTH could not read the account's API key: ${err.message}`, "WARN");
      track("key_fetched", { present: false, ok: false });
      return { key: "failed" };
    }
    if (sessionId !== id) {
      log("AUTH signed out while the account's API key was read: not saved");
      return { key: "failed", keyReason: "signed_out" };
    }
    if (keyFound !== (found.status === "key")) {
      keyFound = found.status === "key";
      track("key_fetched", { present: keyFound, ok: true });
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

  // How a sign-in ended, for the charts, where it was going on at the end.
  function trackEnd(waiting, result) {
    const method = waiting.where;
    if (result.outcome === "signed_in") {
      track("sign_in_succeeded", { method, new_account: !!waiting.newAccount, has_key: result.key === "saved" });
    } else if (result.outcome === "cancelled") {
      track("sign_in_cancelled", { method });
    } else if (result.outcome === "failed") {
      track("sign_in_failed", { method, reason: result.error });
    }
  }

  function finish(waiting, result) {
    trackEnd(waiting, result);
    clearTimeout(waiting.timer);
    try { waiting.server.close(); } catch { /* already closed */ }
    if (pending === waiting) pending = null;
    if (trading === waiting) trading = null;
    // After the two above: the window's onClosed then finds nothing to cancel.
    try { waiting.window?.close(); } catch { /* already closed */ }
    waiting.resolve(result);
    onChange();
  }

  // Perso's sign-in in the window, a port listening for the way back; answers when it comes back, is cancelled or times out.
  async function login() {
    if (!isOn()) return DISABLED;
    // The code is being traded: that sign-in ends by itself, and a new one would only open a second door.
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
      const waiting = { ...pkce, redirectUri, server, resolve, where: "window" };
      waiting.timer = setTimeout(() => finish(waiting, { outcome: "failed", error: "timeout" }), loginTimeoutMs);
      waiting.timer.unref?.();
      pending = waiting;
      onChange();
      log(`AUTH sign-in started: listening on port ${server.port}, opening the sign-in window`);
      track("sign_in_started", { method: "window" });
      try {
        const url = authorizeUrl(cfg, { challenge: pkce.challenge, state: pkce.state, redirectUri });
        waiting.window = makeSignInWindow({
          url,
          navigation: (to) => signInNavigation(to, { authorizeUrl: cfg.authorizeUrl, redirectUri }),
          handOffAddress: (to) => handOffAddress(cfg, to, url),
          // Perso's own sign-in and sign-up pages carry the tail too, since Perso drops the authorize address's.
          utm: utmTail(cfg.version, "sign_in"),
          // The sign-in waits on in the computer's browser, with the same state, port and ten minutes.
          onHandOff: (to) => {
            if (pending !== waiting) return;
            waiting.where = "browser";
            waiting.handOff = to;
            const u = new URL(to);
            log(`AUTH Google or Microsoft in the sign-in window: the whole sign-in goes on in the computer's browser at ${u.host}${u.pathname}`);
            track("sign_in_handoff", { provider: signInProvider(to) });
            onChange();
          },
          // Closed by the user, its close button or Esc: as Cancel; closed by the hand-off, not.
          onClosed: () => {
            if (pending !== waiting || waiting.where === "browser") return;
            log("AUTH sign-in window closed: cancelled");
            finish(waiting, { outcome: "cancelled" });
          },
          onFailed: () => {
            if (pending !== waiting) return;
            log("AUTH the sign-in window could not load Perso's page", "WARN");
            finish(waiting, { outcome: "failed", error: "network" });
          },
        });
      } catch (err) {
        log(`AUTH could not open the sign-in window: ${err.message}`, "ERROR");
        finish(waiting, { outcome: "failed", error: "window" });
      }
    });
  }

  // After a hand-off, Perso's start for that provider afresh, this sign-in's authorize address as the way back: a sign-up
  // leaves the browser signed out, and the authorize address would sign in its old account. Without Perso's answer, or
  // for a provider it has no start for, the first hand-off's address again.
  async function openHandOffAgain(waiting) {
    const back = authorizeUrl(cfg, waiting);
    const provider = PERSO_PROVIDERS[signInProvider(waiting.handOff)];
    let address = handOffAddress(cfg, waiting.handOff, back);
    let start = "fallback";
    if (provider) {
      try {
        const loginUrl = (await callJson(fetchFn, "social sign-in", `${cfg.authBase}/v1/auth/sign-in/social?provider=${provider}`, { timeoutMs: 10_000 }))?.result?.loginUrl;
        if (typeof loginUrl !== "string" || !loginUrl) throw new Error("no loginUrl in the answer");
        address = withUtm(`${new URL(cfg.authorizeUrl).origin}${SOCIAL_START}${provider}?redirect_uri=${loginUrl}&callbackUrl=${encodeURIComponent(back)}`,
          cfg.version, `sign_in_${signInProvider(waiting.handOff)}`);
        start = provider;
      } catch (err) { log(`AUTH Perso's ${provider} start was not read (${err.message}): the first hand-off's address opens again`, "WARN"); }
    }
    if (pending !== waiting) return;
    openExternal(address);
    // Never the address: it carries this sign-in's state and Perso's login URL.
    log(`AUTH browser opened again (${start} start)`);
  }

  // Open again: the window reloaded, or after a hand-off (Continue) Perso's start again in the browser.
  async function showLogin() {
    if (!isOn()) return DISABLED;
    if (trading) return { outcome: "busy" };
    if (!pending) return { outcome: "idle" };
    const waiting = pending;
    if (waiting.where === "browser") await openHandOffAgain(waiting);
    else waiting.window.show();
    return { outcome: "shown" };
  }

  function cancelLogin() {
    if (!isOn()) return DISABLED;
    if (trading) return { outcome: "busy" };
    if (!pending) return { outcome: "idle" };
    log("AUTH sign-in cancelled");
    finish(pending, { outcome: "cancelled" });
    return { outcome: "cancelled" };
  }

  // The way back's request, {code, state} or {error, state}; the answer is for its page, the log and the tests.
  async function handleCallback(params) {
    if (!isOn()) return "disabled";
    const cb = callbackParams(params);
    if (!cb) return "not_callback";
    const waiting = pending;
    if (!waiting) { log("AUTH a sign-in came back with no sign-in waiting: ignored", "WARN"); return "no_pending"; }
    if (cb.state !== waiting.state) { log("AUTH a sign-in came back with the wrong state: ignored", "WARN"); return "bad_state"; }
    pending = null; // taken: the same request twice is not traded twice
    trading = waiting;
    // Back: the ten minutes are over, and the trade below ends this sign-in, closing the window.
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
      sessionId++;
      try {
        const answer = await authedGet("profile", cfg.profileUrl);
        const p = parseProfile(answer);
        waiting.newAccount = isNewAccount(answer, now());
        // `account` is the name, shown in place of an e-mail the account lacks.
        session = { ...session, userId: p.userId, account: p.name, email: p.email };
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

  // Sign out: tokens and key leave this computer first, then Perso is told, not waited on.
  async function logout() {
    if (!isOn()) return DISABLED;
    if (pending) finish(pending, { outcome: "cancelled" });
    const was = session;
    if (was) track("sign_out", { reason: "user" });
    await dropSession();
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

  // The kept sign-in, read once after the app is ready (safeStorage), refreshed if expired; never while disabled.
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
    showLogin,
    logout: loadedFirst(logout),
    connectKey: loadedFirst(async () => (isOn() ? connectKey() : DISABLED)),
    handleCallback,
    signedInAccount,
    sessionCookies: loadedFirst(sessionCookies),
    keyPageUrl: cfg.keyPageUrl,
  };
}
