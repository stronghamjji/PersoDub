// A video brought into a finished audio project: how it comes in, and how the
// page plays it with the dubbed sound before any file is built.
//
// Two elements, one clock. #doneVideo goes on playing the dubbed sound and
// stays the element everything else reads (the script's lit row, the
// subtitles' timing, a line played on its own). #joinVideo, muted, shows the
// picture and follows it: every frame it is asked where it should be
// (ui/src/joinClock.mjs) and hurried, held back or moved there. When the sound
// runs out first the picture runs on as the clock, and both stop at the end of
// what is kept of the picture. The sound's speed is its playbackRate, pitch
// kept. The built file is exact; this preview is close.
//
// The state is the app's (ui/src/dubApi.mjs fetchJoin): asked once per opened
// project, saved a moment after each change.
//
// A video already in is replaced through the same picker (change, the
// timeline's "Change the video"). A picture the browser cannot decode is said
// so in the box, and the sound plays on.
//
// The elements this file touches: #joinVideo and #doneVideo (handed in),
// #joinBring, #joinBringBtn, #joinFile, #joinBringNote, and #videoWrap (a
// video dropped on the box).
import { fetchJoin, saveJoin, uploadJoinVideo, joinVideoUrl } from "./dubApi.mjs";
import { joinedEnd, soundEnd, soundAt, pictureAt, joinedNow, step } from "./joinClock.mjs";
import { keptToSource, playableFrom } from "./cutTools.mjs";
import { pendingSave } from "./pendingSave.mjs";
import { t } from "./i18n.mjs";

// Play pressed this close to the end starts from the top, as a player does.
const AT_END = 0.05;
// The most a move of the picture is aimed ahead to cover the time moving takes.
const MAX_LEAD = 0.5;

const copy = (ranges) => ranges.map(([a, b]) => [a, b]);

/**
 * @param {object} deps
 * @param {(id: string) => any} deps.$   the page's getElementById helper
 * @param {any} deps.sound    #doneVideo: the element that plays the dubbed sound
 * @param {any} deps.picture  #joinVideo: the muted element that shows the picture
 * @param {(file: File) => string|null} deps.checkFile  why a file is not
 *        taken as a video, or null (the page's one rule for picture tools)
 * @param {() => void} [deps.onChange]  the open project's answer arrived, or
 *        a video came in
 * @param {() => void} [deps.onTick]  the joined time or whether it is playing
 *        changed without the sound element saying so (the tail, a seek, the end)
 * @param {(fn: () => void) => void} [deps.raf]  the next frame
 * @param {() => number} [deps.clock]  milliseconds, for how long a move takes
 * @returns {{ open: (jobId: string|null) => void, getJoin: () => object|null,
 *   playing: () => boolean, play: () => void, pause: () => void,
 *   time: () => number, end: () => number, saved: () => Promise<void>,
 *   change: () => void }}
 *   open: the finished audio project on screen, or null for none. getJoin:
 *   null with no video in, else {video: {name, duration}, audio: {duration},
 *   clips() -> {video, audio}, setClips({video, audio}), tempo(), setTempo(x),
 *   time(), seek(j), paused()} with time and seek in joined time. saved: sends
 *   a change still waiting and answers when the app has it.
 */
export function initJoinPlayer({ $, sound, picture, checkFile, onChange = () => {}, onTick = () => {},
                                 raf = (fn) => requestAnimationFrame(fn),
                                 clock = () => performance.now() }) {
  let openId = null;      // the finished audio project on screen
  let loaded = false;     // its answer has arrived
  let now = null;         // {video, audio, tempo} once a video is in (ui/src/joinClock.mjs Join)
  let handle = null;      // what getJoin() answers
  let playing = false;
  let tail = false;       // the sound has run out: the picture is the clock
  let looping = false;    // a frame is already asked for
  let busy = false;       // a video is on its way in
  let broken = false;     // the picture cannot be decoded here
  // How long the picture's last move took, in seconds: the next move while
  // playing aims that far ahead, so it lands where the sound has got to.
  let lead = 0;
  let movedAt = null;

  const position = () => ({ tail, sound: sound.currentTime || 0, picture: picture.currentTime || 0 });
  const time = () => (now ? joinedNow(now, position()) : 0);
  const end = () => (now ? joinedEnd(now) : 0);
  // The sound has nothing more to play: its file ended, or what is kept of it did.
  const soundOut = () => sound.ended || playableFrom(now.audio, sound.currentTime || 0) === null;

  // ---- Saving ----
  let lastSave = Promise.resolve();
  const saver = pendingSave((jobId, body) => {
    // A failed save is tried again by the next change.
    lastSave = saveJoin(jobId, body).catch(() => {});
  });
  function save() {
    saver.schedule(openId, { video: copy(now.video), audio: copy(now.audio), tempo: now.tempo });
  }
  function saved() {
    saver.flush();
    return lastSave;
  }

  // ---- The picture follows the sound ----
  function movePicture(to, ahead) {
    movedAt = clock();
    picture.currentTime = to + (ahead ? lead : 0);
  }
  picture.addEventListener("seeked", () => {
    if (movedAt !== null) lead = Math.min(MAX_LEAD, (clock() - movedAt) / 1000);
    movedAt = null;
    if (now && tail) onTick();
  });
  // In the tail the picture's own signals are the clock's.
  picture.addEventListener("timeupdate", () => { if (now && tail) onTick(); });

  // Standing still: the picture shows the frame of the moment the sound is at.
  function settle() {
    const to = pictureAt(now, time());
    if (Math.abs((picture.currentTime || 0) - to) > 0.01) {
      movedAt = null;
      picture.currentTime = to;
    }
  }
  picture.addEventListener("loadedmetadata", () => { if (now && !playing) settle(); });
  // A picture this browser cannot decode: said in the box, and the sound plays
  // on. With no picture to run on, the tail is not waited for (frame below).
  // An element with nothing on it (a video let go) has nothing to say.
  picture.addEventListener("error", () => {
    if (!now || !picture.getAttribute("src")) return;
    broken = true;
    say(t("This video cannot be previewed here. The dubbed video is still made."));
  });

  function frame() {
    looping = false;
    if (!playing || !now) return;
    // A file opened on the sound element stops it with no "pause" signal.
    // Stopped at its own end is not that: the step below starts the tail.
    if (!tail && sound.paused && !sound.ended) { halt(); return; }
    const s = step(now, { ...position(), soundEnded: sound.ended, pictureEnded: picture.ended || broken });
    if (s.done) { finish(); return; }
    if (s.tail && !tail) {
      // Set before the sound is stopped: its "pause" must not stop the picture.
      tail = true;
      sound.pause();
      onTick();
    }
    if (s.soundTo !== null) sound.currentTime = s.soundTo;
    // One move at a time: asked again before it lands, it would never land.
    if (s.pictureTo !== null && !picture.seeking) movePicture(s.pictureTo, !tail);
    if (picture.playbackRate !== s.rate) picture.playbackRate = s.rate;
    if (picture.paused) picture.play().catch(() => {});
    loop();
  }
  function loop() {
    if (looping) return;
    looping = true;
    raf(frame);
  }
  function start() {
    playing = true;
    if (picture.paused) picture.play().catch(() => {});
    loop();
  }
  function halt() {
    if (!playing) return;
    playing = false;
    picture.pause();
    picture.playbackRate = 1;
    onTick();
  }
  // The joined video is over: both stop on its last frame.
  function finish() {
    tail = true;
    sound.pause();
    movedAt = null;
    picture.currentTime = pictureAt(now, end());
    halt();
  }

  // The sound element is still pressed and moved by the rest of the page (a
  // script line, a timeline bar), so the picture answers to its signals.
  sound.addEventListener("play", () => {
    // Stopped again before this arrived (a seek into the tail): not playing.
    if (!now || sound.paused) return;
    tail = false;
    start();
  });
  // A sound that played to its own end says "pause" too: the picture is not
  // stopped for it, and the next frame starts the tail or finishes.
  sound.addEventListener("pause", () => { if (now && !tail && !sound.ended) halt(); });
  sound.addEventListener("seeked", () => {
    if (!now) return;
    // The tail's own: the sound sits at its end while the picture runs on.
    if (tail && soundOut()) return;
    if (tail) {
      tail = false;
      // Moved back into the sound with only the picture playing: stopped, as
      // a line pressed in the script stops an ordinary project.
      if (sound.paused) halt();
    }
    if (!playing) settle();
  });

  function play() {
    if (!now || playing) return;
    if (time() >= end() - AT_END) seek(0);
    if (!tail) sound.play().catch(() => {});
    start();
  }
  function pause() {
    if (!now) return;
    sound.pause();
    halt();
  }
  function seek(j) {
    const to = Math.min(Math.max(0, j), end());
    const a = soundAt(now, to);
    tail = a === null;
    if (tail) {
      sound.pause();
      sound.currentTime = keptToSource(now.audio, soundEnd(now) * now.tempo);
    } else {
      sound.currentTime = a;
      if (playing && sound.paused) sound.play().catch(() => {});
    }
    movedAt = null;
    picture.currentTime = pictureAt(now, to);
    onTick();
  }

  function setRate() {
    // Speed without the voice going up or down with it.
    sound.preservesPitch = true;
    sound.defaultPlaybackRate = now ? now.tempo : 1;
    sound.playbackRate = now ? now.tempo : 1;
  }

  // ---- The app's answer ----
  function take(d) {
    loaded = true;
    if (d && d.video) {
      now = { video: copy(d.ranges.video), audio: copy(d.ranges.audio), tempo: d.tempo };
      handle = {
        video: { name: d.video.name, duration: d.video.seconds },
        audio: { duration: d.audio_seconds },
        clips: () => ({ video: copy(now.video), audio: copy(now.audio) }),
        setClips: ({ video, audio }) => {
          now.video = copy(video);
          now.audio = copy(audio);
          if (!playing) settle();
          save();
          onTick();
        },
        tempo: () => now.tempo,
        setTempo: (x) => {
          now.tempo = x;
          setRate();
          if (!playing) settle();
          save();
          onTick();
        },
        time, seek,
        paused: () => !playing,
      };
      tail = false;
      lead = 0;
      broken = false;
      picture.setAttribute("src", joinVideoUrl(openId, d.stamp));
      setRate();
      // Brought in while the sound was playing: the picture joins it.
      if (!sound.paused && !sound.ended) start();
    }
    paintBring();
    onChange();
  }

  function release() {
    saver.flush();
    const had = !!now;
    playing = false;
    tail = false;
    broken = false;
    loaded = false;
    now = null;
    handle = null;
    if (had) {
      picture.pause();
      picture.playbackRate = 1;
      picture.removeAttribute("src");
      picture.load();
      // The same element plays the next project's sound, at its own speed.
      setRate();
    }
  }

  function open(jobId) {
    if (jobId === openId) return;
    release();
    openId = jobId;
    say("");
    paintBring();
    if (!jobId) return;
    // An answer for a project already left is dropped; no answer at all leaves
    // the box as it is, since offering to bring a video in would replace one.
    fetchJoin(jobId).then((d) => { if (openId === jobId) take(d); }, () => {});
  }

  // ---- Bringing the video in ----
  function say(text, isError = false) {
    const note = $("joinBringNote");
    note.textContent = text;
    note.classList.toggle("form-error", isError);
    // With a video in, the line is the only thing the box shows for it.
    paintBring();
  }
  const canBring = () => !!openId && loaded && !now;
  // With a video in, the box shows only the line under it, and only when it
  // has something to say (the stylesheet hides the button row then).
  function paintBring() {
    $("joinBring").hidden = !canBring() && !(now && $("joinBringNote").textContent);
    $("joinBringBtn").disabled = busy;
  }

  // A video brought in, or (with one in, from change) replacing it.
  async function bring(file) {
    const jobId = openId;
    if (!file || !openId || !loaded || busy) return;
    const bad = checkFile(file);
    if (bad) { say(bad, true); return; }
    busy = true;
    paintBring();
    say(t("Bringing the video in…"));
    // Windows will not let the app replace a file the page still has open,
    // so the picture lets go of it first, and takes it back if the app says no.
    const held = now ? picture.getAttribute("src") : null;
    if (held) {
      pause();
      picture.removeAttribute("src");
      picture.load();
    }
    // Another project may be on screen by the time the app answers: the video
    // is in for the one it was brought into, and nothing is said on this one.
    try {
      await uploadJoinVideo(jobId, file);
      const d = await fetchJoin(jobId);
      if (openId === jobId) { say(""); take(d); }
    } catch (e) {
      if (openId === jobId) {
        if (held) picture.setAttribute("src", held);
        say((e && e.message) || t("Could not bring the video in."), true);
      }
    }
    busy = false;
    paintBring();
  }
  // Change the video: the same picker, with a video in.
  function change() {
    if (now && !busy) $("joinFile").click();
  }
  $("joinBringBtn").addEventListener("click", () => $("joinFile").click());
  $("joinFile").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    // Emptied, so picking the same file again is still a change.
    e.target.value = "";
    bring(file);
  });
  // A video dropped on the box is the same as one picked.
  const takesDrop = (e) => canBring() && e.dataTransfer
    && Array.from(e.dataTransfer.types || []).includes("Files");
  $("videoWrap").addEventListener("dragover", (e) => { if (takesDrop(e)) e.preventDefault(); });
  $("videoWrap").addEventListener("drop", (e) => {
    if (!takesDrop(e)) return;
    e.preventDefault();
    bring(e.dataTransfer.files && e.dataTransfer.files[0]);
  });

  paintBring();
  return { open, getJoin: () => handle, playing: () => playing, play, pause, time, end, saved, change };
}
