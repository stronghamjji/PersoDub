// A dubbing's way through its stages, as the page sees it, for the product's
// charts (ui/src/events.mjs record): dub_stage as a stage starts and as it
// ends, done or failed, with the seconds in between, read off every job record
// the page gets -- the open dubbing's every poll, and Home's Up next card,
// which asks after the one running. A stage the page did not see start has no
// seconds. Stop dubbing is dub_cancelled, on the stage it was on. How a
// dubbing ended is the shell's dub_finished (desktop/src/usageIpc.js).
import { STAGES } from "./dubApi.mjs";
import { record as recordStep } from "./events.mjs";

// A Perso API dubbing's three stages, by the engine's names (app/perso_client.py).
const CLOUD = ["upload", "perso-dubbing", "download"];
const LIVE = new Set(["queued", "running", "cancelling"]);
const isDub = (job) => !job.kind || job.kind === "dub";
const modeOf = (job) => (job.dub_mode === "perso" ? "perso" : "local");

/** The stage a parseProgress reading is on, by the engine's name, or "". */
export function stageName(progress) {
  if (!progress || !progress.stage) return "";
  if (progress.raw) return (STAGES[progress.raw - 1] || {}).name || "";
  return CLOUD[progress.stage - 1] || "";
}

/** dub_started's props: how it runs, the language it goes into (two
 *  letters), how long the video is, and the speakers asked for (0: found by
 *  the app). Whatever is not known is left out. */
export function dubStartedProps({ mode, lang, speakers, seconds }) {
  return {
    mode: mode === "perso" ? "perso" : "local",
    ...(lang ? { target_lang: String(lang).slice(0, 2).toLowerCase() } : {}),
    ...(Number.isFinite(seconds) && seconds > 0 ? { minutes: Math.round(seconds / 60), video_seconds: Math.round(seconds) } : {}),
    speakers: Number.isInteger(speakers) && speakers > 0 ? speakers : 0,
  };
}

/** The same, off a dubbing's form (dubApi.mjs buildDubFormData); `seconds`
 *  is the video's length when the page knows it, a trim's own length wins. */
export function startedFromForm(fd, seconds) {
  const start = Number(fd.get("trim_start")), end = Number(fd.get("trim_end"));
  return dubStartedProps({
    mode: fd.get("dub_mode"), lang: fd.get("language_code"), speakers: Number(fd.get("num_speakers")),
    seconds: fd.get("trim_end") !== null && end > start ? end - start : seconds,
  });
}

/** The same, off a dubbing's record: Start over dubs it again. */
export const startedFromJob = (job) => dubStartedProps({
  mode: job.dub_mode, lang: job.language_code, speakers: job.num_speakers, seconds: job.duration,
});

/**
 * @param {object} deps
 * @param {(logs: string[]) => object} deps.parse  dubApi.mjs parseProgress
 * @param {(name: string, props: object) => void} [deps.record]
 * @param {() => number} [deps.now]
 */
export function createDubTracker({ parse, record = recordStep, now = Date.now }) {
  const jobs = new Map();   // job id -> {stage, since, timed, mode}
  const seconds = (at) => (at.timed ? { seconds: Math.round((now() - at.since) / 1000) } : {});

  /** A dubbing this page just started or resumed: its stages are timed from here. */
  function started(id, mode = "local") {
    if (id) jobs.set(id, { stage: "", since: now(), timed: true, mode });
  }

  /** A job record, from a poll (with its log) or a list (without). */
  function see(job) {
    if (!job || !job.id || !isDub(job)) return;
    const at = jobs.get(job.id);
    const mode = job.dub_mode ? modeOf(job) : (at ? at.mode : "local");
    if (LIVE.has(job.status)) {
      if (!Array.isArray(job.logs)) return;   // a list's row says no stage
      const stage = stageName(parse(job.logs));
      if (!at) { jobs.set(job.id, { stage, since: now(), timed: false, mode }); return; }
      if (!stage || stage === at.stage) return;
      if (at.stage) record("dub_stage", { stage: at.stage, state: "done", ...seconds(at), mode });
      record("dub_stage", { stage, state: "start", mode });
      jobs.set(job.id, { stage, since: now(), timed: true, mode });
      return;
    }
    if (!at) return;   // over before this page saw it run
    jobs.delete(job.id);
    const state = job.status === "done" ? "done" : job.status === "error" ? "failed" : "";
    if (at.stage && state) record("dub_stage", { stage: at.stage, state, ...seconds(at), mode });
  }

  /** Stop dubbing, confirmed: on the stage it was on, when that is known. */
  function cancelled(job) {
    if (!job || !job.id || !isDub(job)) return;
    const at = jobs.get(job.id);
    const stage = (at && at.stage) || (Array.isArray(job.logs) ? stageName(parse(job.logs)) : "");
    record("dub_cancelled", { ...(stage ? { stage } : {}), mode: job.dub_mode ? modeOf(job) : (at ? at.mode : "local") });
  }

  return { started, see, cancelled };
}
