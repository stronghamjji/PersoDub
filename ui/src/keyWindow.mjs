// The key window: the small dialog that asks for an API key (Perso or Gemini)
// the moment a choice needs one, and for a Perso workspace when the
// key has several and none is picked. Picking a keyed engine with no key saved
// opens it from the dropdown; a start the app refused for a missing key or
// workspace opens it too, and goes on (`then`) once it is saved. Lifted out of
// the page's script unchanged (2026-10-10).
//
// The elements this file touches: #keyOverlay and what is in it (#keyTitle,
// #keyLink, #keyField, #keyInput, #keySpaceRow, #keySpace, #keyError, #keySave,
// #keyCancel), and the dropdowns that need a key: #dubModeSelect, #sepSelect,
// #sttSelect and #translateSelect.
import { t } from "./i18n.mjs";
import { record as recordStep } from "./events.mjs";

/**
 * @param {object} deps
 * @param {(id: string) => any} deps.$   the page's getElementById helper
 * @param {{perso: boolean, gemini: boolean}} deps.keySaved
 *        which keyed engines have a key saved: the page keeps it current from
 *        GET /api/engines, and a key saved here is marked in it at once
 * @param {() => void} deps.onSaved  a key was saved: the page asks again which
 *        engines are usable
 * @returns {{ askKey: (kind: string, sel: any, back: string|null,
 *   opts?: {spaceOnly?: boolean, then?: (() => void)|null}) => void }}
 *   askKey opens the window for a kind of key ("perso", "gemini"), from
 *   dropdown `sel` (set back to `back` on Cancel), or for
 *   the workspace alone (`spaceOnly`); `then` runs once it is saved.
 */
// persoKeyLink: the tagged link to Perso's key page the app's settings carry
// (perso_signup_link), so the visit says it came from this app; the bare page without it.
export function initKeyWindow({ $, keySaved, onSaved, persoKeyLink = () => null, record = recordStep }) {
  // Picking a keyed engine with no key saved opens the key window. Save keeps
  // the choice; Cancel puts the dropdown back where it was.
  const KEY_KINDS = {
    // The title is read when the window is drawn, in the language of the moment.
    perso: { get title() { return t("Perso API key"); }, field: "perso_api_key", link: "https://developers.perso.ai/api-keys" },
    gemini: { get title() { return t("Google (Gemini) key"); }, field: "gemini_api_key", link: "https://aistudio.google.com/apikey" },
  };
  let keyAsk = null;   // {kind, sel, back, spaceOnly, then}
  // A Perso key's workspaces: fetched for the pasted key (or the saved one when
  // only the workspace is missing) and painted into the window's picker.
  let keySpacesRun = 0;
  async function loadKeySpaces(typedKey) {
    const run = ++keySpacesRun;
    const pick = $("keySpace");
    pick.replaceChildren();
    $("keySpaceRow").hidden = true;
    $("keyError").textContent = "";
    paintKeySave();
    try {
      const r = typedKey
        ? await fetch("/api/perso/spaces/preview", { method: "POST",
            headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_key: typedKey }) })
        : await fetch("/api/perso/spaces");
      if (run !== keySpacesRun) return;
      if (!r.ok) throw new Error();
      const { spaces } = await r.json();
      if (run !== keySpacesRun) return;
      if (!spaces.length) { $("keyError").textContent = t("This key has no workspace for dubbing."); return; }
      const add = (value, label, credits) => {
        const o = document.createElement("option");
        o.value = value; o.textContent = label;
        if (credits != null) o.dataset.credits = String(credits);
        pick.appendChild(o);
      };
      if (spaces.length > 1) add("", t("Choose a workspace…"));
      for (const s of spaces) {
        const extra = [s.tier, s.credits != null ? t("{n} credits left", { n: s.credits }) : null].filter(Boolean).join(", ");
        add(String(s.seq), extra ? `${s.name} (${extra})` : s.name, s.credits);
      }
      // One workspace needs no choosing: it is picked and the row stays out of sight.
      $("keySpaceRow").hidden = spaces.length === 1;
    } catch {
      if (run === keySpacesRun) $("keyError").textContent = t("Could not check this key. Check it and try again.");
    }
    paintKeySave();
  }
  function paintKeySave() {
    const pick = $("keySpace");
    const o = pick.selectedOptions[0];
    const zero = o && o.dataset.credits === "0";
    // Written and read back in the same language: the window is drawn anew
    // (askKey clears this line) and nothing can change the language under it.
    const ZERO = t("This workspace has 0 credits left.");
    const err = $("keyError").textContent;
    // The zero-credit line follows the pick; any other message stays put.
    if (zero) $("keyError").textContent = ZERO;
    else if (err === ZERO) $("keyError").textContent = "";
    const perso = keyAsk && keyAsk.kind === "perso";
    const keyOk = keyAsk && (keyAsk.spaceOnly || !!$("keyInput").value.trim());
    $("keySave").disabled = !keyOk || (perso && !pick.value);
  }
  function askKey(kind, sel, back, { spaceOnly = false, then = null } = {}) {
    keyAsk = { kind, sel, back, spaceOnly, then };
    keySpacesRun += 1;
    $("keyTitle").textContent = spaceOnly ? t("Perso workspace") : KEY_KINDS[kind].title;
    $("keyLink").href = (kind === "perso" && persoKeyLink()) || KEY_KINDS[kind].link;
    $("keyField").hidden = spaceOnly;
    $("keyInput").value = "";
    $("keySpace").replaceChildren();
    $("keySpaceRow").hidden = true;
    $("keyError").textContent = "";
    $("keySave").disabled = true;
    $("keyOverlay").classList.add("open");
    if (spaceOnly) loadKeySpaces(null);
    else $("keyInput").focus();
  }
  function closeKey(keep) {
    $("keyOverlay").classList.remove("open");
    const ask = keyAsk;
    keyAsk = null;
    if (ask && !keep && ask.sel) {
      ask.sel.value = ask.back;
      ask.sel.dispatchEvent(new Event("change"));   // the hint under it follows
    }
  }
  for (const [id, kind, value] of [["dubModeSelect", "perso", "perso"], ["sepSelect", "perso", "perso"],
                                   ["sttSelect", "perso", "perso"], ["translateSelect", "gemini", "gemini"]]) {
    const sel = $(id);
    let last = sel.value;
    sel.addEventListener("focus", () => { last = sel.value; });
    sel.addEventListener("change", () => {
      if (sel.value === value && !keySaved[kind] && !keyAsk) {
        const back = last !== value ? last : [...sel.options].find((o) => o.value !== value).value;
        askKey(kind, sel, back);
      } else if (!keyAsk) last = sel.value;
    });
  }
  let keyLookupTimer = null;
  $("keyInput").addEventListener("input", () => {
    paintKeySave();
    if (!keyAsk || keyAsk.kind !== "perso") return;
    clearTimeout(keyLookupTimer);
    const key = $("keyInput").value.trim();
    if (key.length < 20) { keySpacesRun += 1; $("keySpaceRow").hidden = true; $("keySpace").replaceChildren(); paintKeySave(); return; }
    keyLookupTimer = setTimeout(() => loadKeySpaces(key), 400);   // a paste settles at once
  });
  $("keySpace").addEventListener("change", paintKeySave);
  $("keyInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !$("keySave").disabled) $("keySave").click(); });
  $("keyCancel").addEventListener("click", () => closeKey(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("keyOverlay").classList.contains("open")) { e.stopPropagation(); closeKey(false); }
  }, true);
  $("keySave").addEventListener("click", async () => {
    if (!keyAsk) return;
    $("keySave").disabled = true;
    try {
      const body = keyAsk.spaceOnly ? {} : { [KEY_KINDS[keyAsk.kind].field]: $("keyInput").value.trim() };
      if (keyAsk.kind === "perso") body.perso_space_seq = $("keySpace").value;
      const r = await fetch("/api/settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error();
      record("key_saved", { ok: true, kind: keyAsk.kind });
      keySaved[keyAsk.kind] = true;
      const then = keyAsk.then;
      closeKey(true);
      onSaved();
      if (then) then();
    } catch {
      if (keyAsk) record("key_saved", { ok: false, kind: keyAsk.kind });
      $("keyError").textContent = t("Could not save the key. Is {app} running?");
      $("keySave").disabled = false;
    }
  });

  return { askKey };
}
