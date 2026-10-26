// The running dub and every way to stop work: a local dub's progress card
// (its four stages ticking in order, the percent), Home while it runs and back
// in, a second dub waiting in line and taken out of it, the first one finishing
// by itself, a running dub stopped, then resumed and stopped again, an
// erase stopped, and a dub with Gemini and no key (the key
// window stops it before it can fail). Everything runs on this computer with
// the translator the app remembers; the projects it made are deleted at the end.
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { sleep, shown, pressable, isOpen, isClosed, onHome, textOf } from "../lib/cdp.mjs";

export const area = "running";

const CHOICES_KEY = "persodub.lastChoices";
const LIVE = ["queued", "running", "cancelling"];
const AREA_PREFIX = "e2e-running-";
const STAGES = ["Separating audio", "Transcribing", "Translating", "Dubbing"];
const since = (t0) => Math.round((Date.now() - t0) / 100) / 10;
const nameOf = (j) => String(j.title || j.project || "");
const getJob = (app, id) => app.api(`/api/dub/jobs/${id}`);

// Ask the server until `test` gives something, or throw after `ms`.
async function until(what, ms, test) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await test();
    if (v) return v;
    if (Date.now() > end) throw new Error(`waited ${ms / 1000} s for ${what}`);
    await sleep(500);
  }
}

// The job reaching `want`; any other end on the way is the answer instead.
const reaches = (app, id, want, ms) => until(`job ${id} to be ${want}`, ms, async () => {
  const j = await getJob(app, id);
  if (j.status === want) return j;
  if (!LIVE.includes(j.status)) throw new Error(`job ${id} ended ${j.status}${j.error ? ` (${j.error})` : ""}, not ${want}`);
  return null;
});

// The progress card as drawn, with the finished screen's two facts beside it.
const cardNow = () => {
  const lis = [...document.querySelectorAll("#progressSteps li")];
  return { job: document.body.dataset.jobId || "", screen: document.body.dataset.screen,
           on: document.querySelector("#progressCard").getClientRects().length > 0,
           title: document.querySelector("#progressTitle").textContent.trim(),
           pct: parseInt(document.querySelector("#progressPct").textContent, 10) || 0,
           names: lis.map((li) => [...li.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim()),
           states: lis.map((li) => li.className),
           note: (document.querySelector("#progressSteps .step-note")?.textContent || "").replace(/^·\s*/, "").trim(),
           sub: document.querySelector("#topbarSub").textContent.trim(),
           rows: document.querySelectorAll("#scriptBox .sc-row:not(.head)").length,
           why: document.querySelector("#doneFailWhy").textContent.trim() };
};

// Follow a job's card until `stop` says so: the stages may only be done from
// the first on, the percent never goes back, and when each stage was first
// seen done is noted (seconds after Start) in w.doneAt.
async function watch(app, w, stop, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const s = await app.inPage(cardNow);
    if (s.job !== w.id) throw new Error(`the screen left job ${w.id} (now ${s.screen}, job ${s.job || "none"})`);
    if (s.screen === "failed") throw new Error(`job ${w.id} stopped: "${s.why}"`);
    if (s.screen === "running" && s.on) {
      if (!/^(step-done )*(current )?(todo )*$/.test(s.states.map((c) => `${c} `).join(""))) {
        throw new Error(`the stages are out of order: ${s.states.join(", ")}`);
      }
      if (s.pct < w.pct) throw new Error(`the percent went back from ${w.pct}% to ${s.pct}%`);
      w.pct = s.pct;
      s.states.forEach((c, i) => { if (c === "step-done" && w.doneAt[i] == null) w.doneAt[i] = since(w.t0); });
      if (s.note && !w.notes.includes(s.note)) w.notes.push(s.note);
    }
    if (stop(s)) return s;
    if (Date.now() > end) {
      const e = new Error(`waited ${ms / 1000} s for job ${w.id} (last: ${s.screen} "${s.title}" ${s.pct}%)`);
      e.timeout = true;
      throw e;
    }
    await sleep(500);
  }
}

// Home, with no dialog in the way.
async function toHome(app) {
  for (let i = 0; i < 3 && (await app.js(`!!document.querySelector(".modal-overlay.open")`)); i++) {
    await app.key("Escape");
    await sleep(300);
  }
  if (!(await app.inPage(onHome))) await app.click("#homeBtn");
  await app.waitFor("the Home screen", 10000, onHome);
}

// A new project of a copy of the clip named <prefix>-<tag>, up to its Before dubbing card.
async function newDraft(app, ctx, tag) {
  const r = ctx.state.run;
  const name = `${r.prefix}-${tag}`;
  const file = join(ctx.out, `${name}.mp4`);
  copyFileSync(ctx.video, file);
  await toHome(app);
  await app.click("#homeDubCard");
  await app.waitFor("the Dubbing tab's Import block", 10000, shown, "#dubbingZone .import-head");
  await app.feed("#dubbingZone .import-head", file);
  const ready = await app.waitFor("the Before dubbing card with Start lit", 120000, () => {
    const s = document.querySelector("#dubbingImportStatus");
    if (s.classList.contains("error") && s.textContent.trim()) return `refused: ${s.textContent.trim()}`;
    return !document.querySelector("#draftSetup").hidden && !document.querySelector("#draftStartBtn").disabled ? "ready" : "";
  });
  if (ready !== "ready") throw new Error(`the import of ${name}.mp4 was ${ready}`);
  return name;
}

// Start dubbing on this computer: the job, when Start was pressed, and how
// long the progress card took to show its four stages.
async function startDub(app) {
  // The mode first: it refills the target list. Perso at separation or
  // speech-to-text spends credits, so both are put on this computer.
  for (const [sel, v] of [["#dubModeSelect", "local"], ["#sepSelect", "local"], ["#sttSelect", "local"], ["#targetLangSelect", "ko"]]) {
    await app.choose(sel, v);
  }
  const before = await app.js(`document.body.dataset.jobId || ""`);
  const t0 = Date.now();
  await app.click("#draftStartBtn");
  const started = await app.waitFor("the dub to start", 60000, (was) => {
    const b = document.body;
    if (b.dataset.screen === "running" && b.dataset.jobId && b.dataset.jobId !== was) return `job:${b.dataset.jobId}`;
    const error = document.querySelector("#draftError").textContent.trim();
    if (error) return `refused: ${error}`;
    const d = document.querySelector(".modal-overlay.open");
    return d ? `#${d.id} opened` : "";
  }, before);
  if (!started.startsWith("job:")) throw new Error(`Start was ${started}`);
  const id = started.slice(4);
  const j = await getJob(app, id);
  if (j.dub_mode !== "local" || j.separation === "perso" || j.stt_engine === "perso") {
    throw new Error(`PERSO CREDITS: job ${id} runs ${j.dub_mode}/${j.separation}/${j.stt_engine}. Stop it in the app now`);
  }
  await app.waitFor("the progress card with its four stages", 15000, (jid) => document.body.dataset.jobId === jid
    && document.querySelector("#progressCard").getClientRects().length > 0
    && document.querySelectorAll("#progressSteps li").length === 4, id);
  return { id, t0, cardIn: since(t0), translator: j.translator };
}

// The running card's Stop, and the question after it if one is asked: its words.
async function pressStop(app) {
  await app.click("#cancelBtn");
  const asked = await app.waitFor("the stop question", 3000, isOpen, "#cancelDubOverlay").catch(() => false);
  if (!asked) return "";
  const q = await app.inPage(textOf, "#cancelDubTitle");
  await app.click("#cancelDubConfirmBtn");
  await app.waitFor("the stop question to close", 5000, isClosed, "#cancelDubOverlay");
  return q;
}

// The stopped card of a job: its sentence and its two buttons.
async function stoppedCard(app, id, ms = 30000) {
  return app.waitFor(`job ${id}'s stopped card`, ms, (jid) => {
    if (document.body.dataset.jobId !== jid || document.body.dataset.screen !== "failed") return null;
    const why = document.querySelector("#doneFailWhy").textContent.trim();
    const btn = (s) => { const b = document.querySelector(s); return b.getClientRects().length > 0 ? b.textContent.trim() : ""; };
    return why && { why, resume: btn("#doneResume"), retry: btn("#doneRetry") };
  }, id);
}

// A project card on Home, opened by a press: the screen it lands on.
async function openCard(app, id, screen) {
  await toHome(app);
  // Home shows the Up next card only after it has asked for the jobs again,
  // and the card pushes the grid down about 100 px when it appears: a click
  // measured before that lands on the card above (seen on Windows and on this
  // Mac, 0.9.0 too). Wait for the card to match the line first.
  const live = (await app.api("/api/dub/jobs")).jobs.some((j) => LIVE.includes(j.status));
  await app.waitFor("the Up next card to settle", 10000, (on) => document.querySelector("#queueCard").hidden !== on, live);
  await app.click(`#projectsGrid .proj-card[data-job="${id}"]`, 40000);
  await app.waitFor(`job ${id} on the ${screen} screen`, 40000, (jid, s) => document.body.dataset.jobId === jid
    && document.body.dataset.screen === s, id, screen);
}

// The newest job of a kind made from the draft `name`.
const jobOf = (app, kind, name) => until(`the ${kind} job of ${name}`, 15000, async () => {
  const { jobs } = await app.api("/api/dub/jobs");
  return jobs.find((j) => j.kind === kind && nameOf(j).startsWith(name)) || null;
});

// The first project card named <prefix>..., as a selector, or "".
const cardOf = (p) => {
  const c = [...document.querySelectorAll("#projectsGrid .proj-card")]
    .find((x) => (x.querySelector(".proj-name")?.textContent || "").startsWith(p));
  return c ? (c.dataset.job ? `[data-job="${c.dataset.job}"]` : `[data-draft="${c.dataset.draft}"]`) : "";
};

// Someone else's job may still be finishing (one started through the agent, say):
// a step that stops a running job needs the line to itself, or it stops a queued one.
async function lineEmpty(app, ms = 180000) {
  const busy = async () => (await app.api("/api/dub/jobs")).jobs.filter((j) => LIVE.includes(j.status));
  await until("the line to empty", ms, async () => !(await busy()).length).catch(async () => {
    const b = await busy();
    throw new Error(`${b.length} job(s) still in line (${b.map((j) => `${j.id} ${nameOf(j)} ${j.status}`).join(", ")}); the step needs the line empty`);
  });
}

const newWatch = (d) => ({ id: d.id, t0: d.t0, doneAt: [null, null, null, null], pct: 0, notes: [] });

export const steps = [
  { name: "start a local dub", looks: ["#progressCard", "#draftSetup"],
    async run(app, ctx) {
      const r = ctx.state.run = { prefix: `${AREA_PREFIX}${ctx.stamp}` };
      r.choices = await app.js(`localStorage.getItem(${JSON.stringify(CHOICES_KEY)})`);
      // A dialog someone left open is closed the way a person would, with Escape.
      r.leftOpen = await app.js(`document.querySelector(".modal-overlay.open")?.id || ""`);
      await toHome(app);
      const still = await app.js(`document.querySelector(".modal-overlay.open")?.id || ""`);
      if (still) throw new Error(`#${still} stays open after Escape`);
      r.cardsBefore = await app.js(`document.querySelectorAll("#projectsGrid .proj-card").length`);
      await lineEmpty(app);
      await newDraft(app, ctx, "a");
      const d = await startDub(app);
      const w = r.first = newWatch(d);
      const want = STAGES.map((k) => app.tr(k));
      const c = await app.inPage(cardNow);
      if (JSON.stringify(c.names) !== JSON.stringify(want)) throw new Error(`the card's stages are ${c.names.join(" / ")}, not ${want.join(" / ")}`);
      // Two stages ticked off is enough to see the order; the rest is read in step 4.
      const s = await watch(app, w, (x) => x.states[1] === "step-done", 120000);
      await app.shot("running-card");
      return `job ${d.id} (local, ${d.translator}): card in ${d.cardIn} s with ${want.join(" / ")}; `
        + `${want[0]} done at ${w.doneAt[0]} s, ${want[1]} at ${w.doneAt[1]} s; "${c.title}" ${c.pct}% → "${s.title}" ${s.pct}%; `
        + `the card has no elapsed clock (percent only)${r.leftOpen ? `; #${r.leftOpen} was open at the start, closed by Escape` : ""}`;
    } },

  { name: "Home while it runs", looks: ["#projectsGrid", "#queueCard", "#progressCard"],
    async run(app, ctx) {
      const w = ctx.state.run?.first;
      if (!w) throw new Error("step 1 started no dub");
      await toHome(app);
      const chip = await app.waitFor("the project card to say it runs", 15000, (id, word) => {
        const c = document.querySelector(`#projChip-${id}`);
        return c && c.classList.contains("proj-chip-run") && c.textContent.trim().startsWith(word) ? c.textContent.trim() : "";
      }, w.id, app.tr("Dubbing"));
      const line = await app.waitFor("the Up next card", 10000, () => !document.querySelector("#queueCard").hidden
        && document.querySelector("#queueSummary").textContent.trim());
      await app.shot("running-home");
      await app.click(`#projectsGrid .proj-card[data-job="${w.id}"]`, 20000);
      const back = await app.waitFor("the running card again", 20000, (id) => document.body.dataset.jobId === id
        && document.body.dataset.screen === "running" && document.querySelector("#progressCard").getClientRects().length > 0
        && document.querySelector("#progressTitle").textContent.trim(), w.id);
      await watch(app, w, () => true, 1000);
      return `card chip "${chip}", Up next "${line}"; opened again: running card "${back}" ${w.pct}%`;
    } },

  { name: "a second dub waits in line", looks: ["#progressCard", "#doneFail"],
    async run(app, ctx) {
      const r = ctx.state.run, w = r?.first;
      if (!w) throw new Error("step 1 started no dub");
      if ((await getJob(app, w.id)).status !== "running") throw new Error(`job ${w.id} is not running any more`);
      await newDraft(app, ctx, "b");
      const d = await startDub(app);
      r.second = d.id;
      const c = await app.inPage(cardNow);
      const listed = (await app.api("/api/dub/jobs")).jobs.find((j) => j.id === d.id);
      await app.shot("running-queued");
      if (c.title !== app.tr("Waiting to start") || c.sub !== app.tr("Waiting for its turn")) {
        throw new Error(`the waiting card says "${c.title}" under "${c.sub}"`);
      }
      if (listed?.status !== "queued") throw new Error(`GET /api/dub/jobs lists job ${d.id} as ${listed?.status}`);
      const t0 = Date.now();
      const asked = await pressStop(app);
      await reaches(app, d.id, "cancelled", 60000);
      const took = since(t0);
      const card = await stoppedCard(app, d.id);
      const first = await getJob(app, w.id);
      if (first.status !== "running") throw new Error(`the first dub is ${first.status} after the second was taken out`);
      if (card.why !== app.tr("This dubbing was stopped.")) throw new Error(`the stopped card says "${card.why}"`);
      await openCard(app, w.id, "running");
      return `job ${d.id}: "${c.title}", top bar "${c.sub}", listed queued; ${app.tr("Stop")}${asked ? ` → "${asked}" → ${app.tr("Stop")}` : ""} → `
        + `cancelled in ${took} s, card "${card.why}"; job ${w.id} still running, its card open again`;
    } },

  { name: "the first dub finishes", looks: ["#progressCard", "#scriptBox"],
    async run(app, ctx) {
      const w = ctx.state.run?.first;
      if (!w) throw new Error("step 1 started no dub");
      if (!(await app.inPage((id) => document.body.dataset.jobId === id, w.id))) await openCard(app, w.id, "running");
      // Waited past 300 s, so the steps after it get the line to themselves and
      // the report says how long it really took.
      const left = 600000 - (Date.now() - w.t0);
      const s = await watch(app, w, (x) => x.screen === "done" && x.rows > 0, Math.max(left, 1000));
      w.doneAt[3] = since(w.t0);
      // The target is 300 s; a dub of this clip took 190-465 s on this computer
      // (2026-10-23, under other engineers' load), so only 600 s fails the step.
      const j = await getJob(app, w.id);
      await app.shot("running-finished");
      const st = j.stage_seconds || {};
      const want = STAGES.map((k) => app.tr(k));
      const counted = w.notes.length ? `counter ${w.notes.map((n) => `"${n}"`).join(", ")}`
        : `no line counter (a ${j.quality === 1 ? "fast" : "high quality"} run logs no chosen take)`;
      return `done ${w.doneAt[3]} s after Start${w.doneAt[3] > 300 ? " (OVER THE 300 s TARGET)" : ""} (record ${j.elapsed_seconds} s); seen done at `
        + `${want.map((n, i) => `${n} ${w.doneAt[i] ?? "?"} s`).join(", ")}; record stage_seconds `
        + `${Object.entries(st).map(([k, v]) => `${k} ${v}`).join(", ")}; ${counted}; the finished screen opened by itself with ${s.rows} rows`;
    } },

  { name: "stop a running dub, resume, stop", looks: ["#progressCard", "#doneFail", "#projectsGrid"],
    async run(app, ctx) {
      const r = ctx.state.run;
      if (!r) throw new Error("step 1 did not run");
      await lineEmpty(app);
      await newDraft(app, ctx, "c");
      const d = await startDub(app);
      r.third = d.id;
      const w = newWatch(d);
      await reaches(app, d.id, "running", 60000);
      w.t0 = Date.now();
      let when = `after ${app.tr("Transcribing")}`;
      try {
        await watch(app, w, (x) => x.states[1] === "step-done", 20000);
      } catch (e) {
        if (!e.timeout) throw e;
        when = "20 s in";
      }
      const at = since(d.t0);
      const was = (await getJob(app, d.id)).status;
      if (was !== "running") throw new Error(`job ${d.id} is ${was} when ${app.tr("Stop")} is pressed, not running`);
      const asked = await pressStop(app);
      const t0 = Date.now();
      await reaches(app, d.id, "cancelled", 60000);
      const took = since(t0);
      const card = await stoppedCard(app, d.id);
      await app.shot("running-stopped");
      if (card.why !== app.tr("This dubbing was stopped.")) throw new Error(`the stopped card says "${card.why}"`);
      await toHome(app);
      const chip = await app.waitFor("the card to say Cancelled", 15000, (id) => (document.querySelector(`#projChip-${id}`)?.textContent || "").trim(), d.id);
      if (chip !== app.tr("Cancelled")) throw new Error(`the project card says "${chip}", not "${app.tr("Cancelled")}"`);
      // Back in, and on from where it stopped.
      await openCard(app, d.id, "failed");
      const again = await stoppedCard(app, d.id);
      if (!again.resume) throw new Error(`the stopped card offers no ${app.tr("Resume")} (only "${again.retry}")`);
      await app.click("#doneResume");
      const back = await app.waitFor("the dub to run again", 30000, (id) => document.body.dataset.jobId === id
        && document.body.dataset.screen === "running" && document.querySelector("#progressTitle").textContent.trim(), d.id);
      const resumed = (await getJob(app, d.id)).status;
      await sleep(3000);
      const title = await app.inPage(textOf, "#progressTitle");
      await pressStop(app);
      await reaches(app, d.id, "cancelled", 60000);
      const last = await stoppedCard(app, d.id);
      return `job ${d.id}: ${app.tr("Stop")} pressed ${when} (${at} s after Start, ${was})${asked ? `, "${asked}" confirmed` : ""}; cancelled ${took} s later, `
        + `card "${card.why}" with "${card.resume}" / "${card.retry}"; Home chip "${chip}"; "${again.resume}" → ${resumed}, "${back}" then "${title}"; `
        + `stopped again → "${last.why}"`;
    } },

  { name: "stop an erase", looks: ["#tabErase", "#erasePane"],
    async run(app, ctx) {
      const r = ctx.state.run;
      if (!r) throw new Error("step 1 did not run");
      await lineEmpty(app);
      r.draft = await newDraft(app, ctx, "d");
      await app.click('#leftTabs [data-tab="erase"]');
      await app.waitFor("the box on the video", 15000, shown, "#eraseBox");
      await app.waitFor(`${app.tr("Erase")} to light (the subtitles found)`, 90000, pressable, "#eraseRunBtn");
      const box = await app.inPage(textOf, "#eraseBox b");
      await lineEmpty(app);
      const t0 = Date.now();
      await app.click("#eraseRunBtn");
      const job = await jobOf(app, "erase", r.draft);
      await reaches(app, job.id, "running", 15000);
      await app.click("#eraseCancelBtn", 20000);
      const pressed = since(t0);
      const label = await app.inPage(textOf, "#eraseCancelBtn");
      await reaches(app, job.id, "cancelled", 60000);
      const took = since(t0);
      const said = await app.waitFor("the tab to say it was cancelled", 10000, () => !document.querySelector("#eraseBackBtn").hidden
        && document.querySelector("#eraseState").textContent.trim());
      await app.shot("running-erase-cancelled");
      if (said !== app.tr("Erasing was cancelled.")) throw new Error(`the tab says "${said}"`);
      await app.click("#eraseBackBtn");
      await app.waitFor("the box again", 10000, () => {
        const b = document.querySelector("#eraseBox");
        return b.getClientRects().length > 0 && !b.hidden && !document.querySelector("#eraseRunBtn").hidden;
      });
      return `box "${box}" → "${app.tr("Erase")}" → "${label}" at ${pressed} s (running) → job ${job.id} cancelled ${took} s in; "${said}"; `
        + `${app.tr("Back")} → the box and "${await app.inPage(textOf, "#eraseRunBtn")}" again`;
    } },

  { name: "Gemini with no key", looks: ["#keyOverlay", "#draftSetup"],
    async run(app, ctx) {
      const engines = await app.api("/api/engines");
      if (engines.gemini_available) throw new Error("this kit has a Gemini key saved; the step needs none");
      const r = ctx.state.run;
      if (!r) throw new Error("step 1 did not run");
      const onSetup = () => !document.querySelector("#draftSetup").hidden && !document.querySelector("#draftStartBtn").disabled;
      if (r.draft && (await app.inPage(pressable, '#leftTabs [data-tab="dubbing"]'))) {
        await app.click('#leftTabs [data-tab="dubbing"]');
        await app.waitFor("the Before dubbing card", 10000, onSetup).catch(() => {});
      }
      if (!(await app.inPage(onSetup))) await newDraft(app, ctx, "e");
      const was = await app.js(`document.querySelector("#translateSelect").value`);
      await app.click("#translateSelectBtn");
      const opts = await app.waitFor("the Translation list", 15000, () => {
        const list = document.querySelector("#translateSelectBtn").parentElement.querySelector(".model-pick-list");
        return list && [...list.querySelectorAll(".model-opt")].map((o) => o.dataset.value);
      });
      if (!opts.includes("gemini")) throw new Error(`the Translation list has no Gemini API (${opts.join("/")})`);
      await app.click('#translateSelectBtn ~ .model-pick-list .model-opt[data-value="gemini"]');
      const opened = await app.waitFor("the key window, or Gemini picked", 15000, () => (document.querySelector("#keyOverlay").classList.contains("open") ? "key"
        : document.querySelector("#translateSelect").value === "gemini" ? "picked" : ""));
      if (opened !== "key") throw new Error("Gemini API was picked with no key and no key window opened");
      const title = await app.inPage(textOf, "#keyTitle");
      await app.shot("running-gemini-key");
      await app.key("Escape");
      await app.waitFor(`the key window to close and ${was} back`, 10000, (v) => !document.querySelector("#keyOverlay").classList.contains("open")
        && document.querySelector("#translateSelect").value === v, was);
      if (title !== app.tr("Google (Gemini) key")) throw new Error(`the key window is titled "${title}"`);
      return `Gemini API with no key → "${title}" window, so no dub can start and fail: the failure card's `
        + `"${app.tr("Try again")}" / "${app.tr("Open Settings")}" are not reachable this way (skipped); Escape → ${was} again, nothing typed`;
    } },

  { name: "tidy up", looks: ["#projectsGrid", "#deleteOverlay"],
    async run(app, ctx) {
      const r = ctx.state.run;
      if (!r) throw new Error("step 1 did not run");
      await app.inPage((k, v) => { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); return true; }, CHOICES_KEY, r.choices);
      await toHome(app);
      // This run's, and any an earlier run of the area left behind.
      const mine = async () => (await app.api("/api/dub/jobs")).jobs.filter((j) => nameOf(j).startsWith(AREA_PREFIX));
      // Anything of this area's still in line is taken out with its row's X.
      let stopped = 0;
      for (const j of (await mine()).filter((x) => LIVE.includes(x.status) && x.status !== "cancelling")) {
        await app.waitFor("the Up next rows", 10000, (n) => [...document.querySelectorAll("#queueRows .queue-line")]
          .some((l) => l.querySelector(".q-name").textContent.startsWith(n)), nameOf(j));
        const i = await app.inPage((n) => [...document.querySelectorAll("#queueRows .queue-line")].findIndex((l) => l.querySelector(".q-name").textContent.startsWith(n)), nameOf(j));
        await app.click(`#queueRows .queue-line:nth-child(${i + 1}) .queue-x`);
        if (await app.waitFor("the stop question", 3000, isOpen, "#cancelDubOverlay").catch(() => false)) await app.click("#cancelDubConfirmBtn");
        await until(`job ${j.id} to stop`, 60000, async () => !LIVE.includes((await getJob(app, j.id)).status));
        stopped += 1;
      }
      const made = (await mine()).filter((j) => nameOf(j).startsWith(r.prefix)).length;
      const older = (await mine()).length - made;
      const peak = await app.js(`document.querySelectorAll("#projectsGrid .proj-card").length`);
      // Each card of this area's: ... → Delete → Delete.
      let deleted = 0;
      for (let sel = await app.inPage(cardOf, AREA_PREFIX); sel; sel = await app.inPage(cardOf, AREA_PREFIX)) {
        if (deleted > 20) throw new Error("more than 20 cards to delete; something keeps coming back");
        // Its ... shows on a card that has the pointer or the focus: the focus, as Tab gives it,
        // with the card in the middle of the window so its menu has room under it.
        await app.inPage((x) => { const c = document.querySelector(`#projectsGrid .proj-card${x}`); c.scrollIntoView({ block: "center" }); c.focus(); return true; }, sel);
        await app.click(`#projectsGrid .proj-card${sel} .proj-more`);
        await app.waitFor("the card menu", 5000, () => !document.querySelector("#projectCardMenu").hidden);
        await app.click("#projectMenuDelete");
        if (await app.waitFor("the delete question", 3000, isOpen, "#deleteOverlay").catch(() => false)) {
          await app.click("#deleteConfirmBtn");
          await app.waitFor("the delete question to close", 15000, isClosed, "#deleteOverlay");
        }
        await app.waitFor("the card to go", 15000, (x) => !document.querySelector(`#projectsGrid .proj-card${x}`), sel);
        deleted += 1;
      }
      const after = await app.js(`document.querySelectorAll("#projectsGrid .proj-card").length`);
      const still = await mine();
      if (still.length) throw new Error(`${still.length} job(s) of this area are still listed: ${still.map((j) => `${j.id} ${j.status}`).join(", ")}`);
      await toHome(app);
      return `${made} job(s) made${older ? ` (+${older} left by an earlier run)` : ""}, ${stopped} taken out of line here; cards ${r.cardsBefore ?? "?"} at the start, ${peak} before tidying, `
        + `${deleted} deleted → ${after}; none of this area's left; Home, no dialog`;
    } },
];
