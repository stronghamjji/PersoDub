// The choices made for the last project -- the target language and every
// Advanced option -- so the next project starts on them, after a restart too,
// the paid Perso ones included (owner, 2026-08-27 and again 2026-10-06:
// Windows test B7 dubbed with Perso API and Wren, and the next project came
// back On this computer with Oriole). Kept in the browser's own storage, one
// entry per control, written only when the person changes that control: a
// value the screen puts back by itself (a saved default, a fallback below)
// never overwrites what was chosen.
//
// Nothing here touches the page or the network.
import { neededModelId, neededPackIds } from "./modelsUi.mjs";
import { isModelId } from "./persoModels.mjs";

const KEY = "persodub.lastChoices";

// The choices that have a saved default as well (GET /api/setup defaults:
// kit.env, written by Settings or the Dub Agent's set_default), by its name.
// A default changed after the choice was made is the newer word and wins.
const SAVED_AS = { dubMode: "dub_mode", sep: "separation", stt: "stt",
                   translator: "translator", quality: "voice_quality", voice: "voice" };

// The values that need a cloud key saved, by the key they need.
const KEYED = { dubMode: { perso: "perso" }, sep: { perso: "perso" }, stt: { perso: "perso" },
                translator: { gemini: "gemini" } };

/** What was remembered, as {name: {value, over}}. {} when nothing was, or
    the storage cannot be read. */
export function readRemembered(storage) {
  try {
    const all = JSON.parse(storage.getItem(KEY) || "{}");
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  } catch { return {}; }
}

/** Remember one choice the person just made, with the saved default it was
    made over (`defaults`: GET /api/setup's, or null before it answered). */
export function rememberChoice(storage, name, value, defaults) {
  const all = readRemembered(storage);
  all[name] = { value: String(value), over: SAVED_AS[name] ? (defaults || {})[SAVED_AS[name]] ?? null : null };
  try { storage.setItem(KEY, JSON.stringify(all)); } catch { /* private window: kept for this run only */ }
}

/**
 * The remembered choices that can be put back now, as the New project dialog
 * puts choices back ({dubMode, sep, stt, translator, quality, voice,
 * persoModel, speakers, target}). One that cannot is left out, so its control
 * keeps the saved default: its default changed since, it needs a key that is
 * not saved any more, it is a local translator or the RoFormer no longer
 * downloaded, or it is a Perso model or speaker count this build does not
 * know. A target language the list does not have is the dialog's to settle
 * (it falls back to English).
 *
 * @param {object} all    readRemembered()
 * @param {object|null} setup  GET /api/setup: {defaults, keys, models}; null
 *        when it did not answer, which brings back only what needs none of it
 */
export function choicesToPutBack(all, setup) {
  const { defaults = null, keys = {}, models = [] } = setup || {};
  const gone = (ids) => ids.some((id) => (models.find((r) => r.id === id) || {}).state === "not_downloaded");
  const out = {};
  for (const name of [...Object.keys(SAVED_AS), "persoModel", "speakers", "target"]) {
    const entry = all[name];
    const value = entry && typeof entry.value === "string" ? entry.value : null;
    if (value === null) continue;
    if (SAVED_AS[name] && (!defaults || defaults[SAVED_AS[name]] !== entry.over)) continue;
    const key = (KEYED[name] || {})[value];
    if (key && !keys[key]) continue;
    if (name === "translator" && gone([...neededPackIds("translate", value), neededModelId("translate", value)].filter(Boolean))) continue;
    if (name === "sep" && gone([neededModelId("sep", value)].filter(Boolean))) continue;
    if (name === "persoModel" && !isModelId(value)) continue;
    if (name === "speakers" && !/^\d*$/.test(value)) continue;
    out[name] = value;
  }
  return out;
}
