// The "draft" state of the work screen: what shows before a video has been
// dubbed (mockups m1..m4, cut1, user 2026-09-29). openDraft() is the one way
// in -- Home calls it with nothing (New project, empty), or with one file,
// one link, or an already-held video, in which case it goes straight onto
// the timeline (the shortcut the task asked for). Several files still open
// the New project dialog directly (ui/src/newProject.mjs); that path never
// runs through here.
//
// This file also draws the Dubbing tab's "Before dubbing" card once a video
// is imported: the kept part of it, the two languages, Advanced options --
// borrowed from the New project dialog rather than redrawn, so every hint,
// key dialog and remembered default it already has just keeps working -- and
// Start dubbing.
//
// With no video yet the tab shows the shared Import block instead; bringing
// a video in is ui/src/draftImport.mjs, and this file only calls its
// importSource for the shortcut above.
import { buildDubFormData, fetchCreditsLeft, saveDownloadParts } from "./dubApi.mjs";
import { errorText, fmtLength, videoCardHtml } from "./format.mjs";
import { getDraft, clearDraft, setRanges, keptSeconds, spokenSeconds, isWhole, onDraftChange } from "./draft.mjs";
import { modelInfo } from "./persoModels.mjs";
import { t } from "./i18n.mjs";
import { gb } from "./modelsUi.mjs";

function stripExt(name) {
  return String(name || "").replace(/\.[^./\\]+$/, "");
}

/**
 * Wire the draft state of the work screen and the Dubbing tab's "Before
 * dubbing" card.
 *
 * @param {object} deps
 * @param {(id: string) => any} deps.$
 * @param {object} deps.state    state.jobId gates a real job back into view; state.draftProject
 *        is the project a draft opened by Add language joins
 * @param {(name: string) => void} deps.showScreen
 * @param {(opts: object) => void} deps.setTopbar
 * @param {() => void} deps.fitLayout       timeline.fitLayout
 * @param {() => void} deps.sizeVideoPane
 * @param {(name: string) => void} deps.leftTabsShow
 * @param {{ render: () => void, importSource: (s: object) => Promise<void> }} deps.importer
 *        ui/src/draftImport.mjs
 * @param {{ currentLanguages: () => any[], moveOptionsInto: (el: any) => void,
 *           startOnDefaults?: () => Promise<void> }} deps.newProject
 * @param {(o: { fd, label, errorEl, retry, retried? }) => Promise<boolean>} deps.submitDubStart
 * @param {(fn: () => void) => void} deps.setDubRestart  which "start again" a
 *        finished model download resumes (the models dialog's onStartDubbing)
 * @param {() => string} [deps.getScreen]  the screen that is up: the Erase tab
 *        edits the same draft and keeps its own top bar
 * @param {(d: object) => void} [deps.removeDraft]  the Video card's Remove:
 *        asks, as the Home card's Delete does, and deletes this draft
 * @param {() => number} [deps.firstDownloadBytes]  what a dubbing on the
 *        form's choices downloads first, in bytes; 0 for nothing
 * @returns {{ openDraft: (source?: {file?, link?, downloadId?, name?, duration?}) => Promise<void>,
 *             showDraftScreen: () => void, paint: () => void, paintFoot: () => void, canExport: () => boolean,
 *             saveDraft: (what?: {audio?: string, ratio?: string}) => Promise<string> }}
 */
export function initDraftSetup({ $, state, showScreen, setTopbar, fitLayout, sizeVideoPane,
                                  leftTabsShow, importer, newProject, submitDubStart, setDubRestart,
                                  showDraftTimeline = () => {}, getScreen = () => "done",
                                  removeDraft = () => {}, firstDownloadBytes = () => 0 }) {
  // What a Perso API dubbing of the kept part costs and what the workspace
  // has left, beside Start (owner, 2026-10-22). Perso charges the model's
  // credits a second for the whole seconds spoken: until a script has heard
  // the video that is at most every second kept, and once one has (a draft
  // opened by + Add language) about the seconds it heard in the kept parts,
  // whole seconds as the clock beside it counts them. What is left is what
  // Settings' workspace list says, asked at most once a minute: it moves
  // only when credits are spent.
  const LEFT_FRESH_MS = 60 * 1000;
  let creditsLeft = null;
  let leftAskedAt = -Infinity;
  const number = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });
  function persoCost(d) {
    if (Date.now() - leftAskedAt >= LEFT_FRESH_MS) {
      leftAskedAt = Date.now();
      fetchCreditsLeft().then((n) => { creditsLeft = n; paintFoot(); });
    }
    const { rate } = modelInfo(newProject.persoModel());
    const spoken = spokenSeconds(d);
    const cost = rate == null || !(keptSeconds(d) > 0) ? null
      : Math.round(Math.floor(spoken ?? keptSeconds(d)) * rate * 10) / 10;
    const about = spoken != null;
    const price = cost == null ? ""
      : cost === 1 ? (about ? t("about {n} credit", { n: 1 }) : t("up to {n} credit", { n: 1 }))
      : about ? t("about {n} credits", { n: number(cost) }) : t("up to {n} credits", { n: number(cost) });
    return [price, creditsLeft == null ? "" : t("{n} left", { n: number(creditsLeft) })].filter(Boolean);
  }

  // The Dubbing tab's three faces: the Import block with no video yet (the
  // importer shows it), this card once there is one, and the Script pane
  // (script engineer's own #dubbingPaneHead/#scriptBox) for a job.
  const LONG_VIDEO_SECONDS = 30 * 60;
  function paintDubbingTab() {
    importer.render();
    const d = getDraft();
    const active = !!d && !state.jobId;
    // A video with the user's own subtitles has no script: one card instead,
    // with the way to dub the same video.
    const own = !!state.jobId && !!state.job && state.job.id === state.jobId && state.job.kind === "captions";
    const script = !!state.jobId && !own;
    $("draftSetup").hidden = !active;
    $("dubbingCaptions").hidden = !own;
    const head = $("dubbingPaneHead");
    if (head) head.hidden = !script;
    const box = $("scriptBox");
    if (box) box.hidden = !script;
    if (!active) return;
    newProject.moveOptionsInto($("draftOptionsSlot"));
    $("draftPartCard").innerHTML = videoCardHtml({ name: d.name, kept: keptSeconds(d), total: d.duration });
    // Over 30 minutes of kept video: not refused, but said plainly, with the
    // way out (cut into parts). The old New project dialog said it; this card
    // took its place and said nothing (Windows B11, 2026-10-07).
    $("draftLongHint").hidden = !(keptSeconds(d) > LONG_VIDEO_SECONDS);
    paintFoot();
    $("draftStartBtn").disabled = !d.downloadId;
    $("draftStartBtn").title = d.downloadId ? "" : t("The video is still coming in");
  }
  // The foot: the length, the mode and then, for a Perso API dubbing, its
  // credits (persoCost above), or, while the local choices still need a
  // download, its size the first time (owner, 2026-10-22, 1-3). Painted by
  // itself as well whenever the model rows change (ui/src/app.mjs).
  function paintFoot() {
    const d = getDraft();
    if (!d || state.jobId) return;
    // Perso does the whole job, so the voice-quality choice is not in force.
    const cloud = $("dubModeSelect").value === "perso";
    const quality = cloud ? "Perso API"
      : $("qualitySelect").value === "high" ? t("High quality mode") : t("Fast mode");
    const first = firstDownloadBytes();
    $("draftFootLabel").textContent = [t("Dubbing {length} · {mode}", { length: fmtLength(keptSeconds(d)), mode: quality }),
      ...(cloud ? persoCost(d) : first ? [t("{size} GB the first time", { size: gb(first) })] : [])].join(" · ");
  }
  // The foot names the mode, so it has to follow the two choices that set it:
  // it went on saying "Fast mode" after High quality was picked (2026-09-30).
  // And the Dubbing model, which prices a Perso dubbing.
  for (const id of ["qualitySelect", "dubModeSelect", "persoModelPick"]) $(id).addEventListener("change", paintDubbingTab);

  onDraftChange(() => {
    paintDubbingTab();
    const d = getDraft();
    if (d && !state.jobId && getScreen() !== "erase") {
      setTopbar({ title: stripExt(d.name) || t("New project"), back: true, done: true });
      $("exportBtn").disabled = !canExport();
    }
  });

  // `again`: the video this start was first asked for, when it is being
  // picked up again (models downloaded, signed in). On any other draft by
  // then, that draft was never asked to start and is left alone.
  async function startDraftDubbing(again = null) {
    const d = getDraft();
    if (!d || !d.downloadId || (again && again !== d.downloadId)) return;
    $("draftStartBtn").disabled = true;
    setDubRestart(() => startDraftDubbing(d.downloadId));
    try {
      const opts = {
        downloadId: d.downloadId,
        sourceLang: $("sourceLangSelect").value,
        targetLang: $("targetLangSelect").value,
        languages: newProject.currentLanguages(),
        sttEngine: $("sttSelect").value,
        sepEngine: $("sepSelect").value,
        dubMode: $("dubModeSelect").value,
        persoModel: newProject.persoModel(),
        qualityMode: $("qualitySelect").value,
        numSpeakers: $("numSpeakers").value ? Number($("numSpeakers").value) : undefined,
        translateEngine: $("translateSelect").value,
        ttsEngine: $("voiceSelect").value,
        project: stripExt(d.name) || undefined,
        // Add language: the project this dubbing joins (ui/src/languageRow.mjs).
        projectId: state.draftProject || undefined,
      };
      if (!isWhole(d)) {
        if (d.ranges.length === 1) opts.trim = { start: d.ranges[0][0], end: d.ranges[0][1] };
        // Pairs of seconds, as app/api/dub.py parse_ranges reads them.
        else opts.ranges = d.ranges;
      }
      const fd = buildDubFormData(opts);
      const started = await submitDubStart({
        fd, label: stripExt(d.name) || t("Dubbing"), errorEl: $("draftError"),
        retry: () => startDraftDubbing(d.downloadId),
      });
      // Only the draft that was started: another may be open by now.
      if (started && (getDraft() || {}).downloadId === d.downloadId) clearDraft();
    } catch (e) {
      $("draftError").textContent = errorText(e);
    } finally {
      $("draftStartBtn").disabled = false;
    }
  }
  $("draftStartBtn").addEventListener("click", () => startDraftDubbing());

  // The Video card's two ways out (owner, 2026-10-22): Replace opens the
  // Import block's own file picker (ui/src/draftImport.mjs takes the file),
  // and Remove deletes the draft once asked, leaving the empty project.
  $("draftReplaceBtn").addEventListener("click", () => $("draftFileInput").click());
  $("draftRemoveBtn").addEventListener("click", () => {
    const d = getDraft();
    if (d) removeDraft(d);
  });

  // What the top bar's Export hands back before a dub: the kept parts as one
  // video, in the canvas of `ratio` when the Ratio button is on one, or their
  // sound alone ({audio: "mp3" | "wav"}). Export is lit once there is a video
  // on the timeline. Resolves to the file written.
  const canExport = () => { const d = getDraft(); return !!d && !!d.downloadId; };
  async function saveDraft({ audio = "", ratio = null } = {}) {
    const d = getDraft();
    if (!canExport()) throw new Error(t("There is no video to save."));
    const saved = await saveDownloadParts(d.downloadId, { ranges: isWhole(d) ? null : d.ranges, audio, ratio });
    return saved.path;
  }

  /** The work screen on the draft as it stands: its video, the Before
      dubbing card and its cuts on the timeline. Also the way back from the
      Erase tab, which edits the same draft. */
  function showDraftScreen() {
    showScreen("done");
    setTopbar({ title: stripExt((getDraft() || {}).name) || t("New project"), back: true, done: true });
    $("exportBtn").disabled = !canExport();
    $("doneLayout").hidden = false;
    $("doneFail").hidden = true;
    paintDubbingTab();
    // The timeline draws the draft (or the empty row that asks for one) and
    // its cut tools instead of a finished job's lanes.
    showDraftTimeline();
    fitLayout();
    sizeVideoPane();
  }

  /** The one way in: Home, with nothing (empty New project), one file, one
      link, or an already-held video -- straight onto the timeline, as every
      import is. `tab` is the left tab to open on; `ranges` the parts to keep
      of an already-held video (Add language: the parts that dub kept);
      `choices` the Advanced options to start on instead of the saved ones
      (Add language: the open dubbing's). */
  async function openDraft(source = null, { tab = "dubbing", ranges = null, choices = null } = {}) {
    clearDraft();
    // The last draft's refusal is not this one's.
    $("draftError").textContent = "";
    // Nor is its link: the Import blocks kept the last address in their
    // field, so an empty project opened from Home showed it (review, 2026-10-09).
    for (const id of ["dubbingLinkInput", "capLinkInput", "saveLinkInput"]) {
      const f = $(id);
      if (f) f.value = "";
    }
    // And the last draft's Advanced options are not this one's either: the
    // choices start on the saved ones, as the New project window's do.
    newProject.startOnDefaults?.(choices).then(paintDubbingTab, () => {});
    showDraftScreen();
    leftTabsShow(tab);
    if (source && (source.file || source.link || source.downloadId)) {
      await importer.importSource(source);
      if (ranges && getDraft()) setRanges(ranges);
    }
  }

  return { openDraft, showDraftScreen, paint: paintDubbingTab, paintFoot, canExport, saveDraft };
}
