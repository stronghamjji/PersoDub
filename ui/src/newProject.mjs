// The New project dialog: what opens the moment a video or a link is ready,
// and the only place a job can be started from. Everything the first screen
// stopped asking for lives in here -- the thumbnail and its trim bar, the two
// language dropdowns, Advanced options, and the Start button.
//
// What is NOT here: the two ways IN (the upload zone's drag-and-drop and the
// link field) stay on the home screen with the rest of index.html and call
// openNewProject(); startDubbing stays there too, because it drives the
// running screen and the top bar -- this file only hands it the form through
// readOptions() and wires it to the Start button. The repaint passes that
// reach across sections (the hints under the dropdowns, the cloud-mode
// greying, the key-gated greying) are passed in rather than moved, and so is
// playRange/cancelRange, which the finished screen plays its lines with.
//
// Everything this file touches is #projectOverlay and its children.
import { LANGUAGES } from "./dubApi.mjs";
import { fmtClock, fmtClockTenths } from "./format.mjs";

// The flags are the app's one deliberate use of emoji: where the dub is headed
// is the single most-glanced-at line in the dialog, and a flag says it faster
// than a word. The Original dropdown stays plain -- its default is not a
// country at all ("Auto-detect"), so a half-flagged list would only look broken.
const LANG_FLAGS = {
  en: "🇺🇸", ko: "🇰🇷", zh: "🇨🇳", fr: "🇫🇷", de: "🇩🇪",
  it: "🇮🇹", ja: "🇯🇵", pt: "🇵🇹", ru: "🇷🇺", es: "🇪🇸",
};

// The shortest part worth dubbing; also what keeps the two handles from
// crossing over each other.
const TRIM_MIN_SPAN = 0.5;
// What one nudge of a handle is worth -- the sliders' step, in seconds.
const TRIM_STEP = 0.1;
// How far apart the ruler's ticks are, and the coarsest they may ever be read
// in: squeezed, they thin out to 10s, 15s, 20s rather than to 6s or 7s.
const TRIM_TICK_SEC = 5;

/**
 * Wire the New project dialog to a page.
 *
 * @param {object} deps
 * @param {(id: string) => any} deps.$   the page's getElementById helper
 * @param {object} deps.state            the page's shared state object; this file
 *        reads and writes state.newProject and nothing else on it
 * @param {() => void} deps.onStart      what the Start button does (startDubbing)
 * @param {() => void} deps.applyEngineAvailability  re-grey the key-gated options
 * @param {() => void} deps.updateEngineHints  repaint the hint under each dropdown
 * @param {() => void} deps.paintDubMode  grey the per-stage dropdowns in cloud mode
 * @param {(video, start, end) => Promise} deps.playRange  play only [start, end]
 * @param {(video) => void} deps.cancelRange  forget a range never played out
 * @param {() => number} deps.labelPx    how much room a clock label needs on a
 *        ruler -- the timeline's own TL_LABEL_PX, read late because the page
 *        declares it further down than this dialog is wired up
 * @param {() => void} deps.onClosed     forget the source the dialog was holding:
 *        the home screen's error line, the file input and the link field
 * @param {() => void} deps.onPickFile   open the file picker (Replace)
 * @returns the operations the rest of the page calls.
 */
export function initNewProjectUi({ $, state, onStart, applyEngineAvailability,
                                   updateEngineHints, paintDubMode,
                                   playRange, cancelRange, labelPx,
                                   onClosed, onPickFile }) {
  // Populated from dubApi.LANGUAGES (the model's own supported-language table).
  // sourceLangSelect's default is the literal "Auto-detect" <option> written into
  // its markup -- defCode null never matches a real LANGUAGES code, so no
  // appended option overwrites that selection with a specific language.
  // targetLangSelect defaults to English: the app's own use is Korean source
  // material dubbed outward. Neither default is remembered between launches --
  // every launch starts here.
  function fillLanguageSelects() {
    for (const [selId, defCode, withFlag] of [["sourceLangSelect", null, false], ["targetLangSelect", "en", true]]) {
      const sel = $(selId);
      if (!sel) continue;
      for (const l of LANGUAGES) {
        const o = document.createElement("option");
        o.value = l.code;
        o.textContent = withFlag && LANG_FLAGS[l.code] ? `${LANG_FLAGS[l.code]} ${l.name}` : l.name;
        if (l.code === defCode) o.selected = true;
        sel.appendChild(o);
      }
    }
  }
  fillLanguageSelects();

  // The dropdowns start on the app's saved defaults (GET /api/setup: kit.env,
  // written by Settings or the Dub Agent's set_default), so what the agent
  // changed is what the dialog shows, and a choice survives a relaunch.
  async function loadSavedDefaults() {
    let d;
    try {
      const r = await fetch("/api/setup");
      if (!r.ok) return;
      d = (await r.json()).defaults || {};
    } catch { return; }
    const pick = (id, value) => {
      const sel = $(id);
      if (sel && value && sel.querySelector(`option[value="${value}"]`)) sel.value = value;
    };
    pick("dubModeSelect", d.dub_mode);
    pick("sepSelect", d.separation);
    pick("sttSelect", d.stt);
    pick("translateSelect", d.translator);
    pick("qualitySelect", d.voice_quality);
  }

  // The play button's purple-while-playing state is driven by the video, whose
  // listeners outlive the box; kept here so re-drawing swaps them rather than
  // piling a second set on.
  let trimPlayState = null;

  // Draws the trim box: play button, readout, and a bar with a handle at each
  // end. Called once a local file's length is known (a link has none to scrub).
  function renderTrim(duration) {
    const box = $("trimBox");
    // No usable length (metadata still loading, or a stream): draw nothing
    // rather than a bar that lies. The loadedmetadata handler calls back.
    if (!Number.isFinite(duration) || duration < 1) { box.innerHTML = ""; return; }

    box.innerHTML = `
      <div class="trim-row">
        <button class="trim-play" id="trimPlay" type="button" title="Play the selected part" aria-label="Play the selected part">
          <svg class="ico-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 5.5v13l10.5-6.5z"/></svg>
          <svg class="ico-pause" viewBox="0 0 18 18" aria-hidden="true"><rect x="5" y="3" width="3" height="12" rx="1"/><rect x="10" y="3" width="3" height="12" rx="1"/></svg>
        </button>
        <span class="trim-label">Trim</span>
        <span class="trim-read" id="trimRead"></span>
      </div>
      <div class="trim-scale" id="trimScale">
        <div class="trim-bar">
          <div class="trim-hatch" id="trimHatchStart" style="left: 0"></div>
          <div class="trim-hatch" id="trimHatchEnd" style="right: 0"></div>
          <div class="trim-sel" id="trimSel"></div>
          <input type="range" class="trim-range" id="trimStart" min="0" step="${TRIM_STEP}" aria-label="Trim start">
          <input type="range" class="trim-range" id="trimEnd" min="0" step="${TRIM_STEP}" aria-label="Trim end">
          <div class="trim-head" id="trimHead" hidden><i></i></div>
        </div>
        <div class="trim-ruler" id="trimRuler"></div>
      </div>`;

    const startInput = $("trimStart"), endInput = $("trimEnd");
    startInput.max = endInput.max = String(duration);
    startInput.value = "0";
    endInput.value = String(duration);

    // Where a slider's thumb centre sits: half a thumb in from each edge, which
    // is exactly how the browser lays a range out. The painted layers use the
    // same formula so bar and handles never drift apart.
    const at = (sec) => `calc(5px + (100% - 10px) * ${sec / duration})`;

    // The ruler under the bar, ticked on that same mapping. Every 5 seconds
    // where they fit; where they do not, the timeline's rule -- a label needs
    // labelPx of room, so thin the ticks until it has it -- rounded up to
    // whole fives. Settled once, from the width the bar has now.
    const room = Math.max(1, $("trimScale").clientWidth - 10);
    const every = TRIM_TICK_SEC *
      Math.max(1, Math.ceil((labelPx() * duration) / (room * TRIM_TICK_SEC)));
    let ticks = "";
    for (let s = 0; s <= Math.floor(duration); s += every) {
      // The label hangs to the RIGHT of its tick, so the last one would run off
      // the end and be cut in half. A tick with no room keeps the line and
      // drops the label.
      const label = 5 + room * (s / duration) + labelPx() <= room + 10
        ? `<span>${fmtClock(s)}</span>` : "";
      ticks += `<div class="trim-tick" style="left:${at(s)}">${label}</div>`;
    }
    $("trimRuler").innerHTML = ticks;

    function paint() {
      const start = Number(startInput.value), end = Number(endInput.value);
      $("trimHatchStart").style.width = at(start);
      $("trimHatchEnd").style.left = at(end);
      $("trimSel").style.left = at(start);
      $("trimSel").style.width = `calc((100% - 10px) * ${(end - start) / duration})`;
      // Both handles parked at the ends is not a trim -- send no range at all,
      // so the server keeps the file exactly as uploaded. Within one step of the
      // end counts as the end: a slider snaps to its 0.1 s grid, so a length like
      // 22.08s can only ever be dragged back to 22.0.
      const whole = start <= 0 && end >= duration - TRIM_STEP;
      // Which is also why the readout counts a full range against the real
      // length: otherwise an untrimmed 22.085s video reads "22.0s of 22.1s", as
      // if a tenth had been shaved off it.
      const shownEnd = whole ? duration : end;
      $("trimRead").textContent =
        `${fmtClockTenths(start)} – ${fmtClockTenths(shownEnd)} · ${(shownEnd - start).toFixed(1)}s of ${duration.toFixed(1)}s`;
      if (state.newProject) state.newProject.trim = whole ? null : { start, end };
      // A handle dragged past the playhead leaves it outside the part being
      // dubbed, where it means nothing: put it away.
      if (headAt !== null && (headAt < start || headAt > end)) {
        headAt = null;
        $("trimHead").hidden = true;
      }
    }

    startInput.addEventListener("input", () => {
      startInput.value = String(Math.min(Number(startInput.value), Number(endInput.value) - TRIM_MIN_SPAN));
      paint();
    });
    endInput.addEventListener("input", () => {
      endInput.value = String(Math.max(Number(endInput.value), Number(startInput.value) + TRIM_MIN_SPAN));
      paint();
    });

    const video = $("projectVideo"), playBtn = $("trimPlay");
    // Where the playhead stands when nothing is playing: null means "nowhere",
    // and the line is not drawn at all. Set by a drag, a click on the selection,
    // or by playback stopping partway.
    let headAt = null;
    // The reverse of at(): a pointer's x turned back into a second of the video,
    // never outside the part that is actually going to be dubbed.
    const secAt = (clientX) => {
      const box = $("trimSel").parentElement.getBoundingClientRect();
      const sec = ((clientX - box.left - 5) / Math.max(1, box.width - 10)) * duration;
      return Math.min(Math.max(sec, Number(startInput.value)), Number(endInput.value));
    };
    const head = $("trimHead");
    // Moving the playhead moves the preview with it: the video seeks, the line
    // follows the pointer and the badge counts along.
    function seekTo(sec) {
      headAt = sec;
      video.currentTime = sec;
      head.style.left = at(sec);
      head.hidden = false;
      $("projectDur").textContent = fmtClockTenths(sec);
    }

    // Dragging the head. The video is stopped for the duration of the drag so
    // playRange's stop-listener cannot fire on a seek, and started again on drop
    // if it had been playing -- from where it was dropped, still stopping at the
    // end of the selection.
    let wasPlaying = false;
    head.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      head.setPointerCapture(e.pointerId);
      wasPlaying = !video.paused;
      if (wasPlaying) cancelRange(video);
      seekTo(secAt(e.clientX));
    });
    head.addEventListener("pointermove", (e) => {
      if (head.hasPointerCapture(e.pointerId)) seekTo(secAt(e.clientX));
    });
    head.addEventListener("pointerup", (e) => {
      if (!head.hasPointerCapture(e.pointerId)) return;
      head.releasePointerCapture(e.pointerId);
      if (wasPlaying) playRange(video, headAt, Number(endInput.value)).catch(() => {});
      wasPlaying = false;
    });
    // A click anywhere on the chosen part puts the playhead there too. The
    // handles sit on top of their own ends, so they still grab first.
    $("trimSel").addEventListener("pointerdown", (e) => { seekTo(secAt(e.clientX)); });

    // The thumbnail is muted so it can sit quietly; a press on the play
    // button is the user asking to hear the part they picked, so unmute then.
    // A second press pauses -- the same button, the same place.
    playBtn.addEventListener("click", () => {
      if (!video.paused) { cancelRange(video); return; }
      video.muted = false;
      // Play from where the playhead was left standing, not from the start.
      const from = headAt === null ? Number(startInput.value) : headAt;
      playRange(video, from, Number(endInput.value)).catch(() => {});
    });
    if (trimPlayState) {
      for (const e of ["play", "pause", "ended", "timeupdate"]) video.removeEventListener(e, trimPlayState);
    }
    // One handler for play / pause / ended / timeupdate: the button's look, the
    // badge on the thumbnail (the running clock while it plays, the length
    // when it stops) and the playhead line walking the bar.
    trimPlayState = () => {
      const playing = !video.paused && !video.ended;
      playBtn.classList.toggle("playing", playing);
      const label = playing ? "Pause" : "Play the selected part";
      playBtn.title = label; playBtn.setAttribute("aria-label", label);
      if (playing) {
        headAt = video.currentTime;
        $("projectDur").textContent = fmtClockTenths(headAt);
        head.style.left = at(headAt);
        head.hidden = false;
      } else if (headAt !== null && headAt < Number(endInput.value) - TRIM_STEP) {
        // Stopped partway -- by the pause button or by a drag. The line stays
        // where it stopped, and the next press picks up from there.
        $("projectDur").textContent = fmtClockTenths(headAt);
        head.style.left = at(headAt);
        head.hidden = false;
      } else {
        // Played to the end of the selection: back to a bare bar and the length.
        headAt = null;
        $("projectDur").textContent = fmtClock(duration);
        head.hidden = true;
      }
    };
    for (const e of ["play", "pause", "ended", "timeupdate"]) video.addEventListener(e, trimPlayState);

    paint();
  }

  // A dropped file is played straight from memory, which costs an object URL --
  // released whenever the dialog lets go of that file.
  let projectObjectUrl = null;
  function releaseProjectVideo() {
    const v = $("projectVideo");
    cancelRange(v);
    // The trim box goes with the video, so its play/pause listeners go too --
    // otherwise they keep toggling a class on a button that has left the page.
    if (trimPlayState) {
      for (const e of ["play", "pause", "ended", "timeupdate"]) v.removeEventListener(e, trimPlayState);
      trimPlayState = null;
    }
    v.removeAttribute("src");
    v.load();
    if (projectObjectUrl) { URL.revokeObjectURL(projectObjectUrl); projectObjectUrl = null; }
  }

  function openNewProject(source) {
    // Several files come in as `files`; the dialog is then asked once and the
    // same choices start them all, one after another (the queue's job).
    const files = source.files && source.files.length > 1 ? source.files : null;
    const file = source.file || (files ? files[0] : null);
    state.newProject = { file, files, probe: source.probe || null, trim: null };
    releaseProjectVideo();
    const v = $("projectVideo");
    // A local file can be played and scrubbed; a link only ever has a still.
    v.hidden = !file;
    $("projectTitle").textContent = files ? `New projects (${files.length})` : "New project";
    // Replace picks ONE file, which would silently drop the rest of the batch.
    $("projectReplace").hidden = !!files;
    $("projectThumb").style.backgroundImage = "";
    // The previous video's bar would otherwise sit there until this one's
    // length is known -- and stay for good behind a link, which has no bar.
    $("trimBox").innerHTML = "";
    if (file) {
      projectObjectUrl = URL.createObjectURL(file);
      v.src = projectObjectUrl;
      // Only a real file ever fires this, so only a real file may register it --
      // a once-listener that never fires never detaches, and one per link would
      // pile up until the next file opened them all at once.
      v.addEventListener("loadedmetadata", () => {
        if (files) {
          // The first video stands for the batch. No trim: a cut made on this
          // one would mean nothing to the others.
          $("projectDur").textContent = `${files.length} videos`;
        } else {
          $("projectDur").textContent = fmtClock(v.duration);
          renderTrim(v.duration);
        }
      }, { once: true });
    } else if (source.probe && source.probe.thumbnail_url) {
      $("projectThumb").style.backgroundImage = `url(${source.probe.thumbnail_url})`;
    }
    $("projectDur").textContent = source.probe ? fmtClock(source.probe.duration_sec) : "";
    $("projectError").textContent = "";
    // The dropdowns start on the saved defaults every time the dialog opens
    // (the Dub Agent may have changed them a moment ago), then the key-gated
    // options are greyed out. Not on a Settings save: that path must leave a
    // choice the user is in the middle of making alone.
    loadSavedDefaults().then(() => {
      // Setting a select's value fires no change event, so the hints under the
      // dropdowns and the cloud-mode greying must be repainted by hand.
      updateEngineHints();
      paintDubMode();
      applyEngineAvailability();
    });
    $("projectOverlay").classList.add("open");
  }

  // Closing throws the pending video away: the dialog IS the confirmation that a
  // video was accepted, so leaving one half-chosen behind would be a lie.
  function closeNewProject() {
    $("projectOverlay").classList.remove("open");
    releaseProjectVideo();
    state.newProject = null;
    // The home screen forgets the source too: its error line, the file input
    // (otherwise re-picking the same file fires no change event) and the link
    // field with its card (the probe only runs on an `input` event, so a URL
    // left sitting there could never open the dialog again).
    onClosed();
  }
  $("projectClose").addEventListener("click", closeNewProject);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("projectOverlay").classList.contains("open")) closeNewProject();
  });
  $("projectReplace").addEventListener("click", () => { closeNewProject(); onPickFile(); });
  $("advancedBtn").addEventListener("click", () => {
    const open = $("advancedBody").hidden;
    $("advancedBody").hidden = !open;
    $("advancedBtn").setAttribute("aria-expanded", String(open));
    $("advancedBtn").classList.toggle("open", open);
  });

  // Start is wired here so the dialog owns every button inside it; what the
  // button does -- the job, the running screen, the top bar -- stays on the page.
  $("startBtn").addEventListener("click", () => onStart());

  function readOptions() {
    // The dialog owns the source now: either a dropped file or a probed link.
    const np = state.newProject || {};
    return {
      video: np.file || null,
      sourceUrl: np.probe ? np.probe.url : null,
      sourceLang: $("sourceLangSelect").value,
      targetLang: $("targetLangSelect").value,
      sttEngine: $("sttSelect").value,
      sepEngine: $("sepSelect").value,
      dubMode: $("dubModeSelect").value,
      qualityMode: $("qualitySelect").value,
      numSpeakers: $("numSpeakers").value ? Number($("numSpeakers").value) : undefined,
      translateEngine: $("translateSelect").value,
      // A link's title is only known here -- the probe already fetched it, while
      // the server learns nothing from downloading the video. Names the job's
      // folder, so send it along with the job.
      project: np.probe ? np.probe.title : undefined,
      // The part of the video the trim bar has selected, or null for all of it.
      trim: np.trim || null,
    };
  }

  return { openNewProject, closeNewProject, readOptions, loadSavedDefaults,
           releaseProjectVideo };
}
