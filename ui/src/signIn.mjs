// The production edition's Perso sign-in screen. The signing in itself is the
// desktop shell's (desktop/src/auth.js, reached through
// window.persodubShell.auth*): this file only shows where it stands.
//
// The screen covers the whole window while the app is signed out, while the
// sign-in window is open on Perso's sign-in (or the computer's browser, for
// Google and Microsoft), and while the account signed in to has no API key. What it shows is read off the shell's status each time it
// changes (onAuthState), so a sign-out from anywhere -- Settings, or a token
// Perso no longer takes -- brings it back on its own.
//
// A status with enabled: false (the open-source edition) shows nothing. In a
// plain browser there is no shell and nothing runs.
//
// Everything this file touches is #signInScreen and Home's #homeAccount.
import { t } from "./i18n.mjs";
import { record as recordStep } from "./events.mjs";

// A failed sign-in's reason (createAuth's `error`) as one short line.
const FAILED = {
  timeout: "Sign-in took too long.",
  window: "Couldn't open the sign-in window.",
  port: "Couldn't start the sign-in. Try again.",
  network: "Couldn't reach Perso. Check your connection.",
};

// Why a key that did not arrive did not, as one short line: this computer
// could not write it (the shell's keyReason "save"), or Perso was not reached.
const keyTrouble = (r) => (r && r.keyReason === "save"
  ? t("Couldn't save the key on this computer.")
  : t("Couldn't check the key. Check your connection."));

/** Which face the screen shows for a status: "start", "wait", "nokey", or
 * "" for none (the app itself). */
export function signInFace(status) {
  if (!status || !status.enabled) return "";
  if (status.required) return status.waiting ? "wait" : "start";
  return status.hasKey ? "" : "nokey";
}

export function initSignIn({ $, shell, body = document.body, pollMs = 10000, win = globalThis.window, doc = globalThis.document,
                             record = recordStep }) {
  let status = { enabled: false };
  let note = "";      // why the last sign-in did not finish, on the first face
  let keyNote = "";   // what the last "Check again" found, on the no-key face
  const listeners = [];
  const auth = shell && shell.authStatus ? shell : null;
  // The name under the logo is the edition's (PersoDubbing in production).
  $("signInName").textContent = t("{app}");
  // The elements made inert while the screen is up, so nothing under it can
  // be reached by Tab or a shortcut. Only these are given back.
  const madeInert = new Set();

  function holdBackground(on) {
    if (!on) { for (const el of madeInert) el.inert = false; madeInert.clear(); return; }
    for (const el of body.children) {
      if (el === $("signInScreen") || el.inert) continue;
      el.inert = true;
      madeInert.add(el);
    }
  }

  // The account's keys looked at again. Loud is the Check again button: it
  // says what it found. Quiet is a look nobody pressed for, which says
  // nothing and only moves the screen on once there is a key.
  async function checkKey({ loud }) {
    let r;
    try { r = await auth.authCheckKey(); } catch { r = { key: "failed" }; }
    if (r && r.key === "saved") keyNote = "";
    else if (loud) keyNote = r && r.key === "no_key" ? t("Still no API key. Make one, then check again.") : keyTrouble(r);
    await refresh();
  }

  // While the no-key face is up, the keys are looked at quietly when the
  // user comes back to the app (from the key window, where a key is made) and
  // every pollMs while the app is in view, so a key made on the Perso site
  // is taken without a press. One quiet look at a time.
  let looking = false;
  async function lookQuietly() {
    if (looking || !auth || signInFace(status) !== "nokey") return;
    looking = true;
    try { await checkKey({ loud: false }); } finally { looking = false; }
  }
  let polling = false;
  function watchKey() {
    if (polling || !auth) return;
    polling = true;
    const tick = async () => {
      if (signInFace(status) !== "nokey") { polling = false; return; }
      if (doc?.visibilityState !== "hidden") await lookQuietly();
      if (signInFace(status) === "nokey") later(tick); else polling = false;
    };
    later(tick);
  }
  // unref: in a test on Node the pending look must not hold the process open.
  const later = (fn) => { const timer = setTimeout(fn, pollMs); timer.unref?.(); };

  async function openKeyPage() {
    try { await auth.authOpenKeyPage(); } catch { /* Make a key is still there */ }
  }

  let shownFace = "";
  function paint() {
    const face = signInFace(status);
    $("signInScreen").hidden = !face;
    $("signInStart").hidden = face !== "start";
    $("signInWait").hidden = face !== "wait";
    $("signInNoKey").hidden = face !== "nokey";
    // Where a waiting sign-in goes on: the app's sign-in window, or the
    // computer's browser once Google or Microsoft took it there.
    const inBrowser = status.where === "browser";
    $("signInWaitTitle").textContent = inBrowser ? t("Finish signing in in your browser") : t("Finish signing in in the sign-in window");
    $("signInWaitNote").hidden = !inBrowser;
    $("signInWaitNote").textContent = inBrowser ? t("Finish signing in with Google or Microsoft in your browser. If you are done and nothing happens here, press Continue.") : "";
    $("signInReopen").textContent = inBrowser ? t("Continue") : t("Open the sign-in window again");
    $("signInBtn").textContent = note ? t("Try again") : t("Sign in with Perso");
    // Only a failure's reason goes under the button.
    $("signInHint").textContent = note;
    $("signInHint").classList.toggle("danger", !!note);
    $("signInAccount").textContent = status.account || t("Perso account");
    $("signInKeyNote").textContent = keyNote;
    // Home's account line: the signed-in account under the brand, or nothing.
    const signedIn = !!status.enabled && !!status.signedIn;
    $("homeAccount").hidden = !signedIn;
    $("homeAccountName").textContent = signedIn ? (status.account || t("Perso account")) : "";
    $("homeAccount").title = signedIn ? t("signed in as {account}", { account: status.account || t("Perso account") }) : "";
    holdBackground(!!face);
    // A new face takes the keyboard on its first button, and is a step in
    // the charts: who stops at the sign-in, and where.
    if (face && face !== shownFace) {
      record("sign_in_shown", { face });
      ({ start: $("signInBtn"), wait: $("signInReopen"), nokey: $("signInMakeKey") })[face].focus();
      // Come to the no-key face, after a sign-in or at a launch signed in to an account with no key: the key page
      // opens, once; the screen moves on by itself once a key is made there (watchKey).
      if (face === "nokey") void openKeyPage();
    }
    shownFace = face;
    if (face === "nokey") watchKey();
  }

  function take(s) {
    if (!s || typeof s !== "object") return;
    status = s;
    paint();
    for (const cb of listeners) cb(status);
  }
  async function refresh() {
    try { take(await auth.authStatus()); } catch { /* the shell answers; nothing to show if not */ }
  }

  // A sign-in from any button, or signing out. Its answer comes when it is
  // over; the faces in between follow the shell's status.
  async function run(action) {
    note = "";
    keyNote = "";
    paint();
    let r;
    try { r = await action(); } catch { r = { outcome: "failed" }; }
    if (r && r.outcome === "failed") note = t(FAILED[r.error] || "Couldn't sign in.");
    // Signed in, but the key did not arrive: the no-key face says why.
    if (r && r.key === "failed") keyNote = keyTrouble(r);
    await refresh();
    return r;
  }

  if (auth) {
    $("signInBtn").addEventListener("click", () => run(() => auth.authLogin()));
    // The waiting sign-in's window brought forward again, or, waiting in the
    // browser, Continue: Perso's Google or Microsoft start there again. No new sign-in.
    $("signInReopen").addEventListener("click", () => auth.authShow());
    $("signInCancel").addEventListener("click", () => auth.authCancel());
    $("signInMakeKey").addEventListener("click", () => auth.authOpenKeyPage());
    $("signInCheckKey").addEventListener("click", async () => {
      const btn = $("signInCheckKey");
      btn.disabled = true;
      try { await checkKey({ loud: true }); } finally { btn.disabled = false; }
    });
    // Back in the app: the window has the focus again, or is in view again.
    win?.addEventListener?.("focus", () => lookQuietly());
    doc?.addEventListener?.("visibilitychange", () => (doc?.visibilityState === "visible" ? lookQuietly() : undefined));
    // The no-key face's way out: sign out, and sign in as an account that has a key.
    $("signInSignOut").addEventListener("click", () => run(() => auth.authLogout()));
    if (auth.onAuthState) auth.onAuthState(take);
    refresh();
  }

  return {
    status: () => status,
    onChange: (cb) => listeners.push(cb),
    logout: () => run(() => auth.authLogout()),
  };
}
