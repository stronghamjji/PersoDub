// The ChatGPT sign-in window: a dub that translates with ChatGPT, started
// before this computer is signed in, asks for the sign-in here instead of
// sending the user to Settings. Sign In opens the browser; once the status
// says signed in, what asked goes on by itself -- the dub, or the Dub Agent
// (one ChatGPT sign-in covers both). Lifted out of the page's script
// unchanged (2026-10-10).
//
// The elements this file touches: #chatgptSignInOverlay and what is in it
// (#csTitle, #csLine, #csBar, #csButtons, #csSignIn, #csCancel, #csLocal).
import { setupText, setupPercent, watchSetup } from "./chatgptSetup.mjs";
import { errorText } from "./format.mjs";
import { t } from "./i18n.mjs";

/**
 * @param {object} deps
 * @param {(id: string) => any} deps.$   the page's getElementById helper
 * @param {() => Promise<void>} deps.startDubbing  the New project dialog's
 *        start: what a sign-in goes on with when nothing else is named
 * @param {() => void} deps.onTranslateHere  picks the translator that runs on
 *        this computer, for a dub that goes on without ChatGPT
 * @returns {{ askChatgptSignIn: (then?: () => any) => void }}
 *   askChatgptSignIn opens the window for a dub; `then` runs once signed in.
 *   The Dub Agent asks through the persodub:chatgpt-signin event instead.
 */
export function initChatgptSignIn({ $, startDubbing, onTranslateHere }) {
  // First dub with ChatGPT and no sign-in yet: ask here instead of sending the
  // user to Settings. Sign In opens the browser; once the status says signed
  // in, the dub starts by itself. Cancel (or closing) just stops waiting.
  let chatgptSignInRun = 0;
  // What a finished sign-in does next: start the dub that asked, or -- when the
  // Dub Agent asked (one ChatGPT sign-in covers both, 2026-09-28) -- tell it.
  let chatgptSignedInThen = startDubbing;
  // Whether the Dub Agent asked: it asks through the persodub:chatgpt-signin
  // event, and every direct call is a dub. Told apart by the function before,
  // a dub's own retry (a wrapper) got the agent's words (2026-10-10).
  let agentAsked = false;
  function paintSignIn(step, note = "") {
    $("csTitle").textContent = step === "done" ? t("Signed in") : t("Sign in to ChatGPT");
    const line = $("csLine");
    line.classList.toggle("danger", !!note);
    if (note) line.textContent = note;
    else if (step === "wait") line.innerHTML = '<span class="cs-spin"></span>' + t("Finish in your browser.");
    else if (step === "prep") line.innerHTML = '<span class="cs-spin"></span>' + t("Opening sign-in\u2026");
    else if (step === "done") line.textContent = "\u2713 " + (agentAsked ? t("Ready") : t("Starting\u2026"));
    else line.textContent = agentAsked ? t("Codex uses your ChatGPT account.") : t("Translation uses your ChatGPT account.");
    $("csButtons").hidden = step === "done";
    // The way round the sign-in, for a dub only: Codex has no translator to switch.
    $("csLocal").hidden = agentAsked || step !== "ask";
    if (step !== "prep") paintSetup(null);
    $("csSignIn").hidden = step === "wait" || step === "prep";
  }
  function paintSetup(p) {
    // Only a computer fetching the program says so: one that has it goes
    // straight to the browser, and "first time only" would be untrue there.
    if (p && p.stage) $("csLine").textContent = setupText(p);
    const pct = setupPercent(p);
    $("csBar").hidden = pct == null;
    if (pct != null) $("csBar").firstElementChild.style.width = pct + "%";
  }
  function askChatgptSignIn(then = startDubbing, agent = false) {
    chatgptSignedInThen = then;
    agentAsked = agent;
    chatgptSignInRun += 1;
    paintSignIn("ask");
    $("chatgptSignInOverlay").classList.add("open");
  }
  window.addEventListener("persodub:chatgpt-signin", (e) =>
    askChatgptSignIn(typeof e.detail === "function" ? e.detail : () => {}, true));
  $("csCancel").addEventListener("click", () => {
    chatgptSignInRun += 1; // any wait in progress stops at its next check
    $("chatgptSignInOverlay").classList.remove("open");
  });
  // No ChatGPT account, or no wish to sign in: the dub goes on translating with
  // a local model (Hunyuan), the way the download window offers Perso. Without it a user
  // with no account stopped here unless they knew the Advanced options (owner,
  // 2026-10-18). Its download, if any, is the dub's own download window next.
  $("csLocal").addEventListener("click", () => {
    chatgptSignInRun += 1;
    $("chatgptSignInOverlay").classList.remove("open");
    onTranslateHere();
    return chatgptSignedInThen();
  });
  $("csSignIn").addEventListener("click", async () => {
    const run = ++chatgptSignInRun;
    // The first Sign In on a computer without OpenAI's sign-in program fetches
    // it first (app/codex_fetch.py), which takes seconds, not a browser.
    paintSignIn("prep");
    const stopWatching = watchSetup((p) => { if (run === chatgptSignInRun) paintSetup(p); });
    try {
      const r = await fetch("/api/agent/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "chatgpt" }),
      }).finally(stopWatching);
      if (!r.ok) {
        const detail = (await r.json().catch(() => ({}))).detail;
        throw new Error(typeof detail === "string" ? detail : "");
      }
      if (run !== chatgptSignInRun) return;
      paintSignIn("wait");
      for (let i = 0; i < 60; i++) {            // every 3 s for three minutes
        await new Promise((res) => setTimeout(res, 3000));
        if (run !== chatgptSignInRun) return;
        const st = await fetch("/api/agent/status?login=1").then((x) => x.json()).catch(() => ({}));
        const a = (st.agents || []).find((x) => x.id === "chatgpt");
        if (a && a.logged_in === true) {
          paintSignIn("done");
          await new Promise((res) => setTimeout(res, 1000));
          if (run !== chatgptSignInRun) return;
          $("chatgptSignInOverlay").classList.remove("open");
          return chatgptSignedInThen();
        }
      }
      if (run === chatgptSignInRun) paintSignIn("ask", t("Didn\u2019t finish. Try again."));
    } catch (e) {
      if (run === chatgptSignInRun) paintSignIn("ask", errorText(e) || t("Could not start. Try again."));
    }
  });

  return { askChatgptSignIn };
}
