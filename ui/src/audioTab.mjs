// Separate audio, the left panel's Audio tab: the voice and the background of
// a video, apart. A tool of its own, the way Erase subtitles is one: it works
// on the draft (ui/src/draft.mjs), the same video the Dubbing and Erase tabs
// start from, and on the parts its timeline cuts kept.
//
// Three faces, by what is known about the draft on screen:
//   before   the part, where it runs (this computer or Perso API), about how
//            long, and Separate
//   running  "Separating… 42%", a bar, and Stop
//   done     Voice and Background, each with a play button and its picture,
//            then Dubbing and Export
// and two more at the edges: no video yet (the shared Import block), and a
// separation that stopped (why, Back, Try again).
//
// The job belongs to a cut: a held video and the parts kept of it. Cut the
// draft differently and the tab is "before" again; put the cut back and the
// two sounds are there as they were. A dubbing started from the same cut
// takes them instead of separating again (reusableJob, app/api/dub.py).
//
// Once there is a result the draft's video plays through the two sounds
// instead of its own: both follow the video, and each can be silenced, from
// its row here or from its lane on the timeline (ui/src/timeline.mjs
// showAudio).
//
// Everything this file touches is #tabAudio, the draft, the draft's video
// (its `muted`), and the timeline through showTimeline.
import { startSeparate, fetchSeparate, retrySeparate, cancelDubJob, stemUrl,
         stemWaveUrl } from "./dubApi.mjs";
import { getDraft, keptSeconds, isWhole, onDraftChange } from "./draft.mjs";
import { sourceToKept } from "./cutTools.mjs";
import { errorText, fmtLength, videoCardHtml } from "./format.mjs";
import { lucide } from "./icons.mjs";
import { emptyTabHtml, wireImportBlock, wireImportInput } from "./importBlock.mjs";
import { waveSvg } from "./timeline.mjs";
import { t } from "./i18n.mjs";

const POLL_MS = 1000;
const LIVE = ["queued", "running", "cancelling"];
export const STEMS = ["voice", "background"];

/** The parts a draft kept, [[start, end], ...], or null when nothing was cut. */
export function partsOf(draft) {
  return !draft || isWhole(draft) ? null : draft.ranges.map(([a, b]) => [a, b]);
}

/** One word for a cut, to the hundredth of a second the app compares them by. */
export function partsKey(parts) {
  return parts ? JSON.stringify(parts.map(([a, b]) => [Math.round(a * 100), Math.round(b * 100)])) : "";
}

/** Whether `job` is the separation of this very draft, cut as it is now. */
export function jobIsOf(job, draft) {
  return !!job && !!draft && !!draft.downloadId && job.downloadId === draft.downloadId
    && job.key === partsKey(partsOf(draft));
}

/**
 * Which face is up: "empty" (no video), "before", "running", "done" or
 * "failed" (stopped or broke).
 */
export function audioView({ draft, job }) {
  if (!draft || !draft.downloadId) return "empty";
  if (!jobIsOf(job, draft)) return "before";
  if (LIVE.includes(job.status)) return "running";
  return job.status === "done" && job.done ? "done" : "failed";
}

// How long a separation takes: [seconds to start, seconds per second of
// video]. This computer: a 6 second cut took 5 seconds on an M4 MacBook Air
// (measured 2026-09-30, one run). Perso: its queue and the upload, a guess
// until it is measured.
const SPEED = { local: [5, 0.3], perso: [60, 0.5] };

/** About how many seconds separating `seconds` of video takes. */
export function estimateSeconds(seconds, engine = "local") {
  if (!seconds) return 0;
  const [setup, per] = SPEED[engine === "perso" ? "perso" : "local"];
  return setup + seconds * per;
}

/** "About 1 min", or "" when there is nothing to promise. */
export function estimateLabel(seconds) {
  return seconds ? t("About {n} min", { n: Math.max(1, Math.ceil(seconds / 60)) }) : "";
}

/**
 * How far along, 0-95: the engines report no percentage of their own, so it
 * is the time spent against the estimate, and it never claims the end.
 */
export function percentOf(job, estimate) {
  if (!job || job.status === "queued" || !estimate) return 0;
  return Math.min(95, Math.round(((job.elapsed || 0) / estimate) * 100));
}

/** The running card's line. */
export function runningLine(job, pct) {
  if (job.status === "queued") return t("Waiting for its turn");
  if (job.status === "cancelling") return t("Stopping…");
  return t("Separating… {pct}%", { pct });
}

/** Why a separation is not there, as one plain sentence. */
export function stoppedLine(job) {
  if (job.status === "cancelled") return t("Separating was stopped.");
  if (job.error === "interrupted") return t("PersoDub was closed before this finished.");
  if (job.status === "done") return t("The separated audio is no longer on this computer.");
  // error_shown: the engine's sentence in the page's language; error stays
  // English for the desktop app and the failure reports. error_detail is the
  // cause the engine sent apart from it (Perso's reason), said after it.
  if (job.error_shown && job.error_detail) return `${job.error_shown} ${job.error_detail}`;
  return job.error_shown || job.error || t("Separating stopped.");
}

const stripExt = (name) => String(name || "").replace(/\.[A-Za-z0-9]{2,4}$/, "");

/**
 * Wire the Audio tab to a page.
 *
 * @param {object} deps
 * @param {(id: string) => any} deps.$
 * @param {object} deps.state   state.jobId: a job that owns the work screen
 * @param {() => any} deps.getVideo   the draft's <video>
 * @param {(name: string) => void} deps.goToTab   press a tab of the left panel
 * @param {(source: object) => Promise<void>} deps.importSource  bring a video
 *        in as the draft (ui/src/draftImport.mjs), which also says how it is
 *        going on the line under the block
 * @param {(text: string, isError?: boolean) => void} deps.say  that line
 * @param {() => Promise<boolean>} deps.askStop  the app's own stop question
 * @param {(e: Error, retry: () => void) => boolean} deps.onStartRefused  a
 *        start that came back short of something the page can fix (the
 *        engine pack, a Perso key or workspace, disk space); true when the
 *        page took it
 * @param {() => void} deps.onJobsChanged  the Projects list has a changed row
 * @param {() => void} deps.openExport   open the Export dialog
 * @param {(info: object|null) => void} deps.showTimeline  what the timeline
 *        adds to the draft (ui/src/timeline.mjs showAudio)
 * @param {() => number} [deps.now]
 */
export function initAudioTab({ $, state, getVideo, goToTab, importSource, say,
                               askStop, onStartRefused, onJobsChanged, openExport,
                               showTimeline, now = () => Date.now() }) {
  $("audioImportSlot").outerHTML = emptyTabHtml("audio", "audioZone", "audioLink");

  // The separation this tab knows about: {id, status, elapsed, done, error,
  // logs, downloadId, key, engine}. It stays while the draft is cut another
  // way, and shows again when the cut comes back.
  let job = null;
  let timer = null;
  // A start is on its way to the app.
  let busy = false;
  // Perso spends credits, so its Separate is pressed twice: when the first
  // press was, or 0.
  let armedAt = 0;
  // Which job's two sounds the draft's video is playing through, or "".
  let playing = "";
  // Which of the two is silenced.
  let muted = { voice: false, background: false };
  // The pictures of the two sounds, per job: {voice: svg, background: svg}.
  let waves = { id: "", voice: "", background: "" };

  const sounds = () => ({ voice: $("audioVoice"), background: $("audioBackground") });
  const engine = () => ($("audioEngine").value === "perso" ? "perso" : "local");
  const armed = () => !!armedAt && now() - armedAt < 10000;

  // ---- Painting -------------------------------------------------------------

  function paint() {
    const d = getDraft();
    const view = audioView({ draft: d, job });
    const kept = d ? keptSeconds(d) : 0;
    const show = (id, on) => { $(id).hidden = !on; };

    show("audioEmpty", view === "empty");
    show("audioBody", view !== "empty");
    show("audioRow", view !== "empty");
    // With a job on screen there is no draft to bring a video into.
    show("audioZone", !state.jobId);
    $("audioEmptyNote").textContent = state.jobId ? t("Separate audio starts from a new project.") : "";
    show("audioEmptyNote", !!state.jobId);

    // The first card names the video, whatever the separation is doing.
    show("audioPartCard", !!d);
    $("audioPartCard").innerHTML = d ? videoCardHtml({ name: d.name, kept, total: d.duration }) : "";
    show("audioEngineCard", view === "before");
    $("audioEngineNote").textContent = engine() === "perso" ? t("Uses Perso credits.") : "";

    // Running, or why it stopped, in the one card.
    const est = estimateSeconds(kept, job && view !== "before" ? job.engine : engine());
    const pct = view === "running" ? percentOf(job, est) : 0;
    show("audioRunCard", view === "running" || view === "failed");
    $("audioRunLine").textContent = view === "running" ? runningLine(job, pct) : "";
    show("audioBarBox", view === "running");
    $("audioFill").style.width = `${pct}%`;
    $("audioState").textContent = view === "failed" ? stoppedLine(job) : "";
    $("audioState").classList.toggle("bad", view === "failed");
    show("audioLogDetails", view === "failed" && job.status === "error");
    if (view === "failed") $("audioLogBox").textContent = (job.logs || []).join("\n");

    // The two sounds.
    const on = playing && !getVideo().paused;
    for (const which of STEMS) {
      const cap = which[0].toUpperCase() + which.slice(1);
      // Before there is a separation the two rows are there already, dim,
      // saying what each will be: no button and no picture yet.
      show(`audio${cap}Row`, view !== "failed");
      $(`audio${cap}Row`).classList.toggle("dim", view !== "done");
      show(`audio${cap}Play`, view === "done");
      show(`audio${cap}Note`, view !== "done");
      const solo = on && !muted[which] && STEMS.every((w) => w === which || muted[w]);
      const btn = $(`audio${cap}Play`);
      btn.innerHTML = lucide(solo ? "pause" : "play", 12, true);
      const voice = which === "voice";
      btn.setAttribute("aria-label", solo ? (voice ? t("Pause the voice") : t("Pause the background"))
        : (voice ? t("Play the voice") : t("Play the background")));
      btn.title = solo ? t("Pause") : voice ? t("Play the voice alone") : t("Play the background alone");
      $(`audio${cap}Wave`).innerHTML = view === "done" && waves.id === job.id ? waves[which] : "";
    }

    // The foot.
    $("audioFootLabel").textContent = view === "before"
      ? (armed() ? t("Uses Perso credits. Press again to start.") : estimateLabel(est))
      : view === "running" ? fmtLength(kept)
      : view === "done" ? t("{length} separated", { length: fmtLength(kept) }) : "";
    show("audioRunBtn", view === "before");
    $("audioRunBtn").disabled = busy;
    show("audioStopBtn", view === "running");
    $("audioStopBtn").disabled = !!job && job.status === "cancelling";
    show("audioBackBtn", view === "failed");
    show("audioRetryBtn", view === "failed");
    show("audioDubBtn", view === "done");
    show("audioExportBtn", view === "done");

    if (view === "done") loadWaves();
    play(view === "done" && !state.jobId ? job.id : "");
    // The draft's cuts stand still while they are being separated, and the
    // two sounds get a lane each once they are there. Only a draft's own
    // screen has that timeline.
    showTimeline(state.jobId || view === "empty" ? null : {
      locked: view === "running",
      stems: view === "done" ? { id: job.id, muted: { ...muted } } : null,
    });
  }

  async function loadWaves() {
    if (waves.id === job.id) return;
    const id = job.id;
    waves = { id, voice: "", background: "" };
    for (const which of STEMS) {
      try {
        const wave = await (await fetch(stemWaveUrl(id, which))).json();
        if (waves.id !== id) return;
        waves[which] = wave && wave.peaks ? waveSvg(wave, 0, wave.duration || wave.peaks.length / wave.rate) : "";
      } catch { /* the row stays without its picture */ }
    }
    paint();
  }

  // ---- The two sounds under the video ---------------------------------------
  // The draft's video is the whole original; the two sounds are the kept
  // parts joined. So each follows the video's kept time.

  function play(id) {
    if (id === playing) return;
    const v = getVideo();
    const was = playing;
    playing = id;
    for (const [which, el] of Object.entries(sounds())) {
      el.pause();
      if (id) el.src = stemUrl(id, which);
      else el.removeAttribute("src");
    }
    if (id) muted = { voice: false, background: false };
    if (id || was) v.muted = !!id;
    if (id) follow(true);
  }

  function keptTime() {
    const d = getDraft();
    return d ? sourceToKept(d.ranges, getVideo().currentTime || 0) : 0;
  }

  // Put each sound where the video is; `hard` always, otherwise only when it
  // has drifted far enough to hear.
  function follow(hard = false) {
    if (!playing) return;
    const v = getVideo();
    const t = keptTime();
    for (const [which, el] of Object.entries(sounds())) {
      el.muted = muted[which];
      if (hard || Math.abs((el.currentTime || 0) - t) > 0.3) el.currentTime = t;
      if (v.paused) el.pause();
      else if (el.paused) Promise.resolve(el.play()).catch(() => {});
    }
  }

  const video = getVideo();
  video.addEventListener("play", () => { follow(true); paint(); });
  for (const ev of ["pause", "ended"]) video.addEventListener(ev, () => { follow(); paint(); });
  video.addEventListener("seeked", () => follow(true));
  video.addEventListener("timeupdate", () => follow());

  /** Silence one of the two, or let it be heard again. */
  function toggleMute(which) {
    if (!playing || !STEMS.includes(which)) return;
    muted = { ...muted, [which]: !muted[which] };
    follow();
    paint();
  }

  // A row's play button: that sound alone, from where the video stands.
  function playAlone(which) {
    if (!playing) return;
    const v = getVideo();
    const alone = !muted[which] && STEMS.every((w) => w === which || muted[w]);
    if (!v.paused && alone) { v.pause(); return; }
    muted = { voice: which !== "voice", background: which !== "background" };
    if (v.paused) Promise.resolve(v.play()).catch(() => {});
    else { follow(); paint(); }
  }
  $("audioVoicePlay").addEventListener("click", () => playAlone("voice"));
  $("audioBackgroundPlay").addEventListener("click", () => playAlone("background"));

  // ---- Separating -----------------------------------------------------------

  function record(jid, j, extra = {}) {
    return { ...(job && job.id === jid ? job : {}), id: jid, status: j.status,
             elapsed: j.elapsed || 0, done: !!j.done, error: j.error || "", error_shown: j.error_shown || "",
             error_detail: j.error_detail || "",
             logs: j.logs || [], engine: j.separation === "perso" ? "perso" : "local", ...extra };
  }

  function stopWatching() { clearInterval(timer); timer = null; }

  // Once a second until the record settles. A question that fails to arrive
  // is left alone: the next second asks again.
  function watch(jid) {
    stopWatching();
    timer = setInterval(async () => {
      let j;
      try { j = await fetchSeparate(jid); } catch { return; }
      if (!job || job.id !== jid) { stopWatching(); return; }
      job = record(jid, j);
      if (!LIVE.includes(j.status)) { stopWatching(); onJobsChanged(); }
      paint();
    }, POLL_MS);
  }

  async function catchUp(jid) {
    let j;
    try { j = await fetchSeparate(jid); } catch (e) {
      $("audioError").textContent = errorText(e);
      return;
    }
    if (!job || job.id !== jid) return;
    job = record(jid, j);
    paint();
    if (LIVE.includes(j.status)) watch(jid);
  }

  async function start(again = false) {
    const d = getDraft();
    if (!d || !d.downloadId || busy) return;
    const where = engine();
    // The first press says what it costs; the second, within ten seconds,
    // goes ahead. A retry after a key or a download was asked for already.
    if (where === "perso" && !again && !armed()) {
      armedAt = now();
      // The warning goes when its ten seconds are up.
      const back = setTimeout(paint, 10050);
      if (back && back.unref) back.unref();
      paint();
      return;
    }
    armedAt = 0;
    busy = true;
    $("audioError").textContent = "";
    paint();
    try {
      const parts = partsOf(d);
      const jid = await startSeparate({
        downloadId: d.downloadId, engine: where, project: stripExt(d.name),
        trim: parts && parts.length === 1 ? { start: parts[0][0], end: parts[0][1] } : null,
        ranges: parts && parts.length > 1 ? parts : null,
      });
      job = { id: jid, status: "queued", elapsed: 0, done: false, error: "", logs: [],
              downloadId: d.downloadId, key: partsKey(parts), engine: where };
      onJobsChanged();
      watch(jid);
    } catch (e) {
      if (!onStartRefused(e, () => start(true))) $("audioError").textContent = errorText(e);
    } finally {
      busy = false;
      paint();
    }
  }
  $("audioRunBtn").addEventListener("click", () => start());
  $("audioEngine").addEventListener("change", () => { armedAt = 0; paint(); });

  $("audioStopBtn").addEventListener("click", async () => {
    if (!job) return;
    const jid = job.id;
    // A waiting job goes quietly; stopping one that is running is asked about.
    if (job.status !== "queued" && !(await askStop())) return;
    try {
      const status = await cancelDubJob(jid);
      if (job && job.id === jid) job = { ...job, status };
    } catch (e) {
      $("audioError").textContent = errorText(e);
    }
    paint();
  });

  $("audioBackBtn").addEventListener("click", () => {
    stopWatching();
    job = null;
    $("audioError").textContent = "";
    paint();
  });

  $("audioRetryBtn").addEventListener("click", async () => {
    if (!job) return;
    const from = job;
    $("audioRetryBtn").disabled = true;
    $("audioError").textContent = "";
    try {
      const jid = await retrySeparate(from.id);
      job = { ...from, id: jid, status: "queued", elapsed: 0, done: false, error: "", logs: [] };
      onJobsChanged();
      watch(jid);
    } catch (e) {
      if (!onStartRefused(e, () => $("audioRetryBtn").click())) $("audioError").textContent = errorText(e);
    } finally {
      $("audioRetryBtn").disabled = false;
      paint();
    }
  });

  $("audioDubBtn").addEventListener("click", () => goToTab("dubbing"));
  $("audioExportBtn").addEventListener("click", () => openExport());

  // ---- Coming in ------------------------------------------------------------

  // No video yet: the shared Import block. The video comes in the one way
  // every tab brings one in (ui/src/draftImport.mjs), which says how it is
  // going on the line under the block, and this tab stays up.
  wireImportInput($("audioInput"), (files) => importSource({ file: files[0] }));
  wireImportBlock($, {
    id: "audioZone", linkId: "audioLink", input: $("audioInput"),
    onFiles: (files) => importSource({ file: files[0] }),
    onLink: (link) => importSource({ link }),
    onNotLink: (message) => say(message, true),
  });

  onDraftChange(() => {
    armedAt = 0;
    paint();
  });

  /**
   * A row in the Projects list: a separation that is under way or finished.
   * The page opens a draft on the video `held` names (POST
   * /api/separate/{id}/open) right after; this says whose two sounds go with
   * that draft.
   */
  function adopt(rec, held) {
    stopWatching();
    job = record(rec.id, rec, { downloadId: held.download_id, key: partsKey(held.ranges || null) });
    catchUp(rec.id);
  }

  /** The finished separation of the draft as it is cut now, or null: what
      Export hands out, and what a dubbing started now takes its sounds from. */
  function separatedJob() {
    return audioView({ draft: getDraft(), job }) === "done" ? job : null;
  }

  paint();
  return { paint, adopt, separatedJob, toggleMute, forgetWant: () => { wantTab = false; } };
}
