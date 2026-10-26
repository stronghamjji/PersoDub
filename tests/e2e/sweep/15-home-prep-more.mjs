// More of Home and the Before dubbing screen, the rows of the coverage list
// the home and prep areas leave open: the two GitHub buttons and Send
// feedback (window.open stood in for, so no browser opens), the sidebar's
// tools, the Erase card, a card renamed and named back, the Dub Agent card's
// chips, the way back to the last project, a video dropped on the timeline,
// High quality, the download lines under the stage fields, the download
// dialog's buttons, split / delete / redo, the raw log and the original video
// while a dub runs, the result card, Settings' Discard question and the Dub
// Agent's model picker. Every dub started here runs on this computer and is
// stopped at once; every pick is put back; only what this run made, named
// e2e-dub-home2-*, is deleted at the end.
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { shown, pressable, isOpen, isClosed, onHome, textOf, sleep, Skip } from "../lib/cdp.mjs";

export const area = "home2";

const CHOICES_KEY = "persodub.lastChoices";
const AGENT_KEY = "persodub.assistantChoice";

async function toHome(app) {
  const dialog = await app.js(`document.querySelector(".modal-overlay.open")?.id || ""`);
  if (dialog) throw new Error(`#${dialog} is open; the step starts with no dialog in the way`);
  if (!(await app.inPage(onHome))) await app.click("#homeBtn");
  await app.waitFor("the Home screen", 10000, onHome);
}

// A key the page reads by its code too: Backspace deletes only with one.
async function rawKey(app, key, code, vk, commands) {
  for (const type of ["keyDown", "keyUp"]) {
    await app.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: vk, ...(type === "keyDown" && commands ? { commands } : {}) });
  }
}
async function emptyField(app, sel) {
  await app.click(sel);
  await rawKey(app, "a", "KeyA", 65, ["selectAll"]);
  await rawKey(app, "Backspace", "Backspace", 8);
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

// A file dragged from the computer and let go over the middle of `sel`.
async function dropFile(app, sel, file) {
  const r = await app.inPage((s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, sel);
  const data = { items: [], files: [file], dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"]) await app.send("Input.dispatchDragEvent", { type, x: r.x, y: r.y, data });
}

// A card's "..." shows only under the pointer or while the card has the
// focus (app.css .proj-card:hover .proj-more). The pointer goes over it; a
// move may wait for the window's next frame, so the card is also given the
// focus, the way Tab gives it, if the button has not shown in 3 s.
async function pressMore(app, cardSel) {
  const r = await app.inPage((s) => { const el = document.querySelector(s); el.scrollIntoView({ block: "center" });
    const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, cardSel);
  await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x, y: r.y }, 10000).catch(() => {});
  const more = `${cardSel} .proj-more`;
  const on = await app.waitFor("the card's ... button", 3000, pressable, more).catch(() => false);
  if (!on) await app.inPage((s) => { document.querySelector(s).focus(); return true; }, cardSel);
  await app.click(more);
}

// ---- the Before dubbing screen -------------------------------------------
const onPrep = () => !document.querySelector("#draftSetup").hidden && !document.body.dataset.jobId
  && document.body.dataset.screen === "done";
const card = () => ({ name: (document.querySelector("#draftPartCard .vc-name")?.textContent || "").trim(),
                      len: (document.querySelector("#draftPartCard .vc-len")?.textContent || "").trim(),
                      src: document.querySelector("#doneVideo").getAttribute("src") || "" });

// The prep screen with this run's copy of the video on it: the one already
// up, or a new project from Home's Dubbing card.
async function ensurePrep(app, ctx) {
  if (await app.inPage(onPrep)) return "kept";
  if (!("h2Choices" in ctx.state)) ctx.state.h2Choices = await app.js(`localStorage.getItem(${JSON.stringify(CHOICES_KEY)})`);
  if (!ctx.state.h2Video) {
    ctx.state.h2File = `e2e-dub-home2-${ctx.stamp}.mp4`;
    ctx.state.h2Video = join(ctx.out, ctx.state.h2File);
    copyFileSync(ctx.video, ctx.state.h2Video);
  }
  await toHome(app);
  await app.click("#homeDubCard");
  await app.waitFor("the Dubbing tab's Import block", 10000, shown, "#dubbingZone .import-head");
  await app.feed("#dubbingZone .import-head", ctx.state.h2Video);
  const ready = await app.waitFor("the Before dubbing card with Start lit", 120000, () => {
    const s = document.querySelector("#dubbingImportStatus");
    if (s.classList.contains("error") && s.textContent.trim()) return `refused: ${s.textContent.trim()}`;
    return !document.querySelector("#draftSetup").hidden && !document.querySelector("#draftStartBtn").disabled ? "ready" : "";
  });
  if (ready !== "ready") throw new Error(`the import was ${ready}`);
  const c = await app.inPage(card);
  if (c.name !== ctx.state.h2File || c.len !== "00:10") throw new Error(`the video card reads "${c.name}" "${c.len}"`);
  return "new";
}

async function restoreChoices(app, ctx) {
  if (!("h2Choices" in ctx.state)) return;
  await app.inPage((k, v) => { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); return true; },
                   CHOICES_KEY, ctx.state.h2Choices);
}

// A stage's pick list: opened by its button, a press on the option.
// The button is brought into view first and the scroll let settle: a scroll
// closes an open list (stagePicker.mjs), and the one a press brings with it
// landed just after the list opened.
async function pickStage(app, id, value) {
  await app.inPage((s) => { document.querySelector(s).scrollIntoView({ block: "center" }); return true; }, `#${id}Btn`);
  await sleep(400);
  await app.click(`#${id}Btn`);
  await app.waitFor(`the ${id} list`, 5000, (i) => {
    return !!document.querySelector(`#${i}Btn`).parentElement.querySelector(".model-pick-list .model-opt");
  }, id);
  await app.click(`#${id}Btn ~ .model-pick-list .model-opt[data-value="${value}"]`);
  await app.waitFor(`${id} on ${value}`, 5000, (i, v) => document.querySelector(`#${i}`).value === v
    && !document.querySelector(`#${i}Btn`).parentElement.querySelector(".model-pick-list"), id, value);
}

const choices = () => ({ mode: document.querySelector("#dubModeSelect").value, sep: document.querySelector("#sepSelect").value,
                         stt: document.querySelector("#sttSelect").value, translator: document.querySelector("#translateSelect").value,
                         quality: document.querySelector("#qualitySelect").value });
function assertNoCredits(c) {
  if (c.mode !== "local" || c.sep === "perso" || c.stt === "perso") throw new Error(`the choices would spend Perso credits: ${JSON.stringify(c)}`);
}

// A separation or translation found on a model this kit has not downloaded
// (a run before this one left it there) would make Start ask for the
// download: for the dub, the stage goes to one that is here, and back after.
async function readyStages(app) {
  const rows = (await app.api("/api/models")).models;
  const ready = (id) => (rows.find((m) => m.id === id) || {}).state === "ready";
  const c = await app.inPage(choices);
  const moved = [];
  if (c.sep === "roformer" && !ready("vocal-separator")) { await pickStage(app, "sepSelect", "local"); moved.push(["#sepSelect", c.sep]); }
  if (["gemma", "hunyuan"].includes(c.translator) && !ready(c.translator)) { await pickStage(app, "translateSelect", "chatgpt"); moved.push(["#translateSelect", c.translator]); }
  return moved;
}

// Start dubbing from the prep screen: the job's id once the running screen has it.
async function startDub(app) {
  const moved = await readyStages(app);
  try {
    return await startOnly(app);
  } finally {
    for (const [sel, v] of moved) await app.choose(sel, v);
  }
}
async function startOnly(app) {
  assertNoCredits(await app.inPage(choices));
  await app.click("#draftStartBtn");
  const started = await app.waitFor("the dub to start", 60000, () => {
    const b = document.body;
    if (b.dataset.screen === "running" && b.dataset.jobId) return `job:${b.dataset.jobId}`;
    const error = document.querySelector("#draftError").textContent.trim();
    if (error) return `refused: ${error}`;
    const d = document.querySelector(".modal-overlay.open");
    return d ? `#${d.id} opened` : "";
  });
  if (!started.startsWith("job:")) {
    await app.key("Escape");
    throw new Error(`Start was ${started}`);
  }
  const id = started.slice(4);
  const job = await app.api(`/api/dub/jobs/${id}`);
  if (job.dub_mode === "perso" || job.separation === "perso" || job.stt_engine === "perso") {
    await stopDub(app, id);
    throw new Error(`PERSO CREDITS: job ${id} runs ${job.dub_mode}/${job.separation}/${job.stt_engine}; stopped`);
  }
  return { id, job };
}

// A dub queued behind someone else's is let in line: what is measured here
// needs it running. Up to three minutes.
async function waitRunning(app, id) {
  const end = Date.now() + 180000;
  for (;;) {
    const s = (await app.api(`/api/dub/jobs/${id}`)).status;
    if (s === "running") return;
    if (s !== "queued") throw new Error(`job ${id} is ${s}, not running`);
    if (Date.now() > end) throw new Error(`job ${id} still queued after 3 minutes (another dub is running)`);
    await sleep(2000);
  }
}

// Stop, confirm when asked, and wait for the job to say cancelled and the card to say it stopped.
async function stopDub(app, id) {
  if (await app.inPage((jid) => document.body.dataset.jobId === jid && document.body.dataset.screen === "running", id)) {
    await app.click("#cancelBtn", 10000);
    const asked = await app.waitFor("the stop question", 3000, isOpen, "#cancelDubOverlay").catch(() => false);
    if (asked) await app.click("#cancelDubConfirmBtn");
  } else {
    await app.api(`/api/dub/jobs/${id}/cancel`, { method: "POST" }).catch(() => {});
  }
  const end = Date.now() + 60000;
  let status = "";
  while (Date.now() < end) {
    status = (await app.api(`/api/dub/jobs/${id}`)).status;
    if (status === "cancelled") break;
    await sleep(1000);
  }
  if (status !== "cancelled") throw new Error(`job ${id} is ${status} 60 s after Stop`);
  await app.waitFor("the card to say it stopped", 15000, (jid) => document.body.dataset.jobId !== jid
    || (document.body.dataset.screen === "failed" && document.querySelector("#doneFailWhy").textContent.trim()), id);
}

// ---- the Dub Agent column on Home ------------------------------------------
// Home has no close for it: the Dubbing tab's pane button folds it, and Home
// hides the column again when it is come back to (50-settings does the same).
async function closeAgent(app, wasOpen) {
  if (!(await app.inPage(shown, "#agentStrip"))) return;
  await app.click("#homeNavDub");
  await app.waitFor("the Dubbing tab", 10000, shown, "#homeBtn");
  if (!wasOpen && (await app.inPage(() => document.body.classList.contains("agent-open")))) await app.click("#paneAgent");
  await app.click("#homeBtn");
  await app.waitFor("Home", 10000, onHome);
  await app.waitFor("the panel to close", 5000, () => !document.querySelector("#agentStrip").getClientRects().length);
}

const lines = (s) => String(s || "").split("\n").filter((l) => l.trim()).length;

export const steps = [
  { name: "H1-H5 GitHub and Send feedback", looks: [".home-side", "#settingsOverlay"],
    async run(app) {
      // The production edition has no repository button, and its Send
      // feedback opens the Service inquiry form (ui/src/feedbackSheet.mjs).
      if (app.production) throw new Skip("the production edition has no GitHub button, and Send feedback opens the inquiry form");
      await toHome(app);
      // Every press lands in a list instead of the system browser.
      await app.js(`(() => { window.__e2eOpen = window.open; window.__e2eUrls = [];
        window.open = (u) => { window.__e2eUrls.push(String(u)); return null; }; return true; })()`);
      let urls;
      try {
        await app.click("#homeGhName");
        await app.click("#homeFeedback");
        await app.click("#homeNavSettings");
        await app.waitFor("the Settings dialog", 10000, isOpen, "#settingsOverlay");
        await app.click("#settingsTab-about");
        await app.waitFor("the About tab", 5000, () => !document.querySelector("#settingsPanel-about").hidden);
        await app.click("#brandBtn");
        await app.click("#settingsCancelBtn");
        await app.waitFor("Settings to close", 5000, isClosed, "#settingsOverlay");
      } finally {
        urls = await app.js(`(() => { const u = window.__e2eUrls || []; if (window.__e2eOpen) window.open = window.__e2eOpen;
          delete window.__e2eOpen; delete window.__e2eUrls; return u; })()`);
      }
      const back = await app.js(`String(window.open).includes("e2eUrls") ? "still stood in for" : "restored"`);
      if (back !== "restored") throw new Error("window.open was not put back");
      if (urls.length !== 3) throw new Error(`3 presses opened ${urls.length} address(es): ${urls.join(", ")}`);
      const [gh, fb, brand] = urls;
      if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(gh)) throw new Error(`the GitHub button opened "${gh}"`);
      if (brand !== gh) throw new Error(`Settings > About's logo opened "${brand}", Home's GitHub button "${gh}"`);
      if (fb !== `${gh}/issues`) throw new Error(`${app.tr("Send feedback")} opened "${fb}", not ${gh}/issues`);
      return `${app.tr("PersoDub on GitHub")} → ${gh}; About logo → same; ${app.tr("Send feedback")} → ${fb}; window.open restored`;
    } },

  { name: "H2 sidebar tools", looks: [".home-side", "#leftTabs", "#homeBannerLink"],
    async run(app) {
      await toHome(app);
      const said = [];
      // Burn in subtitles: an empty new project on its tab, asking for a video and a .srt.
      await app.click("#homeNavCaptions");
      const burn = await app.waitFor("the Burn in subtitles tab", 10000, () => {
        const b = document.querySelector('#leftTabs [data-tab="captions"]');
        return b.classList.contains("on") && b.getAttribute("aria-selected") === "true" && !document.querySelector("#tabCaptions").hidden
          && !document.querySelector("#capAlone").hidden && document.querySelector("#capSrtZone").getClientRects().length > 0
          && document.body.dataset.screen;
      });
      said.push(`${app.tr("Burn in subtitles")} → its tab on, video and .srt asked for (screen ${burn})`);
      await app.click("#homeBtn");
      await app.waitFor("Home", 10000, onHome);
      await app.click("#homeNavErase");
      await app.waitFor("the Erase tab", 10000, () => document.body.dataset.screen === "erase"
        && document.querySelector('#leftTabs [data-tab="erase"]').classList.contains("on")
        && document.querySelector("#eraseDrop").getClientRects().length > 0);
      said.push(`${app.tr("Erase subtitles")} → screen erase, erase tab on, drop zone shown`);
      await app.click("#homeBtn");
      await app.waitFor("Home", 10000, onHome);
      // The link field's blinks, counted as the mark going on.
      await app.js(`(() => { const row = document.querySelector("#homeBannerLink"); window.__e2eBlinks = 0;
        window.__e2eObs = new MutationObserver(() => { const on = row.classList.contains("ask");
          if (on && !window.__e2eAsk) window.__e2eBlinks += 1; window.__e2eAsk = on; });
        window.__e2eAsk = false; window.__e2eObs.observe(row, { attributeFilter: ["class"] }); return true; })()`);
      let got;
      try {
        await app.click("#homeNavSave");
        await sleep(1500);
        got = await app.inPage(() => ({ blinks: window.__e2eBlinks, still: document.querySelector("#homeBannerLink").classList.contains("ask"),
          focused: document.activeElement === document.querySelector("#linkInput"),
          card: document.querySelector("#linkCard").hidden ? "" : document.querySelector("#linkCard").textContent.trim() }));
      } finally {
        await app.js(`(() => { window.__e2eObs && window.__e2eObs.disconnect(); delete window.__e2eObs; delete window.__e2eBlinks; delete window.__e2eAsk; return true; })()`);
      }
      // The line under the cards put away: a typed space taken out again empties it.
      await app.type("#linkInput", " ");
      await rawKey(app, "Backspace", "Backspace", 8);
      await app.waitFor("the line under the cards to go", 5000, () => document.querySelector("#linkCard").hidden && !document.querySelector("#linkInput").value);
      if (got.blinks !== 1 || got.still || !got.focused) throw new Error(`${app.tr("Save video")}: ${got.blinks} blink(s), mark left ${got.still}, caret in the field ${got.focused}`);
      const want = app.tr("Paste a link and the video is fetched to this computer. Then Download saves it.");
      if (got.card !== want) throw new Error(`the line under the cards reads "${got.card}"`);
      said.push(`${app.tr("Save video")} → link field blinked ${got.blinks} time, caret in it, line "${got.card}" (emptied again)`);
      return said.join("; ");
    } },

  { name: "H12 Erase card", looks: ["#homeEraseCard", "#eraseDrop"],
    async run(app) {
      await toHome(app);
      await app.click("#homeEraseCard");
      const hint = await app.waitFor("the Erase tab", 10000, () => document.body.dataset.screen === "erase"
        && document.querySelector('#leftTabs [data-tab="erase"]').classList.contains("on")
        && document.querySelector("#eraseDrop").getClientRects().length > 0
        && document.querySelector("#eraseDrop").textContent.replace(/\s+/g, " ").trim().slice(0, 60));
      await app.shot("home2-erase-card");
      await app.click("#homeBtn");
      await app.waitFor("Home", 10000, onHome);
      return `${app.tr("Erase subtitles")} card → screen erase, erase tab on, #eraseDrop "${hint}…"; ${app.tr("Home")}`;
    } },

  { name: "H15 rename a card and back", looks: ["#projectsGrid", "#projectCardMenu"],
    async run(app, ctx) {
      await toHome(app);
      const jobs = (await app.api("/api/dub/jobs")).jobs;
      const byId = new Map(jobs.map((j) => [j.id, j]));
      const onGrid = await app.inPage(() => [...document.querySelectorAll("#projectsGrid .proj-card[data-job]")]
        .map((c) => ({ id: c.dataset.job, name: (c.querySelector(".proj-name")?.textContent || "").trim() })));
      // A finished job's card named e2e-, with a title of its own, so naming it back is exact.
      const pick = onGrid.find((c) => /^e2e-/.test(c.name) && byId.get(c.id)?.status === "done" && (byId.get(c.id).title || "").trim() === c.name);
      if (!pick) throw new Error("no finished card named e2e-* with a title of its own to rename");
      const members = jobs.filter((j) => (j.project_id || j.id) === (byId.get(pick.id).project_id || pick.id)).map((j) => j.id);
      const temp = `e2e-renamed-${ctx.stamp}`;
      async function rename(to) {
        await pressMore(app, `#projectsGrid .proj-card[data-job="${pick.id}"]`);
        await app.waitFor("the card menu", 5000, shown, "#projectMenuRename");
        await app.click("#projectMenuRename");
        await app.waitFor("the name field", 5000, (id) => document.activeElement === document.querySelector(`#projectsGrid [data-rename="${id}"]`), pick.id);
        await rawKey(app, "a", "KeyA", 65, ["selectAll"]);
        await app.send("Input.insertText", { text: to });
        await app.key("Enter");
        await app.waitFor(`the card to read ${to}`, 5000, (id, n) => (document.querySelector(`#projectsGrid .proj-card[data-job="${id}"] .proj-name`)?.textContent || "").trim() === n, pick.id, to);
        const end = Date.now() + 10000;
        for (;;) {
          const titles = await Promise.all(members.map(async (m) => (await app.api(`/api/dub/jobs/${m}`)).title));
          if (titles.every((tt) => tt === to)) return titles.length;
          if (Date.now() > end) throw new Error(`GET /api/dub/jobs titles are ${titles.join(", ")}, not ${to}`);
          await sleep(500);
        }
      }
      let n;
      try {
        n = await rename(temp);
        await app.shot("home2-renamed-card");
      } finally {
        await rename(pick.name);
      }
      return `"${pick.name}" (job ${pick.id}, ${n} language(s)) → ${app.tr("Rename")} "${temp}" + Enter: card and GET title the same → named back "${pick.name}"`;
    } },

  { name: "H9 Dub Agent chips", looks: ["#homeAgentCard", "#agentStrip"],
    async run(app) {
      await toHome(app);
      const wasOpen = await app.inPage(() => document.body.classList.contains("agent-open"));
      const chips = await app.inPage(() => [...document.querySelectorAll("#homeAgentCard .home-chip")].map((c) => c.dataset.prompt));
      if (chips.length !== 3) throw new Error(`the Dub Agent card has ${chips.length} chips, not 3`);
      const said = [];
      try {
        for (let i = 0; i < chips.length; i++) {
          const before = await app.inPage(() => document.querySelectorAll("#assistantLog > *").length);
          await app.click(`#homeAgentCard .home-chip:nth-of-type(${i + 1})`);
          const want = app.tr(chips[i]);
          const v = await app.waitFor(`the box to hold chip ${i + 1}'s words`, 5000, (w) => document.querySelector("#agentStrip").getClientRects().length > 0
            && document.querySelector("#assistantInput").value === w && w, want);
          await sleep(1000);
          const after = await app.inPage(() => document.querySelectorAll("#assistantLog > *").length);
          if (after !== before) throw new Error(`chip ${i + 1} put ${after - before} new row(s) in the conversation: it sent`);
          said.push(`"${v}"`);
        }
      } finally {
        // The box emptied again, then the column put away as it was.
        if (await app.inPage(shown, "#assistantInput")) await emptyField(app, "#assistantInput");
        await closeAgent(app, wasOpen).catch((e) => { if (said.length === chips.length) throw e; });
      }
      const left = await app.inPage(() => document.querySelector("#assistantInput").value);
      if (left) throw new Error(`the agent's box still holds "${left}"`);
      return `3 chips, each → #agentStrip on, box = ${said.join(", ")}, 0 new rows (not sent); box emptied, column closed`;
    } },

  { name: "H17 reopen the last project", looks: ["#topbarForward", "#projectsGrid"],
    async run(app) {
      await toHome(app);
      const jobs = (await app.api("/api/dub/jobs")).jobs;
      const onGrid = await app.inPage(() => [...document.querySelectorAll("#projectsGrid .proj-card[data-job]")].map((c) => c.dataset.job));
      const job = jobs.find((j) => j.status === "done" && (j.kind || "dub") === "dub" && onGrid.includes(j.id));
      if (!job) throw new Error("no finished dub has a card on Home");
      await app.click(`#projectsGrid .proj-card[data-job="${job.id}"]`);
      const title = await app.waitFor("the finished screen", 15000, (id) => document.body.dataset.screen === "done" && document.body.dataset.jobId === id
        && document.querySelector("#topbarTitle").textContent.trim(), job.id);
      await app.click("#homeBtn");
      await app.waitFor("Home", 10000, onHome);
      const fwd = await app.waitFor("the way back on the top bar", 5000, () => document.querySelector("#topbarForward").getClientRects().length > 0
        && document.querySelector("#topbarForwardName").textContent.trim());
      if (fwd !== title) throw new Error(`the top bar's way back reads "${fwd}", the project is "${title}"`);
      await app.shot("home2-topbar-forward");
      await app.click("#topbarForward");
      await app.waitFor("the same project", 15000, (id) => document.body.dataset.screen === "done" && document.body.dataset.jobId === id, job.id);
      await app.click("#homeBtn");
      await app.waitFor("Home", 10000, onHome);
      return `opened ${job.id} "${title}" → ${app.tr("Home")}: #topbarForward shown, "${fwd}" → pressed: data-jobId ${job.id} again → ${app.tr("Home")}`;
    } },

  { name: "N22 drop a video on the timeline", looks: ["#mediaReplaceOverlay", "#timeline", "#draftSetup"],
    async run(app, ctx) {
      const how = await ensurePrep(app, ctx);
      const was = await app.inPage(card);
      await dropFile(app, "#timeline", ctx.state.h2Video);
      await app.waitFor("the replace question", 5000, isOpen, "#mediaReplaceOverlay");
      const q = await app.inPage(textOf, "#mediaReplaceOverlay h2");
      await app.shot("home2-replace-question");
      await app.click("#mediaReplaceCancelBtn");
      await app.waitFor("the question to close", 5000, isClosed, "#mediaReplaceOverlay");
      await sleep(2000);
      const kept = await app.inPage(card);
      if (kept.src !== was.src) throw new Error(`${app.tr("Keep it")} changed the video: ${was.src} → ${kept.src}`);
      await dropFile(app, "#timeline", ctx.state.h2Video);
      await app.waitFor("the replace question again", 5000, isOpen, "#mediaReplaceOverlay");
      await app.click("#mediaReplaceConfirmBtn");
      const now = await app.waitFor("the new copy on the card", 60000, (src) => {
        const c = { src: document.querySelector("#doneVideo").getAttribute("src") || "",
                    len: (document.querySelector("#draftPartCard .vc-len")?.textContent || "").trim() };
        return c.src && c.src !== src && !document.querySelector("#draftStartBtn").disabled ? c : null;
      }, was.src);
      if (q !== app.tr("Replace this video?")) throw new Error(`the question reads "${q}"`);
      if (now.len !== "00:10") throw new Error(`the card reads ${now.len} after ${app.tr("Replace")}`);
      return `prep (${how}); drop → "${q}" 1 → ${app.tr("Keep it")}: src the same → drop → ${app.tr("Replace")}: src changed, card ${now.len}`;
    } },

  { name: "N10 High quality", looks: ["#advancedBody", "#progressCard"],
    async run(app, ctx) {
      await ensurePrep(app, ctx);
      const was = await app.inPage(() => document.querySelector("#qualitySelect").value);
      let note;
      try {
        await app.choose("#qualitySelect", "high");
        const { id, job } = await startDub(app);
        try {
          if (job.quality !== 4) throw new Error(`job ${id} has quality ${job.quality}, not 4 (High quality)`);
          note = `${app.tr("Voice quality")} ${app.tr("High quality")} → job ${id} (${job.status}) quality ${job.quality}`;
        } finally {
          await stopDub(app, id);
        }
        note += "; stopped, cancelled";
      } finally {
        await app.choose("#qualitySelect", was);
        await restoreChoices(app, ctx);
      }
      await toHome(app);
      return `${note}; ${app.tr("Voice quality")} back to ${was}, remembered choices put back`;
    } },

  { name: "N12 download lines under the fields", looks: ["#sepModelHint", "#modelsNeededOverlay"],
    async run(app, ctx) {
      await ensurePrep(app, ctx);
      const sep = (await app.api("/api/models")).models.find((m) => m.id === "vocal-separator");
      if (!sep) throw new Error("Mel-Band RoFormer is not listed in GET /api/models");
      if (sep.state === "ready") throw new Skip("Mel-Band RoFormer is downloaded here: no download line to read");
      const was = await app.inPage(() => document.querySelector("#sepSelect").value);
      try {
        await pickStage(app, "sepSelect", "roformer");
        const hints = await app.waitFor("the line under Voice separation", 5000, () => {
          const all = ["sepModelHint", "sttModelHint", "translateModelHint", "voiceModelHint"].map((id) => {
            const el = document.querySelector(`#${id}`);
            return { id, text: el.hidden ? "" : (el.querySelector("span")?.textContent || el.textContent).trim() };
          });
          return all[0].text ? all : null;
        });
        // A download stopped part way (paused, its pieces kept) is named with
        // Resume instead of the size; the dialog still counts its whole size.
        const paused = sep.state === "paused";
        const want = paused ? app.tr("{name} paused", { name: "Mel-Band RoFormer" })
          : app.tr("Needs {names} · {size} GB", { names: "Mel-Band RoFormer", size: (sep.bytes / 1e9).toFixed(1) });
        if (paused ? !hints[0].text.startsWith(want) : hints[0].text !== want) throw new Error(`the line reads "${hints[0].text}", not "${want}"`);
        const shownLines = hints.filter((h) => h.text && /GB/.test(h.text));
        const sum = shownLines.reduce((n, h) => n + Number(h.text.match(/([\d.]+)\s*GB/)[1]), 0)
          + (paused ? Number((sep.bytes / 1e9).toFixed(1)) : 0);
        await app.shot("home2-roformer-line");
        assertNoCredits(await app.inPage(choices));
        await app.click("#draftStartBtn");
        const d = await app.waitFor("the download dialog", 30000, () => {
          if (document.body.dataset.jobId) return { started: document.body.dataset.jobId };
          const open = document.querySelector(".modal-overlay.open");
          return open ? { id: open.id, title: document.querySelector("#mnTitle").textContent.trim() } : null;
        });
        if (d.started) throw new Error(`Start began job ${d.started} instead of asking for the download`);
        if (d.id !== "modelsNeededOverlay") throw new Error(`#${d.id} opened instead of the download dialog`);
        await app.click("#mnCancel");
        await app.waitFor("the dialog to close", 5000, isClosed, "#modelsNeededOverlay");
        const wantTitle = app.tr("Download {size} GB?", { size: sum.toFixed(1) });
        if (d.title !== wantTitle) throw new Error(`the lines add up to ${sum.toFixed(1)} GB, the dialog says "${d.title}"`);
        const engine = (await app.api("/api/models")).models.find((m) => m.id === "engine");
        return `${paused ? `RoFormer paused: "${hints[0].text}" (+${(sep.bytes / 1e9).toFixed(1)} GB); ` : ""}`
          + `${shownLines.length} line(s): ${shownLines.map((h) => `${h.id} "${h.text}"`).join(", ")}; sum ${sum.toFixed(1)} GB = "${d.title}" → ${app.tr("Cancel")}`
          + `; Python + PyTorch ${engine.state} here, so the counted-once rule is not on show`;
      } finally {
        if (await app.inPage(onPrep)) await pickStage(app, "sepSelect", was);
        await restoreChoices(app, ctx);
      }
    } },

  { name: "N16 download dialog's Hide and Use Perso API", looks: ["#modelsNeededOverlay"],
    async run(app, ctx) {
      await ensurePrep(app, ctx);
      const models = (await app.api("/api/models")).models;
      const state = (id) => (models.find((m) => m.id === id) || {}).state;
      const voiceMissing = state("engine") !== "ready" || state("qwen3-tts") !== "ready";
      const was = await app.inPage(() => document.querySelector("#sepSelect").value);
      try {
        await pickStage(app, "sepSelect", "roformer");
        assertNoCredits(await app.inPage(choices));
        await app.click("#draftStartBtn");
        await app.waitFor("the download dialog", 30000, isOpen, "#modelsNeededOverlay");
        const b = await app.inPage(() => ({ hide: !document.querySelector("#mnHide").hidden, perso: !document.querySelector("#mnSettings").hidden,
                                            download: !document.querySelector("#mnDownload").hidden }));
        await app.shot("home2-download-dialog");
        await app.click("#mnCancel");
        await app.waitFor("the dialog to close", 5000, isClosed, "#modelsNeededOverlay");
        // Hide is there only while a download runs; Use Perso API only when the voice parts are missing.
        if (b.hide) throw new Error("Hide shows before any download began");
        if (b.perso !== voiceMissing) throw new Error(`Use Perso API is ${b.perso ? "shown" : "hidden"} with the voice parts ${voiceMissing ? "missing" : "ready"}`);
        if (!b.download) throw new Error("Download is not shown");
        return `RoFormer missing, voice parts ${voiceMissing ? "missing" : "ready"}: ${app.tr("Download")} shown, ${app.tr("Hide")} hidden (shows only once a download runs), `
          + `${app.tr("Use Perso API")} ${b.perso ? "shown" : "hidden"} → ${app.tr("Cancel")}. NOT PRESSED: Hide needs a download into the kit's models folder, `
          + "Use Perso API is not offered while the voice parts are here";
      } finally {
        if (await app.inPage(onPrep)) await pickStage(app, "sepSelect", was);
        await restoreChoices(app, ctx);
      }
    } },

  { name: "T1 split, delete selected, redo", looks: ["#timeline", "#draftSetup"],
    async run(app, ctx) {
      await ensurePrep(app, ctx);
      const strip = () => {
        const inner = document.querySelector("#timeline .tl-inner"), ruler = document.querySelector("#timeline .tl-ruler");
        const cuts = document.querySelectorAll("#timeline .tl-cut");
        if (!inner || !ruler || cuts.length !== 1) return null;
        const r = ruler.getBoundingClientRect();
        return { left: inner.getBoundingClientRect().left, width: cuts[0].getBoundingClientRect().width + 2, y: r.top + r.height / 2 };
      };
      const now = () => ({ cuts: document.querySelectorAll("#timeline .tl-cut").length,
                           len: document.querySelector("#draftPartCard .vc-len").textContent.trim() });
      const s = await app.waitFor("the timeline's ruler and one clip", 5000, strip);
      await pressAt(app, ".tl-ruler", s.left + 4 * (s.width / 10), s.y);
      const at = await app.waitFor("the playhead at 4 s", 3000, () => {
        const v = document.querySelector("#doneVideo").currentTime;
        return Math.abs(v - 4) < 0.05 ? v : null;
      });
      const seen = [];
      try {
        await app.click("#tlSplit");
        const a = await app.waitFor("two clips", 5000, () => document.querySelectorAll("#timeline .tl-cut").length === 2 && document.querySelector("#draftPartCard .vc-len").textContent.trim());
        seen.push(`split: 2 clips, ${a}`);
        await app.click('#timeline .tl-cut[data-i="0"]');
        await app.waitFor("the first clip chosen", 5000, () => document.querySelector('#timeline .tl-cut[data-i="0"]').classList.contains("sel"));
        await app.click("#tlDelete");
        const b = await app.waitFor("one clip of 6 s", 5000, () => document.querySelectorAll("#timeline .tl-cut").length === 1
          && document.querySelector("#draftPartCard .vc-len").textContent.trim().startsWith("00:06") && document.querySelector("#draftPartCard .vc-len").textContent.trim());
        seen.push(`delete selected: 1 clip, ${b}`);
        await app.shot("home2-deleted-clip");
        await app.click("#tlUndo");
        const c = await app.waitFor("two clips again", 5000, () => document.querySelectorAll("#timeline .tl-cut").length === 2
          && document.querySelector("#draftPartCard .vc-len").textContent.trim() === "00:10" && "00:10");
        seen.push(`undo: 2 clips, ${c}`);
        await app.click("#tlRedo");
        await app.waitFor("the delete again", 5000, (want) => document.querySelectorAll("#timeline .tl-cut").length === 1
          && document.querySelector("#draftPartCard .vc-len").textContent.trim() === want, b);
        seen.push(`redo: 1 clip, ${b}`);
      } finally {
        // Back to the whole video: undo the delete, then the split.
        for (let i = 0; i < 3 && !(await app.inPage(() => document.querySelectorAll("#timeline .tl-cut").length === 1
          && document.querySelector("#draftPartCard .vc-len").textContent.trim() === "00:10")); i++) {
          if (!(await app.inPage(pressable, "#tlUndo"))) break;
          await app.click("#tlUndo");
          await sleep(300);
        }
      }
      const end = await app.inPage(now);
      if (end.cuts !== 1 || end.len !== "00:10") throw new Error(`left with ${end.cuts} clip(s), ${end.len}`);
      return `playhead ${at.toFixed(2)} s; ${seen.join("; ")}; undo ×2 → 1 clip, ${end.len}`;
    } },

  { name: "R2 raw log while running", looks: ["#rawLogDetails", "#progressCard", "#doneFail"],
    async run(app, ctx) {
      await ensurePrep(app, ctx);
      const { id } = await startDub(app);
      let note;
      try {
        await waitRunning(app, id);
        await app.waitFor("the running card", 10000, shown, "#progressCard");
        // The running card redraws as the job leaves the line, which can swallow the first press.
        for (let tries = 0; ; tries++) {
          await app.click("#rawLogDetails > summary");
          try { await app.waitFor("the raw log open", 5000, () => document.querySelector("#rawLogDetails").open); break; }
          catch (e) { if (tries >= 2) throw e; }
        }
        // The first line in, then five seconds.
        const n0 = await app.waitFor("a first log line", 30000, () => {
          const n = document.querySelector("#logBox").textContent.split("\n").filter((l) => l.trim()).length;
          return n || null;
        });
        await sleep(5000);
        const n1 = await app.inPage(() => document.querySelector("#logBox").textContent.split("\n").filter((l) => l.trim()).length);
        await app.shot("home2-raw-log");
        if (n1 - n0 < 1) throw new Error(`the raw log went from ${n0} to ${n1} lines in 5 s`);
        note = `job ${id} running, ${app.tr("Raw log")} opened: ${n0} → ${n1} lines in 5 s`;
      } finally {
        await stopDub(app, id);
        await restoreChoices(app, ctx);
      }
      const job = await app.api(`/api/dub/jobs/${id}`);
      const card = await app.inPage(() => ({ n: document.querySelector("#logBox").textContent.split("\n").filter((l) => l.trim()).length,
                                             inFail: !!document.querySelector("#doneFailBody #rawLogDetails") }));
      const want = lines((job.logs || []).join("\n"));
      if (!card.inFail) throw new Error("the raw log did not move onto the stopped card");
      if (card.n !== want) throw new Error(`the stopped card's raw log has ${card.n} lines, GET /api/dub/jobs/${id} logs ${want}`);
      await toHome(app);
      return `${note}; stopped: card's raw log ${card.n} lines = GET logs ${want}; Home`;
    } },

  { name: "R4 original video while running", looks: ["#runningVideo", "#runPlay"],
    async run(app, ctx) {
      await ensurePrep(app, ctx);
      const { id } = await startDub(app);
      let note;
      try {
        await waitRunning(app, id);
        const src = await app.waitFor("the original on the running screen", 15000, () => {
          const v = document.querySelector("#runningVideo");
          return v.readyState >= 2 && v.getAttribute("src");
        });
        if (src !== `/api/dub/result/${id}/original`) throw new Error(`#runningVideo plays ${src}`);
        const t0 = await app.inPage(() => document.querySelector("#runningVideo").currentTime);
        await app.click("#runPlay");
        await sleep(1000);
        const t1 = await app.inPage(() => document.querySelector("#runningVideo").currentTime);
        if (!(await app.inPage(() => document.querySelector("#runningVideo").paused))) await app.click("#runPlay");
        const step = t1 - t0;
        if (step < 0.5 || step > 2) throw new Error(`1 s of play moved the original ${step.toFixed(2)} s`);
        note = `job ${id}: #runningVideo ${src}; play 1 s → ${t0.toFixed(2)} → ${t1.toFixed(2)} s (+${step.toFixed(2)}), paused`;
      } finally {
        await stopDub(app, id);
        await restoreChoices(app, ctx);
      }
      await toHome(app);
      return `${note}; stopped; Home`;
    } },

  { name: "P15 result card", looks: ["#draftResult", "#keyOverlay"],
    async run(app, ctx) {
      await ensurePrep(app, ctx);
      const engines = await app.api("/api/engines");
      // Signed in, the production edition always has the account's key: the app is behind its sign-in screen without one.
      if (app.production) throw new Skip("the production edition is signed in with the account's key, so Perso API never asks for one");
      if (engines.perso_available) throw new Error("this kit has a Perso key saved; the step needs none");
      const read = () => app.inPage(() => {
        const el = document.querySelector("#draftResult");
        return { on: el.getClientRects().length > 0, k: el.querySelector(".k").textContent.trim(), m: el.querySelector(".m").textContent.trim() };
      });
      const local = await read();
      await app.click("#dubModePerso");
      await app.waitFor("the key window", 5000, isOpen, "#keyOverlay");
      const perso = await read();
      await app.key("Escape");
      await app.waitFor("Local model back", 5000, () => !document.querySelector("#keyOverlay").classList.contains("open")
        && document.querySelector("#dubModeSelect").value === "local");
      const back = await read();
      await restoreChoices(app, ctx);
      const want = app.tr("Dubbed video, subtitles and audio files");
      if (!local.on || local.m !== want || local.k !== app.tr("What you get")) throw new Error(`the result card: ${JSON.stringify(local)}`);
      if (perso.m !== want || back.m !== want) throw new Error(`the card changed: Perso "${perso.m}", back "${back.m}"`);
      await toHome(app);
      return `#draftResult shown: "${local.k}" / "${local.m}"; ${app.tr("Perso API")} (key window, no key) and ${app.tr("Local model")} again: the same words`;
    } },

  { name: "G10 Settings' discard question", looks: ["#settingsDiscardOverlay", "#settingsOverlay"],
    async run(app) {
      await toHome(app);
      const before = (await app.api("/api/settings")).ui_language;
      await app.click("#homeNavSettings");
      await app.waitFor("the Settings dialog", 10000, isOpen, "#settingsOverlay");
      try {
        await app.click("#settingsTab-about");
        await app.waitFor("the About tab", 5000, () => !document.querySelector("#settingsPanel-about").hidden);
        const other = await app.inPage(() => [...document.querySelector("#uiLanguageSelect").options].map((o) => o.value)
          .find((v) => v !== document.querySelector("#uiLanguageSelect").value));
        await app.choose("#uiLanguageSelect", other);
        await app.click("#settingsCancelBtn");
        await app.waitFor("the discard question", 5000, isOpen, "#settingsDiscardOverlay");
        const q = await app.inPage(textOf, "#settingsDiscardTitle");
        await app.shot("home2-discard-question");
        await app.click("#settingsDiscardKeep");
        await app.waitFor("the question to close, Settings still open", 5000, () => !document.querySelector("#settingsDiscardOverlay").classList.contains("open")
          && document.querySelector("#settingsOverlay").classList.contains("open"));
        const kept = await app.inPage(() => document.querySelector("#uiLanguageSelect").value);
        if (kept !== other) throw new Error(`${app.tr("Keep editing")} left the language on ${kept}, not ${other}`);
        await app.click("#settingsCancelBtn");
        await app.waitFor("the discard question again", 5000, isOpen, "#settingsDiscardOverlay");
        await app.click("#settingsDiscardYes");
        await app.waitFor("Settings to close", 5000, () => !document.querySelector("#settingsOverlay").classList.contains("open")
          && !document.querySelector("#settingsDiscardOverlay").classList.contains("open"));
        const after = (await app.api("/api/settings")).ui_language;
        if (q !== app.tr("Discard changes?")) throw new Error(`the question reads "${q}"`);
        if (after !== before) throw new Error(`GET /api/settings ui_language is ${after}, was ${before}`);
        return `language ${before} → ${other}, ${app.tr("Cancel")} → "${q}" → ${app.tr("Keep editing")}: still ${kept} → ${app.tr("Cancel")} → ${app.tr("Discard")}: closed, ui_language ${after}`;
      } finally {
        if (await app.inPage(isOpen, "#settingsDiscardOverlay")) await app.click("#settingsDiscardYes");
        if (await app.inPage(isOpen, "#settingsOverlay")) {
          await app.click("#settingsCancelBtn");
          if (await app.inPage(isOpen, "#settingsDiscardOverlay")) await app.click("#settingsDiscardYes");
        }
      }
    } },

  { name: "M2 Dub Agent model picker", looks: ["#assistantMenu", "#assistantModelWrap"],
    async run(app) {
      await toHome(app);
      const wasOpen = await app.inPage(() => document.body.classList.contains("agent-open"));
      const saved = await app.js(`localStorage.getItem(${JSON.stringify(AGENT_KEY)})`);
      const menuRows = () => [...document.querySelectorAll("#assistantMenu > button.menu-item")].map((b) => ({
        name: b.querySelector(".menu-name").firstChild?.textContent.trim() || "", off: b.disabled,
        tick: !!b.querySelector(".tick") }));
      const openMenu = async () => {
        if (!(await app.inPage(() => document.querySelector("#assistantMenu").hidden))) return;
        await app.click("#assistantModelBtn");
        await app.waitFor("the assistant list", 15000, () => !document.querySelector("#assistantMenu").hidden
          && document.querySelectorAll("#assistantMenu > button.menu-item").length);
      };
      // The menu is drawn again when the sign-in check it starts answers, so a
      // row found just before that is gone under the press (its new copy takes
      // it): the press is made again on the row drawn in its place.
      const pressRow = async (sel) => {
        for (let i = 0; ; i++) {
          try { return await app.click(sel); } catch (e) {
            if (i >= 3 || !/covered by button\.menu-item|Could not compute box model/.test(e.message)) throw e;
            await sleep(700);
          }
        }
      };
      // An assistant's row by its name, pressed: its models. Codex not signed
      // in opens the ChatGPT sign-in instead (and the menu closes): that is
      // closed with its Cancel, never signed in, and "sign-in" comes back.
      const into = async (name) => {
        const i = await app.inPage((n) => [...document.querySelectorAll("#assistantMenu > button.menu-item")]
          .findIndex((b) => b.querySelector(".menu-name").firstChild?.textContent.trim() === n && !b.disabled), name);
        if (i < 0) return null;
        await pressRow(`#assistantMenu > button.menu-item:nth-of-type(${i + 1})`);
        const got = await app.waitFor(`${name}'s models`, 15000, () => document.querySelector("#chatgptSignInOverlay").classList.contains("open") ? "sign-in"
          : document.querySelector("#assistantMenu .menu-back") ? "models" : "");
        if (got === "sign-in") {
          await app.click("#csCancel");
          await app.waitFor("the sign-in window to close", 5000, isClosed, "#chatgptSignInOverlay");
          return got;
        }
        // Codex's list may still be checking: up to 15 s for one to be pickable.
        await app.waitFor(`a pickable ${name} model`, 15000, () => [...document.querySelectorAll("#assistantMenu > button.menu-item")].some((b) => !b.disabled)).catch(() => {});
        return app.inPage(menuRows);
      };
      const back = async () => {
        await pressRow("#assistantMenu .menu-group");
        await app.waitFor("the assistant list again", 5000, () => !document.querySelector("#assistantMenu .menu-back"));
      };
      let note, codexOut = false;
      try {
        await app.inPage(() => { document.querySelector("#homeAgentOpen").scrollIntoView({ block: "center" }); return true; });
        await sleep(400);
        await app.click("#homeAgentOpen");
        await app.waitFor("the Dub Agent panel", 5000, shown, "#agentStrip");
        await app.waitFor("the model picker", 20000, shown, "#assistantModelBtn");
        const label0 = await app.inPage(textOf, "#assistantModelLabel");
        await openMenu();
        const top = await app.inPage(menuRows);
        const claude = await into("Claude");
        if (!claude) throw new Error(`Claude cannot be picked: ${JSON.stringify(top)}`);
        await back();
        let codex = await into("Codex");
        codexOut = codex === "sign-in";
        if (codexOut) { codex = []; await openMenu(); } else if (codex) await back();
        if (claude.length !== 4) throw new Error(`Claude lists ${claude.length} models (${claude.map((r) => r.name).join(", ")}), not 4`);
        if (!codexOut && (!codex || !codex.length)) throw new Error(`Codex lists no models (${JSON.stringify(top)})`);
        // Picked: the first Claude model without the tick, then the one that had it, back.
        const wasPick = claude.find((r) => r.tick) || (codex || []).find((r) => r.tick);
        if (codexOut && !wasPick) throw new Skip(`Codex not signed in, and "${label0}" is no Claude model, so it could not be picked back`);
        const other = claude.find((r) => !r.tick);
        await into("Claude");
        await pressRow(`#assistantMenu > button.menu-item:nth-of-type(${claude.indexOf(other) + 1})`);
        await app.waitFor("the menu to close", 5000, () => document.querySelector("#assistantMenu").hidden);
        const label1 = await app.inPage(textOf, "#assistantModelLabel");
        if (label1 === label0) throw new Error(`picking ${other.name} left the label "${label0}"`);
        if (wasPick) {
          await openMenu();
          const owner = claude.includes(wasPick) ? "Claude" : "Codex";
          const rows = await into(owner);
          const i = rows.findIndex((r) => r.name === wasPick.name);
          await pressRow(`#assistantMenu > button.menu-item:nth-of-type(${i + 1})`);
          await app.waitFor("the menu to close", 5000, () => document.querySelector("#assistantMenu").hidden);
        }
        const label2 = await app.inPage(textOf, "#assistantModelLabel");
        if (label2 !== label0) throw new Error(`picked back, the label reads "${label2}", not "${label0}"`);
        note = `${top.length} assistants (${top.map((r) => r.name + (r.off ? " off" : "")).join(", ")}); Claude ${claude.length} (${claude.map((r) => r.name).join("/")}), `
          + (codexOut ? `Codex opened the ChatGPT sign-in, closed with ${app.tr("Cancel")}`
            : `Codex ${codex.length} (${codex.map((r) => r.name + (r.off ? " off" : "")).join("/")})`)
          + `; "${label0}" → ${other.name}: "${label1}" → back: "${label2}"`;
      } finally {
        if (!(await app.inPage(() => document.querySelector("#assistantMenu").hidden))) await app.key("Escape");
        await app.inPage((k, v) => { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); return true; }, AGENT_KEY, saved);
        // After a failure the putting away must not hide the reason.
        await closeAgent(app, wasOpen).catch((e) => { if (note) throw e; });
      }
      if (codexOut) throw new Skip(`Codex not signed in; the rest ran: ${note}; ${AGENT_KEY} put back; column closed`);
      return `${note}; ${AGENT_KEY} put back; column closed`;
    } },

  { name: "tidy up this run's cards", looks: ["#projectsGrid", "#deleteOverlay"],
    async run(app, ctx) {
      await toHome(app);
      await restoreChoices(app, ctx);
      // This area's own cards, from this run and any run before it that stopped short.
      const stem = "e2e-dub-home2-";
      const gone = [];
      for (let round = 0; round < 10; round++) {
        const c = await app.inPage((s) => {
          const el = [...document.querySelectorAll("#projectsGrid .proj-card")]
            .find((x) => (x.querySelector(".proj-name")?.textContent || "").trim().startsWith(s));
          return el ? { job: el.dataset.job || "", draft: el.dataset.draft || "", name: el.querySelector(".proj-name").textContent.trim() } : null;
        }, stem);
        if (!c) break;
        if (!c.name.startsWith(stem)) throw new Error(`refused to delete "${c.name}"`);
        await pressMore(app, c.draft ? `#projectsGrid .proj-card[data-draft="${c.draft}"]` : `#projectsGrid .proj-card[data-job="${c.job}"]`);
        await app.waitFor("the card menu", 5000, shown, "#projectMenuDelete");
        await app.click("#projectMenuDelete");
        await app.waitFor("the delete dialog", 5000, isOpen, "#deleteOverlay");
        await app.click("#deleteConfirmBtn");
        await app.waitFor("the card to go", 20000, (sel) => !document.querySelector("#deleteOverlay").classList.contains("open")
          && !document.querySelector(sel), c.draft ? `#projectsGrid [data-draft="${c.draft}"]` : `#projectsGrid [data-job="${c.job}"]`);
        gone.push(c.draft ? `draft ${c.draft}` : `job ${c.job}`);
      }
      const left = (await app.api("/api/dub/jobs")).jobs.filter((j) => (j.title || j.project || "").startsWith(stem));
      if (left.length) throw new Error(`GET /api/dub/jobs still lists ${left.map((j) => j.id).join(", ")}`);
      return `deleted ${gone.length} card(s) named ${stem}*: ${gone.join(", ") || "none"}; remembered choices as found`;
    } },
];
