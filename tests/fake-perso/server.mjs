// A fake Perso for the desktop app's browser sign-in (desktop/src/auth.js),
// so no test ever signs in to, or spends anything on, the real one. Node's
// own modules only. It answers on the real paths, so pointing the app at it
// is one variable: PERSODUB_AUTH_BASE=<url>/auth/api.
//
//   node tests/fake-perso/server.mjs [--port 8765] [--access-ttl 3600]
//
// What it plays, as Perso's own PKCE demo (external-client-demo) shows it:
//   GET  /auth/api/v2/authorize   no browser session -> /login?continue=...
//                                 with one -> 302 <registered redirect_uri>?code&state
//   GET  /login, POST /login      the sign-in form; sets the browser's session cookie
//   GET  /auth/oauth2/authorization/<provider>
//                                 the form's Google button, as Perso's: the browser comes back
//                                 signed in as b@test.local, whoever it was signed in as, and goes
//                                 on to callbackUrl in the address, else to where the form it was
//                                 pressed on was going (that browser keeps it), else to GET /
//   GET  /auth/api/v1/auth/sign-in/social?provider=<provider>
//                                 {result: {loginUrl}}, the redirect_uri Perso's page gives its Google start
//   GET  /logout                  signs the browser out
//   POST /auth/api/v2/token       JSON: authorization_code (PKCE S256, one-use code); refresh_token -> 500,
//                                 as the real one. A form (RFC 6749): refresh_token, answered
//                                 {access_token, refresh_token, expires_in, token_type} with the same
//                                 refresh token back (not rotated); a spent one -> 400 invalid_grant
//   POST /auth/api/v1/auth/sign-out
//   GET  /user/api/v1/users/profile
//   GET  /auth/api/v1/api-keys/active
//   GET  /__fake/stats            counts, for the tests
//   GET  /__fake/last-authorize   the last authorize address the app opened
// misbehave({...}) makes it fail the ways a real network and a real Perso can
// (see there); misbehave({}) puts it right again.
// Accounts (password "test-pass"): a@test.local and b@test.local have a key
// each, c@test.local has none. Answers have the shapes the real Perso gave on
// 2026-10-26: {result: ...}; profile {userSeq, userName, email, provider, ...};
// keys [{seq, apiKey, apiKeyName, status, ...}]; JWT claims sub, scope, iat, exp.
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

export const FAKE_CLIENT_ID = "persodub-fake-client";
// The redirect addresses registered for the fake client: the app's loopback
// ports for the tests (src/authFlow.test.mjs sets PERSODUB_AUTH_REDIRECT_PORTS to these).
export const FAKE_REDIRECTS = ["http://127.0.0.1:52380/callback", "http://127.0.0.1:52381/callback", "http://127.0.0.1:52382/callback"];
export const FAKE_PASSWORD = "test-pass";
export const ACCOUNTS = {
  "a@test.local": { userId: "1001", keys: [{ id: 1, name: "A", apiKey: "pk_test_AAAA1111" }] },
  "b@test.local": { userId: "1002", keys: [{ id: 2, name: "B", apiKey: "pk_test_BBBB2222" }] },
  "c@test.local": { userId: "1003", keys: [] },
};

const b64url = (v) => Buffer.from(v).toString("base64url");
const rand = () => randomBytes(16).toString("base64url");

export function startFakePerso({ port = 0, accessTtl = 3600, clientId = FAKE_CLIENT_ID, redirectUris = FAKE_REDIRECTS } = {}) {
  const browserSessions = new Map(); // cookie -> email
  const goingOn = new Map();         // cookie -> where that browser's sign-in form goes on after Google
  const codes = new Map();           // code -> {email, challenge, redirectUri}
  const access = new Map();          // access token -> {email, exp}
  const refresh = new Map();         // refresh token -> email
  const stats = { authorize: 0, loginForm: 0, token: 0, refresh: 0, signOut: 0, profile: 0, apiKeys: 0 };
  let ttl = accessTtl;
  let lastAuthorize = ""; // the app's last authorize address, for a test that cannot see the browser
  // How it misbehaves, set by misbehave(). Every part is off when left out:
  //   drop      the routes (stats names: "token", "refresh", "profile", "apiKeys",
  //             "authorize") whose connection is cut with no answer: no network
  //   delayMs   how long every answer waits first: a slow Perso
  //   refreshStatus  every refresh answered with this HTTP status (429, 503...)
  //   keys      (email) => the whole api-keys/active answer, in place of the usual
  //   noEmail   a profile with no e-mail, only a name (a Google or Microsoft account)
  let bad = {};

  function issueAccess(email) {
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const accessToken = `${b64url(JSON.stringify({ alg: "none" }))}.${b64url(JSON.stringify({ sub: ACCOUNTS[email].userId, scope: "profile email", iat: exp - ttl, exp }))}.${rand()}`;
    access.set(accessToken, { email, exp });
    return accessToken;
  }
  function issue(email) {
    const refreshToken = rand();
    refresh.set(refreshToken, email);
    return { accessToken: issueAccess(email), refreshToken };
  }
  function bearer(req) {
    const t = (req.headers.authorization || "").replace(/^Bearer /, "");
    const a = access.get(t);
    return a && a.exp * 1000 > Date.now() ? a.email : null;
  }
  const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const html = (res, status, body) => { res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }); res.end(body); };
  const fail = (res, status, code) => json(res, status, { code, message: code, status: "ERROR" });
  const cookieOf = (req) => /(?:^|;\s*)fake_session=([^;]+)/.exec(req.headers.cookie || "")?.[1];
  const readBody = (req) => new Promise((ok) => { let s = ""; req.on("data", (c) => { s += c; }); req.on("end", () => ok(s)); });
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  const NAMES = {
    "GET /auth/api/v2/authorize": "authorize", "POST /auth/api/v2/token": "token",
    "GET /user/api/v1/users/profile": "profile", "GET /auth/api/v1/api-keys/active": "apiKeys",
  };
  const tokenAnswer = (t) => ({ result: t });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake");
    const q = url.searchParams;
    const route = `${req.method} ${url.pathname}`;
    // The refresh is a form to the token address: told apart by its type.
    const isForm = (req.headers["content-type"] || "").startsWith("application/x-www-form-urlencoded");
    const name = route === "POST /auth/api/v2/token" && isForm ? "refresh" : NAMES[route];
    if (bad.delayMs) await new Promise((r) => setTimeout(r, bad.delayMs));
    if (bad.drop?.includes(name)) { stats[name]++; return req.socket.destroy(); }
    try {
      if (route === "GET /auth/api/v2/authorize") {
        stats.authorize++;
        lastAuthorize = url.pathname + url.search;
        if (q.get("client_id") !== clientId) return html(res, 400, "<h1>Unknown client</h1>");
        if (!redirectUris.includes(q.get("redirect_uri"))) return html(res, 400, "<h1>redirect_uri is not registered</h1>");
        if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge") || !q.get("state")) {
          return html(res, 400, "<h1>Bad authorize request</h1>");
        }
        const email = browserSessions.get(cookieOf(req));
        if (!email) {
          res.writeHead(302, { Location: `/login?continue=${encodeURIComponent(url.pathname + url.search)}` });
          return res.end();
        }
        const code = rand();
        codes.set(code, { email, challenge: q.get("code_challenge"), redirectUri: q.get("redirect_uri") });
        res.writeHead(302, { Location: `${q.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(q.get("state"))}` });
        return res.end();
      }
      if (route === "GET /login") {
        stats.loginForm++;
        // Where the form goes on after Google stays in the browser showing
        // it (Perso's page keeps it in its own storage), not in the Google
        // button's address.
        const sid = cookieOf(req) || rand();
        goingOn.set(sid, q.get("continue") || "/");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": `fake_session=${sid}; Path=/; HttpOnly` });
        return res.end(`<!doctype html><title>Fake Perso sign-in</title><form method="post" action="/login">
<input type="hidden" name="continue" value="${esc(q.get("continue") || "/")}">
<input name="email" placeholder="email"><input name="password" type="password"><button>Sign in</button></form>
<a href="/auth/oauth2/authorization/google">Google</a>`);
      }
      if (req.method === "GET" && url.pathname.startsWith("/auth/oauth2/authorization/")) {
        const sid = cookieOf(req) || rand();
        browserSessions.set(sid, "b@test.local");
        const back = q.get("callbackUrl") ? new URL(q.get("callbackUrl"), `http://${req.headers.host}`) : null;
        const next = back?.host === req.headers.host ? back.pathname + back.search : goingOn.get(sid) || "/";
        goingOn.delete(sid);
        res.writeHead(302, { Location: next.startsWith("/") ? next : "/", "Set-Cookie": `fake_session=${sid}; Path=/; HttpOnly` });
        return res.end();
      }
      if (route === "GET /") return html(res, 200, "<!doctype html><title>Fake Perso home</title><h1>Perso</h1>");
      if (route === "GET /auth/api/v1/auth/sign-in/social") return json(res, 200, { result: { loginUrl: `http://${req.headers.host}/oauth/callback` } });
      if (route === "POST /login") {
        const form = new URLSearchParams(await readBody(req));
        const email = form.get("email");
        if (!ACCOUNTS[email] || form.get("password") !== FAKE_PASSWORD) return html(res, 401, "<h1>Wrong e-mail or password</h1>");
        const sid = rand();
        browserSessions.set(sid, email);
        const next = form.get("continue") || "/";
        res.writeHead(302, { Location: next.startsWith("/") ? next : "/", "Set-Cookie": `fake_session=${sid}; Path=/; HttpOnly` });
        return res.end();
      }
      if (route === "GET /logout") {
        browserSessions.delete(cookieOf(req));
        res.writeHead(200, { "Set-Cookie": "fake_session=; Path=/; Max-Age=0" });
        return res.end("signed out");
      }
      if (route === "POST /auth/api/v2/token" && isForm) {
        const form = new URLSearchParams(await readBody(req));
        if (form.get("client_id") !== clientId) return json(res, 401, { error: "invalid_client" });
        if (form.get("grant_type") !== "refresh_token") return json(res, 400, { error: "unsupported_grant_type" });
        stats.refresh++;
        if (bad.refreshStatus) return fail(res, bad.refreshStatus, "BUSY");
        const email = refresh.get(form.get("refresh_token"));
        if (!email) return json(res, 400, { error: "invalid_grant" });
        return json(res, 200, { access_token: issueAccess(email), token_type: "Bearer", expires_in: ttl, refresh_token: form.get("refresh_token") });
      }
      if (route === "POST /auth/api/v2/token") {
        const body = JSON.parse((await readBody(req)) || "{}");
        if (body.clientId !== clientId) return fail(res, 404, "A0003");
        if (body.grantType === "authorization_code") {
          stats.token++;
          const r = body.authorizationCodeRequest || {};
          const c = codes.get(r.code);
          codes.delete(r.code); // one use, right or wrong
          if (!c || r.redirectUri !== c.redirectUri) return fail(res, 400, "INVALID_GRANT");
          const challenge = createHash("sha256").update(String(r.codeVerifier || "")).digest("base64url");
          if (challenge !== c.challenge) return fail(res, 400, "INVALID_PKCE");
          return json(res, 200, tokenAnswer(issue(c.email)));
        }
        if (body.grantType === "refresh_token") return fail(res, 500, "INTERNAL");
        return fail(res, 400, "C4001");
      }
      if (route === "POST /auth/api/v1/auth/sign-out") {
        stats.signOut++;
        const email = bearer(req);
        if (!email) return fail(res, 401, "UNAUTHORIZED");
        for (const [t, a] of access) if (a.email === email) access.delete(t);
        for (const [t, e] of refresh) if (e === email) refresh.delete(t);
        return json(res, 200, { result: null });
      }
      if (route === "GET /user/api/v1/users/profile") {
        stats.profile++;
        const email = bearer(req);
        if (!email) return fail(res, 401, "UNAUTHORIZED");
        const profile = { userSeq: Number(ACCOUNTS[email].userId), userName: `User ${email[0].toUpperCase()}`, email: bad.noEmail ? null : email,
          provider: bad.noEmail ? "google" : "email", createDate: "2026-01-01T00:00:00", isMarketingAgree: false, isPasswordExist: !bad.noEmail, isCompleteProfiling: true };
        return json(res, 200, { result: profile });
      }
      if (route === "GET /auth/api/v1/api-keys/active") {
        stats.apiKeys++;
        const email = bearer(req);
        if (!email) return fail(res, 401, "UNAUTHORIZED");
        const keys = ACCOUNTS[email].keys.map((k) => ({ seq: k.id, apiKey: k.apiKey, apiKeyName: k.name, status: "ACTIVE",
          expireDate: null, lastUsedDate: null, createDate: "2026-01-01T00:00:00" }));
        return json(res, 200, bad.keys ? bad.keys(email) : { result: keys });
      }
      if (route === "GET /__fake/stats") return json(res, 200, stats);
      if (route === "GET /__fake/last-authorize") return json(res, 200, { path: lastAuthorize });
      return fail(res, 404, "NOT_FOUND");
    } catch {
      return fail(res, 500, "FAKE_ERROR");
    }
  });

  return new Promise((ok) => {
    server.listen(port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      ok({
        url, stats,
        authBase: `${url}/auth/api`,
        setAccessTtl: (s) => { ttl = s; },
        // Every refresh token refused from now on, as after a long absence.
        forgetRefreshTokens: () => refresh.clear(),
        misbehave: (how = {}) => { bad = how; },
        close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }),
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i === -1 ? fallback : process.argv[i + 1]; };
  const fake = await startFakePerso({
    port: Number(arg("--port", 8765)),
    accessTtl: Number(arg("--access-ttl", 3600)),
  });
  console.log(`fake Perso on ${fake.url}  (PERSODUB_AUTH_BASE=${fake.authBase} PERSODUB_AUTH_CLIENT_ID=${FAKE_CLIENT_ID})`);
}
