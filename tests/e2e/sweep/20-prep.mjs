// The Before dubbing screen of a new project: the video card and Replace,
// the model choice (Perso API stops at its key window), the stage lists, a
// model that needs downloading, the two languages, the speaker count, a cut
// on the timeline, and a dub started and stopped. Every pick is put back, and
// persodub.lastChoices is left as it was found. Nothing here spends credits:
// the one dub it starts runs on this computer and is stopped at once.
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { shown, isOpen, isClosed, onHome, textOf, sleep } from "../lib/cdp.mjs";

export const area = "prep";

const CHOICES_KEY = "persodub.lastChoices";

// The draft's screen is up: the Before dubbing card, no job.
const onPrep = () => !document.querySelector("#draftSetup").hidden && !document.body.dataset.jobId
  && document.body.dataset.screen === "done";

async function needPrep(app) {
  if (!(await app.inPage(onPrep))) throw new Error("the Before dubbing screen is not up (the first step did not open it)");
}

// A key the page reads by its code too: Backspace deletes only with one.
async function rawKey(app, key, code, vk, commands) {
  for (const type of ["keyDown", "keyUp"]) {
    await app.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: vk, ...(type === "keyDown" && commands ? { commands } : {}) });
  }
}

// A press and a release at (x, y) on the element `sel` is to be hit there.
async function pressAt(app, sel, x, y) {
  const over = await app.inPage((s, px, py) => {
    const hit = document.elementFromPoint(px, py);
    return hit && hit.closest(s) ? "" : hit ? hit.tagName.toLowerCase() + (hit.id ? `#${hit.id}` : "") + [...hit.classList].map((c) => `.${c}`).join("") : "nothing";
  }, sel, x, y);
  if (over) throw new Error(`${sel} at ${Math.round(x)},${Math.round(y)} is covered by ${over}`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await app.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
  }
}

// The options panel scrolled to a button first, and given a moment: the
// scroll's event lands a frame later, and one landing after the press closes
// the list the press opened (the lists close on scrolling).
async function intoView(app, sel) {
  // Inside the window is not enough: the options panel clips what is below its fold.
  const moved = await app.inPage((s) => {
    const el = document.querySelector(s), boxes = [];
    for (let p = el.parentElement; p; p = p.parentElement) boxes.push([p, p.scrollTop]);
    el.scrollIntoView({ block: "center" });
    return boxes.some(([p, top]) => p.scrollTop !== top);
  }, sel);
  if (moved) await sleep(400);
}

// A stage's pick list: opened by its button, its options, closed by Escape.
async function openList(app, id) {
  await intoView(app, `#${id}Btn`);
  await app.click(`#${id}Btn`);
  return app.waitFor(`the ${id} list`, 5000, (i) => {
    const list = document.querySelector(`#${i}Btn`).parentElement.querySelector(".model-pick-list");
    return list && list.contains(document.activeElement) ? [...list.querySelectorAll(".model-opt")].map((o) => o.dataset.value) : null;
  }, id);
}
const listClosed = (id) => !document.querySelector(`#${id}Btn`).parentElement.querySelector(".model-pick-list");
async function pickStage(app, id, value) {
  await openList(app, id);
  await app.click(`#${id}Btn ~ .model-pick-list .model-opt[data-value="${value}"]`);
  await app.waitFor(`${id} on ${value}`, 5000, (i, v) => document.querySelector(`#${i}`).value === v && !document.querySelector(`#${i}Btn`).parentElement.querySelector(".model-pick-list"), id, value);
}

// The Target language: its list, a search, a press on the language.
async function pickTarget(app, words, code) {
  await intoView(app, "#targetLangBtn");
  await app.click("#targetLangBtn");
  await app.waitFor("the language list", 5000, () => document.activeElement === document.querySelector("#targetLangList input"));
  await app.type("#targetLangList input", words);
  const left = await app.waitFor(`${code} among the rows`, 5000, (c) => {
    const rows = [...document.querySelectorAll("#targetLangList .model-opt")];
    return rows.some((r) => r.dataset.lang === c) ? { rows: rows.length, count: document.querySelector("#targetLangList .lang-count").textContent.trim() } : null;
  }, code);
  await app.click(`#targetLangList .model-opt[data-lang="${code}"]`);
  await app.waitFor(`the language on ${code}`, 5000, (c) => document.querySelector("#targetLangSelect").value === c && !document.querySelector("#targetLangList"), code);
  return { ...left, said: await app.inPage(textOf, "#targetLangBtn") };
}

// What a dub started from here would run on: never Perso.
const choices = () => ({ mode: document.querySelector("#dubModeSelect").value, sep: document.querySelector("#sepSelect").value,
                         stt: document.querySelector("#sttSelect").value, translator: document.querySelector("#translateSelect").value });
function assertNoCredits(c) {
  if (c.mode !== "local" || c.sep === "perso" || c.stt === "perso") throw new Error(`the choices would spend Perso credits: ${JSON.stringify(c)}`);
}

const card = () => ({ name: (document.querySelector("#draftPartCard .vc-name")?.textContent || "").trim(),
                      len: (document.querySelector("#draftPartCard .vc-len")?.textContent || "").trim(),
                      foot: document.querySelector("#draftFootLabel").textContent.trim(),
                      src: document.querySelector("#doneVideo").getAttribute("src") || "" });

export const steps = [
  { name: "new project", looks: ["#draftSetup", "#dubbingImport"], stopsArea: true,
    async run(app, ctx) {
      const dialog = await app.js(`document.querySelector(".modal-overlay.open")?.id || ""`);
      if (dialog) throw new Error(`#${dialog} is open; the area starts with no dialog in the way`);
      ctx.state.prepChoices = await app.js(`localStorage.getItem(${JSON.stringify(CHOICES_KEY)})`);
      ctx.state.prepFile = `e2e-dub-sweep-${ctx.stamp}.mp4`;
      ctx.state.prepVideo = join(ctx.out, ctx.state.prepFile);
      copyFileSync(ctx.video, ctx.state.prepVideo);
      if (!(await app.inPage(onHome))) await app.click("#homeBtn");
      await app.waitFor("the Home screen", 10000, onHome);
      await app.click("#homeDubCard");
      await app.waitFor("the Dubbing tab's Import block", 10000, shown, "#dubbingZone .import-head");
      await app.feed("#dubbingZone .import-head", ctx.state.prepVideo);
      const ready = await app.waitFor("the Before dubbing card with Start lit", 120000, () => {
        const s = document.querySelector("#dubbingImportStatus");
        if (s.classList.contains("error") && s.textContent.trim()) return `refused: ${s.textContent.trim()}`;
        return !document.querySelector("#draftSetup").hidden && !document.querySelector("#draftStartBtn").disabled ? "ready" : "";
      });
      if (ready !== "ready") throw new Error(`the import was ${ready}`);
      const c = await app.inPage(card);
      const label = await app.inPage(textOf, "#draftSetup .draft-label > span");
      if (label !== app.tr("Before dubbing")) throw new Error(`the card is headed "${label}", not "${app.tr("Before dubbing")}"`);
      if (c.name !== ctx.state.prepFile || c.len !== "00:10") throw new Error(`the video card reads "${c.name}" "${c.len}"`);
      return `"${label}": ${c.name}, ${c.len}; foot "${c.foot}"`;
    } },

  { name: "replace with the same file", looks: ["#draftSetup"],
    async run(app, ctx) {
      await needPrep(app);
      const was = await app.inPage(card);
      await app.feed("#draftReplaceBtn", ctx.state.prepVideo);
      const now = await app.waitFor("the new copy on the card", 60000, (src) => {
        const s = document.querySelector("#draftImportStatus");
        if (s.classList.contains("error") && s.textContent.trim()) return { refused: s.textContent.trim() };
        const v = document.querySelector("#doneVideo").getAttribute("src") || "";
        return v && v !== src && !s.textContent.trim() && !document.querySelector("#draftStartBtn").disabled
          ? { name: document.querySelector("#draftPartCard .vc-name").textContent.trim(),
              len: document.querySelector("#draftPartCard .vc-len").textContent.trim(), screen: document.body.dataset.screen } : null;
      }, was.src);
      if (now.refused) throw new Error(`Replace was refused: ${now.refused}`);
      await needPrep(app);
      if (now.name !== was.name || now.len !== was.len) throw new Error(`the card went from "${was.name}" ${was.len} to "${now.name}" ${now.len}`);
      return `${app.tr("Replace")}: a new copy (video src changed), screen ${now.screen}, still "${now.name}" ${now.len}`;
    } },

  { name: "Perso API stops at the key window", looks: ["#keyOverlay", "#langGrid"],
    async run(app) {
      await needPrep(app);
      const engines = await app.api("/api/engines");
      if (engines.perso_available) throw new Error("this kit has a Perso key saved; the step needs none");
      await intoView(app, "#dubModePerso");
      await app.click("#dubModePerso");
      await app.waitFor("the key window", 5000, isOpen, "#keyOverlay");
      const title = await app.inPage(textOf, "#keyTitle");
      await app.shot("prep-key-window");
      if (title !== app.tr("Perso API key")) throw new Error(`the key window is titled "${title}"`);
      await app.key("Escape");
      await app.waitFor("the key window to close and Local model back", 5000, () => !document.querySelector("#keyOverlay").classList.contains("open")
        && document.querySelector("#dubModeSelect").value === "local" && document.querySelector("#dubModeLocal").getAttribute("aria-checked") === "true");
      return `Perso API → "${title}" window, no key typed; Escape → ${app.tr("Local model")} selected again`;
    } },

  { name: "stage lists", looks: ["#advancedBody"],
    async run(app) {
      await needPrep(app);
      const head = await app.inPage(textOf, "#stageHead");
      if (head !== app.tr("Dubbing step settings")) throw new Error(`the stage heading reads "${head}"`);
      const said = [];
      for (const [id, key] of [["sepSelect", "Voice separation"], ["sttSelect", "Speech-to-text"], ["translateSelect", "Translation"], ["voiceSelect", "Text-to-speech"]]) {
        const opts = await openList(app, id);
        await app.key("Escape");
        await app.waitFor(`the ${id} list to close`, 5000, listClosed, id);
        said.push(`${app.tr(key)} ${opts.length} (${opts.join("/")})`);
      }
      // The last two rows are not lists: a dropdown, whose menu is the
      // computer's own and cannot be pressed from here, and a number field.
      const q = await app.inPage(() => [...document.querySelector("#qualitySelect").options].map((o) => o.value));
      const sp = await app.inPage(() => ({ type: document.querySelector("#numSpeakers").type, on: document.querySelector("#numSpeakers").getClientRects().length > 0 }));
      if (!sp.on) throw new Error("the Number of speakers field is not on show");
      said.push(`${app.tr("Voice quality")} dropdown ${q.length} (${q.join("/")})`, `${app.tr("Number of speakers")} a ${sp.type} field`);
      return `4 lists opened and closed by Escape: ${said.join("; ")}`;
    } },

  { name: "a model to download", looks: ["#modelsNeededOverlay", "#advancedBody"],
    async run(app) {
      await needPrep(app);
      const rows = await app.api("/api/models");
      const sep = (rows.models || rows).find((m) => m.id === "vocal-separator");
      if (!sep || sep.state === "ready") throw new Error(`Mel-Band RoFormer is ${sep ? sep.state : "not listed"}: Start would dub, not ask`);
      const was = await app.inPage(() => document.querySelector("#sepSelect").value);
      await pickStage(app, "sepSelect", "roformer");
      try {
        assertNoCredits(await app.inPage(choices));
        await app.click("#draftStartBtn");
        const d = await app.waitFor("the download dialog", 30000, () => {
          if (document.body.dataset.jobId) return { started: document.body.dataset.jobId };
          const open = document.querySelector(".modal-overlay.open");
          if (!open) return null;
          return { id: open.id, title: document.querySelector("#mnTitle").textContent.trim(), line: document.querySelector("#mnLine").textContent };
        });
        if (d.started) throw new Error(`Start began job ${d.started} instead of asking for the download`);
        if (d.id !== "modelsNeededOverlay") throw new Error(`#${d.id} opened instead of the download dialog`);
        await app.shot("prep-download-dialog");
        const lines = d.line.split("\n").filter((s) => s.trim());
        await app.click("#mnCancel");
        await app.waitFor("the download dialog to close", 5000, isClosed, "#modelsNeededOverlay");
        await needPrep(app);
        if (lines.length !== 2) throw new Error(`the dialog's second line has ${lines.length} line(s): "${d.line}"`);
        return `${app.tr("Start dubbing")} with Mel-Band RoFormer → "${d.title}" / "${lines[0]}" + "${lines[1]}" → ${app.tr("Cancel")}; no job`;
      } finally {
        // Put back, past the dialog should a failure have left it open.
        if (await app.inPage(isOpen, "#modelsNeededOverlay")) await app.click("#mnCancel");
        await pickStage(app, "sepSelect", was === "roformer" ? "local" : was);
      }
    } },

  { name: "languages", looks: ["#langGrid"],
    async run(app) {
      await needPrep(app);
      const was = await app.inPage(() => ({ src: document.querySelector("#sourceLangSelect").value, target: document.querySelector("#targetLangSelect").value }));
      // The Original language is a plain dropdown (no search list): its menu
      // is the computer's own, so the value is chosen the way that menu leaves it.
      await app.choose("#sourceLangSelect", "en");
      const src = await app.inPage(() => { const s = document.querySelector("#sourceLangSelect"); return s.selectedOptions[0].textContent.trim(); });
      if (src !== "영어") throw new Error(`the Original language reads "${src}", not 영어`);
      const ja = await pickTarget(app, "일본어", "ja");
      if (!ja.said.includes("일본어")) throw new Error(`the Target language reads "${ja.said}", not 일본어`);
      const ko = await pickTarget(app, "한국어", "ko");
      if (!ko.said.includes("한국어")) throw new Error(`the Target language reads "${ko.said}", not 한국어`);
      await app.choose("#sourceLangSelect", was.src);
      return `원본 언어 dropdown → "${src}" (put back to "${was.src || "auto"}"); 더빙 언어 "일본어" → ${ja.rows} row(s) "${ja.count}" → "${ja.said}"; "한국어" → "${ko.said}"`;
    } },

  { name: "speakers", looks: ["#advancedBody"],
    async run(app) {
      await needPrep(app);
      const empty = async () => {
        await app.click("#numSpeakers");
        await rawKey(app, "a", "KeyA", 65, ["selectAll"]);
        await rawKey(app, "Backspace", "Backspace", 8);
      };
      const was = await app.inPage(() => document.querySelector("#numSpeakers").value);
      await empty();
      await app.type("#numSpeakers", "1");
      await app.click("#draftSetup .draft-label > span");   // the field let go, so its change is said
      const one = await app.inPage(() => document.querySelector("#numSpeakers").value);
      if (one !== "1") throw new Error(`the field holds "${one}", not 1`);
      await empty();
      await app.click("#draftSetup .draft-label > span");
      const back = await app.inPage(() => ({ v: document.querySelector("#numSpeakers").value, ph: document.querySelector("#numSpeakers").placeholder }));
      if (back.v !== "" || back.ph !== app.tr("Auto-detect")) throw new Error(`the field holds "${back.v}" under "${back.ph}"`);
      return `${app.tr("Number of speakers")} "${was}" → 1 → emptied: "${back.ph}" again`;
    } },

  { name: "cut to 6 seconds", looks: ["#timeline", "#draftSetup"],
    async run(app) {
      await needPrep(app);
      // The ruler and the one clip: seconds per pixel off the clip's width.
      const strip = () => {
        const inner = document.querySelector("#timeline .tl-inner"), ruler = document.querySelector("#timeline .tl-ruler");
        const cut = document.querySelector("#timeline .tl-cut[data-i='0']");
        if (!inner || !ruler || !cut || document.querySelectorAll("#timeline .tl-cut").length !== 1) return null;
        const r = ruler.getBoundingClientRect();
        return { left: inner.getBoundingClientRect().left, width: cut.getBoundingClientRect().width + 2, y: r.top + r.height / 2 };
      };
      const at = () => document.querySelector("#doneVideo").currentTime;
      // Where the playhead goes: the strip is the kept seconds laid end to end.
      async function playheadTo(sourceSec, keptFrom, keptLen) {
        const s = await app.waitFor("the timeline's ruler and one clip", 5000, strip);
        const pps = s.width / keptLen;
        await pressAt(app, ".tl-ruler", s.left + (sourceSec - keptFrom) * pps, s.y);
        const t = await app.waitFor("the playhead to move", 3000, (want) => {
          const v = document.querySelector("#doneVideo").currentTime;
          return Math.abs(v - want) < 0.05 ? v : null;
        }, sourceSec).catch(async () => { throw new Error(`the playhead is at ${(await app.inPage(at)).toFixed(2)} s, not ${sourceSec}`); });
        return t;
      }
      const a = await playheadTo(1.95, 0, 10);
      await app.click("#tlDelLeft");
      await app.waitFor("8 s kept", 5000, () => document.querySelector("#draftPartCard .vc-len").textContent.startsWith("00:08"));
      const b = await playheadTo(8.05, a, 10 - a);
      await app.click("#tlDelRight");
      const c = await app.waitFor("6 s kept", 5000, (want) => {
        const el = document.querySelector("#draftPartCard .vc-len"), foot = document.querySelector("#draftFootLabel").textContent.trim();
        const len = `${el.firstChild?.textContent || ""} (${el.querySelector(".vc-cut")?.textContent || "nothing cut"})`;
        return len.startsWith("00:06 ") && foot.startsWith(want) ? { len, foot } : null;
      }, app.tr("Dubbing {length} · {mode}", { length: "00:06", mode: "" }).split(" · ")[0]);
      await app.shot("prep-cut-6s");
      await app.click("#tlUndo");
      await app.click("#tlUndo");
      const back = await app.waitFor("the whole video again", 5000, () => {
        const len = document.querySelector("#draftPartCard .vc-len").textContent.trim();
        return len === "00:10" && document.querySelectorAll("#timeline .tl-cut").length === 1 ? { len, foot: document.querySelector("#draftFootLabel").textContent.trim() } : null;
      });
      return `playhead ${a.toFixed(2)} s → ${app.tr("Delete left of playhead")}, ${b.toFixed(2)} s → ${app.tr("Delete right of playhead")}: card "${c.len}", foot "${c.foot}"; ${app.tr("Undo")} ×2 → "${back.len}"`;
    } },

  { name: "start and stop a dub", looks: ["#progressCard", "#doneFail", "#draftSetup"],
    async run(app, ctx) {
      try {
        await needPrep(app);
        const c = await app.inPage(choices);
        assertNoCredits(c);
        const before = await app.js(`document.body.dataset.jobId || ""`);
        await app.click("#draftStartBtn");
        const started = await app.waitFor("the dub to start", 60000, (was) => {
          const b = document.body;
          if (b.dataset.screen === "running" && b.dataset.jobId && b.dataset.jobId !== was) return `job:${b.dataset.jobId}`;
          const error = document.querySelector("#draftError").textContent.trim();
          if (error) return `refused: ${error}`;
          const d = document.querySelector(".modal-overlay.open");
          return d ? `#${d.id} opened` : "";
        }, before);
        if (!started.startsWith("job:")) {
          await app.key("Escape");
          throw new Error(`Start was ${started}`);
        }
        const id = started.slice(4);
        const t0 = Date.now();
        await app.waitFor("the running card", 10000, shown, "#progressCard");
        const line = await app.inPage(textOf, "#progressTitle");
        await app.click("#cancelBtn", 10000);
        const pressedIn = (Date.now() - t0) / 1000;
        // A running dub asks first; a queued one goes at once.
        const asked = await app.waitFor("the stop question", 3000, isOpen, "#cancelDubOverlay").catch(() => false);
        if (asked) await app.click("#cancelDubConfirmBtn");
        const job = await app.api(`/api/dub/jobs/${id}`);
        if (job.dub_mode === "perso" || job.separation === "perso" || job.stt_engine === "perso") {
          throw new Error(`PERSO CREDITS: job ${id} runs ${job.dub_mode}/${job.separation}/${job.stt_engine}`);
        }
        let status = job.status;
        const end = Date.now() + 60000;
        while (status !== "cancelled" && Date.now() < end) {
          await new Promise((r) => setTimeout(r, 1000));
          status = (await app.api(`/api/dub/jobs/${id}`)).status;
        }
        if (status !== "cancelled") throw new Error(`job ${id} is ${status} 60 s after ${app.tr("Stop")}`);
        const took = Math.round((Date.now() - t0) / 1000);
        const why = await app.waitFor("the card to say it stopped", 15000, (jid) => document.body.dataset.jobId === jid
          && document.body.dataset.screen === "failed" && document.querySelector("#doneFailWhy").textContent.trim(), id);
        await app.shot("prep-stopped-card");
        if (why !== app.tr("This dubbing was stopped.")) throw new Error(`the card says "${why}"`);
        await app.click("#homeBtn");
        await app.waitFor("the Home screen", 10000, onHome);
        return `job ${id} (${c.mode}, ${c.translator}, sep ${job.separation}, stt ${job.stt_engine}) at "${line}"; ${app.tr("Stop")} pressed ${pressedIn.toFixed(1)} s in${asked ? ", confirmed" : ""}; cancelled ${took} s after; card "${why}"; Home`;
      } finally {
        if ("prepChoices" in ctx.state) {
          await app.inPage((k, v) => { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); return true; },
                           CHOICES_KEY, ctx.state.prepChoices);
        }
      }
    } },
];
