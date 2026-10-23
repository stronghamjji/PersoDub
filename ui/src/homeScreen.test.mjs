// The Projects grid writes its cards as one string of HTML, so a fake page
// cannot walk real nodes back out of it -- the same shape scriptTable.test.mjs
// uses. Where a test needs to press a card, it pre-loads the fake grid's
// querySelectorAll answer (`grid.qs[selector]`) with the nodes the browser
// would have built from that string, then fires their listeners by hand.
// The tests of painting the same cards again use liveGrid instead, which
// builds those nodes from the string itself, anew on every write.
//
// Run with: node --test ui/src/homeScreen.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initHomeScreen, FOLD_KEY } from "./homeScreen.mjs";

function makeEl(id) {
  return {
    id, textContent: "", value: "", hidden: false, dataset: {}, style: {},
    listeners: {}, focused: false, selected: false, attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
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

function harness({ fetchOk = true, storage = null } = {}) {
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  const log = { opened: [], deleted: [], calls: [], errors: [], openedDrafts: [], deletedDrafts: [] };

  const real = { fetch: globalThis.fetch, document: globalThis.document };
  const docListeners = {};
  globalThis.document = { addEventListener(ev, fn) { (docListeners[ev] ||= []).push(fn); },
                          createElement: () => node("") };
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
    storage,
  });
  return { $, api, log };
}

// A node of a card, as much of one as paint() reaches for: its classes and
// words, its attributes and listeners, and the nodes inside it, found by class.
function node(className, textContent = "", kids = []) {
  const n = {
    className, textContent, kids, dataset: {}, attrs: {}, listeners: {}, parent: null,
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    querySelector(sel) {
      for (const kid of this.kids) {
        const hit = kid.className.split(" ").includes(sel.slice(1)) ? kid : kid.querySelector(sel);
        if (hit) return hit;
      }
      return null;
    },
    insertBefore(kid, ref) {
      kid.parent = this;
      this.kids.splice(ref ? this.kids.indexOf(ref) : this.kids.length, 0, kid);
      return kid;
    },
    // Only ever asked for "afterbegin".
    insertAdjacentHTML(where, html) { this.insertBefore(node(html.match(/class="([^"]*)"/)[1]), this.kids[0]); },
    remove() { this.parent.kids.splice(this.parent.kids.indexOf(this), 1); },
  };
  for (const kid of kids) kid.parent = n;
  return n;
}

// The card a browser builds from one card's HTML, down to those parts.
function cardFrom(html) {
  const words = (cls) => (html.match(new RegExp(`class="${cls}">([^<]*)<`)) || [])[1];
  const chip = html.match(/class="(proj-chip [^"]*)">([^<]*)</);
  const picture = Object.assign(node("proj-img"), { tag: html.includes("<video") ? "video" : "img" });
  const thumb = node("proj-thumb", "", [picture, ...(chip ? [node(chip[1], chip[2])] : []),
                                        ...(words("proj-dur") ? [node("proj-dur", words("proj-dur"))] : [])]);
  const more = node("proj-more");
  more.attrs["aria-label"] = (html.match(/aria-label="(More for [^"]*)"/) || [])[1];
  const card = node("proj-card", "", [thumb, ...(words("proj-name") ? [node("proj-name", words("proj-name"))] : []),
                                      node("proj-meta", words("proj-meta")), more]);
  card.dataset = { job: (html.match(/data-job="([^"]*)"/) || [])[1], draft: (html.match(/data-draft="([^"]*)"/) || [])[1] };
  card.attrs["aria-label"] = (html.match(/aria-label="([^"]*)"/) || [])[1];
  return card;
}

// A grid that builds its cards from the HTML written into it, as a browser
// does: every write is new nodes, so a card (or a draft's <video>) that is
// the same object after a paint is one that paint did not draw again.
function liveGrid(h) {
  const grid = h.$("projectsGrid");
  let html = "";
  grid.writes = 0;
  Object.defineProperty(grid, "innerHTML", {
    get: () => html,
    set(v) {
      html = v;
      grid.writes += 1;
      grid.qs[".proj-card"] = v.split('<div class="proj-card"').slice(1).map(cardFrom);
    },
  });
  return grid;
}
const cardOf = (grid, id) => grid.qs[".proj-card"].find((c) => c.dataset.job === id);

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
  assert.match(card, />Subtitles erased</);
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
  const grid = liveGrid(h);
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
  // Put back on the card that is there: the same projects are still on show.
  const card = cardOf(grid, "a");
  assert.equal(card.querySelector(".proj-name").textContent, "Interview");
  assert.equal(card.attrs["aria-label"], "Open Interview");
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

// A draft left on the Erase tab read "Not dubbed yet" (2026-10-21).
test("a draft left on the Erase tab says what it was being made into, with the eraser", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.api.renderDrafts([{ ...KEPT[0], tab: "erase" }]);
  const erase = h.$("projectsGrid").innerHTML;
  assert.match(erase, /<span class="proj-kind" title="Erase subtitles"><svg viewBox="0 0 24 24" width="12" height="12">/);
  assert.match(erase, /<span class="proj-chip proj-chip-muted">Draft<\/span>/);
  assert.match(erase, /<div class="proj-meta">Not erased yet<\/div>/);
  // The Korean the owner approved names the tool (2026-10-21).
  const ko = JSON.parse(readFileSync(new URL("../../static/i18n/ui.ko.json", import.meta.url), "utf8"));
  assert.equal(ko["Not erased yet"], "자막 지우기 · 미완료");
  // The same draft moved to Dubbing is drawn again with its own words.
  h.api.renderDrafts([{ ...KEPT[0], tab: "dubbing" }]);
  const again = h.$("projectsGrid").innerHTML;
  assert.doesNotMatch(again, /proj-kind/);
  assert.match(again, /data-draft="0a1b2c3d"[^]*?<div class="proj-meta">Not dubbed yet<\/div>/);
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
  const card = makeEl("card");
  card.dataset.job = "en2";
  h.$("projectsGrid").qs[".proj-card"] = [card];
  h.api.renderProjects(FAMILY());
  const html = h.$("projectsGrid").innerHTML;
  assert.equal((html.match(/class="proj-card"/g) || []).length, 2, "the old job with no project is its own card");
  assert.match(html, /data-job="en2"[^]*?proj-meta">Korean · English</);
  assert.doesNotMatch(html, /data-job="ko1"/);
  assert.equal(h.$("projectsCount").textContent, "2");
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

// -- painting the same cards again ------------------------------------------
// Writing the whole grid on every refresh made each draft's video load again,
// so the drafts flickered, and a press that landed meanwhile was lost.

test("the same cards painted again stay the same nodes, and a draft's <video> is not made again", (t) => {
  const h = harness();
  t.after(h.log.restore);
  const grid = liveGrid(h);
  h.api.renderProjects(JOBS());
  h.api.renderDrafts(KEPT);
  const draft = grid.qs[".proj-card"][0];
  const interview = cardOf(grid, "a");
  const video = draft.querySelector(".proj-img");
  assert.equal(video.tag, "video");
  assert.equal(grid.writes, 2);

  // The next refresh: a new list of the same projects, and the same draft.
  h.api.renderProjects(JOBS());
  h.api.renderDrafts(KEPT.map((d) => ({ ...d })));
  assert.equal(grid.writes, 2, "the grid's HTML is not written again");
  assert.equal(grid.qs[".proj-card"][0], draft);
  assert.equal(draft.querySelector(".proj-img"), video);
  assert.equal(cardOf(grid, "a"), interview);
  assert.equal(interview.listeners.click.length, 1, "a kept card is not given a second listener");
  assert.equal(interview.querySelector(".proj-name").textContent, "Interview");
  assert.equal(interview.querySelector(".proj-meta").textContent, "Korean → English");
});

test("a job whose state changed has its chip, length and words changed on the card it already has", (t) => {
  const h = harness();
  t.after(h.log.restore);
  const grid = liveGrid(h);
  h.api.renderProjects(JOBS());
  const ids = ["a", "b", "e", "f"];
  const before = ids.map((id) => cardOf(grid, id));
  const [finished, onAir, next, erase] = before;

  // The one on air is done and knows its length now, the next one's turn has
  // come, a finished one waits to be made again and an erase runs again.
  const jobs = JOBS();
  Object.assign(jobs[1], { status: "done", duration: 75 });
  jobs[4].status = "running";
  jobs[0].status = "queued";
  jobs[5].status = "running";
  h.api.renderProjects(jobs);
  assert.equal(grid.writes, 1);
  ids.forEach((id, i) => assert.equal(cardOf(grid, id), before[i], `card ${id} was drawn again`));
  assert.equal(onAir.querySelector(".proj-chip"), null, "a finished card carries no chip");
  assert.equal(onAir.querySelector(".proj-dur").textContent, "01:15");
  assert.equal(next.querySelector(".proj-chip").className, "proj-chip proj-chip-run");
  assert.equal(next.querySelector(".proj-chip").textContent, "Dubbing…");
  assert.equal(erase.querySelector(".proj-meta").textContent, "Erasing subtitles");
  // A chip put back goes ahead of the length, under the id the percent finds it by.
  const labels = finished.querySelector(".proj-thumb").kids;
  assert.deepEqual(labels.map((k) => k.className), ["proj-img", "proj-chip proj-chip-queued", "proj-dur"]);
  assert.equal(labels[1].id, "projChip-a");
  assert.equal(labels[1].textContent, "Queued");
});

test("a name changed elsewhere, and a draft cut again, show on the cards already there", (t) => {
  const h = harness();
  t.after(h.log.restore);
  const grid = liveGrid(h);
  h.api.renderProjects(JOBS());
  h.api.renderDrafts(KEPT);
  const draft = grid.qs[".proj-card"][0];
  const interview = cardOf(grid, "a");
  const video = draft.querySelector(".proj-img");

  const jobs = JOBS();
  jobs[0].title = "Interview, cut";   // renamed in the top bar of its own screen
  h.api.renderProjects(jobs);
  h.api.renderDrafts([{ ...KEPT[0], ranges: [[0, 20]] }]);
  assert.equal(grid.writes, 2);
  assert.equal(interview.querySelector(".proj-name").textContent, "Interview, cut");
  assert.equal(interview.attrs["aria-label"], "Open Interview, cut");
  assert.equal(interview.querySelector(".proj-more").attrs["aria-label"], "More for Interview, cut");
  assert.equal(draft.querySelector(".proj-dur").textContent, "00:20");
  assert.equal(draft.querySelector(".proj-img"), video);
});

test("a job added or deleted, the same ones in another order and a search each draw the grid again", (t) => {
  const h = harness();
  t.after(h.log.restore);
  const grid = liveGrid(h);
  h.api.renderProjects(JOBS());
  const first = cardOf(grid, "a");

  h.api.renderProjects([{ id: "g", status: "queued", project: "New one" }, ...JOBS()]);
  assert.equal(grid.writes, 2);
  assert.notEqual(cardOf(grid, "a"), first);
  assert.equal(grid.qs[".proj-card"][0].dataset.job, "g");

  h.api.renderProjects(JOBS().filter((j) => j.id !== "c"));   // deleted between two refreshes
  assert.equal(grid.writes, 3);
  assert.equal(cardOf(grid, "c"), undefined);

  h.api.renderProjects(JOBS().filter((j) => j.id !== "c").reverse());
  assert.equal(grid.writes, 4);
  assert.deepEqual(grid.qs[".proj-card"].map((c) => c.dataset.job), ["f", "e", "d", "b", "a"]);

  h.$("projectSearchInput").value = "ad spot";
  h.$("projectSearchInput").fire("input");
  assert.equal(grid.writes, 5);
  assert.deepEqual(grid.qs[".proj-card"].map((c) => c.dataset.job), ["b"]);
});

test("a picture the server had none for is asked for again when the cards are painted again", (t) => {
  // Its <img> takes itself off when there is no picture yet (a link still
  // coming down). Drawing the grid again used to put it back; so does this.
  const h = harness();
  t.after(h.log.restore);
  const grid = liveGrid(h);
  h.api.renderProjects(JOBS());
  const card = cardOf(grid, "e");
  card.querySelector(".proj-img").remove();
  h.api.renderProjects(JOBS());
  assert.equal(grid.writes, 1);
  assert.equal(cardOf(grid, "e"), card);
  assert.equal(card.querySelector(".proj-thumb").kids[0].className, "proj-img");
});

// A long list is a lot to face (owner, 2026-10-23): Collapse folds the cards
// away to the heading row, and the next start remembers it.
test("Collapse folds the grid away and Expand brings it back, remembered for the next start", (t) => {
  const kept = new Map();
  const storage = { getItem: (k) => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => kept.set(k, v) };
  const h = harness({ storage });
  t.after(h.log.restore);
  const btn = h.$("projectFoldBtn");
  assert.equal(h.$("projectsGrid").hidden, false);
  assert.equal(btn.attrs["aria-expanded"], "true");
  assert.match(btn.innerHTML, /<span>Collapse<\/span>$/);
  btn.fire("click");
  assert.equal(h.$("projectsGrid").hidden, true);
  assert.equal(btn.attrs["aria-expanded"], "false");
  assert.match(btn.innerHTML, /<span>Expand<\/span>$/);
  assert.equal(kept.get(FOLD_KEY), "1");
  // The next start opens folded.
  const again = harness({ storage });
  t.after(again.log.restore);
  assert.equal(again.$("projectsGrid").hidden, true);
  again.$("projectFoldBtn").fire("click");
  assert.equal(again.$("projectsGrid").hidden, false);
  assert.equal(kept.get(FOLD_KEY), "0");
  // No storage to read (a private window): open, and a press still folds.
  const bare = harness({ storage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } } });
  t.after(bare.log.restore);
  assert.equal(bare.$("projectsGrid").hidden, false);
  bare.$("projectFoldBtn").fire("click");
  assert.equal(bare.$("projectsGrid").hidden, true);
});

// Searching a folded list shows nothing to find: opening the search unfolds it.
test("opening the search unfolds a folded grid", (t) => {
  const kept = new Map([[FOLD_KEY, "1"]]);
  const storage = { getItem: (k) => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => kept.set(k, v) };
  const h = harness({ storage });
  t.after(h.log.restore);
  assert.equal(h.$("projectsGrid").hidden, true);
  h.$("projectSearchBox").hidden = true;
  h.$("projectSearchBtn").fire("click");
  assert.equal(h.$("projectSearchBox").hidden, false);
  assert.equal(h.$("projectsGrid").hidden, false);
  assert.match(h.$("projectFoldBtn").innerHTML, /<span>Collapse<\/span>$/);
  assert.equal(kept.get(FOLD_KEY), "0");
});
