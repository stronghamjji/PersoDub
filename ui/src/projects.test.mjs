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
import { readFileSync } from "node:fs";
import { initProjectsUi, jobMark, shownName, projectMeta, doingWord } from "./projects.mjs";
import { loadTable, setLanguage } from "./i18n.mjs";

function makeEl(id) {
  return {
    id, textContent: "", className: "", type: "", title: "", hidden: false,
    scrollWidth: 0, clientWidth: 0,
    children: [], listeners: {}, attrs: {},
    // The lists are emptied with innerHTML = "" and filled with appendChild;
    // the empty states are the only strings ever written whole. A queue row's
    // HTML also makes the two nodes the card writes to later: its state and,
    // on the job on air, its bar.
    set innerHTML(v) {
      this.html = v;
      if (v === "") this.children = [];
      const state = v.match(/class="q-state[^"]*">([^<]*)</);
      const bar = v.match(/<i style="width:([^"]*)"/);
      this.parts = { ".q-state": state ? [{ textContent: state[1] }] : [],
                     ".queue-bar i": bar ? [{ style: { width: bar[1] } }] : [] };
    },
    get innerHTML() { return this.html || ""; },
    get classList() { return { contains: (name) => this.className.split(" ").includes(name) }; },
    // What a browser finds under this node, in page order. markClippedNames
    // asks for .job-name, which tests that care about hand back themselves.
    querySelectorAll(sel) {
      return [...((this.parts || {})[sel] || []), ...this.children.flatMap((kid) => kid.querySelectorAll(sel))];
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(kid) { this.children.push(kid); return kid; },
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    async fire(ev, arg) { for (const fn of [...(this.listeners[ev] || [])]) await fn(arg); },
  };
}

/** A page, a fetch log and the callbacks the list reaches out through. */
function harness({ responses = {}, screen = "home", jobId = null, onJobs, onSeen } = {}) {
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
    onJobs,
    ...(onSeen ? { onSeen } : {}),
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
  assert.match(second.innerHTML, /Auto → Korean · 01:00/);
  // Anything still going gets the running dot, named or not.
  assert.match(second.innerHTML, /class="job-dot dot-running"/);
});

// Five colours are one colour to a reader who does not see them, so every state
// carries its own shape too. The colour class is still there; this pins the mark.
test("every job state is a shape as well as a colour", () => {
  const marks = {
    done: jobMark("done"), queued: jobMark("queued"), running: jobMark("running"),
    error: jobMark("error"), cancelled: jobMark("cancelled"),
  };
  for (const [state, svg] of Object.entries(marks)) {
    assert.match(svg, /^<svg viewBox="0 0 12 12"/, `${state} is not a 12px mark`);
  }
  assert.match(marks.done, /<path d="M2\.6 6\.4/, "done is a tick");
  assert.match(marks.queued, /<circle cx="6" cy="6" r="3\.6"\/>/, "waiting is an empty ring");
  assert.doesNotMatch(marks.queued, /fill:currentColor/);
  assert.match(marks.running, /fill:currentColor/, "running fills that ring");
  assert.equal((marks.error.match(/<path/g) || []).length, 2, "a failure is a cross");
  assert.match(marks.cancelled, /<circle[\s\S]*<path/, "cancelled is the ring struck through");
  assert.equal(jobMark("on_perso"), marks.done, "done on Perso is done, its file on Perso's site");
  // Anything the server has no mark for is still going.
  assert.equal(jobMark("separating"), marks.running);
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
    '<div class="history-empty">The connection to PersoDub dropped for a moment. If it stays this way, quit and reopen PersoDub.</div>');
});

test("folded away, the sidebar's list is left as it is, and the Home grid still gets the list", async (t) => {
  // Nothing has opened the old sidebar since the Home grid took its place, so
  // its rows were drawn for no one on every refresh.
  const handed = [];
  const h = harness({
    responses: { [JOBS]: ok({ jobs: [{ id: "a", status: "done", project: "Interview" }] }) },
    onJobs: (jobs) => handed.push(jobs.map((j) => j.id)),
  });
  t.after(h.log.restore);
  h.$("historySidebar").className = "history-sidebar collapsed";
  const list = h.$("historyList");
  list.innerHTML = "as the page left it";

  await h.api.renderHistory();
  assert.equal(list.innerHTML, "as the page left it");
  assert.equal(list.children.length, 0);
  assert.deepEqual(handed, [["a"]]);

  // An engine that cannot be reached is not written into it either.
  const down = harness({ responses: { [JOBS]: () => { throw new Error("offline"); } } });
  t.after(down.log.restore);
  down.$("historySidebar").className = "history-sidebar collapsed";
  down.$("historyList").innerHTML = "as the page left it";
  await down.api.renderHistory();
  assert.equal(down.$("historyList").innerHTML, "as the page left it");
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

// The charts' dubbing stages (ui/src/dubTrack.mjs) read every job the card
// reads: each row of the list, and the one on air with its log.
test("Up next hands every job it reads to onSeen, the one on air with its log", async (t) => {
  const seen = [];
  const h = harness({
    responses: {
      [JOBS]: ok({ jobs: [{ id: "q1", status: "queued" }, { id: "r1", status: "running" }, { id: "d1", status: "done" }] }),
      "/api/dub/jobs/r1": ok({ id: "r1", status: "running", logs: ["2/6 Transcribing"] }),
    },
    onSeen: (job) => seen.push([job.id, job.status, Array.isArray(job.logs)]),
  });
  t.after(h.log.restore);
  await h.api.renderQueueCard();
  assert.deepEqual(seen, [["q1", "queued", false], ["r1", "running", false], ["d1", "done", false], ["r1", "running", true]]);
});

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

test("an erase row wears the eraser and says what it did, not which languages", async (t) => {
  const h = harness({
    responses: {
      [JOBS]: ok({ jobs: [
        { id: "e1", kind: "erase", status: "done", project: "clip10" },
        { id: "e2", kind: "erase", status: "running", project: "shorts" },
        { id: "e3", kind: "erase", status: "error", project: "broken" },
        { id: "d1", status: "done", project: "Interview", source_lang: "ko", language_code: "en" },
      ] }),
    },
  });
  t.after(h.log.restore);

  await h.api.renderHistory();
  const rows = h.$("historyList").children.map((l) => l.children[0]);
  assert.match(rows[0].innerHTML, /class="job-kind"/, "an erase row has no eraser on it");
  assert.match(rows[0].innerHTML, />Subtitles erased</);
  assert.match(rows[1].innerHTML, />Erasing subtitles</);
  // A job that stopped says what it was; the dot beside it says how it ended.
  assert.match(rows[2].innerHTML, />Erase subtitles</);
  assert.match(rows[2].innerHTML, /class="job-dot dot-error"/);
  // A dub is unchanged -- no eraser, and the two languages as before.
  assert.doesNotMatch(rows[3].innerHTML, /class="job-kind"/);
  assert.match(rows[3].innerHTML, /Korean → English/);
  // And a click on an erase row is handed back like any other.
  await rows[0].fire("click");
  assert.deepEqual(h.log.opened, ["e1"]);
});

test("an erase in the line counts itself from its own log line", async (t) => {
  const h = harness({
    responses: {
      [JOBS]: ok({ jobs: [
        { id: "e1", kind: "erase", status: "running", project: "clip10" },
      ] }),
      // The eraser prints this and nothing a dub's stage counter would find.
      "/api/dub/jobs/e1": ok({ logs: ["progress 12%", "progress 43%"] }),
    },
  });
  t.after(h.log.restore);

  await h.api.renderQueueCard();
  const row = h.$("queueRows").children[0].children[0];
  assert.match(row.innerHTML, /Erasing 43%/);
  assert.match(row.innerHTML, /class="queue-bar"><i style="width:43%"/);
  // The X beside it stops an erase, and says so.
  assert.equal(h.$("queueRows").children[0].children[1].title, "Stop erasing");
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
  assert.match(live.children[0].innerHTML, /Stopping…/);

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

test("a tick that finds the same line keeps its rows and X buttons, and moves only the words and the bar", async (t) => {
  // The rows used to be drawn again every tick, so an X pressed just then was
  // a button already gone: the second Cancel did nothing (Windows C18).
  let logs = ["Uploading the video to Perso"];
  const h = harness({
    responses: {
      [JOBS]: () => ok({ jobs: [
        { id: "q1", status: "queued", project: "Second" },
        { id: "r1", status: "running", project: "First" },
      ] }),
      "/api/dub/jobs/r1": () => ok({ logs }),
    },
  });
  t.after(h.log.restore);
  await h.api.renderQueueCard();
  const rows = h.$("queueRows");
  const [onAir, waiting] = rows.children;
  const [row, stop] = onAir.children;
  const x = waiting.children[1];
  const [state, waitingState] = rows.querySelectorAll(".q-state");
  const [bar] = rows.querySelectorAll(".queue-bar i");
  assert.equal(state.textContent, "Dubbing 15%");
  assert.equal(bar.style.width, "15%");

  logs = ["Uploading the video to Perso", "Perso is dubbing"];
  await h.api.renderQueueCard();
  assert.equal(rows.children.length, 2);
  assert.equal(rows.children[0], onAir);
  assert.equal(rows.children[1], waiting);
  assert.equal(onAir.children[0], row);
  assert.equal(onAir.children[1], stop);
  assert.equal(waiting.children[1], x);
  assert.equal(x.listeners.click.length, 1, "a kept X is not given a second listener");
  assert.equal(rows.querySelectorAll(".q-state")[0], state);
  assert.equal(state.textContent, "Dubbing 55%");
  assert.equal(waitingState.textContent, "Waiting");
  assert.equal(bar.style.width, "55%");
  assert.equal(h.$("queueSummary").textContent, "1 running · 1 waiting");
  // The kept X still takes its job out of line.
  await x.fire("click", clickEvent());
  assert.deepEqual(h.log.cancelled, ["q1"]);
});

test("the rows are drawn again when the line changes: one taken out mid-tick, a rename, the next one's turn", async (t) => {
  let jobs = [
    { id: "q2", status: "queued", project: "Third" },
    { id: "q1", status: "queued", project: "Second" },
    { id: "r1", status: "running", project: "First" },
  ];
  const h = harness({
    responses: {
      [JOBS]: () => ok({ jobs }),
      "/api/dub/jobs/r1": ok({ logs: [] }),
      "/api/dub/jobs/q1": ok({ logs: [] }),
    },
  });
  t.after(h.log.restore);
  const lines = () => h.$("queueRows").children;
  const names = () => lines().map((l) => l.children[0].innerHTML.match(/q-name">([^<]*)/)[1]);
  await h.api.renderQueueCard();
  let before = lines();

  // Taken out of line while a tick was still asking: the later answer stays drawn.
  const tick = h.api.renderQueueCard();
  jobs = jobs.filter((j) => j.id !== "q2");
  await Promise.all([tick, h.api.renderQueueCard()]);
  assert.deepEqual(names(), ["First", "Second"]);
  assert.notEqual(lines()[0], before[0]);

  // Renamed on another screen: the row says the new name.
  before = lines();
  jobs = jobs.map((j) => (j.id === "q1" ? { ...j, title: "Second, renamed" } : j));
  await h.api.renderQueueCard();
  assert.deepEqual(names(), ["First", "Second, renamed"]);
  assert.notEqual(lines()[1], before[1]);

  // The first one is done and the next one's turn has come: its row has a bar
  // now, and its X stops it instead of taking it out of line.
  jobs = [{ id: "q1", status: "running", project: "Second", title: "Second, renamed" }];
  await h.api.renderQueueCard();
  assert.deepEqual(names(), ["Second, renamed"]);
  assert.match(lines()[0].children[0].innerHTML, /class="queue-bar"/);
  assert.equal(lines()[0].children[1].title, "Stop dubbing");
});

test("a job that leaves the line has the project list read again, so its card stops saying a percent", async (t) => {
  // The cards kept "Dubbing 97%" for over a minute after the job was done
  // (Windows H19, 2026-10-07): only an event redrew them.
  let jobs = [{ id: "r1", status: "running", project: "First" }];
  const h = harness({
    responses: {
      [JOBS]: () => ok({ jobs }),
      "/api/dub/jobs/r1": ok({ logs: [] }),
    },
  });
  t.after(h.log.restore);
  await h.api.renderQueueCard();
  assert.equal(h.$("queueCard").hidden, false);
  const reads = () => h.log.calls.filter((c) => c === `GET ${JOBS}`).length;
  assert.equal(reads(), 1);

  jobs = [{ id: "r1", status: "done", project: "First" }];
  await h.api.renderQueueCard();
  await new Promise((r) => setTimeout(r, 0));
  // Once for the card, once more for the list the cards are painted from.
  assert.equal(reads(), 3);
  assert.equal(h.$("queueCard").hidden, true);

  await h.api.renderQueueCard();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(reads(), 4, "nothing left the line this time");
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

// The name a project is shown under: the user's own if they set one, the
// folder's name otherwise (user, 2026-09-10).
test("a renamed project shows the name it was given", () => {
  assert.equal(shownName({ project: "clip10" }), "clip10");
  assert.equal(shownName({ project: "clip10", title: "마이클 잭슨 Beat It" }), "마이클 잭슨 Beat It");
  assert.equal(shownName({ project: "clip10", title: "   " }), "clip10", "blank is not a name");
  assert.equal(shownName({}), "Dubbing", "and a job with neither still says something");
});

test("a separation says Separated once it is done, and what it is while it is not", () => {
  const meta = (status) => projectMeta({ kind: "separate", status }, () => "");
  assert.equal(meta("done"), "Separated");
  assert.equal(meta("running"), "Separating the audio");
  assert.equal(meta("queued"), "Separating the audio");
  assert.equal(meta("error"), "Separate audio");
  assert.equal(meta("cancelled"), "Separate audio");
  assert.equal(doingWord({ kind: "separate" }), "Separating");
  assert.equal(doingWord({ kind: "erase" }), "Erasing");
  assert.equal(doingWord({}), "Dubbing");
});

// The words under a card's name say which tool as well (owner, 2026-10-21);
// the chip's percent keeps its short word.
test("in Korean the words under an erase or a separation name the tool", async (t) => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true,
    json: async () => JSON.parse(readFileSync(new URL("../../static/i18n/ui.ko.json", import.meta.url), "utf8")) });
  await loadTable("ko");
  globalThis.fetch = real;
  setLanguage("ko");
  t.after(() => setLanguage("en"));
  const meta = (kind, status) => projectMeta({ kind, status }, () => "");
  assert.equal(meta("separate", "done"), "오디오 분리 완료");
  assert.equal(meta("separate", "running"), "오디오 분리 중");
  assert.equal(meta("erase", "done"), "자막 지우기 완료");
  assert.equal(meta("erase", "running"), "자막 지우는 중");
  // A video with its own subtitles is named by its tool, not as a dubbing's "Auto → Script".
  assert.equal(meta("captions", "done"), "자막 입히기");
  assert.equal(doingWord({ kind: "separate" }), "분리 중");
  assert.equal(doingWord({ kind: "erase" }), "지우는 중");
});
