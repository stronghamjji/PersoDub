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
// playRange/cancelRange, which the finished screen plays its lines with. The
// trim bar itself moved out to ui/src/trimBar.mjs, because the Erase subtitles
// screen draws the same one.
//
// Everything this file touches is #projectOverlay and its children.
import { LANGUAGES, fetchLanguages, startDownload, fetchDownload,
         downloadVideoUrl, uploadDownload, saveDownloadClip } from "./dubApi.mjs";
import { fmtClock } from "./format.mjs";
import { initTrimBar } from "./trimBar.mjs";

// The flags are the app's one deliberate use of emoji: where the dub is headed
// is the single most-glanced-at line in the dialog, and a flag says it faster
// than a word. The Original dropdown stays plain -- its default is not a
// country at all ("Auto-detect"), so a half-flagged list would only look broken.
// One flag per language the app can dub into, keyed by the language's id
// (a region tag such as en-GB where Perso tells variants apart, else the
// code). A language spoken in many countries gets the country it is most
// associated with (Arabic: Saudi Arabia, Swahili: Kenya, the Indian
// languages: India); Welsh gets the Union Jack -- the Welsh flag is a tag
// sequence that Windows draws as a bare black flag, unlike the two-letter
// codes it draws for every other flag here (its emoji font has none), which
// is how the original ten already looked there.
// The local list says plainly "Portuguese" and "Spanish": those keep the
// flags they always had. Perso's default regions for the same codes are
// Brazil and Mexico, which is what the Perso list shows.
const LOCAL_FLAGS = { pt: "🇵🇹", es: "🇪🇸" };
const LANG_FLAGS = {
  "af": "🇿🇦", "ar": "🇸🇦", "as": "🇮🇳", "az": "🇦🇿", "be": "🇧🇾", "bg": "🇧🇬", "bn": "🇧🇩", "bs": "🇧🇦",
  "ca": "🇪🇸", "ceb": "🇵🇭", "cs": "🇨🇿", "cy": "🇬🇧", "da": "🇩🇰", "de": "🇩🇪", "el": "🇬🇷", "en": "🇺🇸",
  "en-GB": "🇬🇧", "es": "🇲🇽", "es-ES": "🇪🇸", "et": "🇪🇪", "fa": "🇮🇷", "fi": "🇫🇮", "fil": "🇵🇭", "fr": "🇫🇷",
  "ga": "🇮🇪", "gl": "🇪🇸", "gu": "🇮🇳", "ha": "🇳🇬", "he": "🇮🇱", "hi": "🇮🇳", "hr": "🇭🇷", "hu": "🇭🇺",
  "hy": "🇦🇲", "id": "🇮🇩", "is": "🇮🇸", "it": "🇮🇹", "ja": "🇯🇵", "jv": "🇮🇩", "ka": "🇬🇪", "kk": "🇰🇿",
  "kn": "🇮🇳", "ko": "🇰🇷", "ky": "🇰🇬", "lb": "🇱🇺", "ln": "🇨🇩", "lt": "🇱🇹", "lv": "🇱🇻", "mk": "🇲🇰",
  "ml": "🇮🇳", "mr": "🇮🇳", "ms": "🇲🇾", "ne": "🇳🇵", "nl": "🇳🇱", "no": "🇳🇴", "ny": "🇲🇼", "pa": "🇮🇳",
  "pl": "🇵🇱", "ps": "🇦🇫", "pt": "🇧🇷", "pt-PT": "🇵🇹", "ro": "🇷🇴", "ru": "🇷🇺", "sd": "🇵🇰", "sk": "🇸🇰",
  "sl": "🇸🇮", "so": "🇸🇴", "sr": "🇷🇸", "sv": "🇸🇪", "sw": "🇰🇪", "ta": "🇮🇳", "te": "🇮🇳", "th": "🇹🇭",
  "tr": "🇹🇷", "uk": "🇺🇦", "ur": "🇵🇰", "vi": "🇻🇳", "zh": "🇨🇳",
};

// How often the dialog asks how far along a link's download is. A second is
// what the progress row is worth: the percent moves in visible steps and the
// question costs one small answer.
const DOWNLOAD_POLL_MS = 1000;

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
 * @param {(path: string) => void} [deps.reveal]  show a saved file in the
 *        computer's own file window, or null outside the desktop app
 * @param {(source: {downloadId, title, duration_sec, trim}) => void} deps.onErase
 *        hand the held video to the subtitle-erasing screen
 * @returns the operations the rest of the page calls.
 */
export function initNewProjectUi({ $, state, onStart, applyEngineAvailability,
                                   updateEngineHints, paintDubMode,
                                   playRange, cancelRange, labelPx,
                                   onClosed, onPickFile, onErase, reveal = null }) {
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
        const flag = LOCAL_FLAGS[l.code] || LANG_FLAGS[l.code];
        o.textContent = withFlag && flag ? `${flag} ${l.name}` : l.name;
        if (l.code === defCode) o.selected = true;
        sel.appendChild(o);
      }
    }
  }
  fillLanguageSelects();

  // The target list follows the dubbing path: Perso's own languages (77 on
  // 2026-09-08, with regional variants such as English (UK)) when the cloud
  // dubs, the model's ten when this computer does. Until GET /api/languages
  // answers, both paths show the ten. The source dropdown stays as it is:
  // "Auto-detect" covers the cloud, and the ten are what Whisper is asked for.
  const asEntries = (xs) => xs.map((l) => ({ id: l.id || l.code, code: l.code, name: l.name, tag: l.tag || null }));
  let languageLists = { local: asEntries(LANGUAGES), perso: asEntries(LANGUAGES) };
  function currentLanguages() {
    const mode = $("dubModeSelect") ? $("dubModeSelect").value : "local";
    return languageLists[mode === "perso" ? "perso" : "local"];
  }
  function refillTargetLanguages() {
    const sel = $("targetLangSelect");
    if (!sel) return;
    const keep = sel.value || "en";
    const list = currentLanguages();
    const local = list === languageLists.local;
    sel.innerHTML = "";
    for (const l of list) {
      const o = document.createElement("option");
      o.value = l.id;
      const flag = (local && LOCAL_FLAGS[l.code]) || LANG_FLAGS[l.id] || (!l.tag && LANG_FLAGS[l.code]);
      o.textContent = flag ? `${flag} ${l.name}` : l.name;
      sel.appendChild(o);
    }
    sel.value = list.some((l) => l.id === keep) ? keep : "en";
  }
  fetchLanguages().then((lists) => {
    languageLists = { local: asEntries(lists.local), perso: asEntries(lists.perso) };
    refillTargetLanguages();
  });
  if ($("dubModeSelect")) $("dubModeSelect").addEventListener("change", refillTargetLanguages);

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
    refillTargetLanguages();
    pick("sepSelect", d.separation);
    pick("sttSelect", d.stt);
    pick("translateSelect", d.translator);
    pick("qualitySelect", d.voice_quality);
  }

  // The play button's purple-while-playing state is driven by the video, whose
  // listeners outlive the box; kept here so re-drawing swaps them rather than
  // piling a second set on.
  // The trim bar is its own module (ui/src/trimBar.mjs): the Erase subtitles
  // screen draws the same control, and one question asked twice is how the two
  // would come to answer it differently. What is this dialog's own goes in
  // here -- the player it scrubs, the badge it writes the position into, and
  // where the chosen part is kept.
  const trimBar = initTrimBar({
    $, getVideo: () => $("projectVideo"), getClock: () => $("projectDur"),
    playRange, cancelRange, labelPx,
    onChange: (trim) => { if (state.newProject) state.newProject.trim = trim; },
  });


  // A dropped file is played straight from memory, which costs an object URL --
  // released whenever the dialog lets go of that file.
  let projectObjectUrl = null;
  function releaseProjectVideo() {
    const v = $("projectVideo");
    cancelRange(v);
    // The trim bar goes with the video, so its play/pause listener goes too --
    // otherwise it keeps toggling a class on a button that has left the page.
    trimBar.release();
    v.removeAttribute("src");
    v.load();
    if (projectObjectUrl) { URL.revokeObjectURL(projectObjectUrl); projectObjectUrl = null; }
  }

  // ---- The held video ------------------------------------------------------
  // A link is fetched into the app's holding area the moment this dialog opens,
  // so by the time the user has looked at it there is a real file on this
  // computer: it plays and scrubs like a dropped one, a clip can be cut out of
  // it, and the dub is handed its id instead of the link.

  // The 1s timer while a link is coming down, and the last link that finished:
  // pasting the same address again plays the file that is already here.
  let downloadTimer = null;
  let lastLink = null;

  function stopWatching() {
    clearInterval(downloadTimer);
    downloadTimer = null;
  }

  function showDownloaded(percent) {
    $("dlRow").hidden = false;
    $("dlFill").style.width = `${percent}%`;
    $("dlPercent").textContent = `${percent}%`;
  }

  // Which of the three buttons can be pressed. Saving a clip and erasing
  // subtitles are done to the held file, so they wait for it; Start needs it
  // only for a link -- a dropped file is startable the moment it lands, while
  // its copy is still being made.
  function paintActions() {
    const np = state.newProject || {};
    $("saveClipBtn").disabled = !np.downloadId;
    $("eraseBtn").disabled = !np.downloadId;
    $("startBtn").disabled = !np.downloadId && !np.file;
  }

  // The file is here. The progress row goes, the still gives way to the video
  // itself, and its length draws the trim bar -- the same path a dropped file
  // takes once its metadata has loaded.
  function playHeldVideo(d) {
    $("dlRow").hidden = true;
    if (!state.newProject) return;
    state.newProject.downloadId = d.id;
    // Only a video that came from a link can be recognised by one: a held file
    // handed straight in has no address to remember it by.
    if (d.url) lastLink = { url: d.url, id: d.id };
    paintActions();
    const v = $("projectVideo");
    v.hidden = false;
    // The still was there to be looked at while the fetch ran; leaving it
    // behind the video shows it again down both sides of a letterboxed frame.
    $("projectThumb").style.backgroundImage = "";
    v.src = downloadVideoUrl(d.id);
    v.addEventListener("loadedmetadata", () => {
      $("projectDur").textContent = fmtClock(v.duration);
      // With the handles where they were, when this dialog is being put back.
      trimBar.render(v.duration, state.newProject && state.newProject.trim);
    }, { once: true });
  }

  // Ask how far along, once a second, until the record settles. A question
  // that fails to arrive is left alone: the next second asks again, and the
  // download itself carries on regardless of who is watching.
  function watchDownload(id) {
    stopWatching();
    downloadTimer = setInterval(async () => {
      let d;
      try {
        d = await fetchDownload(id);
      } catch { return; }
      if (!state.newProject) { stopWatching(); return; }
      if (d.status === "failed") {
        stopWatching();
        $("dlRow").hidden = true;
        $("projectError").textContent = d.error || "Couldn't fetch the video.";
        return;
      }
      if (d.status === "ready") { stopWatching(); playHeldVideo(d); return; }
      showDownloaded(d.percent || 0);
    }, DOWNLOAD_POLL_MS);
  }

  // A dropped file is copied into the holding area too, and quietly: the video
  // is already playing from memory, so nothing on screen waits for the copy.
  // What it buys is the same three buttons a link gets -- and a dub that reads
  // the copy instead of uploading the file a second time. A copy that fails
  // leaves the dialog exactly as it was before this existed.
  async function holdFile(file, durationSec) {
    let d;
    try {
      d = await uploadDownload(file, durationSec);
    } catch { return; }
    const np = state.newProject;
    // The dialog may have moved on to another video while this was uploading.
    if (!np || np.file !== file) return;
    np.downloadId = d.id;
    paintActions();
  }

  async function beginDownload(url) {
    if (lastLink && lastLink.url === url) {
      // The same link, still in the holding area: play it rather than fetch a
      // second copy. If it has been cleared away, fall through and fetch it.
      const d = await fetchDownload(lastLink.id).catch(() => null);
      if (d && d.status === "ready") { playHeldVideo(d); return; }
      lastLink = null;
    }
    showDownloaded(0);
    let id;
    try {
      id = await startDownload(url);
    } catch (e) {
      $("dlRow").hidden = true;
      $("projectError").textContent = e.message;
      return;
    }
    if (!state.newProject) return;   // closed while the fetch was being started
    watchDownload(id);
  }

  function openNewProject(source) {
    // Several files come in as `files`; the dialog is then asked once and the
    // same choices start them all, one after another (the queue's job).
    const files = source.files && source.files.length > 1 ? source.files : null;
    const file = source.file || (files ? files[0] : null);
    // The trim the dialog was left with, when it is being reopened -- the way
    // back from the erase screen (user, 2026-09-09). Null everywhere else,
    // which is the whole video.
    state.newProject = { file, files, probe: source.probe || null,
                         trim: source.trim || null,
                         // The third way in: a video the app is ALREADY holding,
                         // which is how the erase screen hands its result on.
                         // There is nothing to fetch and nothing to upload --
                         // the id, the name and the length are known already.
                         downloadId: source.downloadId || null,
                         title: source.title || "",
                         // Subtitles the user brought themselves, when they came
                         // with the video: the dub then translates these instead
                         // of listening to the audio for them.
                         sourceSrt: source.sourceSrt || null };
    stopWatching();
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
    trimBar.clear();
    // Likewise the last download's row: beginDownload puts it back up when
    // this link actually has to be fetched.
    $("dlRow").hidden = true;
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
          trimBar.render(v.duration);
          // Its length is known now, so the copy can be filed with one.
          holdFile(file, v.duration);
        }
      }, { once: true });
    } else if (source.probe) {
      if (source.probe.thumbnail_url) {
        $("projectThumb").style.backgroundImage = `url(${source.probe.thumbnail_url})`;
      }
      // The still is what there is to look at while the link comes down.
      beginDownload(source.probe.url);
    } else if (source.downloadId) {
      // Already here: it plays and scrubs at once, the way a link's file does
      // the moment its download finishes.
      playHeldVideo({ id: source.downloadId });
    }
    $("projectDur").textContent = source.probe ? fmtClock(source.probe.duration_sec) : "";
    $("projectError").textContent = "";
    $("projectSaved").textContent = "";
    $("projectShowWrap").hidden = true;
    paintActions();
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
    // Nobody is watching the download any more. The fetch itself carries on in
    // the app -- pasting the same link again finds the file waiting.
    stopWatching();
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

  // The file the last Save clip wrote, for the Show button beside its line.
  let savedClipPath = "";
  $("projectShow").addEventListener("click", () => { if (reveal && savedClipPath) reveal(savedClipPath); });

  // Save clip writes the part the handles have chosen (or the whole video)
  // into the Downloads folder as a file of its own. The dub is not involved:
  // for whoever came to cut a piece out of a link, this is the whole errand,
  // and the dialog stays open so they can cut another.
  $("saveClipBtn").addEventListener("click", async () => {
    const np = state.newProject || {};
    if (!np.downloadId) return;
    const btn = $("saveClipBtn");
    btn.textContent = "Saving…";
    btn.disabled = true;
    $("projectError").textContent = "";
    $("projectSaved").textContent = "";
    $("projectShowWrap").hidden = true;
    try {
      const saved = await saveDownloadClip(np.downloadId, np.trim);
      $("projectSaved").textContent = "Saved to Downloads";
      // Where it went, for the Show beside that line. Only the desktop app can
      // open a folder; in a browser the line says where and stops there.
      savedClipPath = saved.path || "";
      $("projectShowWrap").hidden = !reveal || !savedClipPath;
    } catch (e) {
      $("projectError").textContent = e.message;
    } finally {
      btn.textContent = "Save clip";
      paintActions();
    }
  });

  // Erase subtitles hands the held video over by id -- the erasing screen
  // reads the same file, so nothing is fetched or copied again -- and this
  // dialog gets out of the way.
  $("eraseBtn").addEventListener("click", () => {
    const np = state.newProject || {};
    if (!np.downloadId) return;
    const v = $("projectVideo");
    onErase({
      downloadId: np.downloadId,
      title: np.probe ? np.probe.title : (np.file ? np.file.name : ""),
      duration_sec: Number.isFinite(v.duration) && v.duration
        ? v.duration : (np.probe ? np.probe.duration_sec : 0),
      // The part the handles kept goes with it. Without this a 10-second cut
      // of a 60-second video was erased in full -- six times the minutes, and
      // six times the video handed back.
      trim: np.trim || null,
    });
    closeNewProject();
  });

  function readOptions() {
    // The dialog owns the source now: either a dropped file or a probed link.
    const np = state.newProject || {};
    return {
      video: np.file || null,
      sourceUrl: np.probe ? np.probe.url : null,
      // What the app is already holding, which the dub takes in place of both:
      // the link is fetched and the file copied by the time Start can be pressed.
      downloadId: np.downloadId || null,
      sourceLang: $("sourceLangSelect").value,
      targetLang: $("targetLangSelect").value,
      languages: currentLanguages(),
      sttEngine: $("sttSelect").value,
      sepEngine: $("sepSelect").value,
      dubMode: $("dubModeSelect").value,
      qualityMode: $("qualitySelect").value,
      numSpeakers: $("numSpeakers").value ? Number($("numSpeakers").value) : undefined,
      translateEngine: $("translateSelect").value,
      // A link's title is only known here -- the probe already fetched it, while
      // the server learns nothing from downloading the video. Names the job's
      // folder, so send it along with the job. A held video brings its own name
      // the same way (the erase screen's result).
      project: np.probe ? np.probe.title : (np.title || undefined),
      // Subtitles the user supplied for the source language: the dub translates
      // these instead of transcribing the audio.
      sourceSrt: np.sourceSrt || null,
      // The part of the video the trim bar has selected, or null for all of it.
      trim: np.trim || null,
    };
  }

  return { openNewProject, closeNewProject, readOptions, loadSavedDefaults,
           releaseProjectVideo };
}
