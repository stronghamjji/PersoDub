// One real Perso sign-in through this app's own sign-in code, without
// Electron, to see what Perso actually answers. Prints statuses, field names
// and shapes only: never a token, a key or an e-mail address.
//
//   node desktop/scripts/perso-login-check.mjs [--client <id>] [--host 127.0.0.1] [--port 52290]
//                                              [--base https://api.perso.ai/auth/api]
//
// The defaults are PersoDub's own client as Perso registered it:
// --client perso-dubbing-desktop --host 127.0.0.1 --port 52290. Perso ignores
// the port of the 127.0.0.1 redirect, but not the host: never localhost.
// Perso's demo client (external-client-demo): --client demo-pkce-client --host localhost --port 5173
import { exec, spawn } from "node:child_process";
import {
  AuthHttpError, authConfig, authorizeUrl, callJson, exchangeCode, fieldNames, newPkce, parseActiveKey,
  parseProfile, redirectUriFor, refreshTokens, tokenExpiry,
} from "../src/auth.js";
import { startCallbackServer } from "../src/authLoopback.js";

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i === -1 ? fallback : process.argv[i + 1]; };
const cfg = authConfig({
  ...process.env,
  PERSODUB_AUTH_CLIENT_ID: arg("--client", "perso-dubbing-desktop"),
  PERSODUB_AUTH_REDIRECT_HOST: arg("--host", "127.0.0.1"),
  PERSODUB_AUTH_REDIRECT_PORTS: arg("--port", "52290"),
  ...(arg("--base") ? { PERSODUB_AUTH_BASE: arg("--base") } : {}),
});
const say = (...a) => console.log(...a);
const explain = (e) => (e instanceof AuthHttpError ? `HTTP ${e.status}${e.code ? ` ${e.code}` : ""}` : e.message);
const claims = (jwt) => { try { return Object.keys(JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"))); } catch { return []; } };
const minutesLeft = (jwt) => { const exp = tokenExpiry(jwt); return exp === null ? "not a JWT" : `${Math.round((exp - Date.now()) / 60000)} min`; };
const openBrowser = (url) => {
  // Windows: cmd's start, with the address in double quotes. Unquoted, cmd
  // reads each & in the address as the end of one command and the start of
  // another, and the browser opens on a cut-off address.
  if (process.platform === "win32") { exec(`start "" "${url}"`); return; }
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
};

const pkce = newPkce();
let deliver;
const cameBack = new Promise((r) => { deliver = r; });
const server = await startCallbackServer({
  host: cfg.redirectHost, ports: cfg.redirectPorts,
  onRequest: async (p) => { deliver(p); return p.code ? "signed_in" : "failed"; },
});
const redirectUri = redirectUriFor(cfg, server.port);
const url = authorizeUrl(cfg, { challenge: pkce.challenge, state: pkce.state, redirectUri });
say(`client:   ${cfg.clientId}\nredirect: ${redirectUri}\nauth:     ${cfg.authBase}\n`);
say("Opening the browser. Sign in to Perso there; this waits up to 10 minutes.\n");
openBrowser(url);
const params = await Promise.race([cameBack, new Promise((r) => setTimeout(() => r(null), 10 * 60 * 1000))]);
server.close();
if (!params) { say("The browser did not come back in 10 minutes. Was the redirect address registered for this client?"); process.exit(1); }
say(`1. browser came back: ${params.error ? `error=${params.error}` : params.code ? "with a code" : "with no code"}; state ${params.state === pkce.state ? "matches" : "DOES NOT MATCH"}`);
if (!params.code) process.exit(1);

let tokens;
try {
  tokens = await exchangeCode(cfg, fetch, { code: params.code, verifier: pkce.verifier, redirectUri });
  say(`2. token exchange: OK; refresh token ${tokens.refreshToken ? "present" : "ABSENT"}; access token claims: ${claims(tokens.accessToken).join(", ") || "none"}; runs out in ${minutesLeft(tokens.accessToken)}`);
} catch (e) { say(`2. token exchange: ${explain(e)}`); process.exit(1); }
const bearer = { token: tokens.accessToken };

try {
  const raw = await callJson(fetch, "profile", cfg.profileUrl, bearer);
  const r = raw?.result ?? raw;
  const p = parseProfile(raw);
  say(`3. profile: OK; wrapped in result: ${raw && typeof raw === "object" && "result" in raw}; fields: ${fieldNames(r).join(", ") || "none"}; read as userId ${p.userId ? "yes" : "NO"}, email ${p.email ? "yes" : "no"}, name ${p.name ? "yes" : "no"}`);
} catch (e) { say(`3. profile: ${explain(e)}`); }

try {
  const raw = await callJson(fetch, "api-keys", cfg.apiKeysUrl, bearer);
  const r = raw?.result ?? raw;
  const first = Array.isArray(r) ? r[0] : r;
  const k = parseActiveKey(raw);
  say(`4. api-keys/active: OK; shape: ${Array.isArray(r) ? `list of ${r.length}` : typeof r}; fields: ${fieldNames(first).join(", ") || "none"}; read as: ${k.status}${k.status === "key" ? ` (value length ${k.value.length})` : ""}`);
} catch (e) { say(`4. api-keys/active: ${explain(e)}`); }

const api = new URL(cfg.authBase).origin;
try {
  await callJson(fetch, "spaces", `${api}/portal/api/v1/spaces`, bearer);
  say("5. dubbing API with Authorization: Bearer <access token>: OK (200) -- the token can replace the API key");
} catch (e) { say(`5. dubbing API with Authorization: Bearer <access token>: ${explain(e)} -- ${e instanceof AuthHttpError && e.status === 401 ? "the API wants an API key, not the token" : "unclear"}`); }

// The refresh as the app sends it (refreshTokens): a form to v2/token. The
// answer's field names are read on the way past.
const refreshAt = `${new URL(cfg.refreshUrl).pathname} as a form`;
try {
  let raw = null;
  const tap = async (u, o) => { const res = await fetch(u, o); raw = await res.clone().json().catch(() => null); return res; };
  const t = await refreshTokens(cfg, tap, tokens.refreshToken);
  const back = !raw?.refresh_token ? "not sent (old one kept)" : raw.refresh_token === tokens.refreshToken ? "the same" : "a new one";
  say(`6. refresh at ${refreshAt}: OK; fields: ${fieldNames(raw).join(", ") || "none"}; refresh token back: ${back}; runs out in ${minutesLeft(t.accessToken)}`);
  tokens = t;
} catch (e) { say(`6. refresh at ${refreshAt}: ${explain(e)}`); }

try {
  await fetch(cfg.signOutUrl, { method: "POST", headers: { Authorization: `Bearer ${tokens.accessToken}` } }).then((r) => say(`7. sign-out: HTTP ${r.status}`));
} catch (e) { say(`7. sign-out: ${e.message}`); }
