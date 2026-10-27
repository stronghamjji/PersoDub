import test from "node:test";
import assert from "node:assert/strict";
import { parseProgress } from "./dubApi.mjs";
import { createDubTracker, dubStartedProps, stageName, startedFromForm, startedFromJob } from "./dubTrack.mjs";

// A tracker with the real progress reader, a clock the test moves, and every
// step it recorded.
function tracker() {
  let clock = 1_000_000;
  const steps = [];
  const t = createDubTracker({ parse: parseProgress, record: (name, props) => steps.push([name, props]), now: () => clock });
  return { t, steps, tick: (s) => { clock += s * 1000; } };
}
// A dub's record with its log reaching stage `n` of six ("3/6 ..." lines, as app/pipeline.py writes).
const local = (id, n, status = "running", more = {}) => ({
  id, status, dub_mode: "local", logs: Array.from({ length: n }, (_, i) => `${i + 1}/6 step ${i + 1}`), ...more,
});

test("the stages a reading is on, by the engine's names, local and Perso API", () => {
  assert.equal(stageName(parseProgress(["1/6 Separating"])), "separate");
  assert.equal(stageName(parseProgress(["1/6 a", "2/6 b", "3/6 c", "4/6 d"])), "synthesize");
  assert.equal(stageName(parseProgress(["6/6 Building the video"])), "build");
  assert.equal(stageName(parseProgress(["Perso is dubbing (40%)"])), "perso-dubbing");
  assert.equal(stageName(parseProgress(["Downloading the finished video"])), "download");
  assert.equal(stageName(parseProgress([])), "");
});

test("a dubbing this page started: each stage's start and end, timed, then the last stage done", () => {
  const { t, steps, tick } = tracker();
  t.started("j1", "local");
  t.see(local("j1", 0, "queued"));
  tick(2);
  t.see(local("j1", 1));
  tick(30);
  t.see(local("j1", 1));
  t.see(local("j1", 2));
  tick(60);
  t.see(local("j1", 2, "done"));
  t.see(local("j1", 2, "done"));
  assert.deepEqual(steps, [
    ["dub_stage", { stage: "separate", state: "start", mode: "local" }],
    ["dub_stage", { stage: "separate", state: "done", seconds: 30, mode: "local" }],
    ["dub_stage", { stage: "transcribe", state: "start", mode: "local" }],
    ["dub_stage", { stage: "transcribe", state: "done", seconds: 60, mode: "local" }],
  ]);
});

test("a stage first seen halfway has no seconds; a failure is the stage it stopped in; a list row moves nothing on", () => {
  const { t, steps, tick } = tracker();
  t.see(local("j2", 3));                       // opened mid-translate
  tick(20);
  t.see({ id: "j2", status: "running" });      // Home's list: no log
  t.see(local("j2", 4));
  tick(45);
  t.see({ id: "j2", status: "error", dub_mode: "local" });
  assert.deepEqual(steps, [
    ["dub_stage", { stage: "translate", state: "done", mode: "local" }],
    ["dub_stage", { stage: "synthesize", state: "start", mode: "local" }],
    ["dub_stage", { stage: "synthesize", state: "failed", seconds: 45, mode: "local" }],
  ]);
});

test("a job over before the page saw it run, another kind of job, or a cancel's own ending records no stage", () => {
  const { t, steps } = tracker();
  t.see(local("old", 6, "done"));
  t.see({ ...local("e1", 1), kind: "erase" });
  t.see(local("c1", 2));
  t.see(local("c1", 2, "cancelled"));
  assert.deepEqual(steps, []);
});

test("Stop dubbing records the stage it was on, and a Perso API dubbing says so", () => {
  const { t, steps } = tracker();
  t.see({ id: "p1", status: "running", dub_mode: "perso", logs: ["Uploading the video to Perso"] });
  t.cancelled({ id: "p1", status: "running", dub_mode: "perso" });
  t.cancelled({ id: "q1", status: "queued" });
  t.cancelled({ id: "e1", kind: "erase" });
  assert.deepEqual(steps, [
    ["dub_cancelled", { stage: "upload", mode: "perso" }],
    ["dub_cancelled", { mode: "local" }],
  ]);
});

test("dub_started's props off the form or the record: two-letter language, minutes and seconds, speakers or 0", () => {
  const fd = new FormData();
  fd.append("dub_mode", "perso");
  fd.append("language_code", "en-GB");
  fd.append("num_speakers", "2");
  assert.deepEqual(startedFromForm(fd, 170.4), { mode: "perso", target_lang: "en", minutes: 3, video_seconds: 170, speakers: 2 });
  fd.append("trim_start", "10");
  fd.append("trim_end", "40");
  assert.deepEqual(startedFromForm(fd, 170.4), { mode: "perso", target_lang: "en", minutes: 1, video_seconds: 30, speakers: 2 });
  const bare = new FormData();
  bare.append("dub_mode", "local");
  assert.deepEqual(startedFromForm(bare), { mode: "local", speakers: 0 });
  assert.deepEqual(startedFromJob({ dub_mode: "local", language_code: "ko", duration: 20, num_speakers: null }),
    { mode: "local", target_lang: "ko", minutes: 0, video_seconds: 20, speakers: 0 });
  assert.deepEqual(dubStartedProps({ mode: "cloud", speakers: 2.5 }), { mode: "local", speakers: 0 });
});
