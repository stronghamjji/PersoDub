// A video brought into a finished audio project (ui/src/joinPlayer.mjs), run
// on fakes: two media elements that keep their listeners and say where they
// are, a few elements by id, frames the test turns by hand, and a fetch that
// answers as app/api/join.py is to answer.
//
// Run with: node --test ui/src/joinPlayer.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { initJoinPlayer } from "./joinPlayer.mjs";

function makeEl() {
  const el = {
    listeners: {}, hidden: false, disabled: false, textContent: "", value: "", clicks: 0,
    classes: new Set(),
    classList: { toggle: (c, on) => { if (on) el.classes.add(c); else el.classes.delete(c); } },
    addEventListener(type, fn) { (el.listeners[type] ||= []).push(fn); },
    fire(type, fields = {}) {
      const ev = { type, target: el, prevented: false, preventDefault() { ev.prevented = true; }, ...fields };
      for (const fn of el.listeners[type] || []) fn(ev);
      return ev;
    },
    click() { el.clicks += 1; },
  };
  return el;
}

// A media element: playing does not move it by itself (the test says where it
// has got to with playTo), and a move lands at once unless it is `slow`.
function makeMedia() {
  let at = 0;
  const attrs = new Map();
  const el = Object.assign(makeEl(), {
    paused: true, ended: false, seeking: false, slow: false, playbackRate: 1, defaultPlaybackRate: 1,
    moves: [], loads: 0,
    playTo(v) { at = v; },
    // Played to its own end at v, as a browser says it: stopped first, "pause",
    // then "ended".
    playOut(v) { at = v; el.ended = true; el.paused = true; el.fire("pause"); el.fire("ended"); },
    land() { el.seeking = false; el.fire("seeked"); },
    play() {
      if (!el.paused) return Promise.resolve();
      el.paused = false;
      el.fire("play");
      return Promise.resolve();
    },
    pause() {
      if (el.paused) return;
      el.paused = true;
      el.fire("pause");
    },
    load() { el.loads += 1; },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => attrs.delete(k),
  });
  Object.defineProperty(el, "currentTime", {
    get: () => at,
    set: (v) => {
      at = v;
      el.moves.push(v);
      el.ended = false;
      if (el.slow) el.seeking = true; else el.fire("seeked");
    },
  });
  return el;
}

const JOINED = { video: { name: "walk.mp4", seconds: 40 }, audio_seconds: 30,
                 ranges: { video: [[0, 40]], audio: [[0, 30]] }, tempo: 1, stamp: "s1" };
const turn = () => new Promise((r) => setImmediate(r));

/**
 * One page with the module on it. `joins` is what the app holds per job id;
 * `upload` answers a POST (default: the video goes in as JOINED).
 */
function harness({ joins = {}, upload = null, checkFile = () => null } = {}) {
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, makeEl()); return els.get(id); };
  const sound = makeMedia(), picture = makeMedia();
  const calls = { gets: [], posts: [], puts: [], changes: 0, ticks: 0 };
  const frames = [];
  const time = { ms: 0 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const jid = /\/api\/dub\/jobs\/([^/]+)\/join/.exec(url)[1];
    if (opts.method === "POST") {
      calls.posts.push({ url, file: opts.body.get("video") });
      if (upload) return upload(jid);
      joins[jid] = structuredClone(JOINED);
      return new Response("{}", { status: 200 });
    }
    if (opts.method === "PUT") {
      calls.puts.push({ url, body: JSON.parse(opts.body) });
      return new Response("{}", { status: 200 });
    }
    calls.gets.push(url);
    if (!(jid in joins)) return new Response("{}", { status: 500 });
    return new Response(JSON.stringify(joins[jid]), { status: 200 });
  };
  const player = initJoinPlayer({
    $, sound, picture, checkFile,
    onChange: () => { calls.changes += 1; },
    onTick: () => { calls.ticks += 1; },
    raf: (fn) => frames.push(fn),
    clock: () => time.ms,
  });
  const frame = () => { const fn = frames.shift(); if (fn) fn(); };
  const restore = () => { globalThis.fetch = realFetch; };
  return { player, $, sound, picture, calls, frames, frame, time, joins, restore };
}

/** A project with the video in, standing still at the top. */
async function joined(state = JOINED, opts = {}) {
  const h = harness({ joins: { a: structuredClone(state) }, ...opts });
  h.player.open("a");
  await turn();
  return h;
}

const file = (name = "walk.mp4") => new File(["picture bytes"], name);

test("the bring-in row is shown only for an open project the app says has no video", async () => {
  const h = harness({ joins: { a: { video: null }, b: structuredClone(JOINED) } });
  try {
    assert.equal(h.$("joinBring").hidden, true, "no project open");
    h.player.open("a");
    assert.equal(h.$("joinBring").hidden, true, "not before the app has answered");
    await turn();
    assert.equal(h.$("joinBring").hidden, false);
    assert.equal(h.player.getJoin(), null);
    assert.equal(h.calls.changes, 1, "the page is told the answer arrived");
    // The same project reported again is not asked about again.
    h.player.open("a");
    assert.deepEqual(h.calls.gets, ["/api/dub/jobs/a/join"]);
    // A project with a video in: no row, and the picture is on its element.
    h.player.open("b");
    await turn();
    assert.equal(h.$("joinBring").hidden, true);
    assert.equal(h.picture.getAttribute("src"), "/api/dub/jobs/b/join/video?v=s1");
    assert.ok(h.player.getJoin());
    // No project: nothing.
    h.player.open(null);
    assert.equal(h.$("joinBring").hidden, true);
    assert.equal(h.player.getJoin(), null);
  } finally { h.restore(); }
});

test("no answer from the app leaves the box as it is: the row would replace a video that is in", async () => {
  const h = harness({ joins: {} });
  try {
    h.player.open("a");
    await turn();
    assert.equal(h.$("joinBring").hidden, true);
    assert.equal(h.calls.changes, 0);
  } finally { h.restore(); }
});

test("the button opens the file picker, and a picked video is brought in", async () => {
  const h = harness({ joins: { a: { video: null } } });
  try {
    h.player.open("a");
    await turn();
    h.$("joinBringBtn").fire("click");
    assert.equal(h.$("joinFile").clicks, 1);
    const picked = file();
    const input = h.$("joinFile");
    input.files = [picked];
    input.value = "C:\\fakepath\\walk.mp4";
    input.fire("change");
    assert.equal(input.value, "", "the same file can be picked again");
    assert.equal(h.$("joinBringNote").textContent, "Bringing the video in…");
    assert.equal(h.$("joinBringBtn").disabled, true);
    await turn();
    await turn();
    assert.equal(h.calls.posts.length, 1);
    assert.equal(h.calls.posts[0].url, "/api/dub/jobs/a/join/video");
    assert.equal(h.calls.posts[0].file.name, "walk.mp4");
    assert.equal(h.calls.posts[0].file.size, picked.size);
    assert.equal(h.$("joinBringNote").textContent, "");
    assert.equal(h.$("joinBringBtn").disabled, false);
    assert.equal(h.$("joinBring").hidden, true, "a video is in");
    assert.equal(h.picture.getAttribute("src"), "/api/dub/jobs/a/join/video?v=s1");
    assert.equal(h.calls.changes, 2, "the answer, then the video");
    const join = h.player.getJoin();
    assert.deepEqual(join.video, { name: "walk.mp4", duration: 40 });
    assert.deepEqual(join.audio, { duration: 30 });
  } finally { h.restore(); }
});

test("a file that is not a video is turned away before anything is sent", async () => {
  const h = harness({ joins: { a: { video: null } },
                      checkFile: (f) => (f.name.endsWith(".mp4") ? null : "This tool takes video files only.") });
  try {
    h.player.open("a");
    await turn();
    h.$("joinFile").files = [file("voice.wav")];
    h.$("joinFile").fire("change");
    await turn();
    assert.deepEqual(h.calls.posts, []);
    assert.equal(h.$("joinBringNote").textContent, "This tool takes video files only.");
    assert.ok(h.$("joinBringNote").classes.has("form-error"));
    assert.equal(h.$("joinBring").hidden, false);
  } finally { h.restore(); }
});

test("a refusal says the app's sentence, or the page's own, and the row stays", async () => {
  let answer = () => new Response(JSON.stringify({ detail: "Only for audio projects." }), { status: 409 });
  const h = harness({ joins: { a: { video: null } }, upload: () => answer() });
  try {
    h.player.open("a");
    await turn();
    h.$("joinFile").files = [file()];
    h.$("joinFile").fire("change");
    await turn();
    await turn();
    assert.equal(h.$("joinBringNote").textContent, "Only for audio projects.");
    assert.ok(h.$("joinBringNote").classes.has("form-error"));
    assert.equal(h.$("joinBring").hidden, false);
    assert.equal(h.$("joinBringBtn").disabled, false);
    assert.equal(h.player.getJoin(), null);
    answer = () => new Response("oops", { status: 500 });
    h.$("joinFile").fire("change", { target: { files: [file()], value: "" } });
    assert.ok(!h.$("joinBringNote").classes.has("form-error"), "trying again is not an error yet");
    await turn();
    await turn();
    assert.equal(h.$("joinBringNote").textContent, "Could not bring the video in.");
  } finally { h.restore(); }
});

test("a video dropped on the box is brought in; anything else dropped, or a drop with a video in, is left alone", async () => {
  const h = harness({ joins: { a: { video: null } } });
  try {
    const wrap = h.$("videoWrap");
    const drop = (types = ["Files"]) => ({ dataTransfer: { types, files: [file()] } });
    assert.equal(wrap.fire("dragover", drop()).prevented, false, "no project open");
    h.player.open("a");
    await turn();
    assert.equal(wrap.fire("dragover", drop(["text/plain"])).prevented, false);
    assert.equal(wrap.fire("dragover", drop()).prevented, true);
    assert.equal(wrap.fire("drop", drop()).prevented, true);
    await turn();
    await turn();
    assert.equal(h.calls.posts.length, 1);
    assert.ok(h.player.getJoin());
    // With the video in the box takes no more drops.
    assert.equal(wrap.fire("drop", drop()).prevented, false);
    await turn();
    assert.equal(h.calls.posts.length, 1);
  } finally { h.restore(); }
});

test("a video brought in while the sound plays starts playing with it", async () => {
  const h = harness({ joins: { a: { video: null } } });
  try {
    h.player.open("a");
    await turn();
    h.sound.play();
    h.sound.playTo(8);
    h.$("joinFile").files = [file()];
    h.$("joinFile").fire("change");
    await turn();
    await turn();
    assert.equal(h.picture.paused, false);
    assert.equal(h.player.getJoin().paused(), false);
    h.frame();
    assert.equal(h.picture.currentTime, 8, "at the sound's moment");
  } finally { h.restore(); }
});

test("a video that arrives after its project was left is not put on the next one", async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const h = harness({ joins: { a: { video: null }, b: { video: null } },
                      upload: async () => { await held; return new Response("{}", { status: 200 }); } });
  try {
    h.player.open("a");
    await turn();
    h.$("joinFile").files = [file()];
    h.$("joinFile").fire("change");
    h.player.open("b");
    await turn();
    assert.equal(h.$("joinBringNote").textContent, "", "the other project's note is not this one's");
    assert.equal(h.$("joinBringBtn").disabled, true, "one at a time");
    h.joins.a = structuredClone(JOINED);
    release();
    await turn();
    await turn();
    assert.equal(h.player.getJoin(), null);
    assert.equal(h.picture.getAttribute("src"), null);
    assert.equal(h.$("joinBring").hidden, false);
    assert.equal(h.$("joinBringBtn").disabled, false);
  } finally { h.restore(); }
});

test("getJoin is the contract the timeline reads, in joined time", async () => {
  const h = await joined({ ...JOINED, ranges: { video: [[5, 25]], audio: [[0, 10], [20, 30]] } });
  try {
    const join = h.player.getJoin();
    assert.deepEqual(Object.keys(join).sort(),
                     ["audio", "clips", "paused", "seek", "setClips", "setTempo", "tempo", "time", "video"]);
    assert.deepEqual(join.clips(), { video: [[5, 25]], audio: [[0, 10], [20, 30]] });
    assert.equal(join.tempo(), 1);
    assert.equal(join.paused(), true);
    assert.equal(join.time(), 0);
    // What it hands out is a copy: changing it changes nothing.
    join.clips().video[0][0] = 99;
    assert.deepEqual(join.clips().video, [[5, 25]]);
    // 12 s joined: 22 s into the sound's file, 17 s into the picture's.
    join.seek(12);
    assert.equal(h.sound.currentTime, 22);
    assert.equal(h.picture.currentTime, 17);
    assert.equal(join.time(), 12);
    // Never past either end.
    join.seek(-3);
    assert.equal(join.time(), 0);
    join.seek(999);
    assert.equal(join.time(), 20);
    assert.equal(h.player.end(), 20);
  } finally { h.restore(); }
});

test("the picture is put on the sound's moment when the video arrives and when the sound is moved", async () => {
  const h = await joined();
  try {
    // A script line is pressed: the page moves the sound element itself.
    h.sound.currentTime = 12.001;
    assert.equal(h.picture.currentTime, 12.001);
    // The picture's file opens after its address is set: it goes to that moment.
    h.picture.playTo(0);
    h.picture.fire("loadedmetadata");
    assert.equal(h.picture.currentTime, 12.001);
  } finally { h.restore(); }
});

test("the picture plays and stops with the sound, and is nudged or moved to keep step", async () => {
  const h = await joined();
  try {
    // The page plays the sound element, as it always has.
    h.sound.play();
    assert.equal(h.picture.paused, false);
    assert.equal(h.player.playing(), true);
    assert.equal(h.player.getJoin().paused(), false);
    assert.equal(h.frames.length, 1, "one frame asked for");
    // In step: left alone.
    h.sound.playTo(2); h.picture.playTo(2);
    const moves = h.picture.moves.length;
    h.frame();
    assert.equal(h.picture.playbackRate, 1);
    assert.equal(h.picture.moves.length, moves);
    // A tenth of a second behind: a little faster, not moved.
    h.sound.playTo(3); h.picture.playTo(2.9);
    h.frame();
    assert.ok(h.picture.playbackRate > 1);
    assert.equal(h.picture.moves.length, moves);
    // Caught up: its own speed again.
    h.sound.playTo(4); h.picture.playTo(4);
    h.frame();
    assert.equal(h.picture.playbackRate, 1);
    // Half a second off: moved.
    h.sound.playTo(5); h.picture.playTo(4.5);
    h.frame();
    assert.equal(h.picture.currentTime, 5);
    assert.equal(h.frames.length, 1, "and the next frame is asked for, once");
    // The sound is paused while the picture is being hurried: the picture
    // stops too, at its own speed again, and no more frames are turned.
    h.sound.playTo(6); h.picture.playTo(5.9);
    h.frame();
    assert.ok(h.picture.playbackRate > 1);
    h.sound.pause();
    assert.equal(h.picture.paused, true);
    assert.equal(h.picture.playbackRate, 1);
    assert.equal(h.player.playing(), false);
    h.frame();
    assert.equal(h.frames.length, 0);
  } finally { h.restore(); }
});

// Opening another file on the sound element (a line made again, the Original
// tab) stops it with no "pause" signal.
test("a sound that stopped without saying so stops the picture at the next frame", async () => {
  const h = await joined();
  try {
    h.sound.play();
    h.sound.playTo(5); h.picture.playTo(5);
    h.sound.paused = true;
    h.frame();
    assert.equal(h.picture.paused, true);
    assert.equal(h.player.getJoin().paused(), true);
    assert.equal(h.frames.length, 0);
  } finally { h.restore(); }
});

test("a move that takes time is not asked for twice, and the next one aims ahead by as long as it took", async () => {
  const h = await joined();
  try {
    h.sound.play();
    h.picture.slow = true;
    h.sound.playTo(10); h.picture.playTo(2);
    h.frame();
    assert.deepEqual(h.picture.moves.slice(-1), [10]);
    const moves = h.picture.moves.length;
    // Still on its way while the sound plays on: not asked again.
    h.sound.playTo(10.3);
    h.frame();
    assert.equal(h.picture.moves.length, moves);
    // It landed 300 ms later, so the next move aims 0.3 s ahead of the sound.
    h.time.ms = 300;
    h.picture.land();
    h.sound.playTo(20);
    h.frame();
    assert.ok(Math.abs(h.picture.moves.at(-1) - 20.3) < 1e-9);
  } finally { h.restore(); }
});

test("the sound skips what is cut away from its lane, and the picture what is cut away from its own", async () => {
  const h = await joined({ ...JOINED, ranges: { video: [[0, 10], [20, 50]], audio: [[0, 10], [20, 30]] } });
  try {
    h.sound.play();
    // The sound ran into its gap: on to the next kept part.
    h.sound.playTo(10.02); h.picture.playTo(10.02);
    h.frame();
    assert.equal(h.sound.currentTime, 20);
    // 10 s joined is 20 s into the picture's file too: its own gap is stepped over.
    assert.equal(h.picture.currentTime, 20);
  } finally { h.restore(); }
});

test("when the sound ends first the picture runs on as the clock, and both stop at the picture's end", async () => {
  const h = await joined();   // 30 s of sound, 40 s of picture
  try {
    const join = h.player.getJoin();
    h.sound.play();
    h.sound.playTo(30); h.picture.playTo(30);
    h.sound.ended = true;
    const ticks = h.calls.ticks;
    h.frame();
    assert.equal(h.sound.paused, true, "the sound is over");
    assert.equal(h.picture.paused, false, "the picture is not");
    assert.equal(join.paused(), false);
    assert.ok(h.calls.ticks > ticks, "the page is told: the sound's own signals say stopped");
    // The picture's signals move the clock now.
    h.picture.playTo(35);
    const before = h.calls.ticks;
    h.picture.fire("timeupdate");
    assert.equal(h.calls.ticks, before + 1);
    assert.equal(join.time(), 35);
    h.frame();
    assert.equal(h.picture.paused, false);
    // The end of what is kept of the picture: both stand still on it.
    h.picture.playTo(40.01);
    h.frame();
    assert.equal(h.picture.paused, true);
    assert.equal(h.picture.currentTime, 40, "on its last kept frame, not past it");
    assert.equal(join.paused(), true);
    assert.equal(join.time(), 40);
    assert.equal(h.frames.length, 0);
    // Play pressed there starts from the top, with the sound.
    h.player.play();
    assert.equal(h.sound.currentTime, 0);
    assert.equal(h.picture.currentTime, 0);
    assert.equal(h.sound.paused, false);
    assert.equal(h.picture.paused, false);
  } finally { h.restore(); }
});

// A browser stops a file that played to its end and says "pause" before any
// frame has seen that it ended.
test("a sound that plays to its own end does not stop the picture: the tail plays to the picture's end", async () => {
  const h = await joined({ ...JOINED, video: { name: "long.mp4", seconds: 30 }, audio_seconds: 10,
                           ranges: { video: [[0, 30]], audio: [[0, 10]] } });
  try {
    const join = h.player.getJoin();
    h.player.play();
    h.sound.playTo(5); h.picture.playTo(5);
    h.frame();
    h.picture.playTo(10);
    h.sound.playOut(10);
    assert.equal(h.picture.paused, false, "the sound's own end is not a pause");
    assert.equal(join.paused(), false);
    assert.equal(h.frames.length, 1, "the next frame is still asked for");
    h.frame();
    assert.equal(h.picture.paused, false);
    assert.equal(join.paused(), false);
    h.picture.playTo(20);
    h.frame();
    assert.equal(join.time(), 20, "the picture is the clock");
    // Pause and play in the tail are the picture's alone, from where it stands.
    h.player.pause();
    assert.equal(h.picture.paused, true);
    assert.equal(join.paused(), true);
    h.player.play();
    assert.equal(h.sound.paused, true);
    assert.equal(h.picture.paused, false);
    assert.equal(join.time(), 20);
    // The picture's end: both stand still on it, and play starts from the top.
    h.picture.playTo(30.01);
    h.frame();
    assert.equal(h.picture.paused, true);
    assert.equal(join.paused(), true);
    assert.equal(join.time(), 30);
    assert.equal(h.frames.length, 0);
    h.player.play();
    assert.equal(h.sound.currentTime, 0);
    assert.equal(h.picture.currentTime, 0);
    assert.equal(h.sound.paused, false);
    assert.equal(h.picture.paused, false);
  } finally { h.restore(); }
});

test("a sound that plays to its own end where the joined video ends stops both there", async () => {
  const h = await joined({ ...JOINED, video: { name: "same.mp4", seconds: 30 },
                           ranges: { video: [[0, 30]], audio: [[0, 30]] } });
  try {
    const join = h.player.getJoin();
    h.player.play();
    h.picture.playTo(29.98);
    h.sound.playOut(29.98);   // a file can end a hair before the length the app gave
    h.frame();
    assert.equal(h.picture.paused, true);
    assert.equal(h.picture.currentTime, 30, "on its last kept frame");
    assert.equal(join.paused(), true);
    assert.equal(h.frames.length, 0);
    h.player.play();
    assert.equal(h.sound.currentTime, 0, "play there starts from the top");
    assert.equal(h.picture.currentTime, 0);
    assert.equal(join.paused(), false);
  } finally { h.restore(); }
});

test("in the tail, pause and play are the picture's alone; a line pressed there stops it on that line", async () => {
  const h = await joined();
  try {
    const join = h.player.getJoin();
    join.seek(35);
    assert.equal(h.sound.currentTime, 30, "the sound stands at its end");
    assert.equal(h.picture.currentTime, 35);
    assert.equal(join.time(), 35);
    h.player.play();
    assert.equal(h.sound.paused, true);
    assert.equal(h.picture.paused, false);
    assert.equal(join.paused(), false);
    h.player.pause();
    assert.equal(h.picture.paused, true);
    assert.equal(join.paused(), true);
    // Playing in the tail, a script line is pressed: the page moves the sound.
    h.player.play();
    h.sound.currentTime = 12;
    assert.equal(join.paused(), true);
    assert.equal(h.picture.paused, true);
    assert.equal(h.picture.currentTime, 12);
    assert.equal(join.time(), 12);
  } finally { h.restore(); }
});

test("sound longer than the picture stops where the picture ends", async () => {
  const h = await joined({ ...JOINED, video: { name: "short.mp4", seconds: 20 },
                           ranges: { video: [[0, 20]], audio: [[0, 30]] } });
  try {
    const join = h.player.getJoin();
    h.player.play();
    h.sound.playTo(20.01); h.picture.playTo(20);
    h.frame();
    assert.equal(h.sound.paused, true);
    assert.equal(h.picture.paused, true);
    assert.equal(join.paused(), true);
    assert.equal(join.time(), 20);
    // Seeking to the end stands on the same moment.
    join.seek(0);
    join.seek(20);
    assert.equal(join.time(), 20);
    assert.equal(h.sound.currentTime, 20);
  } finally { h.restore(); }
});

test("speed is the sound's playback rate with its pitch kept, and joined time follows it", async () => {
  const h = await joined({ ...JOINED, tempo: 2 });
  try {
    const join = h.player.getJoin();
    assert.equal(h.sound.playbackRate, 2);
    assert.equal(h.sound.defaultPlaybackRate, 2, "a file opened on the same element keeps it");
    assert.equal(h.sound.preservesPitch, true);
    assert.equal(h.picture.playbackRate, 1, "the picture is not sped up");
    // 10 s into the sound is 5 s into the joined video.
    h.sound.currentTime = 10;
    assert.equal(join.time(), 5);
    assert.equal(h.picture.currentTime, 5);
    join.setTempo(0.5);
    assert.equal(join.tempo(), 0.5);
    assert.equal(h.sound.playbackRate, 0.5);
    assert.equal(join.time(), 20);
    assert.equal(h.picture.currentTime, 20);
    await h.player.saved();
    assert.deepEqual(h.calls.puts, [{ url: "/api/dub/jobs/a/join",
                                      body: { video: [[0, 40]], audio: [[0, 30]], tempo: 0.5 } }]);
  } finally { h.restore(); }
});

test("new cuts are taken at once and saved a moment later, once", async () => {
  const h = await joined();
  try {
    const join = h.player.getJoin();
    h.sound.currentTime = 12;
    join.setClips({ video: [[5, 40]], audio: [[0, 30]] });
    assert.equal(h.picture.currentTime, 17, "the picture shows the same joined moment under the new cuts");
    join.setClips({ video: [[5, 35]], audio: [[0, 10], [20, 30]] });
    assert.deepEqual(join.clips(), { video: [[5, 35]], audio: [[0, 10], [20, 30]] });
    assert.deepEqual(h.calls.puts, [], "not on every change");
    await h.player.saved();
    assert.deepEqual(h.calls.puts, [{ url: "/api/dub/jobs/a/join",
                                      body: { video: [[5, 35]], audio: [[0, 10], [20, 30]], tempo: 1 } }]);
    await h.player.saved();
    assert.equal(h.calls.puts.length, 1, "nothing waiting, nothing sent");
  } finally { h.restore(); }
});

test("leaving the project lets the picture go, sends what was waiting and puts the sound's speed back", async () => {
  const h = await joined({ ...JOINED, tempo: 1.5 });
  try {
    h.player.getJoin().setTempo(2);
    h.sound.play();
    h.player.open(null);
    await turn();
    assert.equal(h.calls.puts.length, 1, "the change is not lost");
    assert.equal(h.calls.puts[0].body.tempo, 2);
    assert.equal(h.picture.getAttribute("src"), null);
    assert.equal(h.picture.loads, 1);
    assert.equal(h.picture.paused, true);
    assert.equal(h.sound.playbackRate, 1);
    assert.equal(h.sound.defaultPlaybackRate, 1);
    assert.equal(h.player.getJoin(), null);
    // The sound element is the next project's: its signals move no picture.
    const moves = h.picture.moves.length;
    h.sound.currentTime = 7;
    h.sound.play();
    assert.equal(h.picture.moves.length, moves);
    assert.equal(h.picture.paused, true);
  } finally { h.restore(); }
});

test("an answer that arrives after another project was opened is dropped", async () => {
  const h = harness({ joins: { a: structuredClone(JOINED), b: { video: null } } });
  try {
    h.player.open("a");
    h.player.open("b");
    await turn();
    assert.equal(h.player.getJoin(), null);
    assert.equal(h.picture.getAttribute("src"), null);
    assert.equal(h.$("joinBring").hidden, false);
  } finally { h.restore(); }
});

// -- Change the video, and a picture this browser cannot show -------------------

test("Change the video opens the same picker; the picture lets go of its file before the new one is sent", async () => {
  let h = null;
  let srcAtSend = "unset";
  const upload = (jid) => {
    srcAtSend = h.picture.getAttribute("src");
    h.joins[jid] = { ...structuredClone(JOINED), video: { name: "other.mp4", seconds: 20 }, stamp: "s2" };
    return new Response("{}", { status: 200 });
  };
  h = await joined(JOINED, { upload });
  try {
    h.sound.play();
    h.player.change();
    assert.equal(h.$("joinFile").clicks, 1);
    h.$("joinFile").files = [file("other.mp4")];
    h.$("joinFile").fire("change");
    // While it goes in: stopped, the picture's file let go, and the box says so.
    assert.equal(h.sound.paused, true);
    assert.equal(h.picture.getAttribute("src"), null);
    assert.ok(h.picture.loads >= 1, "the element is told to drop what it had open");
    assert.equal(h.$("joinBringNote").textContent, "Bringing the video in…");
    assert.equal(h.$("joinBring").hidden, false, "the line is shown over the picture");
    await turn();
    await turn();
    assert.equal(srcAtSend, null, "nothing held the old file while the new one was sent");
    assert.equal(h.picture.getAttribute("src"), "/api/dub/jobs/a/join/video?v=s2");
    assert.equal(h.player.getJoin().video.name, "other.mp4");
    assert.equal(h.$("joinBringNote").textContent, "");
    assert.equal(h.$("joinBring").hidden, true);
  } finally { h.restore(); }
});

test("a replacement the app refuses puts the old picture back and says why; no video in, no picker", async () => {
  const upload = () => new Response(JSON.stringify({ detail: "Not enough room." }), { status: 507 });
  const h = await joined(JOINED, { upload });
  try {
    const before = h.player.getJoin();
    h.player.change();
    h.$("joinFile").files = [file()];
    h.$("joinFile").fire("change");
    await turn();
    await turn();
    assert.equal(h.picture.getAttribute("src"), "/api/dub/jobs/a/join/video?v=s1");
    assert.equal(h.player.getJoin(), before);
    assert.equal(h.$("joinBringNote").textContent, "Not enough room.");
    assert.ok(h.$("joinBringNote").classes.has("form-error"));
    assert.equal(h.$("joinBring").hidden, false);
  } finally { h.restore(); }
  const g = harness({ joins: { a: { video: null } } });
  try {
    g.player.open("a");
    await turn();
    g.player.change();
    assert.equal(g.$("joinFile").clicks, 0, "bringing one in is the box's button");
  } finally { g.restore(); }
});

test("a picture this browser cannot decode says so in the box, and the sound plays on", async () => {
  const h = await joined();   // 30 s of sound, 40 s of picture
  try {
    h.picture.fire("error");
    assert.equal(h.$("joinBringNote").textContent,
      "This video cannot be previewed here. The dubbed video is still made.");
    assert.ok(!h.$("joinBringNote").classes.has("form-error"), "a fact, not a failure");
    assert.equal(h.$("joinBring").hidden, false);
    const join = h.player.getJoin();
    h.sound.play();
    h.sound.playTo(12);
    h.frame();
    assert.equal(h.sound.paused, false);
    assert.equal(join.paused(), false);
    assert.equal(join.time(), 12, "the sound is the clock");
    // Where the sound ends there is no picture to run on: the joined video stops.
    h.sound.playTo(30);
    h.sound.ended = true;
    h.frame();
    h.frame();
    assert.equal(join.paused(), true);
    assert.equal(h.frames.length, 0, "nothing left waiting on a picture that never moves");
  } finally { h.restore(); }
});

test("an error from an element with no picture on it says nothing, and another project clears the line", async () => {
  const h = await joined();
  try {
    h.picture.removeAttribute("src");
    h.picture.fire("error");
    assert.equal(h.$("joinBringNote").textContent, "");
    h.picture.setAttribute("src", "x");
    h.picture.fire("error");
    assert.notEqual(h.$("joinBringNote").textContent, "");
    h.joins.b = { video: null };
    h.player.open("b");
    assert.equal(h.$("joinBringNote").textContent, "");
  } finally { h.restore(); }
});
