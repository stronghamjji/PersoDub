// While the first Sign In fetches ChatGPT's sign-in program (app/codex_fetch.py,
// about 130 MB), the window says what it is doing and how far it has got. A
// silent minute read as a hang to a tester (2026-09-28). Used by the first-dub
// sign-in window and by Settings.

/** The progress line under the bar, or "" when there is nothing to show. */
export function setupText(p) {
  if (!p || !p.stage) return "";
  // Short on purpose (user, 2026-09-28): the title already says ChatGPT, and
  // the bar shows the rest.
  const pct = p.stage === "unpack" ? 100 : p.total ? Math.min(100, Math.floor((p.got / p.total) * 100)) : null;
  return pct == null ? "First-time setup" : `First-time setup ${pct}%`;
}

/** 0-100 for the bar, or null while the size is not known yet. */
export function setupPercent(p) {
  if (!p || !p.stage) return null;
  if (p.stage === "unpack") return 100;
  return p.total ? Math.min(100, (p.got / p.total) * 100) : null;
}

/** Ask every half second and hand each answer to paint; returns stop(). */
export function watchSetup(paint, fetchImpl = fetch) {
  let on = true;
  (async () => {
    while (on) {
      const p = await fetchImpl("/api/agent/login/progress").then((r) => r.json()).catch(() => null);
      if (on && p) paint(p);
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  return () => { on = false; };
}
