// The Audio tab, driven the way the page drives it: a paper-thin page of plain
// objects, the app's answers stubbed at fetch, and what is asserted is what
// the user would see -- which face is up, what the cards and the foot say,
// which buttons are there, and what the timeline and the video are told.
//
// Run with: node --test ui/src/audioTab.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { initAudioTab, audioView, partsKey, estimateSeconds, estimateLabel, percentOf,
         runningLine, stoppedLine } from "./audioTab.mjs";
import { setDraft, clearDraft, setRanges } from "./draft.mjs";

function makeEl(id) {
  const classes = new Set();
  const listeners = {};
  const attrs = {};
  const el = {
    id, hidden: false, disabled: false, textContent: "", innerHTML: "", value: "",
    dataset: {}, style: {}, paused: true, muted: false, currentTime: 0, files: [],
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    setAttribute: (k, v) => { attrs[k] = v; },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    removeAttribute: (k) => { delete attrs[k]; if (k === "src") el.src = ""; },
    addEventListener: (ev, fn) => { (listeners[ev] ||= []).push(fn); },
    fire: async (ev, arg = {}) => { for (const fn of [...(listeners[ev] || [])]) await fn(arg); },
    play() { el.paused = false; el.fire("play"); return Promise.resolve(); },
    pause() { if (!el.paused) { el.paused = true; el.fire("pause"); } },
    click() { return el.fire("click"); },
  };
  return el;
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const WAVE = { rate: 10, duration: 1, peaks: [0.2, 0.5, 0.9, 0.4, 0.1, 0.6, 0.3, 0.8, 0.2, 0.1] };

/** A page, the app behind it, and what the tab reached out for. */
function harness({ job = { status: "running", elapsed: 12 }, start = { job_id: "S1" } } = {}) {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };
  $("audioEngine").value = "local";
  const log = { posts: [], bodies: [], tabs: [], imported: [], jobs: 0, exports: 0, asked: 0,
                refused: [], said: [], timeline: undefined, now: 1000 };
  const app = { job, start, startStatus: 200, stop: true, takeRefusal: false };
  const state = { jobId: null };

  const real = { fetch: globalThis.fetch, setInterval: globalThis.setInterval,
                 clearInterval: globalThis.clearInterval, setTimeout: globalThis.setTimeout };
  const ticks = [];
  globalThis.setInterval = (fn) => { ticks.push(fn); return ticks.length; };
  globalThis.clearInterval = (n) => { if (n) ticks[n - 1] = null; };
  globalThis.fetch = async (url, opts = {}) => {
    const answer = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (opts.method === "POST") {
      log.posts.push(String(url));
      log.bodies.push(opts.body instanceof FormData ? Object.fromEntries(opts.body.entries()) : null);
    }
    if (url === "/api/separate") return answer(app.start, app.startStatus);
    if (/\/api\/separate\/\w+\/retry$/.test(url)) return answer({ job_id: "S2" });
    if (/\/waveform\//.test(url)) return answer(WAVE);
    if (/\/api\/separate\/\w+$/.test(url)) return answer({ logs: [], ...app.job });
    if (/\/cancel$/.test(url)) return answer({ status: "cancelling" });
    throw new Error(`unexpected ${url}`);
  };
  log.restore = () => { Object.assign(globalThis, real); clearDraft(); };
  log.tick = async () => { for (const fn of ticks.filter(Boolean)) await fn(); await settle(); };

  const api = initAudioTab({
    $, state,
    getVideo: () => $("doneVideo"),
    goToTab: (name) => log.tabs.push(name),
    importSource: async (source) => { log.imported.push(source); },
    say: (text, isError) => { log.said.push([text, !!isError]); },
    askStop: async () => { log.asked += 1; return app.stop; },
    onStartRefused: (e, retry) => { log.refused.push({ status: e.status, detail: e.detail, retry }); return app.takeRefusal; },
    onJobsChanged: () => { log.jobs += 1; },
    openExport: () => { log.exports += 1; },
    showTimeline: (info) => { log.timeline = info; },
    now: () => log.now,
  });
  const shown = (...ids) => ids.filter((id) => !$(id).hidden);
  const BUTTONS = ["audioRunBtn", "audioStopBtn", "audioBackBtn", "audioRetryBtn", "audioDubBtn", "audioExportBtn"];
  return { $, api, log, app, state, shown, buttons: () => shown(...BUTTONS) };
}

const draft = (duration = 52.6) => setDraft({ downloadId: "D1", name: "street-food.mp4", duration,
                                              videoUrl: "/api/downloads/D1/video" });

// ---- the words and the sums ------------------------------------------------

test("which face is up follows the draft, its cut and the job", () => {
  const d = { downloadId: "D1", duration: 10, ranges: [[0, 10]] };
  const cut = { ...d, ranges: [[2, 8]] };
  const job = (status, more = {}) => ({ downloadId: "D1", key: "", status, ...more });
  assert.equal(audioView({ draft: null, job: null }), "empty");
  assert.equal(audioView({ draft: { ...d, downloadId: "" }, job: null }), "empty");
  assert.equal(audioView({ draft: d, job: null }), "before");
  for (const status of ["queued", "running", "cancelling"]) assert.equal(audioView({ draft: d, job: job(status) }), "running");
  assert.equal(audioView({ draft: d, job: job("done", { done: true }) }), "done");
  for (const status of ["error", "cancelled"]) assert.equal(audioView({ draft: d, job: job(status) }), "failed");
  // Finished, but the two files are gone.
  assert.equal(audioView({ draft: d, job: job("done", { done: false }) }), "failed");
  // Another video, or the same one cut another way, is a separation still to make.
  assert.equal(audioView({ draft: { ...d, downloadId: "D2" }, job: job("done", { done: true }) }), "before");
  assert.equal(audioView({ draft: cut, job: job("done", { done: true }) }), "before");
  assert.equal(audioView({ draft: cut, job: job("done", { done: true, key: partsKey([[2, 8]]) }) }), "done");
});

test("the estimate, the percentage and the lines", () => {
  assert.equal(estimateSeconds(0), 0);
  assert.equal(estimateSeconds(32), 14.6);
  assert.equal(estimateSeconds(32, "perso"), 76);
  assert.equal(estimateLabel(52), "About 1 min");
  assert.equal(estimateLabel(130), "About 3 min");
  assert.equal(estimateLabel(0), "");
  assert.equal(percentOf({ status: "running", elapsed: 21.84 }, 52), 42);
  assert.equal(percentOf({ status: "queued", elapsed: 0 }, 52), 0);
  assert.equal(percentOf({ status: "running", elapsed: 500 }, 52), 95, "it never claims the end");
  assert.equal(runningLine({ status: "running" }, 42), "Separating… 42%");
  assert.equal(runningLine({ status: "queued" }, 0), "Waiting for its turn");
  assert.equal(runningLine({ status: "cancelling" }, 42), "Stopping…");
  assert.equal(stoppedLine({ status: "cancelled" }), "Separating was stopped.");
  assert.equal(stoppedLine({ status: "error", error: "interrupted" }), "PersoDub was closed before this finished.");
  assert.equal(stoppedLine({ status: "error", error: "Voice separation failed on this computer." }),
    "Voice separation failed on this computer.");
  // The engine's sentence in the page's language wins; error stays English.
  assert.equal(stoppedLine({ status: "error", error: "Voice separation failed on this computer.",
                             error_shown: "이 컴퓨터에서 오디오 분리에 실패했어요." }),
    "이 컴퓨터에서 오디오 분리에 실패했어요.");
  // A cause the engine sent apart (error_detail) is said after the sentence.
  assert.equal(stoppedLine({ status: "error", error: "x", error_shown: "Perso 오디오 분리에 실패했어요.",
                             error_detail: "이유: Client error '400 Bad Request'" }),
    "Perso 오디오 분리에 실패했어요. 이유: Client error '400 Bad Request'");
});

// ---- no video yet ------------------------------------------------------------

test("with no video the tab asks for one, brings it in the one shared way, and stays up", async (t) => {
  const h = harness();
  t.after(h.log.restore);
  assert.deepEqual(h.shown("audioEmpty", "audioBody", "audioRow"), ["audioEmpty"]);
  assert.equal(h.$("audioZone").hidden, false);
  assert.equal(h.log.timeline, null);

  // A file goes to the importer, which checks it and says how it is going.
  h.$("audioInput").files = [{ name: "clip.mp4" }];
  await h.$("audioInput").fire("change");
  assert.deepEqual(h.log.imported, [{ file: { name: "clip.mp4" } }]);
  // A link, and something that is not one.
  h.$("audioLinkInput").value = "https://example.com/v";
  await h.$("audioLinkInput").fire("keydown", { key: "Enter", preventDefault() {} });
  assert.deepEqual(h.log.imported[1], { link: "https://example.com/v" });
  h.$("audioLinkInput").value = "holiday";
  await h.$("audioLinkInput").fire("keydown", { key: "Enter", preventDefault() {} });
  assert.deepEqual(h.log.said, [["That is not a link. Paste one that starts with https://", true]]);
  // No other tab is pressed on the way, and the tab is on the video once it is the draft.
  draft();
  assert.deepEqual(h.log.tabs, []);
  assert.deepEqual(h.shown("audioEmpty", "audioBody", "audioRow"), ["audioBody", "audioRow"]);
});

test("with a job on screen there is no draft to bring a video into", (t) => {
  const h = harness();
  t.after(h.log.restore);
  h.state.jobId = "J1";
  h.api.paint();
  assert.equal(h.$("audioZone").hidden, true);
  assert.equal(h.$("audioEmptyNote").textContent, "Separate audio starts from a new project.");
});

// ---- before ------------------------------------------------------------------

test("before: the video, where it runs, the two sounds to come, about how long, and Separate", (t) => {
  const h = harness();
  t.after(h.log.restore);
  draft();
  setRanges([[10, 42]]);
  assert.deepEqual(h.shown("audioPartCard", "audioEngineCard", "audioRunCard", "audioVoiceRow", "audioBackgroundRow"),
    ["audioPartCard", "audioEngineCard", "audioVoiceRow", "audioBackgroundRow"]);
  assert.equal(h.$("audioPartCard").innerHTML,
    '<div class="k">Video</div><div class="m vc-name" title="street-food.mp4">street-food.mp4</div>'
    + '<div class="s vc-len">00:32<span class="vc-cut">00:20 cut</span></div>');
  // The two results are there up front, dim: a note each, no button yet.
  for (const which of ["Voice", "Background"]) {
    assert.equal(h.$(`audio${which}Row`).classList.contains("dim"), true);
    assert.equal(h.$(`audio${which}Play`).hidden, true);
    assert.equal(h.$(`audio${which}Note`).hidden, false);
  }
  assert.equal(h.$("audioEngineNote").textContent, "");
  assert.equal(h.$("audioFootLabel").textContent, "About 1 min");
  assert.deepEqual(h.buttons(), ["audioRunBtn"]);
  // Nothing is locked and no lane is added.
  assert.deepEqual(h.log.timeline, { locked: false, stems: null });
});

test("Separate sends the kept part of the held video and follows the job", async (t) => {
  const h = harness();
  t.after(h.log.restore);
  draft();
  setRanges([[10, 42]]);
  await h.$("audioRunBtn").click();
  assert.deepEqual(h.log.posts, ["/api/separate"]);
  assert.deepEqual(h.log.bodies[0], { download_id: "D1", engine: "local", project: "street-food",
                                      trim_start: "10", trim_end: "42" });
  assert.equal(h.log.jobs, 1, "the Projects list has a new row");
  // Queued until the app says otherwise.
  assert.equal(h.$("audioRunLine").textContent, "Waiting for its turn");

  // Several kept parts go as parts.
  const g = harness();
  draft();
  setRanges([[0, 2], [4, 6]]);
  await g.$("audioRunBtn").click();
  assert.equal(g.log.bodies[0].ranges, "[[0,2],[4,6]]");
  assert.equal(g.log.bodies[0].trim_start, undefined);
  g.log.restore();
});

test("Perso says what it costs on the first press and starts on the second", async (t) => {
  const h = harness();
  t.after(h.log.restore);
  draft();
  h.$("audioEngine").value = "perso";
  await h.$("audioEngine").fire("change");
  assert.equal(h.$("audioEngineNote").textContent, "Uses Perso credits.");
  assert.equal(h.$("audioFootLabel").textContent, "About 2 min");

  await h.$("audioRunBtn").click();
  assert.deepEqual(h.log.posts, [], "the first press starts nothing");
  assert.equal(h.$("audioFootLabel").textContent, "Uses Perso credits. Press again to start.");
  // Too late is a first press again.
  h.log.now += 11000;
  await h.$("audioRunBtn").click();
  assert.deepEqual(h.log.posts, []);
  h.log.now += 3000;
  await h.$("audioRunBtn").click();
  assert.deepEqual(h.log.posts, ["/api/separate"]);
  assert.equal(h.log.bodies[0].engine, "perso");
});

test("a start the page can fix is handed to the page; anything else is said on the tab", async (t) => {
  const h = harness();
  t.after(h.log.restore);
  draft();
  const missing = { missing: [{ id: "engine", kind: "pack" }], total_bytes: 5, free_bytes: 9 };
  h.app.start = { detail: missing };
  h.app.startStatus = 409;
  h.app.takeRefusal = true;
  await h.$("audioRunBtn").click();
  assert.equal(h.log.refused[0].status, 409);
  assert.deepEqual(h.log.refused[0].detail, missing, "the download notice gets its own payload");
  assert.equal(h.$("audioError").textContent, "");
  assert.deepEqual(h.buttons(), ["audioRunBtn"]);
  // Once the pack is there the page starts it again, with no second question.
  h.app.start = { job_id: "S1" };
  h.app.startStatus = 200;
  await h.log.refused[0].retry();
  assert.equal(h.log.posts.length, 2);
  assert.deepEqual(h.buttons(), ["audioStopBtn"]);

  const g = harness({ start: { detail: "This video has no sound." } });
  draft();
  g.app.startStatus = 422;
  await g.$("audioRunBtn").click();
  assert.equal(g.$("audioError").textContent, "This video has no sound.");
  g.log.restore();
});

// ---- running -----------------------------------------------------------------

test("running: the percentage, the bar, the length and Stop; the cuts are locked", async (t) => {
  const h = harness({ job: { status: "running", elapsed: 6.13, separation: "demucs" } });
  t.after(h.log.restore);
  draft();
  setRanges([[10, 42]]);
  await h.$("audioRunBtn").click();
  await h.log.tick();
  assert.deepEqual(h.shown("audioPartCard", "audioEngineCard", "audioRunCard", "audioVoiceRow", "audioBackgroundRow"),
    ["audioPartCard", "audioRunCard", "audioVoiceRow", "audioBackgroundRow"]);
  assert.equal(h.$("audioRunLine").textContent, "Separating… 42%");
  assert.equal(h.$("audioBarBox").hidden, false);
  assert.equal(h.$("audioFill").style.width, "42%");
  assert.equal(h.$("audioFootLabel").textContent, "00:32");
  assert.deepEqual(h.buttons(), ["audioStopBtn"]);
  assert.deepEqual(h.log.timeline, { locked: true, stems: null });
});

test("Stop asks first, and a No leaves it running", async (t) => {
  const h = harness();
  t.after(h.log.restore);
  draft();
  await h.$("audioRunBtn").click();
  await h.log.tick();
  h.app.stop = false;
  await h.$("audioStopBtn").click();
  assert.equal(h.log.asked, 1);
  assert.equal(h.log.posts.some((u) => /cancel/.test(u)), false);

  h.app.stop = true;
  await h.$("audioStopBtn").click();
  assert.equal(h.log.posts.at(-1), "/api/dub/jobs/S1/cancel");
  assert.equal(h.$("audioRunLine").textContent, "Stopping…");
  assert.equal(h.$("audioStopBtn").disabled, true);

  // Stopped: why, the way back and the way to try again.
  h.app.job = { status: "cancelled" };
  await h.log.tick();
  assert.equal(h.$("audioState").textContent, "Separating was stopped.");
  assert.deepEqual(h.buttons(), ["audioBackBtn", "audioRetryBtn"]);
  assert.equal(h.$("audioLogDetails").hidden, true);
  await h.$("audioBackBtn").click();
  assert.deepEqual(h.buttons(), ["audioRunBtn"]);
});

test("a separation that broke says why in one sentence, keeps its log, and can be tried again", async (t) => {
  const h = harness({ job: { status: "error", error: "Voice separation failed on this computer. Check the video file.",
                             logs: ["1/6 Separating…", "Error: RuntimeError: boom"] } });
  t.after(h.log.restore);
  draft();
  await h.$("audioRunBtn").click();
  await h.log.tick();
  assert.equal(h.$("audioState").textContent, "Voice separation failed on this computer. Check the video file.");
  assert.equal(h.$("audioState").classList.contains("bad"), true);
  assert.equal(h.$("audioLogDetails").hidden, false);
  assert.match(h.$("audioLogBox").textContent, /RuntimeError: boom/);
  assert.deepEqual(h.buttons(), ["audioBackBtn", "audioRetryBtn"]);
  assert.equal(h.log.jobs, 2, "the list is told when it ends");

  h.app.job = { status: "running", elapsed: 1 };
  await h.$("audioRetryBtn").click();
  assert.equal(h.log.posts.at(-1), "/api/separate/S1/retry");
  await h.log.tick();
  assert.deepEqual(h.buttons(), ["audioStopBtn"]);
});

// ---- done --------------------------------------------------------------------

async function finished(h) {
  draft();
  setRanges([[10, 42]]);
  await h.$("audioRunBtn").click();
  h.app.job = { status: "done", done: true, separation: "demucs" };
  await h.log.tick();
  await settle();
}

test("done: two rows with their pictures, how much was separated, Dubbing and Export", async (t) => {
  const h = harness();
  t.after(h.log.restore);
  await finished(h);
  assert.deepEqual(h.shown("audioPartCard", "audioEngineCard", "audioRunCard", "audioVoiceRow", "audioBackgroundRow"),
    ["audioPartCard", "audioVoiceRow", "audioBackgroundRow"]);
  for (const id of ["audioVoiceWave", "audioBackgroundWave"]) assert.match(h.$(id).innerHTML, /^<svg viewBox="0 0 10 100"/);
  assert.equal(h.$("audioFootLabel").textContent, "00:32 separated");
  assert.deepEqual(h.buttons(), ["audioDubBtn", "audioExportBtn"]);
  // The timeline gets a lane for each, and the cuts are free again.
  assert.deepEqual(h.log.timeline, { locked: false, stems: { id: "S1", muted: { voice: false, background: false } } });
  // The video plays through the two sounds instead of its own.
  assert.equal(h.$("doneVideo").muted, true);
  assert.equal(h.$("audioVoice").src, "/api/dub/result/S1/stem/voice?format=mp3");
  assert.equal(h.$("audioBackground").src, "/api/dub/result/S1/stem/background?format=mp3");

  await h.$("audioExportBtn").click();
  assert.equal(h.log.exports, 1);
  await h.$("audioDubBtn").click();
  assert.equal(h.log.tabs.at(-1), "dubbing");
  // What the dubbing started there takes its two sounds from.
  assert.equal(h.api.separatedJob().id, "S1");
});

test("a row's play button plays that sound alone under the video, from the kept time", async (t) => {
  const h = harness();
  t.after(h.log.restore);
  await finished(h);
  const v = h.$("doneVideo");
  v.currentTime = 15;     // five seconds into the part kept from 10
  await h.$("audioVoicePlay").click();
  assert.equal(v.paused, false);
  assert.equal(h.$("audioVoice").paused, false);
  assert.equal(h.$("audioVoice").currentTime, 5);
  assert.equal(h.$("audioVoice").muted, false);
  assert.equal(h.$("audioBackground").muted, true);
  assert.match(h.$("audioVoicePlay").getAttribute("aria-label"), /^Pause/);
  assert.match(h.$("audioBackgroundPlay").getAttribute("aria-label"), /^Play/);
  assert.deepEqual(h.log.timeline.stems.muted, { voice: false, background: true });

  // The other row takes over without stopping the video.
  await h.$("audioBackgroundPlay").click();
  assert.equal(v.paused, false);
  assert.equal(h.$("audioVoice").muted, true);
  assert.equal(h.$("audioBackground").muted, false);
  // Pressed again, it pauses, and the sounds with it.
  await h.$("audioBackgroundPlay").click();
  assert.equal(v.paused, true);
  assert.equal(h.$("audioBackground").paused, true);

  // A lane's speaker on the timeline silences one or lets it be heard again.
  h.api.toggleMute("voice");
  assert.deepEqual(h.log.timeline.stems.muted, { voice: false, background: false });
  h.api.toggleMute("background");
  assert.equal(h.$("audioBackground").muted, true);
});

test("the two sounds belong to a cut: cut it another way and it is before again", async (t) => {
  const h = harness();
  t.after(h.log.restore);
  await finished(h);
  setRanges([[10, 30]]);
  assert.deepEqual(h.buttons(), ["audioRunBtn"]);
  assert.equal(h.api.separatedJob(), null);
  assert.equal(h.$("doneVideo").muted, false, "the video has its own sound back");
  assert.deepEqual(h.log.timeline, { locked: false, stems: null });
  // Put the cut back and they are there as they were.
  setRanges([[10, 42]]);
  assert.deepEqual(h.buttons(), ["audioDubBtn", "audioExportBtn"]);
  assert.equal(h.api.separatedJob().id, "S1");
  // The draft goes (a dubbing started): the video is let go of.
  clearDraft();
  assert.equal(h.$("doneVideo").muted, false);
  assert.equal(h.log.timeline, null);
});

test("a separation opened from Projects is followed on the draft its video comes back as", async (t) => {
  const h = harness({ job: { status: "done", done: true, separation: "perso" } });
  t.after(h.log.restore);
  h.api.adopt({ id: "S9", status: "done", separation: "perso" },
              { download_id: "D1", ranges: [[10, 42]] });
  await settle();
  // The draft arrives whole and is then cut to the job's parts.
  draft();
  assert.deepEqual(h.buttons(), ["audioRunBtn"]);
  setRanges([[10, 42]]);
  await settle();
  assert.deepEqual(h.buttons(), ["audioDubBtn", "audioExportBtn"]);
  assert.equal(h.$("audioFootLabel").textContent, "00:32 separated");
  assert.equal(h.api.separatedJob().id, "S9");
});
