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
// the order the choice lists them: a line of what each is where Perso says,
// its price in credits per second, and whether a plan below Pro is refused
// (VT40314, app/perso_client.py PersoPlanRequiredError).
const KNOWN = [
  { id: "ORIOLE", label: "Oriole", desc: "Default", rate: 1 },
  { id: "LINNET_4", label: "Linnet 4", rate: 1 },
  { id: "LINNET_3", label: "Linnet 3", rate: 1 },
  { id: "WREN", label: "Wren", rate: 1 },
  { id: "FINCH", label: "Finch", desc: "Lowest-cost basic dubbing", rate: 0.2, pro: true },
  { id: "NIGHTINGALE", label: "Nightingale", desc: "Premium voice", rate: 6, pro: true },
];
// The one selected until another is chosen, as on Perso's site.
export const DEFAULT_MODEL = "ORIOLE";
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

function rateText(info) {
  return info.rate == null ? "" : t("{n} credits per second", { n: info.rate });
}

/** The line under a model in the list: "Default · 1 credit a second · 77 languages". */
export function modelCaption(info, languages) {
  return [info.desc ? t(info.desc) : "", rateText(info), t("{n} languages", { n: languages })]
    .filter(Boolean).join(" · ");
}

/** The line under the choice: price, languages, and the plan it needs. */
export function modelHint(info, languages) {
  return [rateText(info), t("{n} languages", { n: languages }), info.pro ? t("Perso Pro plan and up") : ""]
    .filter(Boolean).join(" · ");
}
