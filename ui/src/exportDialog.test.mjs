// The Export dialog: which rows each kind of project gets, the ticks it
// remembers, what Export does with the ticked rows, and the MP3 / WAV choice.
//
// Run with: node --test ui/src/exportDialog.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initExportDialog, exportRows, rowsHtml, audioFormat, ticksFor, whereLine, AUDIO_KEY, TICKS_KEY } from "./exportDialog.mjs";
import { loadTable, setLanguage, t as say } from "./i18n.mjs";

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

const DUB = { kind: "dub", jobId: "J1", target: "ko", mark: "&v=2", hasSrt: true, fromLink: true,
              videoHref: "/api/dub/result/J1?v=2",
              subtitled: { href: "/api/dub/result/J1/subtitled?preset=clean&download=1", name: "dub_ko-sub-clean.mp4" },
              where: "Saved in Downloads / 2026-09-30 / clip" };
const STEMS = { ...DUB, project: "clip", stems: { voice: true, background: true } };

test("MP3 is the format unless WAV was remembered", () => {
  assert.equal(audioFormat(null), "mp3");
  assert.equal(audioFormat("wav"), "wav");
  assert.equal(audioFormat("flac"), "mp3");
});

test("a draft and an erased video hand back a video and its sound", () => {
  for (const kind of ["draft", "erase"]) {
    const rows = exportRows({ kind }, "mp3");
    assert.deepEqual(rows.map((r) => [r.id, r.label]), [["video", "Video"], ["audio", "Audio only"]]);
    assert.ok(rows.every((r) => !r.href), "the app writes these itself");
  }
});

test("a finished dubbing's rows, in the owner's order, with its sound named Dubbed audio", () => {
  const rows = exportRows(STEMS, "wav");
  // The videos, the subtitles, then the sounds (owner, 2026-10-22).
  assert.deepEqual(rows.map((r) => r.label),
    ["Dubbed video", "Dubbed video with subtitles", "Original video", "Subtitles (.srt)",
     "Dubbed audio", "Original voice", "Background"]);
  assert.deepEqual(rows.map((r) => r.name),
    ["dub_ko.mp4", "dub_ko-sub-clean.mp4", "org.mp4", "dub_ko.srt",
     "dub_ko.wav", "clip_voice.wav", "clip_background.wav"]);
  const href = (list, id) => list.find((r) => r.id === id).href;
  assert.equal(href(rows, "video"), "/api/dub/result/J1?v=2");
  // The remake mark rides on the audio too, so it is never the old sound.
  assert.equal(href(rows, "audio"), "/api/dub/result/J1/audio?format=wav&download=1&v=2");
  assert.equal(href(exportRows(DUB, "mp3"), "audio"), "/api/dub/result/J1/audio?format=mp3&download=1&v=2");
  assert.equal(href(rows, "voice"), "/api/dub/result/J1/stem/voice?format=wav");
  assert.equal(href(rows, "background"), "/api/dub/result/J1/stem/background?format=wav");
  // No subtitles and a local file: the video and its sound are all there is.
  const bare = exportRows({ ...DUB, hasSrt: false, fromLink: false }, "mp3");
  assert.deepEqual(bare.map((r) => r.id), ["video", "audio"]);
});

test("the subtitled video is there whenever the project has subtitles", () => {
  assert.equal(exportRows(DUB, "mp3")[1].id, "subtitled");
  assert.ok(!exportRows({ ...DUB, hasSrt: false }, "mp3").some((r) => r.id === "subtitled"));
});

test("the original's voice and background are rows only when the job has them", () => {
  const one = exportRows({ ...STEMS, stems: { voice: false, background: true } }, "mp3");
  assert.deepEqual(one.map((r) => r.id), ["video", "subtitled", "original", "srt", "audio", "background"]);
  // A dubbing made wholly on Perso has neither.
  assert.deepEqual(exportRows({ ...DUB, stems: {} }, "mp3").map((r) => r.id),
                   ["video", "subtitled", "original", "srt", "audio"]);
  assert.deepEqual(exportRows(DUB, "mp3").map((r) => r.id), ["video", "subtitled", "original", "srt", "audio"]);
});

// As one list of seven the subtitles file was the sixth row, and people did
// not find it (feedback sheet, 2026-10-21; owner 4-2 가, 2026-10-22). A
// dubbing's rows stand under Video, Subtitles and Audio; the rows themselves
// are the rows they were.
test("a dubbing's rows stand under Video, Subtitles & script and Audio; the other kinds have no headings", () => {
  const rows = exportRows(STEMS, "mp3");
  assert.deepEqual(rows.map((r) => [r.id, r.group]), [
    ["video", "video"], ["subtitled", "video"], ["original", "video"], ["srt", "subtitles"],
    ["audio", "audio"], ["voice", "audio"], ["background", "audio"]]);
  const html = rowsHtml(rows, "mp3", ["video"]);
  // Each heading once, right before the first row under it.
  assert.deepEqual([...html.matchAll(/<div class="export-group">([^<]*)<\/div><a [^>]*data-row="(\w+)"/g)].map((m) => [m[1], m[2]]),
    [["Video", "video"], ["Subtitles &amp; script", "srt"], ["Audio", "audio"]]);
  assert.equal(html.match(/export-group/g).length, 3);
  assert.equal(html.match(/<a href="#" role="checkbox"/g).length, 7, "seven rows, as before");
  // A heading with no row under it is not drawn: no subtitles, no Subtitles.
  const noSrt = rowsHtml(exportRows({ ...STEMS, hasSrt: false }, "mp3"), "mp3");
  assert.deepEqual([...noSrt.matchAll(/class="export-group">([^<]*)</g)].map((m) => m[1]), ["Video", "Audio"]);
  // A draft and an erased video are two rows each, and plain.
  for (const ctx of [{ kind: "draft" }, { kind: "erase" }]) {
    assert.doesNotMatch(rowsHtml(exportRows(ctx, "mp3"), "mp3"), /export-group/, ctx.kind);
  }
});

// The page's Korean table, for the tests that read the dialog in Korean.
async function inKorean(t) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true,
    json: async () => JSON.parse(readFileSync(new URL("../../static/i18n/ui.ko.json", import.meta.url), "utf8")) });
  await loadTable("ko");
  globalThis.fetch = real;
  setLanguage("ko");
  t.after(() => setLanguage("en"));
}

test("in Korean the three headings read 영상, 자막·대본 and 오디오", async (t) => {
  await inKorean(t);
  const html = rowsHtml(exportRows(STEMS, "mp3"), "mp3");
  assert.deepEqual([...html.matchAll(/class="export-group">([^<]*)</g)].map((m) => m[1]), ["영상", "자막·대본", "오디오"]);
});

// The script as the spreadsheet Perso's web app downloads (owner,
// 2026-10-22): a row under the subtitles file, in Perso's name for the file
// without the timestamp Perso adds.
const SCRIPTED = { ...STEMS, hasScript: true, title: "안녕히계세요 여러분", source: "ko", target: "es-MX" };
const SCRIPT_NAME = "안녕히계세요 여러분_KOtoES-MX_OriginalTranslatedScript.xlsx";

test("the script is a row under Subtitles & script whenever the job has one, in Perso's name for the file", () => {
  const rows = exportRows(SCRIPTED, "mp3");
  assert.deepEqual(rows.map((r) => [r.id, r.group]), [
    ["video", "video"], ["subtitled", "video"], ["original", "video"], ["srt", "subtitles"], ["script", "subtitles"],
    ["audio", "audio"], ["voice", "audio"], ["background", "audio"]]);
  assert.deepEqual(rows.find((r) => r.id === "script"), {
    id: "script", group: "subtitles", icon: "subs", label: "Script (original + translation, .xlsx)",
    href: "/api/dub/jobs/J1/script.xlsx", name: SCRIPT_NAME });
  // A dubbing made on Perso has its script and no subtitles file: the heading
  // stands over the script alone.
  const perso = exportRows({ ...SCRIPTED, hasSrt: false }, "mp3");
  assert.deepEqual(perso.map((r) => r.id), ["video", "original", "script", "audio", "voice", "background"]);
  assert.deepEqual([...rowsHtml(perso, "mp3").matchAll(/class="export-group">([^<]*)<\/div><a [^>]*data-row="(\w+)"/g)]
    .map((m) => [m[1], m[2]]), [["Video", "video"], ["Subtitles &amp; script", "script"], ["Audio", "audio"]]);
  // No script, no row. A source left on auto-detect that never learned its
  // language is named so, as the route names it.
  assert.ok(!exportRows({ ...SCRIPTED, hasScript: false }, "mp3").some((r) => r.id === "script"));
  assert.equal(exportRows({ ...SCRIPTED, source: null }, "mp3").find((r) => r.id === "script").name,
               "안녕히계세요 여러분_AUTOtoES-MX_OriginalTranslatedScript.xlsx");
});

test("in Korean the script row reads 대본 (원문·번역, .xlsx) under 자막·대본", async (t) => {
  await inKorean(t);
  const html = rowsHtml(exportRows(SCRIPTED, "mp3"), "mp3");
  assert.match(html, /<div class="export-group">자막·대본<\/div><a [^>]*data-row="srt"/);
  assert.match(html, /data-row="script" data-name="안녕히계세요 여러분_KOtoES-MX_OriginalTranslatedScript\.xlsx">[^]*?<\/svg>대본 \(원문·번역, \.xlsx\)<span class="export-state"><\/span><\/a>/);
});

// Under the title 다운로드, "다운로드 / 2026-10-22 / paris_steps에 저장해요"
// read as the title said twice (owner, 2026-10-22): the line names the
// Downloads folder as a folder, before a save and after it, in every kind.
test("the line under the rows names the Downloads folder as a folder, not as the title again", async (t) => {
  const where = { day: "2026-10-22", project: "paris_steps" };
  assert.equal(say("Saved in Downloads / {day} / {project}", where), "Saved in Downloads / 2026-10-22 / paris_steps");
  await inKorean(t);
  // Before a save: what app.mjs's whereDownloadsGo says, and the other kinds' line.
  assert.equal(say("Saved in Downloads / {day} / {project}", where), "다운로드 폴더의 2026-10-22 / paris_steps에 저장해요");
  assert.equal(say("Saved in Downloads"), "다운로드 폴더에 저장해요");
  // After a save, a draft's two files and an erased video's one.
  const dir = "/Users/me/Downloads/2026-10-22/clip/";
  const draft = harness({ ctx: { kind: "draft", save: async (what) => `${dir}clip.${what.audio || "mp4"}` } });
  await draft.api.open();
  draft.tick("audio");
  draft.go();
  await settle();
  assert.equal(draft.$("exportWhere").textContent, "파일 2개를 다운로드 폴더의 2026-10-22 / clip에 저장했어요");
  const erase = harness({ ctx: { kind: "erase", save: async () => `${dir}clip.mp4` } });
  await erase.api.open();
  erase.go();
  await settle();
  assert.equal(erase.$("exportWhere").textContent, "clip.mp4 파일을 다운로드 폴더의 2026-10-22 / clip에 저장했어요");
});

test("a row is a checkbox, its icon, its name and the place its saved check goes; sound rows carry the switch", () => {
  const html = rowsHtml(exportRows(STEMS, "mp3"), "mp3", ["video"], ["video"]);
  assert.match(html, /<a href="#" role="checkbox" aria-checked="true" data-row="video" data-name="dub_ko\.mp4" class="saved"><span class="export-check"><svg[^]*?<\/svg><\/span><svg class="icon"[^]*?<\/svg>Dubbed video<span class="export-state"><svg class="icon icon-sm"/);
  assert.match(html, /<a href="#" role="checkbox" aria-checked="false" data-row="audio" data-name="dub_ko\.mp3">/);
  assert.match(html, /Dubbed audio<span class="export-seg" role="radiogroup" aria-label="Audio format"><span role="radio" tabindex="0" data-fmt="mp3" aria-checked="true" class="on">MP3<\/span><span role="radio" tabindex="0" data-fmt="wav" aria-checked="false">WAV<\/span><\/span><span class="export-state"><\/span>/);
  assert.equal(html.match(/export-seg"/g).length, 3, "the dubbed audio, the voice and the background");
  // The "?" says what the two separated sounds are; the other rows have none.
  assert.match(html, /Original voice<span class="export-help" data-tip="Only the speech\." tabindex="0" role="img" aria-label="Only the speech\.">\?<\/span><span class="export-seg"/);
  assert.match(html, /Background<span class="export-help" data-tip="Everything except speech: music, effects, noise\."/);
  assert.equal(html.match(/export-help"/g).length, 2);
  assert.doesNotMatch(html, /download=/, "no row is a link to follow");
  const draft = rowsHtml(exportRows({ kind: "draft" }, "wav"), "wav", ["audio"]);
  assert.match(draft, /aria-checked="false" data-row="video">/);
  assert.match(draft, /aria-checked="true" data-row="audio">/);
  assert.match(draft, /data-fmt="wav" aria-checked="true" class="on">WAV/);
  assert.equal(draft.match(/export-seg"/g).length, 1);
});

test("a dubbing's video rows carry the picked ratio; the sound, the subtitles and the original do not", () => {
  const rows = Object.fromEntries(exportRows({ ...STEMS, ratio: "9:16" }, "mp3").map((r) => [r.id, r.href]));
  assert.equal(rows.video, "/api/dub/result/J1?v=2&ratio=9%3A16");
  assert.equal(rows.subtitled, "/api/dub/result/J1/subtitled?preset=clean&download=1&ratio=9%3A16");
  assert.equal(rows.audio, "/api/dub/result/J1/audio?format=mp3&download=1&v=2");
  assert.equal(rows.voice, "/api/dub/result/J1/stem/voice?format=mp3");
  assert.equal(rows.background, "/api/dub/result/J1/stem/background?format=mp3");
  assert.equal(rows.srt, "/api/dub/result/J1/srt?download=1");
  assert.equal(rows.original, "/api/dub/result/J1/original?download=1");
  // Original, or nothing picked: the links are what they were.
  for (const ratio of ["original", undefined]) {
    assert.deepEqual(exportRows({ ...DUB, ratio }, "mp3").map((r) => r.href),
                     exportRows(DUB, "mp3").map((r) => r.href));
  }
});

test("the first row is ticked until the user says otherwise, for each kind on its own", () => {
  const ids = ["video", "subtitled", "audio"];
  assert.deepEqual(ticksFor(null, "dub", ids), ["video"]);
  assert.deepEqual(ticksFor("not json", "dub", ids), ["video"]);
  assert.deepEqual(ticksFor('{"draft":["audio"]}', "dub", ids), ["video"], "another kind's ticks are not this one's");
  assert.deepEqual(ticksFor('{"dub":["audio","video"]}', "dub", ids), ["video", "audio"]);
  assert.deepEqual(ticksFor('{"dub":[]}', "dub", ids), [], "nothing ticked stays nothing ticked");
  // What was ticked is not here any more (a job without its stems): the first row.
  assert.deepEqual(ticksFor('{"dub":["voice"]}', "dub", ids), ["video"]);
  assert.deepEqual(ticksFor('{"dub":["voice","audio"]}', "dub", ids), ["audio"]);
});

// ---- the dialog on a fake page ---------------------------------------------

function harness({ ctx, stored = {}, shell = null, fetchFn = null } = {}) {
  const els = {};
  const $ = (id) => (els[id] ||= {
    id, textContent: "", listeners: {}, html: "", disabled: false,
    classList: { list: new Set(), add(c) { this.list.add(c); }, remove(c) { this.list.delete(c); },
                 contains(c) { return this.list.has(c); } },
    addEventListener(ev, fn) { this.listeners[ev] = fn; },
    set innerHTML(v) { this.html = v; },
    get innerHTML() { return this.html; },
  });
  const store = new Map(Object.entries(stored));
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const asked = [];      // what was fetched first
  const followed = [];   // what was handed to the browser
  const api = initExportDialog({
    $, getContext: async () => ctx, storage, shell,
    fetchFn: fetchFn || (async (href) => { asked.push(href); return { ok: true }; }),
    follow: (href, name) => followed.push([href, name]),
  });
  const list = $("exportList");
  const tag = (id) => new RegExp(`<a [^>]*data-row="${id}"[^>]*>`).exec(list.html)[0];
  const ticked = () => [...list.html.matchAll(/aria-checked="true" data-row="([^"]+)"/g)].map((m) => m[1]);
  const saved = () => [...list.html.matchAll(/<a [^>]*data-row="([^"]+)"[^>]* class="saved">/g)].map((m) => m[1]);
  const click = (target) => {
    const e = { target, prevented: false, preventDefault() { this.prevented = true; } };
    list.listeners.click(e);
    return e;
  };
  const tick = (id) => click({ closest: (sel) => (sel === "a" ? { dataset: { row: id } } : null) });
  const pick = (fmt) => click({ closest: (sel) => (sel === "[data-fmt]" ? { dataset: { fmt } } : null) });
  const go = () => $("exportGoBtn").listeners.click();
  return { $, api, list, tag, ticked, saved, tick, pick, go, click, store, asked, followed };
}

test("the dialog draws a dubbing's headings, and a press on one ticks nothing", async () => {
  const h = harness({ ctx: STEMS });
  await h.api.open();
  assert.equal(h.list.html.match(/class="export-group"/g).length, 3);
  const e = h.click({ closest: () => null });
  assert.equal(e.prevented, false);
  assert.deepEqual(h.ticked(), ["video"]);
});

test("with nothing to export the dialog stays shut", async () => {
  const h = harness({ ctx: null });
  await h.api.open();
  assert.equal(h.$("exportOverlay").classList.contains("open"), false);
});

test("the dialog opens with the first row ticked; ticks are toggled, remembered per kind, and Export needs one", async () => {
  const h = harness({ ctx: STEMS });
  await h.api.open();
  assert.deepEqual(h.ticked(), ["video"]);
  assert.equal(h.$("exportGoBtn").disabled, false);
  const e = h.tick("voice");
  assert.equal(e.prevented, true, "a row is ticked, not followed");
  h.tick("background");
  assert.deepEqual(h.ticked(), ["video", "voice", "background"]);
  h.tick("video");
  assert.deepEqual(JSON.parse(h.store.get(TICKS_KEY)), { dub: ["voice", "background"] });
  h.tick("voice");
  h.tick("background");
  assert.deepEqual(h.ticked(), []);
  assert.equal(h.$("exportGoBtn").disabled, true, "nothing ticked, nothing to export");
  h.go();
  await settle();
  assert.deepEqual(h.followed, []);
  // A draft's ticks are its own, and a dubbing's are still there next time.
  const draft = harness({ ctx: { kind: "draft" }, stored: { [TICKS_KEY]: '{"dub":["voice"]}' } });
  await draft.api.open();
  assert.deepEqual(draft.ticked(), ["video"]);
  draft.tick("audio");
  assert.deepEqual(JSON.parse(draft.store.get(TICKS_KEY)), { dub: ["voice"], draft: ["video", "audio"] });
  const again = harness({ ctx: STEMS, stored: { [TICKS_KEY]: draft.store.get(TICKS_KEY) } });
  await again.api.open();
  assert.deepEqual(again.ticked(), ["voice"]);
});

// Save video opens the dialog by itself once the link's video is in
// (2026-10-21): on Video, whatever a draft was last exported as.
test("an opening that names its rows ticks those, and what was remembered stays for next time", async () => {
  const h = harness({ ctx: { kind: "draft" }, stored: { [TICKS_KEY]: '{"draft":["audio"]}' } });
  await h.api.open(["video"]);
  assert.deepEqual(h.ticked(), ["video"]);
  assert.equal(h.store.get(TICKS_KEY), '{"draft":["audio"]}', "nothing is remembered for it");
  await h.api.open();
  assert.deepEqual(h.ticked(), ["audio"]);
});

// The Save video tab (owner, 2026-10-23): the project's own video and nothing
// else -- a draft's video, a project's original whatever it came from.
test("an opening for some rows offers those alone, the original included for any project", async () => {
  const fromFile = { ...DUB, fromLink: false };
  const only = ["original"];
  assert.deepEqual(exportRows({ ...fromFile, only }, "mp3").map((r) => [r.id, r.href]),
    [["original", "/api/dub/result/J1/original"]], "a file's original, served without the link-only download flag");
  assert.deepEqual(exportRows({ ...DUB, only }, "mp3").map((r) => [r.id, r.href]),
    [["original", "/api/dub/result/J1/original?download=1"]]);
  assert.deepEqual(exportRows({ kind: "captions", jobId: "C1", subtitled: { href: "/s", name: "s.mp4" }, only }, "mp3")
    .map((r) => [r.id, r.href]), [["original", "/api/dub/result/C1/original"]]);
  assert.deepEqual(exportRows({ kind: "draft", only: ["video"] }, "mp3").map((r) => r.id), ["video"]);
  assert.ok(!exportRows(fromFile, "mp3").some((r) => r.id === "original"), "the whole dialog still leaves a file's original out");
  const h = harness({ ctx: fromFile, stored: { [TICKS_KEY]: '{"dub":["srt"]}' } });
  await h.api.open(only, only);
  assert.deepEqual(h.ticked(), ["original"]);
  h.tick("original");
  assert.equal(h.store.get(TICKS_KEY), '{"dub":["srt"]}', "nothing is remembered for the whole dialog");
});

test("Export saves a draft's ticked rows in turn and says where they went", async () => {
  const asked = [];
  let release = null;
  const ctx = { kind: "draft", ratio: "9:16", where: "Saved in Downloads",
    save: (what) => new Promise((resolve) => {
      asked.push(what);
      release = () => resolve(`/Users/me/Downloads/2026-09-30/clip/clip.${what.audio || "mp4"}`);
    }) };
  const h = harness({ ctx });
  await h.api.open();
  assert.equal(h.$("exportWhere").textContent, "Saved in Downloads");
  h.tick("audio");
  h.go();
  await settle();
  // The video goes out in the project's ratio; the sound has no picture.
  assert.deepEqual(asked, [{ ratio: "9:16" }]);
  assert.equal(h.$("exportWhere").textContent, "Downloading 1 of 2…");
  assert.equal(h.$("exportGoBtn").disabled, true);
  assert.equal(h.$("exportCloseBtn").disabled, true);
  // A second press, a tick or a way out while it works changes nothing.
  h.go();
  h.tick("video");
  h.$("exportCloseBtn").listeners.click();
  h.$("exportOverlay").listeners.click({ target: h.$("exportOverlay") });
  assert.equal(h.$("exportOverlay").classList.contains("open"), true);
  release();
  await settle();
  assert.deepEqual(asked, [{ ratio: "9:16" }, { audio: "mp3" }]);
  assert.equal(h.$("exportWhere").textContent, "Downloading 2 of 2…");
  assert.deepEqual(h.saved(), ["video"]);
  release();
  await settle();
  assert.equal(h.$("exportWhere").textContent, "Saved 2 files to Downloads / 2026-09-30 / clip");
  assert.deepEqual(h.saved(), ["video", "audio"]);
  assert.deepEqual(h.ticked(), ["video", "audio"]);
  assert.equal(h.$("exportGoBtn").disabled, false);
  assert.equal(h.$("exportCloseBtn").disabled, false);
});

test("one file is named on the line; an erased video saves the same way, Windows path and all", async () => {
  const ctx = { kind: "erase", where: "Saved in Downloads",
                save: async () => "C:\\Users\\me\\Downloads\\2026-09-30\\clip\\clip.mp4" };
  const h = harness({ ctx });
  await h.api.open();
  h.go();
  await settle();
  assert.equal(h.$("exportWhere").textContent, "Saved clip.mp4 to Downloads / 2026-09-30 / clip");
});

test("the format picked is the one saved, is remembered, and picking saves nothing", async () => {
  const asked = [];
  const ctx = { kind: "erase", save: async (what) => { asked.push(what); return "/d/clip.wav"; } };
  const h = harness({ ctx, stored: { [TICKS_KEY]: '{"erase":["audio"]}' } });
  await h.api.open();
  h.go();
  await settle();
  assert.deepEqual(asked, [{ audio: "mp3" }], "MP3 until another is picked");
  assert.deepEqual(h.saved(), ["audio"]);
  const e = h.pick("wav");
  assert.equal(e.prevented, true);
  assert.equal(asked.length, 1);
  assert.deepEqual(h.ticked(), ["audio"], "picking a format is not a tick");
  assert.deepEqual(h.saved(), [], "the WAV has not been saved yet");
  assert.match(h.list.innerHTML, /data-fmt="wav" aria-checked="true" class="on"/);
  assert.equal(h.store.get(AUDIO_KEY), "wav");
  h.go();
  await settle();
  assert.deepEqual(asked[1], { audio: "wav" });
  // The next time the app opens, WAV is still the choice.
  const again = harness({ ctx, stored: { [AUDIO_KEY]: "wav" } });
  await again.api.open();
  assert.match(again.list.innerHTML, /data-fmt="wav" aria-checked="true" class="on"/);
});

test("a save that fails says why, keeps what was saved and stops there", async () => {
  const ctx = { kind: "draft", save: async (what) => {
    if (what.audio) throw new Error("This video has no sound.");
    return "/d/clip.mp4";
  } };
  const h = harness({ ctx });
  await h.api.open();
  h.tick("audio");
  h.go();
  await settle();
  assert.equal(h.$("exportWhere").textContent, "This video has no sound.");
  assert.deepEqual(h.saved(), ["video"]);
  assert.equal(h.$("exportGoBtn").disabled, false, "it can be tried again");
});

test("a dubbing's ticked rows are made, then downloaded one after another as the shell reports each", async () => {
  let report = null;
  const shell = { onDownloadDone: (fn) => { report = fn; } };
  const h = harness({ ctx: STEMS, shell });
  await h.api.open();
  assert.equal(h.$("exportWhere").textContent, "Saved in Downloads / 2026-09-30 / clip");
  h.tick("voice");
  h.tick("background");
  h.pick("wav");
  h.go();
  await settle();
  assert.deepEqual(h.asked, ["/api/dub/result/J1?v=2"], "asked for first, so it is there to download");
  assert.deepEqual(h.followed, [["/api/dub/result/J1?v=2", "dub_ko.mp4"]]);
  assert.equal(h.$("exportWhere").textContent, "Downloading 1 of 3…");
  const dir = "/Users/me/Downloads/2026-09-30/clip/";
  report({ state: "completed", filename: "dub_ko_002.mp4", path: dir + "dub_ko_002.mp4" });
  await settle();
  assert.deepEqual(h.saved(), ["video"]);
  assert.deepEqual(h.followed[1], ["/api/dub/result/J1/stem/voice?format=wav", "clip_voice.wav"]);
  report({ state: "completed", filename: "clip_voice.wav", path: dir + "clip_voice.wav" });
  await settle();
  assert.deepEqual(h.followed[2], ["/api/dub/result/J1/stem/background?format=wav", "clip_background.wav"]);
  assert.equal(h.$("exportWhere").textContent, "Downloading 3 of 3…");
  report({ state: "completed", filename: "clip_background.wav", path: dir + "clip_background.wav" });
  await settle();
  assert.deepEqual(h.saved(), ["video", "voice", "background"]);
  assert.equal(h.$("exportWhere").textContent, "Saved 3 files to Downloads / 2026-09-30 / clip");
});

// The script goes the way the subtitles file goes: asked for, then handed
// to the shell, which saves it into the project's dated folder under the
// name the route sends; the line under the rows names it or counts it.
test("the script downloads as the subtitles file does, and the line names it or counts it with the rest", async (t) => {
  const dir = "/Users/me/Downloads/2026-10-22/clip/";
  let report = null;
  const alone = harness({ ctx: SCRIPTED, stored: { [TICKS_KEY]: '{"dub":["script"]}' },
                          shell: { onDownloadDone: (fn) => { report = fn; } } });
  await alone.api.open();
  assert.deepEqual(alone.ticked(), ["script"]);
  alone.go();
  await settle();
  assert.deepEqual(alone.asked, ["/api/dub/jobs/J1/script.xlsx"], "asked for first, so a refusal is read as words");
  assert.deepEqual(alone.followed, [["/api/dub/jobs/J1/script.xlsx", SCRIPT_NAME]]);
  report({ state: "completed", filename: SCRIPT_NAME, path: dir + SCRIPT_NAME });
  await settle();
  assert.deepEqual(alone.saved(), ["script"]);
  assert.equal(alone.$("exportWhere").textContent, `Saved ${SCRIPT_NAME} to Downloads / 2026-10-22 / clip`);

  await inKorean(t);
  const both = harness({ ctx: SCRIPTED, stored: { [TICKS_KEY]: '{"dub":["srt","script"]}' },
                         shell: { onDownloadDone: (fn) => { report = fn; } } });
  await both.api.open();
  both.go();
  await settle();
  report({ state: "completed", filename: "dub_es-MX.srt", path: dir + "dub_es-MX.srt" });
  await settle();
  report({ state: "completed", filename: SCRIPT_NAME, path: dir + SCRIPT_NAME });
  await settle();
  assert.deepEqual(both.followed.map((f) => f[0]), ["/api/dub/result/J1/srt?download=1", "/api/dub/jobs/J1/script.xlsx"]);
  assert.deepEqual(both.saved(), ["srt", "script"]);
  assert.equal(both.$("exportWhere").textContent, "파일 2개를 다운로드 폴더의 2026-10-22 / clip에 저장했어요");
});

test("a download the shell could not finish, or a file the app would not make, is said and the rest wait", async () => {
  let report = null;
  const h = harness({ ctx: STEMS, shell: { onDownloadDone: (fn) => { report = fn; } } });
  await h.api.open();
  h.tick("audio");
  h.go();
  await settle();
  report({ state: "interrupted" });
  await settle();
  assert.equal(h.$("exportWhere").textContent, "Download failed - try again");
  assert.deepEqual(h.saved(), []);
  assert.equal(h.followed.length, 1, "the dubbed audio was not started");

  const refused = harness({ ctx: STEMS, stored: { [TICKS_KEY]: '{"dub":["voice"]}' },
    fetchFn: async () => ({ ok: false, json: async () => ({ detail: "This project no longer has that audio." }) }) });
  await refused.api.open();
  refused.go();
  await settle();
  assert.equal(refused.$("exportWhere").textContent, "This project no longer has that audio.");
  assert.deepEqual(refused.followed, []);
});

test("in a plain browser the files are handed over in turn and the line keeps saying where they go", async () => {
  const h = harness({ ctx: { ...STEMS, where: "Saves to the Downloads folder" } });
  await h.api.open();
  h.tick("background");
  h.go();
  await settle();
  assert.deepEqual(h.followed.map((f) => f[1]), ["dub_ko.mp4", "clip_background.mp3"]);
  assert.deepEqual(h.saved(), ["video", "background"]);
  assert.equal(h.$("exportWhere").textContent, "Saves to the Downloads folder");
});

test("the X, Cancel and the backdrop each shut the dialog", async () => {
  const h = harness({ ctx: { kind: "draft" } });
  for (const shut of [() => h.$("exportCloseX").listeners.click(),
                      () => h.$("exportCloseBtn").listeners.click(),
                      () => h.$("exportOverlay").listeners.click({ target: h.$("exportOverlay") })]) {
    await h.api.open();
    assert.equal(h.$("exportOverlay").classList.contains("open"), true);
    shut();
    assert.equal(h.$("exportOverlay").classList.contains("open"), false);
  }
});

// ---- the folder the files go into (owner, 2026-10-22) ------------------------

// The desktop shell's side of it (desktop/src/downloadsIpc.js): what it says
// the folder is, what Change and Use default make it say, and the report of
// each download it saved. `picked` is what the user picks in the picker.
const DOWNLOADS = { folder: "/Users/me/Downloads", chosen: "", missing: false };
const SSD = { folder: "/Volumes/Work SSD", chosen: "/Volumes/Work SSD", missing: false };
const GONE = { folder: "/Users/me/Downloads", chosen: "/Volumes/Work SSD", missing: true };
function folderShell(now) {
  const said = { now, picked: SSD, asked: [], report: null };
  return {
    said,
    onDownloadDone: (fn) => { said.report = fn; },
    downloadFolder: async () => said.now,
    pickDownloadFolder: async () => { said.asked.push("pick"); return (said.now = said.picked); },
    resetDownloadFolder: async () => { said.asked.push("reset"); return (said.now = DOWNLOADS); },
  };
}
const DATED = { ...STEMS, day: "2026-09-30" };
const landedAt = async (shell, path) => { shell.said.report({ state: "completed", path }); await settle(); };

test("in the desktop shell the line ends in Change, and in Use default once a folder is picked", async () => {
  const shell = folderShell(DOWNLOADS);
  const h = harness({ ctx: DATED, shell });
  await h.api.open();
  assert.equal(h.$("exportWhere").textContent, "Saved in Downloads / 2026-09-30 / clip");
  assert.equal(h.$("exportFolder").hidden, false);
  assert.equal(h.$("exportFolderResetWrap").hidden, true, "nothing picked, nothing to go back from");
  await h.$("exportFolderPick").listeners.click();
  assert.deepEqual(shell.said.asked, ["pick"]);
  // The dated folder goes inside the picked one, as inside Downloads.
  assert.equal(h.$("exportWhere").textContent, "Saved in Work SSD / 2026-09-30 / clip");
  assert.equal(h.$("exportFolderResetWrap").hidden, false);
  // The picker closed without a folder: the shell answers what it had.
  shell.said.picked = SSD;
  await h.$("exportFolderPick").listeners.click();
  assert.equal(h.$("exportWhere").textContent, "Saved in Work SSD / 2026-09-30 / clip");
  await h.$("exportFolderReset").listeners.click();
  assert.deepEqual(shell.said.asked, ["pick", "pick", "reset"]);
  assert.equal(h.$("exportWhere").textContent, "Saved in Downloads / 2026-09-30 / clip");
  assert.equal(h.$("exportFolderResetWrap").hidden, true);
  // Every opening asks again: the shell keeps the folder, the dialog does not.
  shell.said.now = SSD;
  await h.api.open();
  assert.equal(h.$("exportWhere").textContent, "Saved in Work SSD / 2026-09-30 / clip");
  // The kinds without a dated folder on their line name the folder alone.
  const draft = harness({ ctx: { kind: "draft", where: "Saved in Downloads" }, shell: folderShell(SSD) });
  await draft.api.open();
  assert.equal(draft.$("exportWhere").textContent, "Saved in Work SSD");
});

test("in Korean the line reads as the approved mock, in all three states", async (t) => {
  await inKorean(t);
  const where = { day: "2026-10-22", project: "paris_steps" };
  const ctx = { ...STEMS, ...where, where: say("Saved in Downloads / {day} / {project}", where) };
  const ssd = { chosen: "/Volumes/작업용 SSD", missing: false };
  assert.equal(whereLine(ctx, DOWNLOADS), "다운로드 폴더의 2026-10-22 / paris_steps에 저장해요");
  assert.equal(whereLine(ctx, ssd), "작업용 SSD의 2026-10-22 / paris_steps에 저장해요");
  assert.equal(whereLine(ctx, { ...ssd, missing: true }),
    "작업용 SSD 폴더를 찾을 수 없어요. 다운로드 폴더의 2026-10-22 / paris_steps에 저장해요");
  assert.equal(whereLine({ kind: "erase", where: say("Saved in Downloads") }, ssd), "작업용 SSD에 저장해요");
  assert.equal(say("Change"), "바꾸기");
  assert.equal(say("Use default"), "기본으로");
  // And once a file is in: named from the picked folder's own name.
  const shell = folderShell({ folder: ssd.chosen, ...ssd });
  const h = harness({ ctx, shell });
  await h.api.open();
  h.go();
  await settle();
  await landedAt(shell, "/Volumes/작업용 SSD/2026-10-22/paris_steps/dub_ko.mp4");
  assert.equal(h.$("exportWhere").textContent, "dub_ko.mp4 파일을 작업용 SSD의 2026-10-22 / paris_steps에 저장했어요");
});

test("files saved in the picked folder are named from it: a dubbing's and the app's own", async () => {
  const shell = folderShell(SSD);
  const h = harness({ ctx: DATED, shell, stored: { [TICKS_KEY]: '{"dub":["video","voice"]}' } });
  await h.api.open();
  h.go();
  await settle();
  await landedAt(shell, "/Volumes/Work SSD/2026-09-30/clip/dub_ko.mp4");
  await landedAt(shell, "/Volumes/Work SSD/2026-09-30/clip/clip_voice.mp3");
  assert.equal(h.$("exportWhere").textContent, "Saved 2 files to Work SSD / 2026-09-30 / clip");
  // A draft's file, which the app writes itself (app/downloads.py save_folder).
  const draft = harness({ ctx: { kind: "draft", where: "Saved in Downloads",
    save: async () => "/Volumes/Work SSD/2026-09-30/clip/clip.mp4" }, shell: folderShell(SSD) });
  await draft.api.open();
  draft.go();
  await settle();
  assert.equal(draft.$("exportWhere").textContent, "Saved clip.mp4 to Work SSD / 2026-09-30 / clip");
});

test("a picked folder that is gone is said once on the line, before and after the files go to Downloads", async () => {
  const shell = folderShell(GONE);
  const h = harness({ ctx: DATED, shell, stored: { [TICKS_KEY]: '{"dub":["video","audio"]}' } });
  await h.api.open();
  assert.equal(h.$("exportWhere").textContent, "Cannot find Work SSD. Saved in Downloads / 2026-09-30 / clip");
  assert.equal(h.$("exportFolderResetWrap").hidden, false, "Use default is there to stop asking for it");
  h.go();
  await settle();
  await landedAt(shell, "/Users/me/Downloads/2026-09-30/clip/dub_ko.mp4");
  await landedAt(shell, "/Users/me/Downloads/2026-09-30/clip/dub_ko.mp3");
  assert.equal(h.$("exportWhere").textContent, "Cannot find Work SSD. Saved 2 files to Downloads / 2026-09-30 / clip");
  // Taken out after the dialog opened: the save is what finds it gone.
  const later = folderShell(SSD);
  const l = harness({ ctx: DATED, shell: later });
  await l.api.open();
  assert.equal(l.$("exportWhere").textContent, "Saved in Work SSD / 2026-09-30 / clip");
  l.go();
  await settle();
  later.said.now = GONE;
  await landedAt(later, "/Users/me/Downloads/2026-09-30/clip/dub_ko.mp4");
  assert.equal(l.$("exportWhere").textContent, "Cannot find Work SSD. Saved dub_ko.mp4 to Downloads / 2026-09-30 / clip");
  // Back in: the next save goes there and says nothing more about it.
  later.said.now = SSD;
  l.go();
  await settle();
  await landedAt(later, "/Volumes/Work SSD/2026-09-30/clip/dub_ko.mp4");
  assert.equal(l.$("exportWhere").textContent, "Saved dub_ko.mp4 to Work SSD / 2026-09-30 / clip");
});

test("Change and Use default stand aside while files go out, and are not there without the shell's folder", async () => {
  const shell = folderShell(SSD);
  const h = harness({ ctx: DATED, shell });
  await h.api.open();
  h.go();
  await settle();
  assert.equal(h.$("exportFolder").hidden, true);
  await h.$("exportFolderPick").listeners.click();
  await h.$("exportFolderReset").listeners.click();
  assert.deepEqual(shell.said.asked, [], "no picker while a file is on its way");
  await landedAt(shell, "/Volumes/Work SSD/2026-09-30/clip/dub_ko.mp4");
  assert.equal(h.$("exportFolder").hidden, false);
  // A browser, or a shell from before the choice: the line as it was, and no words after it.
  for (const without of [null, { onDownloadDone: () => {} }]) {
    const plain = harness({ ctx: DATED, shell: without });
    await plain.api.open();
    assert.equal(plain.$("exportFolder").hidden, true);
    assert.equal(plain.$("exportWhere").textContent, "Saved in Downloads / 2026-09-30 / clip");
    await plain.$("exportFolderPick").listeners.click();
  }
});

test("the dialog says what comes out under its title, and its two words are words that wrap together", async (t) => {
  const page = readFileSync(new URL("../../static/index.html", import.meta.url), "utf8");
  const dialog = page.slice(page.indexOf('<div class="modal-overlay" id="exportOverlay">'));
  assert.match(dialog, /<div class="modal-inner">\s*(<!--[^]*?-->\s*)?<p class="export-headline" data-i18n>Each checked row becomes one file<\/p>\s*<div class="export-list" id="exportList"><\/div>/);
  assert.match(dialog, /<p class="export-where"><span id="exportWhere"><\/span><span id="exportFolder" hidden> · <span class="export-links"><button type="button" class="erase-link" id="exportFolderPick" data-i18n>Change<\/button><span id="exportFolderResetWrap" hidden> · <button type="button" class="erase-link" id="exportFolderReset" data-i18n>Use default<\/button><\/span><\/span><\/span><\/p>/);
  const css = readFileSync(new URL("../../static/css/app.css", import.meta.url), "utf8");
  assert.match(css, /\.export-where \.export-links \{ white-space: nowrap; \}/);
  assert.match(css, /\.export-where \.erase-link \{ font-size: inherit; \}/);
  await inKorean(t);
  assert.equal(say("Each checked row becomes one file"), "체크한 줄마다 파일이 하나씩 나와요");
});

// The Subtitle style tab on its own (owner, 2026-10-22): the video in the
// look picked, and the subtitle file -- nothing a dubbing would add.
test("a video with its own subtitles hands back two rows: the subtitled video and the .srt", () => {
  const ctx = { kind: "captions", jobId: "C1", ratio: "original",
                subtitled: { href: "/api/dub/result/C1/subtitled?preset=sticker&download=1",
                             name: "video-sub-sticker.mp4" } };
  const rows = exportRows(ctx, "mp3");
  assert.deepEqual(rows.map((r) => r.id), ["subtitled", "srt"]);
  assert.deepEqual(rows.map((r) => r.label), ["Video with subtitles", "Subtitles (.srt)"]);
  assert.equal(rows[0].href, "/api/dub/result/C1/subtitled?preset=sticker&download=1");
  assert.equal(rows[0].name, "video-sub-sticker.mp4");
  assert.equal(rows[1].href, "/api/dub/result/C1/srt?download=1");
  assert.equal(rows[1].name, "video.srt");
  // The player's shape goes on the video, as on a dubbing's.
  assert.match(exportRows({ ...ctx, ratio: "9:16" }, "mp3")[0].href, /ratio=9(%3A|:)16/);
  // The first row ticked when nothing was remembered.
  assert.deepEqual(ticksFor(null, "captions", ["subtitled", "srt"]), ["subtitled"]);
});
