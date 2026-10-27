import { createServer } from "node:http";
import { localeLanguage } from "./i18n.js";

// The door the sign-in window, or for Google and Microsoft the computer's
// browser, comes back through after a Perso sign-in: a
// one-shot HTTP listener on this computer only, at http://127.0.0.1:<port>/callback.
// Nothing outside this computer can reach 127.0.0.1, the sign-in's state
// value ties the one request this accepts to the sign-in that opened it, and
// the listener closes as soon as that sign-in ends (desktop/src/auth.js).
//
// What comes back afterwards is one quiet page: the logo, a headline saying
// it is done, one line saying what comes next, in the page's language (Korean
// or English). Only a browser shows it: the app's own sign-in window is
// closed before the answer goes (auth.js finish), and Google and Microsoft
// come back through the computer's browser, whose tab stays.

const WORDS = {
  en: {
    done: (app) => [`Signed in to ${app}`, `Close this tab and go back to ${app}.`],
    notDone: (app) => ["The sign-in did not finish", `Try again in ${app}.`],
    closing: "You can close this tab.",
  },
  ko: {
    done: (app) => [`${app}에 로그인했어요`, `이 탭을 닫고 ${app}으로 돌아가면 돼요.`],
    notDone: (app) => ["로그인이 끝나지 않았어요", `${app}에서 다시 해 봐요.`],
    closing: "이 탭을 닫아도 돼요.",
  },
};
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CHECK = `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;
const CROSS = `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`;

/** The page: one quiet column -- the logo, a headline with a small check or
 * cross drawn in the app's blue, one muted line -- on a warm light page or
 * the app's dark one, whichever the browser prefers. Nothing to press. */
export function callbackPage({ ok, lang, appName, logo }) {
  const words = WORDS[lang] || WORDS.en;
  const [title, line] = ok ? words.done(appName) : words.notDone(appName);
  const app = escapeHtml(appName);
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${app}</title>
<style>
  :root { color-scheme: light dark; --bg: #f7f6f2; --fg: #15181e; --muted: #6b7280; --accent: #166cfb; --bad: #d9534f; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0e131b; --fg: #eaf0fd; --muted: #8e9ab0; --accent: #5b9dff; --bad: #f0725c; } }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; display: flex; align-items: center; justify-content: center; padding: 40px 24px; background: var(--bg); color: var(--fg);
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif;
    -webkit-font-smoothing: antialiased; }
  main { width: min(520px, 100%); text-align: center; transform: translateY(-6vh); }
  .logo { display: block; width: 64px; height: 64px; margin: 0 auto 36px; border-radius: 16px; }
  h1 { display: flex; align-items: center; justify-content: center; gap: 12px; margin: 0 0 14px; font-size: 30px; font-weight: 600;
    letter-spacing: -.02em; line-height: 1.25; }
  h1 .glyph { display: inline-flex; color: var(--accent); flex: none; }
  h1 .glyph.bad { color: var(--bad); }
  p { margin: 0; font-size: 17px; color: var(--muted); }
  @media (max-width: 480px) { h1 { font-size: 24px; } }
</style></head>
<body><main>
  ${logo ? `<img class="logo" src="${logo}" alt="">` : ""}
  <h1><span class="glyph${ok ? "" : " bad"}">${ok ? CHECK : CROSS}</span><span>${escapeHtml(title)}</span></h1>
  <p>${escapeHtml(line)}</p>
</main></body></html>`;
}

/**
 * Listen for the browser's one request. `ports` are tried in order and the
 * first free one is taken; every one of them has to be registered with Perso
 * as a redirect address. `onRequest({code, state, error})` is asked once per
 * request to `path` and answers "signed_in" or anything else, which picks the
 * page the browser is shown. Resolves {port, close}; rejects when no port is
 * free. "localhost" as the host is served on 127.0.0.1: browsers fall back
 * to it from ::1 on their own.
 */
export async function startCallbackServer({ host = "127.0.0.1", ports, path = "/callback", onRequest, appName = "PersoDub", logo = "" }) {
  const handler = async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname.replace(/\/+$/, "") !== path) {
      res.writeHead(404, { "Content-Type": "text/plain", Connection: "close" });
      res.end("not found");
      return;
    }
    const q = url.searchParams;
    let outcome = "";
    try { outcome = await onRequest({ code: q.get("code"), state: q.get("state"), error: q.get("error") }); } catch { /* not done */ }
    // Connection: close -- a browser's kept-alive socket would otherwise
    // outlive server.close() and still be answered after the sign-in ended.
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", Connection: "close" });
    // The browser's first language: Korean for "ko...", English for any other.
    res.end(callbackPage({ ok: outcome === "signed_in", lang: localeLanguage(req.headers["accept-language"]), appName, logo }));
  };
  const address = host === "localhost" ? "127.0.0.1" : host;
  const tried = [];
  for (const port of ports) {
    const server = createServer(handler);
    server.unref?.();
    const taken = await new Promise((resolve) => {
      server.once("error", (err) => resolve(err.code || err.message));
      server.listen(port, address, () => resolve(null));
    });
    if (taken) { tried.push(`${port} (${taken})`); continue; }
    // The port the server really has: the one asked for, or the system's pick for 0.
    return { port: server.address().port, close: () => server.close() };
  }
  throw new Error(`no free port for the sign-in: tried ${tried.join(", ")}`);
}
