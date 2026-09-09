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

/** A page, the calls the screen reaches out through, and the answer confirm gives. */
function harness({ jobId = "j1", status = "running", confirmAnswer = true,
                   onCancel = null } = {}) {
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
  const log = { homeNoticeAndLog: 0, cancelled: [], settings: 0, opened: [], warned: [] };

  const real = { confirm: globalThis.confirm, warn: console.warn };
  globalThis.confirm = () => confirmAnswer;
  console.warn = (m) => log.warned.push(m);
  log.restore = () => { globalThis.confirm = real.confirm; console.warn = real.warn; };

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
    onOpenSettings: () => { log.settings += 1; },
    openExternal: (a, url) => { log.opened.push(url); a.href = url; },
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
  assert.equal(h.$("creditMessage").textContent,
    "Perso credits are used up. Recharge, then run this job again.");
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
  assert.equal(h.$("cancelLabel").textContent, "Cancelling…");
  assert.equal(h.$("cancelBtn").disabled, true);
});

test("pressing Cancel asks once, then disables itself while the server answers", async (t) => {
  const h = harness();
  t.after(h.log.restore);
  const btn = h.$("cancelBtn");

  await btn.fire("click", {});
  assert.deepEqual(h.log.cancelled, ["j1"]);
  assert.equal(btn.disabled, true);
  assert.equal(h.$("cancelLabel").textContent, "Cancelling…");
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
  const h = harness({ status: "done", onCancel: async () => { throw new Error("already done"); } });
  t.after(h.log.restore);

  await h.$("cancelBtn").fire("click", {});
  assert.deepEqual(h.log.warned, ["already done"]);
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
