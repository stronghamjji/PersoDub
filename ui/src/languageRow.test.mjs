// One video's languages are one project, and the row at the foot of the left
// panel switches between them and adds another (mockup script-buttons,
// 2026-10-01). Run with: node --test ui/src/languageRow.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { projectKey, groupProjects, projectLanguages, deleteLine, choicesOf, initLanguageRow } from "./languageRow.mjs";

const langName = (code) => (code ? ({ ko: "Korean", en: "English" })[code] || code.toUpperCase() : null);

// Newest first, as GET /api/dub/jobs lists them. "en0" is an English dubbing
// that failed and was started over as "en2"; "solo" was saved before
// project_id existed.
const JOBS = () => [
  { id: "en2", kind: "dub", status: "running", language: "English", language_code: "en", project_id: "ko1", created: "4" },
  { id: "solo", kind: "dub", status: "done", language_code: "ja", created: "3" },
  { id: "en0", kind: "dub", status: "error", language: "English", language_code: "en", project_id: "ko1", created: "2" },
  { id: "ko1", kind: "dub", status: "done", language: "Korean", language_code: "ko", created: "1" },
];

test("a job's project is its first dubbing; one without the field is its own", () => {
  assert.equal(projectKey({ id: "en2", project_id: "ko1" }), "ko1");
  assert.equal(projectKey({ id: "solo" }), "solo");
  assert.deepEqual(groupProjects(JOBS()).map((m) => m.map((j) => j.id)), [["en2", "en0", "ko1"], ["solo"]]);
});

test("a project's languages come in the order they were added, each its newest dubbing", () => {
  const [family] = groupProjects(JOBS());
  assert.deepEqual(projectLanguages(family).map((j) => j.id), ["ko1", "en2"]);
});

test("the delete line counts languages, and says nothing more for one", () => {
  assert.equal(deleteLine(2), "All 2 languages are deleted. This can’t be undone.");
  assert.equal(deleteLine(1), "This can’t be undone.");
});

test("Add language starts on the open dubbing's own choices", () => {
  assert.deepEqual(choicesOf({ dub_mode: "local", source_lang: "ko", num_speakers: 2, separation: "demucs",
                               stt_engine: "whisper", translator: "chatgpt", quality: 4, tts: "qwen3" }),
                   { dubMode: "local", source: "ko", speakers: "2", sep: "local", stt: "local",
                     translator: "chatgpt", quality: "high", voice: "qwen3" });
  // Separated with the RoFormer: Add language starts on the RoFormer too.
  assert.equal(choicesOf({ dub_mode: "local", separation: "roformer" }).sep, "roformer");
  // A Perso dubbing records its mode alone; the rest stays on the saved defaults.
  assert.deepEqual(choicesOf({ dub_mode: "perso" }), { dubMode: "perso", source: "", speakers: "" });
  // ...and, since it was kept, the Perso voice model it was made with.
  assert.deepEqual(choicesOf({ dub_mode: "perso", perso_model: "WREN" }),
                   { dubMode: "perso", source: "", speakers: "", persoModel: "WREN" });
});

function harness(open, { again, lines = {} } = {}) {
  const row = { hidden: true, innerHTML: "", listeners: [],
                addEventListener(ev, fn) { this.listeners.push(fn); } };
  const log = { opened: [], drafts: [], sent: [] };
  const real = { fetch: globalThis.fetch, setTimeout: globalThis.setTimeout };
  globalThis.fetch = async (url, init) => { log.sent.push(`${init.method} ${url}`); return again; };
  globalThis.setTimeout = () => 0;
  const state = { job: open };
  const api = initLanguageRow({
    $: (id) => ({ langRow: row })[id], getJob: () => state.job, langName,
    onOpenJob: (id) => log.opened.push(id),
    openDraft: async (source, opts, project) => { log.drafts.push({ source, opts, project }); },
    nameOf: (job) => job.title || job.project || "Dubbing",
    linesOf: (id) => lines[id] || null,
  });
  const click = (btn) => Promise.all(row.listeners.map((fn) => fn({ target: { closest: () => btn } })));
  return { row, api, log, state, click, restore: () => Object.assign(globalThis, real) };
}

test("the row shows one chip per language, the open one lit, then + Add language", (t) => {
  const h = harness(JOBS()[3]);
  t.after(h.restore);
  h.api.setJobs(JOBS());
  assert.equal(h.row.hidden, false);
  const chips = [...h.row.innerHTML.matchAll(/<button class="lang-chip( on)?" type="button" data-job="(\w+)"[^>]*>([^<]+)</g)]
    .map((m) => [m[3], m[2], !!m[1]]);
  assert.deepEqual(chips, [["Korean", "ko1", true], ["English", "en2", false]]);
  assert.match(h.row.innerHTML, /<button class="lang-chip lang-add" id="langAddBtn" type="button">\+ Add language<\/button>$/);
  assert.match(h.row.innerHTML, /^<span class="lang-k">Languages<\/span>/);
});

test("a chip opens that language's dubbing; the lit one does nothing", async (t) => {
  const h = harness(JOBS()[3]);
  t.after(h.restore);
  h.api.setJobs(JOBS());
  await h.click({ id: "", dataset: { job: "en2" }, classList: { contains: () => false } });
  await h.click({ id: "", dataset: { job: "ko1" }, classList: { contains: (c) => c === "on" } });
  assert.deepEqual(h.log.opened, ["en2"]);
});

test("an old dubbing with no project shows its one chip", (t) => {
  const h = harness(JOBS()[1]);
  t.after(h.restore);
  h.api.setJobs(JOBS());
  assert.equal((h.row.innerHTML.match(/data-job=/g) || []).length, 1);
  assert.match(h.row.innerHTML, /data-job="solo"[^>]*>JA</);
});

test("a dubbing just started is in its row before the list has it", (t) => {
  const fresh = { id: "fr3", kind: "dub", status: "running", language: "French", language_code: "fr",
                  project_id: "ko1", created: "5" };
  const h = harness(fresh);
  t.after(h.restore);
  h.api.setJobs(JOBS());
  assert.match(h.row.innerHTML, />Korean<[^]*>English<[^]*class="lang-chip on"[^>]*>French</);
});

test("no row without a dubbing open, or for an erase", (t) => {
  const h = harness(null);
  t.after(h.restore);
  h.api.setJobs(JOBS());
  assert.equal(h.row.hidden, true);
  h.state.job = { id: "x", kind: "erase" };
  h.api.paint();
  assert.equal(h.row.hidden, true);
});

test("+ Add language opens the same video and kept parts, set up as the open dubbing, in its project", async (t) => {
  const open = { ...JOBS()[0], title: "My cats", dub_mode: "perso", source_lang: "ko" };
  const h = harness(open, { again: { ok: true, json: async () => ({ download_id: "ab12cd34", title: "Cats",
                                                                    duration_sec: 52.6, ranges: [[0, 20]] }) } });
  t.after(h.restore);
  h.api.setJobs(JOBS());
  await h.click({ id: "langAddBtn", dataset: {}, classList: { contains: () => false } });
  assert.deepEqual(h.log.sent, ["POST /api/dub/jobs/en2/again"]);
  assert.deepEqual(h.log.drafts, [{
    source: { downloadId: "ab12cd34", name: "My cats", duration: 52.6, speech: null },
    opts: { tab: "dubbing", ranges: [[0, 20]], choices: { dubMode: "perso", source: "ko", speakers: "" } },
    project: "ko1",
  }]);
});

// Perso charges a dubbing by the seconds spoken (owner, 2026-10-22): the open
// dubbing's lines say where, on its own clock, which runs through the parts
// it kept one after another.
test("+ Add language says where the video is spoken: the open dubbing's lines, moved onto the video held again", async (t) => {
  const open = { ...JOBS()[0], title: "My cats" };
  const h = harness(open, {
    again: { ok: true, json: async () => ({ download_id: "ab12cd34", title: "Cats", duration_sec: 52.6,
                                            ranges: [[10, 20], [30, 40]] }) },
    lines: { en2: [{ line: 1, start: 2, end: 5 }, { line: 2, start: 8, end: 13 }] },
  });
  t.after(h.restore);
  h.api.setJobs(JOBS());
  await h.click({ id: "langAddBtn", dataset: {}, classList: { contains: () => false } });
  assert.deepEqual(h.log.drafts[0].source.speech, [[12, 15], [18, 20], [30, 33]]);
});

test("+ Add language on a video that is gone says it could not open, with the reason as its tip", async (t) => {
  const h = harness(JOBS()[3], { again: { ok: false, status: 409,
                                          json: async () => ({ detail: "This dubbing's video is no longer on disk." }) } });
  t.after(h.restore);
  h.api.setJobs(JOBS());
  const btn = { id: "langAddBtn", dataset: {}, textContent: "+ Add language", title: "",
                classList: { contains: () => false } };
  await h.click(btn);
  assert.equal(h.log.drafts.length, 0);
  assert.equal(btn.textContent, "Could not open");
  assert.equal(btn.title, "This dubbing's video is no longer on disk.");
});
