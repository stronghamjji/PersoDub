// One video's dubbings in several languages are one project (mockup
// script-buttons, owner 2026-10-01). A dubbing started with "+ Add language"
// carries project_id, the id of its project's first dubbing (app/api/dub.py
// dub_start); the first one, and every job saved before the field existed,
// is a project of its own. Nothing is guessed for old jobs.
//
// This file groups the GET /api/dub/jobs list into projects (Home's cards,
// ui/src/homeScreen.mjs) and draws the row at the foot of the left panel:
// "Languages", one chip per language of the open dubbing's project, the open
// one lit, then "+ Add language". A chip opens that dubbing the way a card
// does (resumeJob); + Add language holds the video again
// (POST /api/dub/jobs/{id}/again) and opens the Before dubbing card on it,
// set up as the open dubbing was, for another target language.
//
// The elements this file touches: #langRow and what it draws in it.
import { dubAgainSource } from "./dubApi.mjs";
import { toOriginal } from "./draft.mjs";
import { errorText, escapeHtml } from "./format.mjs";
import { languageName, t } from "./i18n.mjs";

/** The project a job belongs to: its first dubbing's id. */
export function projectKey(job) {
  return (job && (job.project_id || job.id)) || "";
}

/** The jobs grouped into projects, in the order the list has them (newest
    first): each group is that project's jobs, newest first. */
export function groupProjects(jobs) {
  const groups = new Map();
  for (const j of jobs || []) {
    const k = projectKey(j);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(j);
  }
  return [...groups.values()];
}

/** One job per language of a project, in the order the languages were added;
    a language dubbed twice (Start over) is its newest dubbing. `members` is
    newest first, as groupProjects gives them. */
export function projectLanguages(members) {
  const byLang = new Map();
  for (const j of [...members].reverse()) byLang.set(j.language_code || "", j);
  return [...byLang.values()];
}

/** What a dubbing's language is called: the name it was started with. */
export function languageLabel(job, langName) {
  // The record's English name ("Spanish (Mexico)") tells a variant apart; it
  // is said in the page's language from the code.
  return languageName(job.language_code, job.language || langName(job.language_code)) || t("Dubbing");
}

/** The delete dialog's second line for a project of `n` languages. */
export function deleteLine(n) {
  return n > 1 ? t("All {n} languages are deleted. This can’t be undone.", { n }) : t("This can’t be undone.");
}

/** The Advanced options a dubbing was made with, as the New project block's
    choices (ui/src/newProject.mjs putChoices). An engine the job did not
    record is left out, so the saved default stays. */
export function choicesOf(job) {
  const c = { dubMode: job.dub_mode === "perso" ? "perso" : "local",
              source: job.source_lang || "",
              speakers: job.num_speakers ? String(job.num_speakers) : "" };
  if (job.separation) c.sep = ["perso", "roformer"].includes(job.separation) ? job.separation : "local";
  if (job.stt_engine) c.stt = job.stt_engine === "perso" ? "perso" : "local";
  if (job.translator) c.translator = job.translator;
  if (job.quality != null) c.quality = Number(job.quality) > 1 ? "high" : "fast";
  if (job.tts) c.voice = job.tts;
  if (job.perso_model) c.persoModel = job.perso_model;
  return c;
}

// How long + Add language says why it could not open.
const NOTE_MS = 4000;

/**
 * @param {object} deps
 * @param {(id: string) => any} deps.$
 * @param {() => object|null} deps.getJob   the dubbing on screen
 * @param {(code: string) => string|null} deps.langName
 * @param {(jobId: string) => void} deps.onOpenJob
 * @param {(source: object, opts: object, project: string) => Promise<void>} deps.openDraft
 *        the Before dubbing card on a held video, in `project`
 * @param {(job: object) => string} deps.nameOf   what the project is called
 * @param {(jobId: string) => object[]|null} [deps.linesOf]  that dubbing's
 *        script lines as the table shows them, or null
 * @returns {{ setJobs: (jobs: object[]) => void, paint: () => void }}
 */
export function initLanguageRow({ $, getJob, langName, onOpenJob, openDraft, nameOf, linesOf = () => null }) {
  let jobs = [];
  let opening = false;

  function paint() {
    const row = $("langRow");
    const open = getJob();
    if (!open || (open.kind || "dub") !== "dub") { row.hidden = true; row.innerHTML = ""; return; }
    const members = jobs.filter((j) => projectKey(j) === projectKey(open) && j.id !== open.id);
    const langs = projectLanguages([open, ...members].sort((a, b) =>
      String(b.created || "").localeCompare(String(a.created || ""))));
    row.innerHTML = `<span class="lang-k">${t("Languages")}</span>` + langs.map((j) => {
      const on = (j.language_code || "") === (open.language_code || "");
      return `<button class="lang-chip${on ? " on" : ""}" type="button" data-job="${escapeHtml(j.id)}"${on ? ' aria-current="true"' : ""}>${escapeHtml(languageLabel(j, langName))}</button>`;
    }).join("") + `<button class="lang-chip lang-add" id="langAddBtn" type="button">${t("+ Add language")}</button>`;
    row.hidden = false;
  }

  async function addLanguage(btn) {
    const job = getJob();
    if (!job || opening) return;
    opening = true;
    btn.textContent = t("Opening…");
    try {
      const src = await dubAgainSource(job.id);
      // Where the video is spoken, from this dubbing's lines: a Perso API
      // dubbing is charged by those seconds (owner, 2026-10-22).
      const lines = linesOf(job.id);
      const speech = lines && lines.length ? toOriginal(lines.map((l) => [l.start, l.end]), src.ranges) : null;
      await openDraft({ downloadId: src.download_id, name: nameOf(job), duration: src.duration_sec, speech },
                      { tab: "dubbing", ranges: src.ranges, choices: choicesOf(job) },
                      projectKey(job));
    } catch (e) {
      // The one realistic reason is that the video is gone: the button says
      // it did not open, and the reason is its tip.
      btn.textContent = t("Could not open");
      btn.title = errorText(e);
      setTimeout(() => { btn.textContent = t("+ Add language"); btn.title = ""; }, NOTE_MS);
    } finally {
      opening = false;
    }
  }

  $("langRow").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.id === "langAddBtn") return addLanguage(btn);
    else if (btn.dataset.job && !btn.classList.contains("on")) onOpenJob(btn.dataset.job);
  });

  return {
    setJobs(list) { jobs = list || []; paint(); },
    paint,
  };
}
