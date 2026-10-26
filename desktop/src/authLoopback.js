import { createServer } from "node:http";

// The door the browser comes back through after a Perso sign-in: a one-shot
// HTTP listener on this computer only, at http://127.0.0.1:<port>/callback.
// Nothing outside this computer can reach 127.0.0.1, the sign-in's state
// value ties the one request this accepts to the sign-in that opened it, and
// the listener closes as soon as that sign-in ends (desktop/src/auth.js).
//
// What the browser is shown afterwards is one page in the app's own look:
// the logo, one line saying it is done, one line saying what to do, in the
// browser's language (Korean or English).

const WORDS = {
  en: {
    done: (app) => [`Signed in to ${app}`, `You can close this tab and go back to ${app}.`],
    notDone: (app) => ["The sign-in did not finish", `Try again in ${app}.`],
    closing: "You can close this tab.",
  },
  ko: {
    done: (app) => [`${app}에 로그인했어요`, `이 탭을 닫고 ${app}으로 돌아가세요.`],
    notDone: (app) => ["로그인이 끝나지 않았어요", `${app}에서 다시 시도하세요.`],
    closing: "이 탭을 닫아도 돼요.",
  },
};
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const languageOf = (req) => (/^\s*ko\b/i.test(req.headers["accept-language"] || "") ? "ko" : "en");

const CHECK = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;
const CROSS = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`;

/** The page: the app's dark look by default, light when the browser is, the
 * logo when the shell handed one over (a data: URL), and nothing to press. */
export function callbackPage({ ok, lang, appName, logo }) {
  const words = WORDS[lang] || WORDS.en;
  const [title, line] = ok ? words.done(appName) : words.notDone(appName);
  const app = escapeHtml(appName);
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${app}</title>
<style>
  :root { color-scheme: light dark; --bg: #0e131b; --card: #1c2129; --line: #2a3140; --fg: #eaf0fd; --muted: #9aa5b8; --ok: #34c77b; --bad: #f0725c; }
  @media (prefers-color-scheme: light) { :root { --bg: #f4f6fa; --card: #ffffff; --line: #e3e7ee; --fg: #0e131b; --muted: #5a6477; } }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--bg); color: var(--fg);
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif; }
  main { width: min(420px, 100%); padding: 44px 32px 36px; text-align: center; background: var(--card); border: 1px solid var(--line);
    border-radius: 18px; box-shadow: 0 24px 64px rgba(0, 0, 0, .28); }
  .logo { display: block; width: 76px; height: 76px; margin: 0 auto 22px; border-radius: 19px; }
  .mark { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; margin-bottom: 14px; border-radius: 50%;
    color: #fff; background: var(--ok); }
  .mark.bad { background: var(--bad); }
  h1 { margin: 0 0 8px; font-size: 22px; font-weight: 700; letter-spacing: -.01em; }
  p { margin: 0; color: var(--muted); }
  .app { margin-top: 30px; font-size: 12px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
</style></head>
<body><main>
  ${logo ? `<img class="logo" src="${logo}" alt="">` : ""}
  <div class="mark${ok ? "" : " bad"}">${ok ? CHECK : CROSS}</div>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(line)}</p>
  <div class="app">${app}</div>
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
    res.end(callbackPage({ ok: outcome === "signed_in", lang: languageOf(req), appName, logo }));
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
    return { port, close: () => server.close() };
  }
  throw new Error(`no free port for the sign-in: tried ${tried.join(", ")}`);
}
