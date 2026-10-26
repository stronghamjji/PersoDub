import { createServer } from "node:http";

// The door the browser comes back through after a Perso sign-in: a one-shot
// HTTP listener on this computer only, at http://127.0.0.1:<port>/callback.
// Nothing outside this computer can reach 127.0.0.1, the sign-in's state
// value ties the one request this accepts to the sign-in that opened it, and
// the listener closes as soon as that sign-in ends (desktop/src/auth.js).

const page = (title, line) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;margin:48px;color:#222"><h1 style="font-size:20px;margin:0 0 12px">${title}</h1><p style="margin:0">${line}</p></body></html>`;
const DONE = page("PersoDub에 로그인했습니다 · Signed in to PersoDub",
  "이 탭을 닫고 PersoDub으로 돌아가세요. · You can close this tab and go back to PersoDub.");
const NOT_DONE = page("PersoDub", "로그인이 끝나지 않았습니다. PersoDub에서 다시 시도하세요. · The sign-in did not finish. Try again in PersoDub.");

/**
 * Listen for the browser's one request. `ports` are tried in order and the
 * first free one is taken; every one of them has to be registered with Perso
 * as a redirect address. `onRequest({code, state, error})` is asked once per
 * request to `path` and answers "signed_in" or anything else, which picks the
 * page the browser is shown. Resolves {port, close}; rejects when no port is
 * free. "localhost" as the host is served on 127.0.0.1: browsers fall back
 * to it from ::1 on their own.
 */
export async function startCallbackServer({ host = "127.0.0.1", ports, path = "/callback", onRequest }) {
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
    res.end(outcome === "signed_in" ? DONE : NOT_DONE);
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
