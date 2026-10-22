// The four stage dropdowns of Advanced options -- Audio separation,
// Speech-to-text, Translation, Text-to-speech -- drawn the way the Dubbing
// model is (ui/src/newProject.mjs paintPersoModel): a button naming the
// choice, with "Ready" at its right once all it needs is on this computer,
// and, pressed, a list of every choice the stage has, each with a line of
// what it is and, for a model, its size and whether it is here. The models
// not downloaded yet are in the list too: Mel-Band RoFormer was in none until
// it was downloaded, so nobody knew it was there (feedback 2, 2026-10-20).
// Downloading stays in the line under the field (owner, 2026-10-22, 1-1 가):
// picking a model that is not here brings that line up.
//
// The <select> stays the value. Hidden, it keeps every listener the page
// hangs on it -- the hints, the key window, the remembered choices, the
// download line -- and a pick sets it and fires its change, as the dropdown did.
import { t } from "./i18n.mjs";
import { gb, neededPackIds } from "./modelsUi.mjs";
import { placeList, listKeys } from "./pickList.mjs";

/** The catalog model each choice is: the one whose size and state its line shows. */
export const CHOICE_MODEL = {
  sep: { local: "demucs", roformer: "vocal-separator" },
  stt: { local: "whisper" },
  translate: { hunyuan: "hunyuan", gemma: "gemma" },
  voice: { qwen3: "qwen3-tts" },
};

// What each choice is, in a few words: the line under its name. Getters, so
// each is read in the language of the moment.
const CHARACTER = {
  sep: { get local() { return t("Default · Fast"); },
         get roformer() { return t("Cleaner background · Slower"); },
         get perso() { return t("Most accurate · Perso credits"); } },
  stt: { get local() { return t("Default · Free"); },
         get perso() { return t("Most accurate · Perso credits"); } },
  translate: { get chatgpt() { return t("ChatGPT sign-in · No download"); },
               get hunyuan() { return t("Small and fast"); },
               get gemma() { return t("Bigger and more careful"); },
               get gemini() { return t("Most accurate · Gemini key"); } },
  voice: { get qwen3() { return t("Follows the voice of each speaker"); } },
};

/** A model's state in a word or two, with its look: Ready, Downloading 43%
    (Getting ready… before its first byte), Paused or Not downloaded. */
export function stateWord(row) {
  if (row.state === "ready") return { text: t("Ready"), cls: "st-ok" };
  if (row.state === "downloading") {
    return { text: row.progress == null ? t("Getting ready…") : t("Downloading {pct}%", { pct: row.progress }),
             cls: "st-busy" };
  }
  if (row.state === "paused") return { text: t("Paused"), cls: "st-busy" };
  return { text: t("Not downloaded"), cls: "st-before" };
}

/** Whether the choice is a model and all it needs is here, the pack it runs
    in included: what puts "Ready" on its button. */
export function choiceReady(role, value, rowOf) {
  const id = (CHOICE_MODEL[role] || {})[value];
  return !!id && [id, ...neededPackIds(role, value)].every((x) => (rowOf(x) || {}).state === "ready");
}

/** What one stage's button and list show, from its <select> (`sel`: value,
    disabled and options) and the GET /api/models rows (`rowOf`): {name,
    ready, options: [{value, name, line, state, on}]}, where line is what the
    choice is and, for a model, its size, and state its stateWord or null.
    Greyed for a Perso dubbing (ui/src/app.mjs paintDubMode), the stage is
    Perso's, and its name says so over the choice kept for this computer. */
export function stageView(role, sel, rowOf) {
  const options = [...sel.options].map((o) => {
    const id = (CHOICE_MODEL[role] || {})[o.value];
    const row = id ? rowOf(id) : null;
    const what = (CHARACTER[role] || {})[o.value] || "";
    return { value: o.value, name: o.textContent, on: o.value === sel.value,
             line: [what, row ? `${gb(row.bytes)} GB` : ""].filter(Boolean).join(" · "),
             state: row ? stateWord(row) : null };
  });
  const chosen = options.find((o) => o.on);
  return { name: sel.disabled ? "Perso" : chosen ? chosen.name : "",
           ready: !sel.disabled && choiceReady(role, sel.value, rowOf), options };
}

const STAGES = [["sepSelect", "sep"], ["sttSelect", "stt"], ["translateSelect", "translate"], ["voiceSelect", "voice"]];

/**
 * Put a button in place of each stage's <select>.
 *
 * @param {object} deps
 * @param {(id: string) => any} deps.$
 * @param {(id: string) => object|null} deps.rowOf  a GET /api/models row by its id
 * @returns {{ paint: () => void }}  paint: the buttons again, after the
 *          model rows or a value set without a change event (putChoices)
 */
export function initStagePickers({ $, rowOf }) {
  const pickers = STAGES.map(([id, role]) => {
    const sel = $(id);
    const box = document.createElement("div");
    box.className = "model-pick";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = `${id}Btn`;
    btn.className = "model-pick-btn";
    btn.setAttribute("aria-haspopup", "listbox");
    // The field's own label names the button, as it named the dropdown.
    const label = document.querySelector(`label[for="${id}"]`);
    if (label) {
      label.id ||= `${id}Label`;
      btn.setAttribute("aria-labelledby", `${label.id} ${btn.id}`);
    }
    box.appendChild(btn);
    sel.hidden = true;
    sel.after(box);
    const p = { sel, role, box, btn, list: null };
    btn.addEventListener("click", () => (p.list ? close() : open(p)));
    sel.addEventListener("change", paint);
    // New option names (the voice model's size, GET /api/engines) and the
    // greying a Perso dubbing puts on the stages reach the button by themselves.
    if (globalThis.MutationObserver) {
      new MutationObserver(paint).observe(sel, { attributes: true, attributeFilter: ["disabled"],
                                                 childList: true, subtree: true, characterData: true });
    }
    return p;
  });

  // The button is changed in place, never drawn anew: the 2 s download poll
  // paints it, and a new button would take the focus and a press with it.
  function paint() {
    for (const p of pickers) {
      const view = stageView(p.role, p.sel, rowOf);
      const name = document.createElement("span");
      name.className = "model-name";
      name.textContent = view.name;
      const parts = [name];
      if (view.ready) {
        const state = document.createElement("span");
        state.className = "model-state st-ok";
        state.textContent = t("Ready");
        parts.push(state);
      }
      p.btn.replaceChildren(...parts);
      p.btn.disabled = p.sel.disabled;
      p.btn.setAttribute("aria-expanded", String(!!p.list));
    }
  }

  function open(p) {
    close();
    const view = stageView(p.role, p.sel, rowOf);
    const list = document.createElement("div");
    list.className = "model-pick-list";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-labelledby", p.btn.getAttribute("aria-labelledby") || "");
    for (const o of view.options) {
      const opt = document.createElement("button");
      opt.type = "button";
      opt.className = o.on ? "model-opt on" : "model-opt";
      opt.setAttribute("role", "option");
      opt.setAttribute("aria-selected", String(o.on));
      opt.dataset.value = o.value;
      const text = document.createElement("span");
      text.className = "model-text";
      const name = document.createElement("span");
      name.className = "model-name";
      name.textContent = o.name;
      const caption = document.createElement("span");
      caption.className = "model-caption";
      caption.textContent = o.state ? `${o.line} · ` : o.line;
      if (o.state) {
        const state = document.createElement("b");
        state.className = o.state.cls;
        state.textContent = o.state.text;
        caption.appendChild(state);
      }
      text.append(name, caption);
      opt.appendChild(text);
      opt.addEventListener("click", () => pick(p, o.value));
      list.appendChild(opt);
    }
    p.list = list;
    p.box.appendChild(list);
    placeList(list, p.btn);
    listKeys(list, () => { close(); p.btn.focus?.(); });
    paint();
  }

  function close() {
    for (const p of pickers) {
      if (!p.list) continue;
      p.list.remove();
      p.list = null;
    }
    paint();
  }

  function pick(p, value) {
    close();
    p.btn.focus?.();
    if (p.sel.value === value) return;
    // As the dropdown went: focus first (the key window keeps the value to put
    // back from it), then the new value and its change.
    p.sel.dispatchEvent(new Event("focus"));
    p.sel.value = value;
    p.sel.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // A press anywhere else, scrolling (the list would stay where the button
  // was) or a new window size closes the list.
  const openPicker = () => pickers.find((p) => p.list);
  document.addEventListener("pointerdown", (e) => {
    const p = openPicker();
    if (p && !p.box.contains(e.target)) close();
  });
  document.addEventListener("scroll", (e) => {
    const p = openPicker();
    if (p && !p.list.contains(e.target)) close();
  }, true);
  globalThis.addEventListener?.("resize", () => { if (openPicker()) close(); });

  paint();
  return { paint };
}
