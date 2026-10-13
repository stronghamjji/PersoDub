// The Projects grid writes its cards as one string of HTML, so a fake page
// cannot walk real nodes back out of it -- the same shape scriptTable.test.mjs
// uses. Where a test needs to press a card, it pre-loads the fake grid's
// querySelectorAll answer (`grid.qs[selector]`) with the nodes the browser
// would have built from that string, then fires their listeners by hand.
//
// Run with: node --test ui/src/homeScreen.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { initHomeScreen } from "./homeScreen.mjs";

function makeEl(id) {
  return {
    id, textContent: "", value: "", hidden: false, dataset: {}, style: {},
    listeners: {}, focused: false, selected: false,
    set innerHTML(v) { this.html = v; },
    get innerHTML() { return this.html || ""; },
    qs: {},
    querySelectorAll(sel) { return this.qs[sel] || []; },
    querySelector(sel) { return (this.qs[sel] || [])[0] || null; },
    contains(node) { return (this.qs["*"] || []).includes(node); },
    focus() { this.focused = true; },
    select() { this.selected = true; },
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    async fire(ev, arg) { for (const fn of [...(this.listeners[ev] || [])]) await fn(arg); },
  };
}

const clickEvent = (target) => ({ target, stopPropagation() { this.stopped = true; }, stopped: false, preventDefault() {} });

function harness({ fetchOk = true } = {}) {
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  const log = { opened: [], deleted: [], calls: [], errors: [], openedDrafts: [], deletedDrafts: [] };

  const real = { fetch: globalThis.fetch, document: globalThis.document };
  const docListeners = {};
  globalThis.document = { addEventListener(ev, fn) { (docListeners[ev] ||= []).push(fn); } };
  globalThis.fetch = async (url, init) => {
    log.calls.push(`${(init && init.method) || "GET"} ${url}${init && init.body ? " " + init.body : ""}`);
    return { ok: fetchOk, json: async () => ({}) };
  };
  log.restore = () => { globalThis.fetch = real.fetch; globalThis.document = real.document; };

  const api = initHomeScreen({
    $,
    langName: (code) => (code ? ({ ko: "Korean", en: "English" })[code] || code.toUpperCase() : null),
    onOpenJob: (id) => log.opened.push(id),
    onDeleteJob: (job, members) => { log.deleted.push(job.id); (log.members ||= []).push(members.map((m) => m.id)); },
    onError: (text) => log.errors.push(text),
    onOpenDraft: (id) => log.openedDrafts.push(id),
    onDeleteDraft: (d) => log.deletedDrafts.push(d.downloadId),
  });
  return { $, api, log };
}

// A fresh copy per call: renderProjects's job objects are painted in place
// (a rename writes .title straight onto them, optimistically), so two tests
// sharing one array would leak a rename from one into the next.
const JOBS = () => [
  { id: "a", status: "done", project: "Interview", source_lang: "ko", language_code: "en", duration: 10 },
  { id: "b", status: "running", project: "Ad spot", language_code: "ko" },
  { id: "c", status: "error", project: "Broken", trim: { start: 2, end: 12 } },
  { id: "d", status: "cancelled", project: "Stopped" },
  { id: "e", status: "queued", project: "Waiting one" },
  { id: "f", kind: "erase", status: "done", project: "clip10" },
];

test("a card shows its name, its languages and a duration, and a finished job carries no chip", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.renderProjects(JOBS());
  const html = h.$("projectsGrid").innerHTML;
  assert.match(html, /Interview/);
  assert.match(html, /Korean → English/);
  assert.match(html, /proj-dur">00:10</);
  assert.doesNotMatch(html.split("Interview")[1].slice(0, 300), /proj-chip/);
});

test("a running job says Dubbing, with no percent until one is given", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.renderProjects(JOBS());
  let html = h.$("projectsGrid").innerHTML;
  assert.match(html, /proj-chip proj-chip-run">Dubbing…/);
  // A percent changes the chip's words in place: the grid is not drawn again,
  // or every draft card's video would load again and flicker (0.8.1).
  h.api.setRunningPct("b", 55);
  assert.equal(h.$("projChip-b").textContent, "Dubbing 55%");
  assert.equal(h.$("projectsGrid").innerHTML, html);
});

test("failed, cancelled and queued jobs each carry their own chip", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.renderProjects(JOBS());
  const html = h.$("projectsGrid").innerHTML;
  assert.match(html, /proj-chip proj-chip-bad">Failed/);
  assert.match(html, /proj-chip proj-chip-muted">Cancelled/);
  assert.match(html, /proj-chip proj-chip-queued">Queued/);
  // A trimmed job's duration is the part kept, not the whole file.
  assert.match(html, /proj-dur">00:10</);  // c: 12-2=10s
});

test("an erase job wears the eraser mark and says what it did, not which languages", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.renderProjects(JOBS());
  const html = h.$("projectsGrid").innerHTML;
  const card = html.slice(html.indexOf('data-job="f"'));
  assert.match(card, /proj-kind/);
  assert.match(card, />Erased</);
});

test("clicking a card opens it, and the \"...\" button opens the menu without opening the card", (t) => {
  const h = harness();
  t.after(h.log.restore);
  const card = makeEl("card-a");
  card.dataset.job = "a";
  const more = makeEl("more-a");
  more.dataset.more = "a";
  h.$("projectsGrid").qs[".proj-card"] = [card];
  h.$("projectsGrid").qs[".proj-more"] = [more];
  h.api.renderProjects(JOBS());

  card.fire("click");
  assert.deepEqual(h.log.opened, ["a"]);

  const e = clickEvent(more);
  more.fire("click", e);
  assert.equal(e.stopped, true);
  assert.equal(h.$("projectCardMenu").hidden, false);
});

test("Delete in the menu hands the job to the page's own confirm dialog", (t) => {
  const h = harness();
  t.after(h.log.restore);
  const more = makeEl("more-b");
  more.dataset.more = "b";
  h.$("projectsGrid").qs[".proj-more"] = [more];
  h.api.renderProjects(JOBS());
  more.fire("click", clickEvent(more));

  h.$("projectMenuDelete").fire("click");
  assert.deepEqual(h.log.deleted, ["b"]);
  assert.equal(h.$("projectCardMenu").hidden, true);
});

test("Rename turns the card's name into a field, and Enter saves it", async (t) => {
  const h = harness();
  t.after(h.log.restore);
  const more = makeEl("more-a");
  more.dataset.more = "a";
  h.$("projectsGrid").qs[".proj-more"] = [more];
  h.api.renderProjects(JOBS());
  more.fire("click", clickEvent(more));

  const input = makeEl("rename-a");
  input.dataset.rename = "a";
  input.value = "Interview";
  h.$("projectsGrid").qs[".proj-rename"] = [input];
  await h.$("projectMenuRename").fire("click");
  assert.match(h.$("projectsGrid").innerHTML, /<input class="proj-rename"/);

  input.value = "New name";
  await input.fire("keydown", { key: "Enter", preventDefault() {} });
  assert.deepEqual(h.log.calls, [
    'POST /api/dub/jobs/a/title {"title":"New name"}',
  ]);
  // Back to a plain name once saved.
  assert.doesNotMatch(h.$("projectsGrid").innerHTML, /<input class="proj-rename"/);
});

test("search narrows the grid to names that match, and clears back to everything", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.renderProjects(JOBS());
  h.$("projectSearchInput").value = "ad spot";
  h.$("projectSearchInput").fire("input");
  let html = h.$("projectsGrid").innerHTML;
  assert.match(html, /Ad spot/);
  assert.doesNotMatch(html, /Interview/);

  h.$("projectSearchInput").value = "";
  h.$("projectSearchInput").fire("input");
  html = h.$("projectsGrid").innerHTML;
  assert.match(html, /Interview/);
});

test("an empty result says there are no projects, not nothing at all", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.renderProjects([]);
  assert.match(h.$("projectsGrid").innerHTML, /No projects yet/);
});

test("a rename the server refuses puts the old name back and says so in one line", async (t) => {
  const h = harness({ fetchOk: false });
  t.after(h.log.restore);
  const more = makeEl("more-a");
  more.dataset.more = "a";
  h.$("projectsGrid").qs[".proj-more"] = [more];
  h.api.renderProjects(JOBS());
  more.fire("click", clickEvent(more));
  const input = makeEl("rename-a");
  input.dataset.rename = "a";
  h.$("projectsGrid").qs[".proj-rename"] = [input];
  await h.$("projectMenuRename").fire("click");
  input.value = "New name";
  await input.fire("keydown", { key: "Enter", preventDefault() {} });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(h.log.errors, ["Could not rename the project. Try again."]);
  assert.match(h.$("projectsGrid").innerHTML, /Interview/);
  assert.doesNotMatch(h.$("projectsGrid").innerHTML, /New name/);
});

test("a search says how many it found, and Escape closes the field", async (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.renderProjects(JOBS());
  assert.equal(h.$("projectsCount").textContent, "6");
  h.$("projectSearchBox").hidden = true;
  await h.$("projectSearchBtn").fire("click");
  assert.equal(h.$("projectSearchBox").hidden, false);
  h.$("projectSearchInput").value = "ad spot";
  await h.$("projectSearchInput").fire("input");
  assert.equal(h.$("projectsCount").textContent, "1 of 6");
  await h.$("projectSearchInput").fire("keydown", { key: "Escape", preventDefault() {} });
  assert.equal(h.$("projectSearchBox").hidden, true);
  assert.equal(h.$("projectSearchInput").value, "");
  assert.equal(h.$("projectsCount").textContent, "6");
  assert.match(h.$("projectsGrid").innerHTML, /Interview/);
});

test("Enter on a card's own button is that button's, not the card's", async (t) => {
  const h = harness();
  t.after(h.log.restore);
  const card = makeEl("card-a");
  card.dataset.job = "a";
  h.$("projectsGrid").qs[".proj-card"] = [card];
  h.api.renderProjects(JOBS());
  await card.fire("keydown", { key: "Enter", target: makeEl("more"), preventDefault() {} });
  assert.deepEqual(h.log.opened, []);
  await card.fire("keydown", { key: "Enter", target: card, preventDefault() {} });
  assert.deepEqual(h.log.opened, ["a"]);
});

// A draft left before dubbing is a card ahead of the projects (owner, 2026-09-30).
const KEPT = [{ downloadId: "0a1b2c3d", name: "street-food.mp4", duration: 52.6,
                ranges: [[0, 20], [31.6, 52.6]], ratio: "original" }];

test("a kept draft is the first card: marked Draft, with how much its cuts kept", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.renderProjects(JOBS());
  h.api.renderDrafts(KEPT);
  const html = h.$("projectsGrid").innerHTML;
  assert.ok(html.indexOf('data-draft="0a1b2c3d"') > 0 && html.indexOf('data-draft="0a1b2c3d"') < html.indexOf('data-job="a"'));
  const card = html.slice(html.indexOf('data-draft="0a1b2c3d"'), html.indexOf('data-job="a"'));
  assert.match(card, /<span class="proj-chip proj-chip-muted">Draft<\/span>/);
  assert.match(card, /<span class="proj-dur">00:41<\/span>/);
  assert.match(card, /<div class="proj-name">street-food\.mp4<\/div><div class="proj-meta">Not dubbed yet<\/div>/);
  assert.match(card, /src="\/api\/downloads\/0a1b2c3d\/video#t=0\.5"/);
  // The count is of cards, Draft cards included.
  assert.equal(h.$("projectsCount").textContent, "7");
  // With no projects at all, the draft still shows rather than "No projects yet".
  h.api.renderProjects([]);
  assert.match(h.$("projectsGrid").innerHTML, /data-draft="0a1b2c3d"/);
  assert.doesNotMatch(h.$("projectsGrid").innerHTML, /No projects yet/);
});

test("a press on a draft card opens that draft, and its menu has Delete alone", async (t) => {
  const h = harness();
  t.after(h.log.restore);
  const card = makeEl("card-draft");
  card.dataset.draft = "0a1b2c3d";
  const more = makeEl("more-draft");
  more.dataset.moreDraft = "0a1b2c3d";
  h.$("projectsGrid").qs[".proj-card"] = [card];
  h.$("projectsGrid").qs[".proj-more"] = [more];
  h.api.renderDrafts(KEPT);
  await card.fire("click");
  assert.deepEqual(h.log.openedDrafts, ["0a1b2c3d"]);
  assert.deepEqual(h.log.opened, []);

  await more.fire("click", clickEvent(more));
  assert.equal(h.$("projectCardMenu").hidden, false);
  assert.equal(h.$("projectMenuRename").hidden, true);
  await h.$("projectMenuDelete").fire("click");
  assert.deepEqual(h.log.deletedDrafts, ["0a1b2c3d"]);
  assert.deepEqual(h.log.deleted, []);
});

// One video dubbed into several languages is one project (mockup
// script-buttons, 2026-10-01): the second language names the first as its
// project_id. Newest first, as GET /api/dub/jobs lists them.
const FAMILY = () => [
  { id: "en2", status: "done", project: "Cats", language: "English", language_code: "en",
    project_id: "ko1", created: "2026-10-01T10:05" },
  { id: "old", status: "done", project: "Cats", language_code: "ja", created: "2026-10-01T10:02" },
  { id: "ko1", status: "done", project: "Cats", language: "Korean", language_code: "ko",
    created: "2026-10-01T10:00" },
];

test("a project of two languages is one card that names both and opens the newest", async (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.renderProjects(FAMILY());
  const html = h.$("projectsGrid").innerHTML;
  assert.equal((html.match(/class="proj-card"/g) || []).length, 2, "the old job with no project is its own card");
  assert.match(html, /data-job="en2"[^]*?proj-meta">Korean · English</);
  assert.doesNotMatch(html, /data-job="ko1"/);
  assert.equal(h.$("projectsCount").textContent, "2");
  const card = makeEl("card");
  card.dataset.job = "en2";
  h.$("projectsGrid").qs[".proj-card"] = [card];
  h.api.renderProjects(FAMILY());
  await card.fire("click");
  assert.deepEqual(h.log.opened, ["en2"]);
});

test("an old job without a project keeps its own card and its own line", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.renderProjects(FAMILY());
  assert.match(h.$("projectsGrid").innerHTML, /data-job="old"[^]*?proj-meta">Auto → JA</);
});

test("Delete on a project's card hands over every language", (t) => {
  const h = harness();
  t.after(h.log.restore);
  const more = makeEl("more");
  more.dataset.more = "en2";
  h.$("projectsGrid").qs[".proj-more"] = [more];
  h.api.renderProjects(FAMILY());
  more.fire("click", clickEvent(more));
  h.$("projectMenuDelete").fire("click");
  assert.deepEqual(h.log.deleted, ["en2"]);
  assert.deepEqual(h.log.members, [["en2", "ko1"]]);
});

test("Rename on a project's card renames every language", async (t) => {
  const h = harness();
  t.after(h.log.restore);
  const more = makeEl("more");
  more.dataset.more = "en2";
  h.$("projectsGrid").qs[".proj-more"] = [more];
  h.api.renderProjects(FAMILY());
  more.fire("click", clickEvent(more));
  const input = makeEl("rename");
  input.dataset.rename = "en2";
  h.$("projectsGrid").qs[".proj-rename"] = [input];
  await h.$("projectMenuRename").fire("click");
  input.value = "Kittens";
  await input.fire("keydown", { key: "Enter", preventDefault() {} });
  assert.deepEqual(h.log.calls, [
    'POST /api/dub/jobs/en2/title {"title":"Kittens"}',
    'POST /api/dub/jobs/ko1/title {"title":"Kittens"}',
  ]);
});
