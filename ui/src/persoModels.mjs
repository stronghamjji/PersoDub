// The Perso voice models a Perso API dubbing can be made with: the "Dubbing
// model" choice under Advanced options, and the name a finished dubbing
// shows. The model is chosen first and the target languages follow it: each
// entry of Perso's language list (GET /api/languages) names the models that
// language has. The server checks the pair again (app/languages.py model_for).
//
// Every model that list names is offered, so one Perso adds shows up without
// an app update (owner, 2026-10-19). What the screen knows about each is the
// table below; a model not on it is offered under a name made from its id.
import { t } from "./i18n.mjs";

// The models known on 2026-10-19 (Perso's API docs and language list), in
// the order the choice lists them: a line of what each is for, from Perso's
// dubbing models page in the words the owner approved (2026-10-22), its price
// in credits per second of speech (Nightingale's is 4, owner 2026-10-22), and
// whether a plan below Pro is refused (VT40314, app/perso_client.py
// PersoPlanRequiredError). Nightingale's also says one line cannot be remade
// on its own (app/perso_edit.py nightingale).
const KNOWN = [
  { id: "ORIOLE", label: "Oriole", desc: "Natural local pronunciation, steady voice. Lectures and corporate video", rate: 1 },
  { id: "LINNET_4", label: "Linnet 4", desc: "New model that follows the context. Honours audio tags", rate: 1 },
  { id: "LINNET_3", label: "Linnet 3", desc: "The earlier expressive model", rate: 1 },
  { id: "WREN", label: "Wren", desc: "Steady narration. Lecture scripts, company intros, read-aloud; most even Korean voice", rate: 1 },
  { id: "FINCH", label: "Finch", desc: "Keeps your own voice, lowest cost. Interviews and whole channels", rate: 0.2, pro: true },
  { id: "NIGHTINGALE", label: "Nightingale", desc: "Rich emotion for drama and shows. No per-line remake", rate: 4, pro: true },
];
// What a dubbing nobody chose a model for is made with: Linnet 4, or Oriole
// in a language Linnet 4 lacks, as Perso's own API picks since 2026-10-12
// (owner, 2026-10-22). The app always names the model, so it picks alike
// (app/languages.py model_for).
export const DEFAULT_MODEL = "LINNET_4";
const FALLBACK_MODEL = "ORIOLE";
// What a model's id may look like (Perso's own are like "LINNET_4").
const MODEL_ID = /^[A-Z][A-Z0-9_]{1,30}$/;

/** Whether `id` can name a Perso voice model at all. */
export function isModelId(id) {
  return typeof id === "string" && MODEL_ID.test(id);
}

/** What the screen knows of a model: its name, and when known its line of
    description, price and plan. {label: ""} for something that is no id. */
export function modelInfo(id) {
  const known = KNOWN.find((m) => m.id === id);
  if (known) return known;
  if (!isModelId(id)) return { id, label: "" };
  return { id, label: id.split("_").filter(Boolean).map((w) => w[0] + w.slice(1).toLowerCase()).join(" ") };
}

/** A model's name as the screen says it ("Oriole", "Linnet 4"), or "" for no id. */
export function modelLabel(id) {
  return modelInfo(id).label;
}

/** Every model the language list names, the known ones first in their order
    and any other after them as the list names them. Before the list answers
    (its entries name no models) that is the known ones. */
export function modelsIn(list) {
  const named = [];
  for (const l of list || []) for (const m of l.models || []) if (isModelId(m) && !named.includes(m)) named.push(m);
  if (!named.length) return KNOWN.map((m) => m.id);
  return [...KNOWN.map((m) => m.id).filter((id) => named.includes(id)), ...named.filter((id) => !KNOWN.some((m) => m.id === id))];
}

/** The languages a model can dub into, in the list's own order. An entry that
    names no models (the list has not answered yet) is kept under every model. */
export function languagesFor(list, model) {
  return list.filter((l) => !l.models || l.models.includes(model));
}

/** The model a dubbing into this language gets when nobody chose one:
    Linnet 4 when the language has it, else Oriole. An entry that names no
    models, or none at all, is Linnet 4's. */
export function defaultModelFor(entry) {
  return !entry || !entry.models || entry.models.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : FALLBACK_MODEL;
}

/** The languages a dubbing nobody chose a model for can go into: every one
    Linnet 4 or Oriole has, each with its own (defaultModelFor). */
export function defaultLanguages(list) {
  return list.filter((l) => !l.models || l.models.includes(DEFAULT_MODEL) || l.models.includes(FALLBACK_MODEL));
}

// One credit is singular in English: the line read "1 credits per second" (2026-10-22).
function rateText(info) {
  if (info.rate == null) return "";
  return info.rate === 1 ? t("{n} credit per second", { n: info.rate }) : t("{n} credits per second", { n: info.rate });
}

// "80 supported languages", 지원 언어 80개, as one unit: a line too long for
// its box wraps around it, never inside it (owner, 2026-10-22).
function supportedLanguages(n) {
  return t("{n} supported languages", { n }).replaceAll(" ", "\u00a0");
}

/** The line under a model in the list: "Default · 1 credit per second · 80 supported languages". */
export function modelCaption(info, languages) {
  return [info.id === DEFAULT_MODEL ? t("Default") : "", info.desc ? t(info.desc) : "", rateText(info),
          supportedLanguages(languages)]
    .filter(Boolean).join(" · ");
}

/** The line under the choice: price, languages, and the plan it needs. The
    count is this model's own (Help's "100+" is every model's together), said
    as the list says it, without "with this model" (owner, 2026-10-22). */
export function modelHint(info, languages) {
  return [rateText(info), supportedLanguages(languages), info.pro ? t("Perso Pro plan and up") : ""]
    .filter(Boolean).join(" · ");
}
