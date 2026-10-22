// The running screen paints real elements, so the tests hand it a paper-thin
// page: elements that are plain objects and a $ that makes more of them. What
// is asserted is what the user would see -- which stage the card is on and how
// far along, the one reason line on both screens, the out-of-credits popup and
// where its button goes, and the Cancel button through its two lives (offered,
// then pressed).
//
// The progress reader is the real one from dubApi.mjs: the stage names, the
// weights and the percent are the pipeline's, and a test that mocked them
// would only be checking itself.
//
// Run with: node --test ui/src/runningScreen.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { initRunningScreenUi, stoppedMark } from "./runningScreen.mjs";
import { parseProgress } from "./dubApi.mjs";

function makeEl(id) {
  return {
    id, textContent: "", hidden: false, disabled: false,
    style: {}, attrs: {}, classes: new Set(), listeners: {},
    parentElement: null,
    set innerHTML(v) { this.html = v; },
    get innerHTML() { return this.html || ""; },
    classList: {
      add(c) { this.owner.classes.add(c); },
      remove(c) { this.owner.classes.delete(c); },
      contains(c) { return this.owner.classes.has(c); },
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    async fire(ev, arg) { for (const fn of [...(this.listeners[ev] || [])]) await fn(arg); },
  };
}

/** A page, the calls the screen reaches out through, and the answer the
    question gives. The question is the app's own dialog now, handed in like
    every other way this screen reaches out (user, 2026-09-10). */
function harness({ jobId = "j1", status = "running", confirmAnswer = true,
                   onCancel = null, choices = [] } = {}) {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) {
      const el = makeEl(id);
      // classList needs to know which element it belongs to; the page's real
      // one is bound to its node.
      el.classList = { ...el.classList, owner: el };
      // Only the bar asks for a parent -- it writes the aria value on the
      // track around the fill.
      if (id === "progressFill") el.parentElement = $("progressBar");
      els.set(id, el);
    }
    return els.get(id);
  };
  const log = { homeNoticeAndLog: 0, cancelled: [], settings: 0, opened: [], warned: [],
                resumed: [], choicesFor: [] };

  const real = { warn: console.warn };
  console.warn = (m) => log.warned.push(m);
  log.restore = () => { console.warn = real.warn; };
  log.asked = 0;

  const api = initRunningScreenUi({
    $,
    parseProgress,
    // The page's own, cut down: only the long form reaches this screen.
    trimLabel: (job, withLength) =>
      job.trim ? `Trimmed ${job.trim.start} – ${job.trim.end}${withLength ? " · long" : ""}` : "",
    homeNoticeAndLog: () => { log.homeNoticeAndLog += 1; },
    getJobId: () => jobId,
    getJobStatus: () => status,
    onCancel: onCancel || (async (id) => { log.cancelled.push(id); }),
    askCancel: async () => { log.asked += 1; return confirmAnswer; },
    onOpenSettings: () => { log.settings += 1; },
    openExternal: (a, url) => { log.opened.push(url); a.href = url; },
    jobNote: (job) => job.note || "",
    translatorChoices: async (job) => { log.choicesFor.push(job.id); return choices; },
    onResumeWith: (id, translator) => { log.resumed.push([id, translator]); },
  });
  return { $, api, log };
}

// A job three stages in: the pipeline logs "N/6" markers and the reader turns
// them into a stage number, a label and a percent.
const TRANSLATING = {
  id: "j1", status: "running",
  logs: ["1/6 separating", "2/6 transcribing", "3/6 translating the script"],
};

// -- the progress card ------------------------------------------------------

test("the card says which stage the job is on, how far in, and ticks the stages behind it", (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.paintRunning(TRANSLATING);

  const progress = parseProgress(TRANSLATING.logs);
  assert.equal(progress.stage, 3, "three markers logged is the third stage");
  assert.equal(h.$("progressTitle").textContent, "Translating");
  assert.equal(h.$("progressPct").textContent, `${progress.percent}%`);
  assert.equal(h.$("progressFill").style.width, `${progress.percent}%`);
  assert.equal(h.$("progressBar").getAttribute("aria-valuenow"), String(progress.percent));

  const steps = h.$("progressSteps").innerHTML;
  // The two behind carry the tick, the third is where the job is, the last
  // has not started.
  assert.match(steps, /<li class="step-done">[\s\S]*Separating audio/);
  assert.match(steps, /<li class="step-done">[\s\S]*Transcribing/);
  assert.match(steps, /<li class="current">[\s\S]*Translating/);
  assert.match(steps, /<li class="todo">[\s\S]*Dubbing/);
  assert.equal(h.log.homeNoticeAndLog, 1, "the log has to be brought back under this job's steps");
});

test("the card says what the dub was started with, and nothing when that is not known", (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.paintRunning({ ...TRANSLATING, note: "English → Spanish · Fast mode · ChatGPT" });
  assert.equal(h.$("runNote").textContent, "English → Spanish · Fast mode · ChatGPT");
  assert.equal(h.$("runNote").hidden, false);

  h.api.paintRunning(TRANSLATING);
  assert.equal(h.$("runNote").hidden, true);
});

test("the original is set once, in the center panel, with the trim under it", (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.paintRunning({ ...TRANSLATING, trim: { start: 2, end: 8 } });
  assert.equal(h.$("runningVideo").getAttribute("src"), "/api/dub/result/j1/original");
  assert.equal(h.$("runningTrim").textContent, "Trimmed 2 – 8 · long");
});

test("a job that stopped keeps its video beside the failure card, and leaves the card alone", (t) => {
  const h = harness({ status: "error" });
  t.after(h.log.restore);

  h.api.paintStopped({ id: "j9", status: "error", logs: ["1/6 x"], trim: { start: 0, end: 4 } });
  assert.equal(h.$("runningVideo").getAttribute("src"), "/api/dub/result/j9/original");
  assert.equal(h.$("runningTrim").textContent, "Trimmed 0 – 4 · long");
  // The log and the notice were borrowed by the failure card: they stay there.
  assert.equal(h.log.homeNoticeAndLog, 0);
  assert.equal(h.$("progressTitle").textContent, "");
});

test("the card never promises a time", (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.paintRunning({ id: "j1", status: "running", logs: [
    "1/6 x", "2/6 x", "3/6 x", "4/6 x", "5 dialogue lines prepared", "line 1: chose take 2"] });
  const said = [h.$("progressTitle").textContent, h.$("progressPct").textContent,
                h.$("progressSteps").innerHTML, h.$("runNote").textContent].join(" ");
  assert.doesNotMatch(said, /left|remaining|\bmin\b|about/i);
});

test("the voice counter appears only once lines are being spoken", (t) => {
  const h = harness();
  t.after(h.log.restore);

  const job = { id: "j1", status: "running", logs: [
    "1/6 x", "2/6 x", "3/6 x", "4/6 x",
    "5 dialogue lines prepared",
    "line 1: chose take 2", "line 2: chose take 1",
  ] };
  h.api.paintRunning(job);
  assert.match(h.$("progressSteps").innerHTML, /voice 2 of 5/);

  // Nothing spoken yet: a counter sitting at "voice 0 of 5" reads as stuck.
  h.api.paintRunning({ id: "j1", status: "running",
                       logs: ["1/6 x", "2/6 x", "3/6 x", "4/6 x", "5 dialogue lines prepared"] });
  assert.doesNotMatch(h.$("progressSteps").innerHTML, /voice/);
});

test("the video is set once, and a trimmed link job is refetched when the cut lands", (t) => {
  const h = harness();
  t.after(h.log.restore);
  const video = h.$("runningVideo");

  const job = { id: "j1", status: "running", from_link: true,
                trim: { start: 1, end: 4 }, logs: [] };
  h.api.paintRunning(job);
  assert.equal(video.getAttribute("src"), "/api/dub/result/j1/original",
    "nothing is cut yet, so the plain original");
  assert.equal(h.$("runningTrim").textContent, "Trimmed 1 – 4 · long");

  h.api.paintRunning({ ...job, logs: ["1/6 separating"] });
  assert.equal(video.getAttribute("src"), "/api/dub/result/j1/original?cut=1",
    "the first stage starting is the sign the trimmed file exists");

  // A failed load puts the element back to "no source" so the next poll retries.
  video.fire("error", { target: video });
  assert.equal(video.getAttribute("src"), null);
});

// -- the reason line --------------------------------------------------------

test("a failed job's reason is written into both screens, in plain words", (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.paintNotices({ id: "j1", status: "error", error: "interrupted" });
  for (const id of ["jobNotice", "doneNotice"]) {
    assert.equal(h.$(id).hidden, false);
    assert.equal(h.$(id).innerHTML, "The app was closed before dubbing finished.");
  }
});

test("a failed job shows the engine's sentence in the page's language, error_shown, over the English error", (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.paintNotices({ id: "j1", status: "error", error: "No dialogue lines were found in this video.",
                       error_shown: "이 영상에서 대사를 찾지 못했어요." });
  for (const id of ["jobNotice", "doneNotice"]) assert.equal(h.$(id).innerHTML, "이 영상에서 대사를 찾지 못했어요.");
  // A job saved before there was a twin still reads its English.
  h.api.paintNotices({ id: "j1", status: "error", error: "No dialogue lines were found in this video." });
  assert.equal(h.$("jobNotice").innerHTML, "No dialogue lines were found in this video.");
  // A notice's twin likewise, on a job still running.
  h.api.paintNotices({ id: "j1", status: "running",
                       notices: [{ type: "info", message: "Back on track", message_shown: "다시 진행 중" }] });
  assert.equal(h.$("jobNotice").innerHTML, "다시 진행 중");
});

test("a failure sent with its cause apart shows the whole sentence, and the cause under it", (t) => {
  const h = harness();
  t.after(h.log.restore);

  // Cut at its first ": " this read "Translation failed (ChatGPT." -- the
  // advice and the reason both gone.
  h.api.paintNotices({ id: "j1", status: "error",
                       error: "ChatGPT translation failed. Try again, or pick another translator in Settings. (Reason: ChatGPT: no reply)",
                       error_shown: "ChatGPT 번역에 실패했어요. 다시 시도하거나 설정에서 다른 번역기를 골라 주세요.",
                       error_detail: "이유: ChatGPT: no reply" });
  for (const id of ["jobNotice", "doneNotice"]) {
    assert.equal(h.$(id).innerHTML, "ChatGPT 번역에 실패했어요. 다시 시도하거나 설정에서 다른 번역기를 골라 주세요."
      + '<span class="notice-detail">이유: ChatGPT: no reply</span>');
  }
  // Perso's own words, code and all, under the sentence and its advice.
  h.api.paintNotices({ id: "j1", status: "error", error: "Perso could not finish this job. ...",
                       error_shown: "Perso could not finish this job. Try again, or check the project on Perso. Ask Perso if it keeps happening.",
                       error_detail: "Perso said: <too short> (VT5001)" });
  assert.equal(h.$("jobNotice").innerHTML, "Perso could not finish this job. Try again, or check the project on Perso. "
    + 'Ask Perso if it keeps happening.<span class="notice-detail">Perso said: &lt;too short&gt; (VT5001)</span>');
});

test("no notice and no failure means no line at all", (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.paintNotices({ id: "j1", status: "running" });
  assert.equal(h.$("jobNotice").hidden, true);
  assert.equal(h.$("jobNotice").innerHTML, "");
});

test("the poll loop's red line is replaced -- red and all -- by the next real answer", (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.showNoticeError("Could not reach the app server: down - still trying.");
  assert.equal(h.$("jobNotice").hidden, false);
  assert.equal(h.$("jobNotice").textContent, "Could not reach the app server: down - still trying.");
  assert.ok(h.$("jobNotice").classList.contains("danger"));

  h.api.paintNotices({ id: "j1", status: "running",
                       notices: [{ type: "info", message: "Back on track" }] });
  assert.equal(h.$("jobNotice").innerHTML, "Back on track");
  assert.ok(!h.$("jobNotice").classList.contains("danger"), "a real notice takes the red away");
});

// -- the out-of-credits popup ----------------------------------------------

const EXHAUSTED = {
  id: "j1", status: "running",
  notices: [{ type: "perso_credit_exhausted", message: "Perso credits are used up.",
              link: "https://perso.example/recharge" }],
};

test("a credit-exhausted notice draws the line AND pops the popup once, with the link on its button", (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.paintNotices(EXHAUSTED);

  // The line stays either way, so the reason survives dismissing the popup.
  assert.equal(h.$("jobNotice").innerHTML,
    'Perso credits are used up. <a href="https://perso.example/recharge" target="_blank" rel="noopener">Recharge</a>');
  assert.equal(h.$("creditTitle").textContent, "Out of credits");
  assert.equal(h.$("creditMessage").textContent, "Recharge, then try again.");
  assert.equal(h.$("creditRechargeBtn").textContent, "Recharge");
  assert.deepEqual(h.log.opened, ["https://perso.example/recharge"],
    "the Recharge button is armed to open the link the server sent");
  assert.ok(h.$("creditOverlay").classList.contains("open"));

  // Once per job: the poll asks again three seconds later, and a popup that
  // reopened on every answer could not be dismissed at all.
  h.api.hideCreditModal();
  h.api.paintNotices(EXHAUSTED);
  assert.ok(!h.$("creditOverlay").classList.contains("open"));
});

test("a busy-server notice has nowhere to send anyone, so it shows no button", (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.showCreditModal({ type: "perso_unavailable" });
  assert.equal(h.$("creditTitle").textContent, "Perso server busy");
  assert.equal(h.$("creditRechargeBtn").style.display, "none");
  assert.deepEqual(h.log.opened, []);
});

test("a video too long for the Perso plan pops its own popup: the limit Perso named and the plan page", (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.paintNotices({ id: "j2", status: "error", error: "This video is longer than your Perso plan allows.",
    notices: [{ type: "perso_duration_limit", message: "This video is longer than your Perso plan allows.",
                link: "https://perso.ai/pricing?utm_content=pricing", limit_seconds: 60 }] });
  assert.equal(h.$("creditTitle").textContent, "Video too long");
  assert.equal(h.$("creditMessage").textContent,
    "Your Perso plan dubs videos up to 1 min. Upgrade your plan, or set Choose a model to Local model.");
  assert.equal(h.$("creditRechargeBtn").textContent, "See plans");
  assert.deepEqual(h.log.opened, ["https://perso.ai/pricing?utm_content=pricing"]);
  assert.ok(h.$("creditOverlay").classList.contains("open"));
});

test("a plan limit that is not whole minutes, or not named, still reads", (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.showCreditModal({ type: "perso_duration_limit", limit_seconds: 90, link: "https://perso.ai/pricing" });
  assert.equal(h.$("creditMessage").textContent,
    "Your Perso plan dubs videos up to 90 s. Upgrade your plan, or set Choose a model to Local model.");
  h.api.showCreditModal({ type: "perso_duration_limit", link: "https://perso.ai/pricing" });
  assert.equal(h.$("creditMessage").textContent,
    "Your Perso plan does not take a video this long. Upgrade your plan, or set Choose a model to Local model.");
});

test("a voice model the plan does not cover has its own popup, not the wrong-key one", (t) => {
  // VT40314 came as a 403 and read as a rejected key until 2026-10-19.
  const h = harness();
  t.after(h.log.restore);

  h.api.showCreditModal({ type: "perso_plan_required", link: "https://perso.ai/pricing?utm_content=pricing" });
  assert.equal(h.$("creditTitle").textContent, "Higher plan needed");
  assert.equal(h.$("creditMessage").textContent,
    "This dubbing model needs a higher Perso plan. Upgrade your plan, or choose another dubbing model.");
  assert.equal(h.$("creditRechargeBtn").textContent, "See plans");
  assert.deepEqual(h.log.opened, ["https://perso.ai/pricing?utm_content=pricing"]);
});

test("the wrong-key popup keeps the user in the app: its button opens Settings", async (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.showCreditModal({ type: "perso_invalid_key" });
  assert.equal(h.$("creditRechargeBtn").textContent, "Open Settings");
  assert.deepEqual(h.log.opened, ["#"], "an in-app action leaves the anchor going nowhere");

  let prevented = false;
  await h.$("creditRechargeBtn").fire("click", { preventDefault: () => { prevented = true; } });
  assert.ok(prevented, "the anchor must not navigate");
  assert.equal(h.log.settings, 1);
  assert.ok(!h.$("creditOverlay").classList.contains("open"), "and the popup closes behind it");
});

test("the popup closes on the X, on Close, and on a click outside it", async (t) => {
  const h = harness();
  t.after(h.log.restore);
  const overlay = h.$("creditOverlay");

  for (const id of ["creditCloseX", "creditCloseBtn"]) {
    h.api.showCreditModal({ type: "perso_unavailable" });
    await h.$(id).fire("click", {});
    assert.ok(!overlay.classList.contains("open"), `${id} closes it`);
  }

  h.api.showCreditModal({ type: "perso_unavailable" });
  await overlay.fire("click", { target: h.$("creditTitle") });
  assert.ok(overlay.classList.contains("open"), "a click inside the card leaves it open");
  await overlay.fire("click", { target: overlay });
  assert.ok(!overlay.classList.contains("open"));
});

// -- ChatGPT stopped the dubbing: the user picks what happens next ----------

const LIMITED = {
  id: "j1", status: "error", translator: "chatgpt",
  notices: [{ type: "chatgpt_limit",
              message: "ChatGPT usage limit reached. Resets Oct 24, 1:07 PM. "
                + "Resume then, or continue with another translator." }],
};
const HUNYUAN_AND_GEMMA = [
  { id: "hunyuan", label: "Continue with Hunyuan" },
  { id: "gemma", label: "Continue with Gemma (7.6 GB)" },
];
const settle = () => new Promise((r) => setTimeout(r, 0));

test("the ChatGPT limit popup says when it resets and offers one button per translator", async (t) => {
  const h = harness({ status: "error", choices: HUNYUAN_AND_GEMMA });
  t.after(h.log.restore);

  h.api.paintNotices(LIMITED);
  await settle();

  assert.equal(h.$("creditTitle").textContent, "ChatGPT usage limit");
  assert.equal(h.$("creditMessage").textContent, "Resets Oct 24, 1:07 PM. Resume then, or pick another translator.");
  assert.deepEqual(h.log.choicesFor, ["j1"]);
  assert.equal(h.$("creditChoices").hidden, false);
  assert.equal(h.$("creditChoices").innerHTML,
    '<button class="btn btn-secondary" type="button" data-translator="hunyuan">Continue with Hunyuan</button>'
    + '<button class="btn btn-secondary" type="button" data-translator="gemma">Continue with Gemma (7.6 GB)</button>');
  assert.equal(h.$("creditRechargeBtn").style.display, "none", "nowhere to send anyone: waiting is Close");
});

test("a translator button resumes the job with that translator and closes the popup", async (t) => {
  const h = harness({ status: "error", choices: HUNYUAN_AND_GEMMA });
  t.after(h.log.restore);
  h.api.paintNotices(LIMITED);
  await settle();

  await h.$("creditChoices").fire("click", { target: { dataset: { translator: "gemma" } } });
  assert.deepEqual(h.log.resumed, [["j1", "gemma"]]);
  assert.ok(!h.$("creditOverlay").classList.contains("open"));
  // A click between the buttons is no choice.
  await h.$("creditChoices").fire("click", { target: { dataset: {} } });
  assert.equal(h.log.resumed.length, 1);
});

test("with nothing to switch to the popup only says to wait, and Close is the way out", async (t) => {
  const h = harness({ status: "error", choices: [] });
  t.after(h.log.restore);
  h.api.showCreditModal({ type: "chatgpt_limit", message: "ChatGPT usage limit reached for now." }, LIMITED);
  await settle();
  assert.equal(h.$("creditMessage").textContent, "Wait for it to reset, then Resume.");
  assert.equal(h.$("creditChoices").hidden, true);
  await h.$("creditCloseBtn").fire("click", {});
  assert.ok(!h.$("creditOverlay").classList.contains("open"));
  assert.deepEqual(h.log.resumed, []);
});

test("signed out of ChatGPT keeps Open Settings beside the translators", async (t) => {
  const h = harness({ status: "error", choices: HUNYUAN_AND_GEMMA.slice(0, 1) });
  t.after(h.log.restore);
  h.api.showCreditModal({ type: "chatgpt_signed_out", message: "ChatGPT is not signed in." }, LIMITED);
  await settle();
  assert.equal(h.$("creditTitle").textContent, "Sign in with ChatGPT");
  assert.equal(h.$("creditMessage").textContent, "Sign in from Settings, then Resume, or pick another translator.");
  assert.equal(h.$("creditRechargeBtn").textContent, "Open Settings");
  assert.match(h.$("creditChoices").innerHTML, /data-translator="hunyuan">Continue with Hunyuan</);
});

test("Translate again's ChatGPT popup hands the pick back instead of resuming", async (t) => {
  // The script pane's Translate again (Windows H14): same popup, same
  // translators, but a pick translates those lines; there is no dubbing to resume.
  const h = harness({ status: "done", choices: HUNYUAN_AND_GEMMA });
  t.after(h.log.restore);
  const picked = [];
  h.api.showCreditModal({ type: "chatgpt_limit", message: "ChatGPT usage limit reached. Resets Oct 24, 1:07 PM." },
    { id: "j1", translator: "chatgpt" }, (translator) => picked.push(translator));
  await settle();
  assert.equal(h.$("creditMessage").textContent, "Resets Oct 24, 1:07 PM. Translate again then, or pick another translator.");
  await h.$("creditChoices").fire("click", { target: { dataset: { translator: "gemma" } } });
  assert.deepEqual(picked, ["gemma"]);
  assert.deepEqual(h.log.resumed, []);
  assert.ok(!h.$("creditOverlay").classList.contains("open"));

  // The next dubbing popup resumes again.
  h.api.showCreditModal({ type: "chatgpt_signed_out", message: "" }, LIMITED);
  await settle();
  assert.equal(h.$("creditMessage").textContent, "Sign in from Settings, then Resume, or pick another translator.");
  await h.$("creditChoices").fire("click", { target: { dataset: { translator: "hunyuan" } } });
  assert.deepEqual(h.log.resumed, [["j1", "hunyuan"]]);
  assert.deepEqual(picked, ["gemma"]);
});

test("other popups offer no translators", async (t) => {
  const h = harness({ choices: HUNYUAN_AND_GEMMA });
  t.after(h.log.restore);
  h.api.paintNotices(EXHAUSTED);
  await settle();
  assert.deepEqual(h.log.choicesFor, []);
  assert.equal(h.$("creditChoices").hidden, true);
});

// -- the Cancel button ------------------------------------------------------

test("Cancel is offered while a job is alive and gone once it is over", (t) => {
  for (const [status, hidden] of [["running", false], ["queued", false],
                                  ["cancelling", false], ["done", true],
                                  ["error", true], [null, true]]) {
    const h = harness({ status });
    t.after(h.log.restore);
    h.api.paintCancel();
    assert.equal(h.$("cancelBtn").hidden, hidden, `${status} -> hidden ${hidden}`);
  }
});

test("a job already on its way out says so, and cannot be asked twice", (t) => {
  const h = harness({ status: "cancelling" });
  t.after(h.log.restore);

  h.api.paintCancel();
  // The word lives in its own element beside the stop square (2026-09-09).
  assert.equal(h.$("cancelLabel").textContent, "Stopping…");
  assert.equal(h.$("cancelBtn").disabled, true);
});

test("pressing Cancel asks once, then disables itself while the server answers", async (t) => {
  const h = harness();
  t.after(h.log.restore);
  const btn = h.$("cancelBtn");

  await btn.fire("click", {});
  assert.deepEqual(h.log.cancelled, ["j1"]);
  assert.equal(btn.disabled, true);
  assert.equal(h.$("cancelLabel").textContent, "Stopping…");
});

test("answering no to the question stops nothing", async (t) => {
  const h = harness({ confirmAnswer: false });
  t.after(h.log.restore);

  await h.$("cancelBtn").fire("click", {});
  assert.deepEqual(h.log.cancelled, []);
  assert.equal(h.$("cancelBtn").disabled, false);
});

test("a job that finished between the question and the call puts the button back", async (t) => {
  // The server says 409 -- and the poll loop may already have given up, so
  // nothing else would ever repaint this button.
  const h = harness({ status: "done",
    onCancel: async () => { throw Object.assign(new Error("already done"), { status: 409 }); } });
  t.after(h.log.restore);

  await h.$("cancelBtn").fire("click", {});
  assert.equal(h.$("jobNotice").textContent, "", "too late is not a failure, so no red line");
  assert.equal(h.$("cancelBtn").hidden, true, "the button is repainted from the job's real state");
  assert.equal(h.$("cancelBtn").disabled, false);
});

// -- starting over ----------------------------------------------------------

test("reset takes both reason lines away, red included", (t) => {
  const h = harness();
  t.after(h.log.restore);

  h.api.showNoticeError("the server went quiet");
  h.api.paintNotices({ id: "j1", status: "error", error: "interrupted" });

  h.api.reset();
  assert.equal(h.$("jobNotice").hidden, true);
  assert.equal(h.$("doneNotice").hidden, true);
  assert.ok(!h.$("jobNotice").classList.contains("danger"));
});

// -- a job that stopped -----------------------------------------------------

// Cancelled and failed share one screen and, until now, only the sentence told
// them apart -- so the screen read the same as a finished one at a glance.
test("a stopped job wears a mark: a stop square cancelled, an exclamation failed", () => {
  const cancelled = stoppedMark("cancelled");
  const failed = stoppedMark("error");

  assert.match(cancelled, /^<svg viewBox="0 0 24 24"/);
  assert.match(cancelled, /<rect /, "cancelled is a stop square");
  assert.doesNotMatch(cancelled, /<path /);
  assert.match(failed, /<path d="M12 7\.5v5\.5"\/><path d="M12 16\.6h\.01"\/>/,
    "a failure is a stroke and the dot under it");
  // Anything the server did not call cancelled has failed.
  assert.equal(stoppedMark("interrupted"), failed);
  assert.equal(stoppedMark(undefined), failed);
});

// -- a new dubbing, before its first answer -----------------------------------

test("a dubbing just started shows none of the last one: no progress, no video, no note, no reason", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.$("runningVideo").load = () => { h.log.loaded = (h.log.loaded || 0) + 1; };
  h.api.paintRunning({ ...TRANSLATING, note: "English → Spanish", trim: { start: 1, end: 5 } });
  h.api.showNoticeError("PersoDub is not answering. Still trying.");

  h.api.starting();

  assert.equal(h.$("progressPct").textContent, "0%");
  assert.equal(h.$("progressFill").style.width, "0%");
  assert.doesNotMatch(h.$("progressSteps").innerHTML, /step-done|current/);
  assert.equal(h.$("runningVideo").getAttribute("src"), null, "the last dubbing's video is let go");
  assert.equal(h.log.loaded, 1);
  assert.equal(h.$("runNote").hidden, true);
  assert.equal(h.$("runningTrim").textContent, "");
  assert.equal(h.$("jobNotice").hidden, true);
});

test("a stop the server could not do says so; one that came too late does not", async (t) => {
  const failing = harness({ onCancel: async () => { throw Object.assign(new Error("boom"), { status: 500 }); } });
  t.after(failing.log.restore);
  await failing.$("cancelBtn").fire("click", {});
  assert.equal(failing.$("jobNotice").textContent, "Could not stop the dubbing. Try again.");
  assert.equal(failing.$("jobNotice").hidden, false);
  assert.equal(failing.$("cancelLabel").textContent, "Stop", "and the button is back");

  const late = harness({ onCancel: async () => { throw Object.assign(new Error("over"), { status: 409 }); } });
  t.after(late.log.restore);
  await late.$("cancelBtn").fire("click", {});
  assert.notEqual(late.$("jobNotice").textContent, "Could not stop the dubbing. Try again.");
});

test("a failure with no sentence of its own says the stage it stopped on and the button to press", (t) => {
  const h = harness({ status: "error" });
  t.after(h.log.restore);
  const stopped = (logs, extra = {}) => {
    h.api.paintNotices({ id: "j1", status: "error", error: "KeyError: 'segments'", logs, ...extra });
    return h.$("doneNotice").innerHTML;
  };
  const resume = "Press Resume to go on from where it stopped. If it stops again, you can try the Perso API.";
  assert.equal(stopped(["1/6 separating"]), `It stopped while separating the audio. ${resume}`);
  assert.equal(stopped(TRANSLATING.logs.slice(0, 2)), `It stopped while transcribing. ${resume}`);
  assert.equal(stopped(TRANSLATING.logs), `It stopped while translating. ${resume}`);
  assert.equal(stopped([...TRANSLATING.logs, "4/6 voices"]), `It stopped while making the voices. ${resume}`);
  assert.equal(stopped([...TRANSLATING.logs, "4/6 voices", "5/6 check"]), `It stopped while making the voices. ${resume}`);
  assert.equal(stopped([...TRANSLATING.logs, "4/6 voices", "5/6 check", "6/6 build"]), `It stopped while making the video. ${resume}`);
  // A Perso API dub has no Resume: Start over.
  assert.equal(stopped(["Uploading the video to Perso"], { dub_mode: "perso" }),
    "It stopped while dubbing with the Perso API. Press Start over.");
});

test("a failed dub shows a plain sentence, never what the program said when it broke", (t) => {
  const h = harness({ status: "error" });
  t.after(h.log.restore);
  h.api.paintNotices({ id: "j1", status: "error", error: "No dialogue lines were found in this video." });
  assert.equal(h.$("doneNotice").innerHTML, "No dialogue lines were found in this video.");
  h.api.paintNotices({ id: "j1", status: "error", error: "KeyError: 'segments'", logs: [] });
  assert.equal(h.$("doneNotice").innerHTML,
    "It stopped while getting the dubbing ready. Press Start over. If it stops again, quit and reopen PersoDub, then try again.");
  h.api.paintNotices({ id: "j1", status: "error", error: "local STT reported an error ([Errno 2] No such file)" });
  assert.equal(h.$("doneNotice").innerHTML, "Local STT reported an error.");
});
