// The Projects list and the Up next card both paint real elements from one
// server list, so the tests hand them a paper-thin page: elements that are
// plain objects, a document that makes more of them, and a fetch that answers
// from a script. What is asserted is what the user would see -- a row per job,
// the open one marked, the queue in the order it will run -- and where a click
// on a row is handed back to the page.
//
// Run with: node --test ui/src/projects.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { initProjectsUi } from "./projects.mjs";

function makeEl(id) {
  return {
    id, textContent: "", className: "", type: "", title: "", hidden: false,
    scrollWidth: 0, clientWidth: 0,
    children: [], listeners: {}, attrs: {},
    // The lists are emptied with innerHTML = "" and filled with appendChild;
    // the empty states are the only strings ever written whole.
    set innerHTML(v) { this.html = v; if (v === "") this.children = []; },
    get innerHTML() { return this.html || ""; },
    // Only markClippedNames asks, and only for .job-name -- tests that care
    // about it hand back their own list.
    querySelectorAll() { return []; },
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(kid) { this.children.push(kid); return kid; },
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    async fire(ev, arg) { for (const fn of [...(this.listeners[ev] || [])]) await fn(arg); },
  };
}

/** A page, a fetch log and the callbacks the list reaches out through. */
function harness({ responses = {}, screen = "home", jobId = null } = {}) {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };
  const log = { calls: [], opened: [], deleted: [], cancelled: [] };

  const real = { fetch: globalThis.fetch, document: globalThis.document };
  globalThis.document = { createElement: (tag) => makeEl(tag) };
  globalThis.fetch = async (url) => {
    log.calls.push(`GET ${url}`);
    const r = responses[url];
    if (typeof r === "function") return r();
    if (!r) throw new Error(`no answer scripted for ${url}`);
    return r;
  };
  log.restore = () => {
    globalThis.fetch = real.fetch;
    globalThis.document = real.document;
  };

  const api = initProjectsUi({
    $,
    getActiveJobId: () => jobId,
    isHomeScreen: () => screen === "home",
    // The page's own, cut down to the two languages these tests use.
    langName: (code) => (code ? ({ ko: "Korean", en: "English" })[code] || code.toUpperCase() : null),
    onOpenJob: (id) => log.opened.push(id),
    onDeleteJob: (job) => log.deleted.push(job.id),
    onCancelJob: (job) => log.cancelled.push(job.id),
  });
  return { $, api, log };
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const JOBS = "/api/dub/jobs";
// A click on a row's X, which stops the row underneath from opening the job.
const clickEvent = () => ({ stopPropagation() { this.stopped = true; }, stopped: false });

// -- the sidebar -----------------------------------------------------------

test("the sidebar paints a row per job, marks the open one and says which way each dub goes", async (t) => {
  const h = harness({
    jobId: "b",
    responses: {
      [JOBS]: ok({ jobs: [
        { id: "a", status: "done", project: "Interview", source_lang: "ko", language_code: "en" },
        { id: "b", status: "running", project: "Ad spot", language_code: "ko",
          trim: { start: 10, end: 70 } },
      ] }),
    },
  });
  t.after(h.log.restore);

  await h.api.renderHistory();

  const lines = h.$("historyList").children;
  assert.equal(lines.length, 2);
  const [first, second] = lines.map((l) => l.children[0]);
  // The open job's row is the one marked current, and only that one.
  assert.equal(first.className, "job-row");
  assert.equal(second.className, "job-row current");
  assert.match(first.innerHTML, /Interview/);
  assert.match(first.innerHTML, /Korean → English/);
  assert.match(first.innerHTML, /class="job-dot dot-done"/);
  // No source language is "Auto", and a trimmed job also says how long it is.
  assert.match(second.innerHTML, /Auto → Korean · 00:01:00/);
  // Anything still going gets the running dot, named or not.
  assert.match(second.innerHTML, /class="job-dot dot-running"/);
});

test("a row opens its job, and its Delete button asks the page instead", async (t) => {
  const h = harness({
    responses: { [JOBS]: ok({ jobs: [{ id: "j1", status: "done", project: "Interview" }] }) },
  });
  t.after(h.log.restore);

  await h.api.renderHistory();
  const [row, del] = h.$("historyList").children[0].children;
  await row.fire("click");
  assert.deepEqual(h.log.opened, ["j1"]);

  // Deleting is the page's question -- the row only passes the job along, and
  // the row underneath must not open the job while it is being asked.
  const e = clickEvent();
  await del.fire("click", e);
  assert.equal(e.stopped, true);
  assert.deepEqual(h.log.deleted, ["j1"]);
  assert.deepEqual(h.log.opened, ["j1"]);
});

test("an empty list invites a video; an unreachable engine says so instead", async (t) => {
  const h = harness({ responses: { [JOBS]: ok({ jobs: [] }) } });
  t.after(h.log.restore);

  await h.api.renderHistory();
  assert.equal(h.$("historyList").innerHTML,
    '<div class="history-empty">No projects yet - drop a video to start one.</div>');

  const down = harness({ responses: { [JOBS]: () => { throw new Error("offline"); } } });
  t.after(down.log.restore);
  await down.api.renderHistory();
  assert.equal(down.$("historyList").innerHTML,
    '<div class="history-empty">Could not reach the app server.</div>');
});

test("only the names too long for their column get a tooltip", async (t) => {
  const h = harness({ responses: { [JOBS]: ok({ jobs: [] }) } });
  t.after(h.log.restore);

  const cut = { scrollWidth: 300, clientWidth: 200, textContent: "A very long project name",
                title: "", removeAttribute() { this.title = ""; } };
  const whole = { scrollWidth: 120, clientWidth: 200, textContent: "Short",
                  title: "stale", removeAttribute() { this.title = ""; } };
  h.$("historyList").querySelectorAll = () => [cut, whole];

  h.api.markClippedNames();
  assert.equal(cut.title, "A very long project name");
  // A name fully on show loses the tooltip it was given while it was narrower.
  assert.equal(whole.title, "");
});

// -- the Up next card ------------------------------------------------------

test("Up next shows the job on air with its percent and the line waiting behind it", async (t) => {
  const h = harness({
    responses: {
      [JOBS]: ok({ jobs: [
        // Newest first, the way the server sends them.
        { id: "q2", status: "queued", project: "Third" },
        { id: "q1", status: "queued", project: "Second" },
        { id: "r1", status: "running", project: "First" },
      ] }),
      "/api/dub/jobs/r1": ok({ logs: ["Perso is dubbing"] }),
    },
  });
  t.after(h.log.restore);

  await h.api.renderQueueCard();

  assert.equal(h.$("queueCard").hidden, false);
  assert.equal(h.$("queueSummary").textContent, "1 running · 2 waiting");
  const rows = h.$("queueRows").children.map((l) => l.children[0]);
  assert.equal(rows.length, 3);
  // The job on air first, then the line oldest-first -- the order they run in.
  assert.match(rows[0].innerHTML, /First/);
  assert.match(rows[0].innerHTML, /Dubbing 55%/);
  assert.match(rows[0].innerHTML, /class="queue-bar"><i style="width:55%"/);
  assert.match(rows[1].innerHTML, /Second/);
  assert.match(rows[1].innerHTML, /Waiting/);
  assert.match(rows[2].innerHTML, /Third/);
  // A waiting row has no progress bar to fill.
  assert.doesNotMatch(rows[2].innerHTML, /queue-bar/);

  await rows[1].fire("click");
  assert.deepEqual(h.log.opened, ["q1"]);
});

test("a queue row's X hands the job to the page, and a job on its way out has none", async (t) => {
  const h = harness({
    responses: {
      [JOBS]: ok({ jobs: [
        { id: "q1", status: "queued", project: "Second" },
        { id: "r1", status: "cancelling", project: "First" },
      ] }),
      "/api/dub/jobs/r1": ok({ logs: [] }),
    },
  });
  t.after(h.log.restore);

  await h.api.renderQueueCard();
  const [live, waiting] = h.$("queueRows").children;
  // Already on its way out: the row alone, no X to press twice.
  assert.equal(live.children.length, 1);
  assert.match(live.children[0].innerHTML, /Cancelling…/);

  const x = waiting.children[1];
  assert.equal(x.className, "queue-x");
  assert.equal(x.title, "Take this video out of line");
  const e = clickEvent();
  await x.fire("click", e);
  assert.equal(e.stopped, true);
  assert.deepEqual(h.log.cancelled, ["q1"]);
  // Cancelling is the page's to do: the list asks the server for nothing.
  assert.deepEqual(h.log.calls, [`GET ${JOBS}`, "GET /api/dub/jobs/r1"]);
});

test("the card hides itself when the line is empty, and off the home screen it never asks", async (t) => {
  const h = harness({ responses: { [JOBS]: ok({ jobs: [{ id: "a", status: "done" }] }) } });
  t.after(h.log.restore);
  h.$("queueCard").hidden = false;
  await h.api.renderQueueCard();
  assert.equal(h.$("queueCard").hidden, true);

  const away = harness({ screen: "done" });
  t.after(away.log.restore);
  away.$("queueCard").hidden = false;
  await away.api.renderQueueCard();
  assert.equal(away.$("queueCard").hidden, true);
  assert.deepEqual(away.log.calls, []);
});
