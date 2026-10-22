// The translators a dubbing that ChatGPT stopped (its limit, or its sign-in
// gone) can carry on with: one button each on the popup, and Resume does the
// rest (POST /api/dub/jobs/{id}/resume with the translator). Nothing switches
// by itself (owner, 2026-10-03). Pure: the page hands in what GET /api/engines
// and GET /api/models said.
import { gb } from "./modelsUi.mjs";
import { t, currentLanguage } from "./i18n.mjs";

const NAMES = { chatgpt: "ChatGPT", hunyuan: "Hunyuan", gemma: "Gemma", gemini: "Gemini" };
// Best first, the order the owner named them.
const OFFERED = ["hunyuan", "gemma", "gemini"];

// "with ChatGPT", one whole phrase per translator: Korean puts 로 or 으로
// after a name by how it is read (ChatGPT로, Hunyuan으로), so the name alone
// cannot be dropped into a sentence.
const WITH = {
  chatgpt: () => t("with ChatGPT"), hunyuan: () => t("with Hunyuan"), gemma: () => t("with Gemma"),
  gemini: () => t("with Gemini"), perso: () => t("with Perso"),
};

/** "with ChatGPT", said before what it is doing ("ChatGPT로 1줄 번역 중…"),
 * or "" for a translator this file does not know. */
export function withTranslator(id) {
  return WITH[id] ? WITH[id]() : "";
}

/**
 * @param {string} failed   the job's own translator, never offered back
 * @param {object} engines  GET /api/engines: {hunyuan_available, gemma_available, gemini_available, ...}
 * @param {object[]} rows   GET /api/models rows: {id, state, bytes}
 * @returns {{id: string, label: string}[]}  a translator that runs now says
 *   only its name; a local one not downloaded yet says its size too, and the
 *   resume's 409 then opens the download dialog. One whose model is here but
 *   cannot run right now (its runtime is down), and Gemini without a key,
 *   are left out.
 */
export function translatorChoices(failed, engines, rows) {
  const row = (id) => (rows || []).find((r) => r.id === id);
  const runtime = row("ollama-runtime");
  const out = [];
  for (const id of OFFERED) {
    const name = NAMES[id];
    if (id === failed) continue;
    if (engines && engines[`${id}_available`]) {
      out.push({ id, label: t("Continue with {name}", { name }) });
      continue;
    }
    const model = row(id);
    if (!model || model.state === "ready") continue;
    // The download dialog asks for the runtime too when it is not here yet.
    const bytes = model.bytes + (runtime && runtime.state !== "ready" ? runtime.bytes : 0);
    out.push({ id, label: t("Continue with {name} ({size} GB)", { name, size: gb(bytes) }) });
  }
  return out;
}

/** "Resets Oct 24, 1:07 PM." out of a ChatGPT limit notice (app/pipeline.py
 * raise_notice), in the page's language, or "" when OpenAI named no time. The
 * notice's message is English on purpose, so this reads it the same in both. */
export function resetsSentence(message) {
  const m = /Resets ([^.]+)\./.exec(message || "");
  return m ? t("Resets {time}.", { time: resetTime(m[1]) }) : "";
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** OpenAI's reset time as app/translate.py reset_time_in writes it ("Oct 24,
 * 1:07 PM", or "1:07 PM" later today: Codex writes it in this computer's own
 * time zone) the way the page's language writes a time: "10월 24일 오후 1:07"
 * on a Korean page. English, or a time it cannot read, stays as it came --
 * the same as app/translate.py reset_time_shown. */
export function resetTime(text) {
  const m = /^(?:([a-z]{3})[a-z]*\.? (\d{1,2}), )?(\d{1,2}):(\d{2}) ?([ap]m)$/i.exec(String(text || "").trim());
  const month = m && m[1] ? MONTHS.indexOf(m[1].toLowerCase()) + 1 : 0;
  if (!m || currentLanguage() === "en" || (m[1] && !month)) return text;
  const vars = { hour: Number(m[3]), minute: m[4] };
  const clock = m[5].toUpperCase() === "AM" ? t("{hour}:{minute} AM", vars) : t("{hour}:{minute} PM", vars);
  return month ? t("{month}/{day} {clock}", { month, day: Number(m[2]), clock }) : clock;
}
