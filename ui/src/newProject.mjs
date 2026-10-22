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
import { fmtLength } from "./format.mjs";
import { initTrimBar } from "./trimBar.mjs";
import { downloadsLabel, errorText } from "./format.mjs";
import { DEFAULT_MODEL, defaultLanguages, defaultModelFor, languagesFor, modelCaption, modelHint, modelInfo,
         modelsIn } from "./persoModels.mjs";
import { readRemembered, rememberChoice, choicesToPutBack } from "./rememberedChoices.mjs";
import { lucide } from "./icons.mjs";
import { placeList, listKeys } from "./pickList.mjs";
import { languageName, t } from "./i18n.mjs";

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
  // The languages only Perso's Nightingale model has (its list, 2026-10-02).
  // Tibetan, Uyghur, Cantonese and Chinese (Taiwan) carry no flag on purpose:
  // any one country's flag on them is a statement to someone (user, 2026-10-03).
  "ak": "🇬🇭", "am": "🇪🇹", "ar-EG": "🇪🇬", "dgo": "🇮🇳", "en-AU": "🇦🇺", "en-CA": "🇨🇦", "es-AR": "🇦🇷",
  "es-CL": "🇨🇱", "eu": "🇪🇸", "fr-CA": "🇨🇦", "ki": "🇰🇪", "lg": "🇺🇬", "mn": "🇲🇳", "my": "🇲🇲", "nso": "🇿🇦",
  "rn": "🇧🇮", "rw": "🇷🇼", "sq": "🇦🇱", "ss": "🇸🇿", "st": "🇱🇸", "su": "🇮🇩", "tg": "🇹🇯", "tn": "🇧🇼",
  "ts": "🇿🇦", "uz": "🇺🇿", "ve": "🇿🇦", "war": "🇵🇭", "wo": "🇸🇳", "yo": "🇳🇬", "zu": "🇿🇦",
  // In Perso's list by 2026-10-19: Asturian and Occitan under the country
  // they are spoken in, as Basque is.
  "ast": "🇪🇸", "mi": "🇳🇿", "mt": "🇲🇹", "oc": "🇫🇷", "or": "🇮🇳",
};

// How often the dialog asks how far along a link's download is. A second is
// what the progress row is worth: the percent moves in visible steps and the
// question costs one small answer.
const DOWNLOAD_POLL_MS = 1000;

/** The dialog's bottom line: how long the video is and, once the handles
    have cut into it, how much of it is kept. Nothing for an unknown length. */
export function lengthLine(seconds, trim) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const length = fmtLength(seconds);
  if (!trim || trim.start == null || trim.end == null) return t("Duration: {length}", { length });
  return t("Duration: {length} · {kept} kept", { length, kept: fmtLength(trim.end - trim.start) });
}

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
 * @param {() => Promise<string>} [deps.pickedFolder]  the folder the Download
 *        dialog's Change picked, "" for Downloads, so the saved line names it
 * @param {(source: {downloadId, title, duration_sec, trim}) => void} deps.onErase
 *        hand the held video to the subtitle-erasing screen
 * @param {Storage} [deps.storage]  the browser's localStorage, where the last
 *        project's choices are kept for the next (ui/src/rememberedChoices.mjs)
 * @returns the operations the rest of the page calls.
 */
export function initNewProjectUi({ $, state, onStart, applyEngineAvailability,
                                   updateEngineHints, paintDubMode,
                                   playRange, cancelRange, labelPx,
                                   onClosed, onPickFile, onErase, reveal = null, storage = null,
                                   pickedFolder = async () => "" }) {
  // Populated from dubApi.LANGUAGES (the model's own supported-language table).
  // sourceLangSelect's default is the literal "Auto-detect" <option> written into
  // its markup -- defCode null never matches a real LANGUAGES code, so no
  // appended option overwrites that selection with a specific language.
  // targetLangSelect defaults to English: the app's own use is Korean source
  // material dubbed outward, until a target is chosen: that one is remembered
  // (startOnDefaults).
  function fillLanguageSelects() {
    for (const [selId, defCode, withFlag] of [["sourceLangSelect", null, false], ["targetLangSelect", "en", true]]) {
      const sel = $(selId);
      if (!sel) continue;
      for (const l of LANGUAGES) {
        const o = document.createElement("option");
        o.value = l.code;
        const flag = LOCAL_FLAGS[l.code] || LANG_FLAGS[l.code];
        const name = languageName(l.code, l.name);
        o.textContent = withFlag && flag ? `${flag} ${name}` : name;
        if (l.code === defCode) o.selected = true;
        sel.appendChild(o);
      }
    }
  }
  fillLanguageSelects();

  // The target list follows the dubbing path: when the cloud dubs, the
  // languages the chosen Perso voice model has (of Perso's 111 on 2026-10-02,
  // with regional variants such as English (UK)); the model's ten when this
  // computer does. Until GET /api/languages
  // answers, both paths show the ten. The source dropdown stays as it is:
  // "Auto-detect" covers the cloud, and the ten are what Whisper is asked for.
  const asEntries = (xs) => xs.map((l) => ({ id: l.id || l.code, code: l.code, name: l.name, tag: l.tag || null,
                                             // Perso's entries: the voice models the language has.
                                             ...(l.models ? { models: l.models } : {}) }));
  let languageLists = { local: asEntries(LANGUAGES), perso: asEntries(LANGUAGES) };
  let persoModel = DEFAULT_MODEL;
  // Whether the model is one the person chose (or a choice put back). Until
  // then it is the target language's own default, Linnet 4 or Oriole
  // (ui/src/persoModels.mjs defaultModelFor), and the target list offers
  // every language either of the two has.
  let modelChosen = false;
  // A remembered target the list on screen does not have yet: a Perso one
  // while GET /api/languages has not answered, or while this computer dubs.
  // Picked as soon as a list has it; forgotten once the person picks another.
  let wantedTarget = null;
  function currentLanguages() {
    const mode = $("dubModeSelect") ? $("dubModeSelect").value : "local";
    if (mode !== "perso") return languageLists.local;
    return modelChosen ? languagesFor(languageLists.perso, persoModel) : defaultLanguages(languageLists.perso);
  }
  function refillTargetLanguages() {
    const sel = $("targetLangSelect");
    if (!sel) return;
    // A remembered model Perso no longer names (once its list has answered)
    // gives way to the default rather than starting a dubbing Perso refuses.
    if (languageLists.perso.some((l) => l.models) && !modelsIn(languageLists.perso).includes(persoModel)) {
      modelChosen = false;
    }
    const list = currentLanguages();
    const want = wantedTarget && list.some((l) => l.id === wantedTarget) ? wantedTarget : null;
    if (want) wantedTarget = null;
    const keep = want || sel.value || "en";
    const local = list === languageLists.local;
    sel.innerHTML = "";
    for (const l of list) {
      const o = document.createElement("option");
      o.value = l.id;
      const flag = (local && LOCAL_FLAGS[l.code]) || LANG_FLAGS[l.id] || (!l.tag && LANG_FLAGS[l.code]);
      const name = languageName(l.id, l.name);
      o.textContent = flag ? `${flag} ${name}` : name;
      o.dataset.name = l.name;   // English, for the list's search
      sel.appendChild(o);
    }
    sel.value = list.some((l) => l.id === keep) ? keep : "en";
    paintPersoModel();
    paintTargetPick();
  }

  // The Dubbing model: a button naming the chosen model and, pressed, a list
  // of every model Perso's language list names (ui/src/persoModels.mjs), each
  // with a line of what it is under its name -- an Apple menu item's subtitle
  // -- since "Oriole, Linnet 4, Wren" say nothing by their names alone (owner,
  // 2026-10-19). Choosing one refills the target languages with its own.
  let pickOpen = false;
  let pickBtn = null;
  function paintPersoModel() {
    $("persoModelRow").hidden = $("dubModeSelect").value !== "perso";
    if ($("persoModelRow").hidden) pickOpen = false;
    const box = $("persoModelPick");
    box.innerHTML = "";
    // A model without the chosen target language cannot be chosen: choosing
    // it used to swap the language for English without a word, and a Start
    // then dubbed into the wrong language for credits (Windows C11, 2026-10-07).
    const target = $("targetLangSelect") ? $("targetLangSelect").value : "";
    const entry = languageLists.perso.find((l) => l.id === target);
    const targetName = (entry || {}).name || target;
    // Nobody chose one: the language's own, so it follows the language.
    if (!modelChosen) persoModel = defaultModelFor(entry);
    const chosen = modelInfo(persoModel);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "persoModelBtn";
    btn.className = "model-pick-btn";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", String(pickOpen));
    btn.setAttribute("aria-labelledby", "persoModelLabel persoModelBtn");
    const name = document.createElement("span");
    name.className = "model-name";
    name.textContent = chosen.label;
    btn.appendChild(name);
    if (chosen.pro) btn.appendChild(proBadge());
    btn.addEventListener("click", () => {
      pickOpen = !pickOpen;
      paintPersoModel();
    });
    pickBtn = btn;
    box.appendChild(btn);
    if (pickOpen) {
      const list = modelList(target, targetName);
      box.appendChild(list);
      placeList(list, btn);
    }
    $("persoModelHint").textContent = modelHint(chosen, languagesFor(languageLists.perso, persoModel).length);
  }
  function proBadge() {
    const badge = document.createElement("span");
    badge.className = "model-pro";
    badge.textContent = t("Pro and up");
    return badge;
  }
  function modelList(target, targetName) {
    const list = document.createElement("div");
    list.id = "persoModelList";
    list.className = "model-pick-list";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-labelledby", "persoModelLabel");
    for (const id of modelsIn(languageLists.perso)) {
      const info = modelInfo(id);
      const lacks = !!target && id !== persoModel
        && !languagesFor(languageLists.perso, id).some((l) => l.id === target);
      const opt = document.createElement("button");
      opt.type = "button";
      opt.className = id === persoModel ? "model-opt on" : "model-opt";
      opt.setAttribute("role", "option");
      opt.setAttribute("aria-selected", String(id === persoModel));
      opt.dataset.model = id;
      opt.disabled = lacks;
      opt.title = lacks ? t("{model} has no {language}", { model: info.label, language: targetName }) : "";
      const text = document.createElement("span");
      text.className = "model-text";
      const label = document.createElement("span");
      label.className = "model-name";
      label.textContent = info.label;
      const caption = document.createElement("span");
      caption.className = "model-caption";
      caption.textContent = modelCaption(info, languagesFor(languageLists.perso, id).length);
      text.append(label, caption);
      opt.appendChild(text);
      if (info.pro) opt.appendChild(proBadge());
      opt.addEventListener("click", () => {
        if (lacks) return;
        persoModel = id;
        modelChosen = true;
        pickOpen = false;
        rememberChoice(storage, "persoModel", id, savedDefaults);
        refillTargetLanguages();
        // Said like a dropdown's choice: the Before dubbing card prices the
        // dubbing by the model (ui/src/draftSetup.mjs).
        $("persoModelPick").dispatchEvent(new Event("change"));
        pickBtn?.focus?.();
      });
      list.appendChild(opt);
    }
    listKeys(list, () => {
      pickOpen = false;
      paintPersoModel();
      pickBtn?.focus?.();
    });
    return list;
  }
  function closePick() {
    if (!pickOpen) return;
    pickOpen = false;
    paintPersoModel();
  }
  // Scrolling or resizing would leave the list where the button was.
  globalThis.addEventListener?.("resize", closePick);
  document.addEventListener("scroll", (e) => {
    if (e.target && typeof e.target.closest === "function" && e.target.closest("#persoModelList")) return;
    closePick();
  }, true);
  // A press anywhere else closes the list.
  document.addEventListener("pointerdown", (e) => {
    if (!pickOpen || !e.target || typeof e.target.closest !== "function") return;
    if (e.target.closest("#persoModelPick")) return;
    pickOpen = false;
    paintPersoModel();
  });
  // The Target language: a button naming the chosen language and, pressed,
  // the list in the Dubbing model's dress with a search field at its top --
  // Oriole has 77 languages, found by scrolling until now (owner, 2026-10-22).
  // Choosing one sets #targetLangSelect, kept hidden, and fires its change,
  // so everything that reads the language goes on reading it there.
  let langOpen = false;
  let langQuery = "";
  let langBtn = null;
  function paintTargetPick() {
    const box = $("targetLangPick");
    box.innerHTML = "";
    const sel = $("targetLangSelect");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "targetLangBtn";
    btn.className = "model-pick-btn";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", String(langOpen));
    btn.setAttribute("aria-labelledby", "targetLangLabel targetLangBtn");
    const name = document.createElement("span");
    name.className = "model-name";
    name.textContent = ([...sel.options].find((o) => o.value === sel.value) || {}).textContent || "";
    btn.appendChild(name);
    btn.addEventListener("click", () => {
      langOpen = !langOpen;
      langQuery = "";
      paintTargetPick();
    });
    langBtn = btn;
    box.appendChild(btn);
    if (langOpen) {
      const list = languageList();
      box.appendChild(list);
      placeList(list, btn);
    }
  }
  // The search narrows the list to the languages with the typed words in
  // the name shown, the English name or the code -- "eng" finds English in a
  // Korean window (owner, 2026-10-22) -- and says how many of how many are
  // left ("77개 중 2개").
  const searched = (o) => `${o.textContent} ${o.dataset.name || ""} ${o.value}`.toLowerCase();
  function languageList() {
    const list = document.createElement("div");
    list.id = "targetLangList";
    list.className = "model-pick-list lang-pick-list";
    const search = document.createElement("div");
    search.className = "lang-search";
    search.innerHTML = lucide("search", 14);
    const field = document.createElement("input");
    field.type = "search";
    field.value = langQuery;
    field.placeholder = t("Search languages");
    field.setAttribute("aria-label", t("Search languages"));
    search.appendChild(field);
    const opts = document.createElement("div");
    opts.className = "lang-opts";
    opts.setAttribute("role", "listbox");
    opts.setAttribute("aria-labelledby", "targetLangLabel");
    const count = document.createElement("div");
    count.className = "lang-count";
    function fill() {
      const all = [...$("targetLangSelect").options];
      const words = langQuery.trim().toLowerCase();
      const found = words ? all.filter((o) => searched(o).includes(words)) : all;
      opts.innerHTML = "";
      for (const o of found) opts.appendChild(languageRow(o));
      count.textContent = words ? t("{shown} of {all}", { shown: found.length, all: all.length }) : "";
      count.hidden = !words;
    }
    fill();
    field.addEventListener("input", () => { langQuery = field.value; fill(); });
    // Enter in the field takes the first one left; up and down move between
    // the field and the languages; Escape closes the list and not the dialog
    // under it.
    list.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeLanguages();
        langBtn?.focus?.();
        return;
      }
      const rows = [...opts.children];
      if (e.key === "Enter" && e.target === field) {
        e.preventDefault();
        if (rows[0]) chooseLanguage(rows[0].dataset.lang);
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const at = rows.indexOf(document.activeElement);   // -1: the field
      const next = e.key === "ArrowDown" ? rows[Math.min(at + 1, rows.length - 1)] : at > 0 ? rows[at - 1] : field;
      next?.focus?.();
    });
    list.append(search, opts, count);
    setTimeout(() => {
      field.focus?.({ preventScroll: true });
      const on = opts.querySelector(".model-opt.on");
      if (on) opts.scrollTop = on.offsetTop - (opts.clientHeight - on.offsetHeight) / 2;
    }, 0);
    return list;
  }
  function languageRow(o) {
    const on = o.value === $("targetLangSelect").value;
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = on ? "model-opt on" : "model-opt";
    opt.setAttribute("role", "option");
    opt.setAttribute("aria-selected", String(on));
    opt.dataset.lang = o.value;
    const text = document.createElement("span");
    text.className = "model-text";
    const name = document.createElement("span");
    name.className = "model-name";
    name.textContent = o.textContent;
    text.appendChild(name);
    opt.appendChild(text);
    opt.addEventListener("click", () => chooseLanguage(o.value));
    return opt;
  }
  function chooseLanguage(id) {
    langOpen = false;
    const sel = $("targetLangSelect");
    if (sel.value === id) paintTargetPick();
    else {
      sel.value = id;
      sel.dispatchEvent(new Event("change"));
    }
    langBtn?.focus?.();
  }
  function closeLanguages() {
    if (!langOpen) return;
    langOpen = false;
    paintTargetPick();
  }
  // Scrolling (but not in the list), resizing or a press anywhere else closes it.
  globalThis.addEventListener?.("resize", closeLanguages);
  document.addEventListener("scroll", (e) => {
    if (e.target && typeof e.target.closest === "function" && e.target.closest("#targetLangList")) return;
    closeLanguages();
  }, true);
  document.addEventListener("pointerdown", (e) => {
    if (!langOpen || !e.target || typeof e.target.closest !== "function") return;
    if (e.target.closest("#targetLangPick")) return;
    closeLanguages();
  });
  $("targetLangSelect").addEventListener("change", paintTargetPick);
  paintTargetPick();

  fetchLanguages().then((lists) => {
    languageLists = { local: asEntries(lists.local), perso: asEntries(lists.perso) };
    refillTargetLanguages();
  });
  if ($("dubModeSelect")) $("dubModeSelect").addEventListener("change", refillTargetLanguages);

  // Processing: the two halves above the languages (owner, 2026-10-22) set
  // #dubModeSelect, kept hidden, and fire its change, so everything that
  // follows the choice -- the languages, the model row, the hints, the
  // greying, what is remembered -- follows it as it always has.
  // paintModeSwitch lights the half the select is on, whoever set it.
  const MODE_HALVES = { dubModeLocal: "local", dubModePerso: "perso" };
  function paintModeSwitch() {
    for (const [id, mode] of Object.entries(MODE_HALVES)) {
      $(id).setAttribute("aria-checked", String($("dubModeSelect").value === mode));
    }
  }
  for (const [id, mode] of Object.entries(MODE_HALVES)) {
    $(id).addEventListener("click", () => {
      const sel = $("dubModeSelect");
      if (sel.value === mode) return;
      sel.value = mode;
      sel.dispatchEvent(new Event("change"));
    });
  }
  $("dubModeSelect").addEventListener("change", paintModeSwitch);
  paintModeSwitch();
  // A new target language changes which models can be pressed.
  if ($("targetLangSelect")) $("targetLangSelect").addEventListener("change", paintPersoModel);

  // The dropdowns start on the app's saved defaults (GET /api/setup: kit.env,
  // written by Settings or the Dub Agent's set_default), so what the agent
  // changed is what the dialog shows, and a choice survives a relaunch.
  // Resolves to the whole answer (keys and models too), or null without one.
  let savedDefaults = null;
  async function loadSavedDefaults() {
    let setup;
    try {
      const r = await fetch("/api/setup");
      if (!r.ok) return null;
      setup = await r.json();
    } catch { return null; }
    const d = setup.defaults || {};
    savedDefaults = d;
    putChoices({ dubMode: d.dub_mode, sep: d.separation, stt: d.stt,
                 translator: d.translator, quality: d.voice_quality, voice: d.voice });
    return setup;
  }

  // The five choices under Advanced options, read and put back as one. A value
  // the dropdown does not offer is left alone.
  function putChoices(c) {
    const pick = (id, value) => {
      const sel = $(id);
      if (sel && value && sel.querySelector(`option[value="${value}"]`)) sel.value = value;
    };
    pick("dubModeSelect", c.dubMode);
    paintModeSwitch();
    // The Perso voice model has no saved default: without one handed in, the
    // row starts on the target language's default again.
    persoModel = c.persoModel || DEFAULT_MODEL;
    modelChosen = !!c.persoModel;
    refillTargetLanguages();
    pick("sepSelect", c.sep);
    pick("sttSelect", c.stt);
    pick("translateSelect", c.translator);
    pick("qualitySelect", c.quality);
    pick("voiceSelect", c.voice);
    // Add language also starts on the dubbing's own source language ("" is
    // Auto-detect) and speaker count (ui/src/languageRow.mjs choicesOf).
    const src = $("sourceLangSelect");
    if (c.source !== undefined && src) src.value = src.querySelector(`option[value="${c.source}"]`) ? c.source : "";
    if (c.speakers !== undefined && $("numSpeakers")) $("numSpeakers").value = c.speakers;
    // The remembered target, once the list has it (refillTargetLanguages).
    if (c.target !== undefined) { wantedTarget = c.target; refillTargetLanguages(); }
  }
  // What the person picks is remembered for the next project, control by
  // control (ui/src/rememberedChoices.mjs). Only a change event counts: the
  // values this file puts back by itself fire none, so a default or a
  // fallback never overwrites a choice.
  for (const [id, name] of [["dubModeSelect", "dubMode"], ["sepSelect", "sep"], ["sttSelect", "stt"],
                            ["translateSelect", "translator"], ["qualitySelect", "quality"],
                            ["voiceSelect", "voice"], ["numSpeakers", "speakers"],
                            ["targetLangSelect", "target"]]) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener("change", () => {
      if (name === "target") wantedTarget = null;
      rememberChoice(storage, name, el.value, savedDefaults);
    });
  }
  function takeChoices() {
    return { dubMode: $("dubModeSelect").value, sep: $("sepSelect").value,
             stt: $("sttSelect").value, translator: $("translateSelect").value,
             quality: $("qualitySelect").value, voice: $("voiceSelect").value,
             persoModel: modelChosen ? persoModel : undefined };
  }
  // What the dialog was set to when it sent its video to the erase screen. The
  // way back reopens the dialog, and reopening starts the dropdowns on the
  // saved defaults: Whisper, chosen a moment ago, came back as Perso API, and
  // the dub that followed spent credits nobody chose to spend (2026-09-29).
  let choicesBeforeErase = null;

  // The play button's purple-while-playing state is driven by the video, whose
  // listeners outlive the box; kept here so re-drawing swaps them rather than
  // piling a second set on.
  // The trim bar is its own module (ui/src/trimBar.mjs): the Erase subtitles
  // screen draws the same control, and one question asked twice is how the two
  // would come to answer it differently. What is this dialog's own goes in
  // here -- the player it scrubs, the badge it writes the position into, and
  // where the chosen part is kept.
  // The length under the picture, and the one warning that rides with it:
  // over 30 minutes is not refused, but said plainly, with the way out
  // (trim into parts). The length itself takes hours on a slow machine.
  const LONG_VIDEO_SECONDS = 30 * 60;
  function paintLength(seconds) {
    $("projectDur").textContent = fmtLength(seconds);
    $("projectLength").textContent = lengthLine(seconds, state.newProject && state.newProject.trim);
    $("projectLongHint").hidden = !(Number.isFinite(seconds) && seconds > LONG_VIDEO_SECONDS);
  }
  function clearLength(text = "") {
    $("projectDur").textContent = text;
    $("projectLength").textContent = text;
    $("projectLongHint").hidden = true;
  }

  const trimBar = initTrimBar({
    $, getVideo: () => $("projectVideo"), getClock: () => $("projectDur"),
    playRange, cancelRange, labelPx,
    onChange: (trim) => {
      if (state.newProject) state.newProject.trim = trim;
      // The note speaks of what will be dubbed: a cut under 30 minutes of a
      // longer video needs no warning (user, 2026-09-24).
      const v = $("projectVideo");
      const full = Number.isFinite(v.duration) ? v.duration : 0;
      const kept = trim && trim.end != null && trim.start != null ? trim.end - trim.start : full;
      $("projectLongHint").hidden = !(kept > LONG_VIDEO_SECONDS);
      if (full) $("projectLength").textContent = lengthLine(full, trim);
    },
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
    // Why the two are dim: with several videos they never light up, and
    // nothing said so (2026-09-30).
    const why = np.downloadId ? "" : np.files ? t("One video at a time") : t("The video is still coming in");
    $("saveClipBtn").title = why;
    $("eraseBtn").title = why;
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
      paintLength(v.duration);
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
        $("projectError").textContent = d.error || t("Could not fetch the video from this link. Paste it again in a moment, or drag the video file in.");
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
      $("projectError").textContent = errorText(e);
      return;
    }
    if (!state.newProject) return;   // closed while the fetch was being started
    watchDownload(id);
  }

  // The language dropdowns and Advanced options are one shared block (a
  // draft's Dubbing tab borrows it too -- ui/src/draftSetup.mjs); moveInto
  // puts it back home, into the one box of the dialog that scrolls
  // (#projectOptions), whenever this dialog opens. The ids inside never
  // change, so every listener wired to them above keeps working no matter
  // which panel currently holds the block.
  function restoreOptionsHome() {
    moveOptionsInto($("projectOptions"));
  }

  /** Lets a draft's Dubbing tab borrow the block while there is no dialog to
      show it in (ui/src/draftSetup.mjs). Order: languages, the voice
      engine's warning, then the stage rows under their heading. */
  function moveOptionsInto(container) {
    container.appendChild($("langGrid"));
    container.appendChild($("engineWarning"));
    container.appendChild($("stageHead"));
    container.appendChild($("advancedBody"));
  }

  /** The choices under Advanced options back on the saved ones, then on the
      ones the person last picked (ui/src/rememberedChoices.mjs) -- or on
      `kept` instead, when the dialog is being put back as it was or a
      dubbing's own are handed in (Add language). Also what a new draft
      starts on (ui/src/draftSetup.mjs). */
  function startOnDefaults(kept = null) {
    return loadSavedDefaults().then((setup) => {
      putChoices(kept || choicesToPutBack(readRemembered(storage), setup));
      // Setting a select's value fires no change event, so the hints under the
      // dropdowns and the cloud-mode greying must be repainted by hand.
      updateEngineHints();
      paintDubMode();
      applyEngineAvailability();
    });
  }

  function openNewProject(source) {
    restoreOptionsHome();
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
                         title: source.title || "" };
    stopWatching();
    releaseProjectVideo();
    const v = $("projectVideo");
    // A local file can be played and scrubbed; a link only ever has a still.
    v.hidden = !file;
    // How many, said once: here and nowhere else in the window.
    $("projectTitle").textContent = files ? t("New project · {n} videos", { n: files.length }) : t("New project");
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
          // one would mean nothing to the others. The title says how many.
          clearLength();
        } else {
          paintLength(v.duration);
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
    if (source.probe) paintLength(source.probe.duration_sec); else clearLength();
    $("projectError").textContent = "";
    $("projectSaved").textContent = "";
    $("projectShowWrap").hidden = true;
    paintActions();
    // The dropdowns start on the saved defaults every time the dialog opens
    // (the Dub Agent may have changed them a moment ago), then the key-gated
    // options are greyed out. Not on a Settings save: that path must leave a
    // choice the user is in the middle of making alone.
    // Only for the dialog the erase screen puts back (`fromErase`). A link
    // opened later carries a held video too, and must start on the defaults.
    const kept = source.fromErase ? choicesBeforeErase : null;
    choicesBeforeErase = null;
    startOnDefaults(kept);
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
    btn.textContent = t("Saving…");
    btn.disabled = true;
    $("projectError").textContent = "";
    $("projectSaved").textContent = "";
    $("projectShowWrap").hidden = true;
    try {
      const saved = await saveDownloadClip(np.downloadId, np.trim);
      const folder = downloadsLabel(saved.path, await pickedFolder()) || t("Downloads");
      $("projectSaved").textContent = t("Saved to {folder}", { folder });
      // Where it went, for the Show beside that line. Only the desktop app can
      // open a folder; in a browser the line says where and stops there.
      savedClipPath = saved.path || "";
      $("projectShowWrap").hidden = !reveal || !savedClipPath;
    } catch (e) {
      $("projectError").textContent = errorText(e);
    } finally {
      btn.textContent = t("Save clip");
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
    choicesBeforeErase = takeChoices();
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
      persoModel,
      qualityMode: $("qualitySelect").value,
      numSpeakers: $("numSpeakers").value ? Number($("numSpeakers").value) : undefined,
      translateEngine: $("translateSelect").value,
      ttsEngine: $("voiceSelect").value,
      // A link's title is only known here -- the probe already fetched it, while
      // the server learns nothing from downloading the video. Names the job's
      // folder, so send it along with the job. A held video brings its own name
      // the same way (the erase screen's result).
      project: np.probe ? np.probe.title : (np.title || undefined),
      // Subtitles the user supplied for the source language: the dub translates
      // these instead of transcribing the audio.
      // The part of the video the trim bar has selected, or null for all of it.
      trim: np.trim || null,
    };
  }

  return { openNewProject, closeNewProject, readOptions, loadSavedDefaults,
           releaseProjectVideo,
           // Borrowed by a draft's Dubbing tab (ui/src/draftSetup.mjs): the
           // language list its own Start button must resolve targetLangSelect's
           // value against, and the block of controls itself.
           // ...and the Perso voice model its row has selected.
           currentLanguages, persoModel: () => persoModel, moveOptionsInto, startOnDefaults };
}
