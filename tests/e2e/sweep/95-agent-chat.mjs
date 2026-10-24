// The sweep's Dub Agent chat: the conversation itself, on the newest finished
// e2e- dub, once with Claude and once with Codex (AGENTS.md: every agent
// feature runs on both). Each pass picks its assistant in the model menu, asks
// a question that needs no tool, has line 2 rewritten through the chat and put
// back, stops a long turn, asks for a model download, reads the log for
// anything that should not be there, and starts a new conversation. The
// original pick goes back at the end.
//
// The turns use the owner's own sign-ins and cost no Perso credits; a model's
// Download button is counted, never pressed; a sign-in is never started.
// Notes never carry an account address or a home folder's name.
import { onHome, shown, sleep, Skip } from "../lib/cdp.mjs";

export const area = "agent";

const PICK_KEY = "persodub.assistantChoice";
const CLAUDE_LABELS = { fable: "Fable", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };
const NEW_TEXT = "시험 문장이에요";
// The models download_model can offer (its docstring), smallest first when one is missing.
const OFFERABLE = ["whisper", "qwen3-tts", "gemma", "hunyuan"];

const row2 = `#scriptBox .sc-row[data-line="2"] .sc-dst`;
const script = (app, jid) => app.api(`/api/dub/jobs/${jid}/script`).then((d) => d.lines || []);
const secs = (t0) => ((Date.now() - t0) / 1000).toFixed(1);
// An address or a home folder never goes into a note; an answer is trimmed to 80.
const clean = (s) => String(s).replace(/[^\s@"'<>]+@[^\s@"'<>]+\.[A-Za-z]{2,}/g, "<account>").replace(/\/Users\/[^/\s]+/g, "~")
  .replace(/[A-Za-z]:\\Users\\[^\\\s]+/gi, "~");
const said = (s) => { const c = clean(s).replace(/\s+/g, " ").trim(); return c.length > 80 ? `${c.slice(0, 79)}…` : c; };
const turnOn = () => document.body.dataset.agentTurn === "on";

// The finished dub on screen with the conversation open, and no turn on air.
async function ready(app, s) {
  if (!s || !s.jobId) throw new Error("no finished dub was opened in the first step");
  const here = await app.inPage((jid) => document.body.dataset.screen === "done" && document.body.dataset.jobId === jid, s.jobId);
  if (!here) {
    if (!(await app.inPage(onHome))) await app.click("#homeBtn");
    await app.waitFor("the Home screen", 10000, onHome);
    await app.click(`#projectsGrid .proj-card[data-job="${s.jobId}"]`, 20000);
    await app.waitFor("the finished dub and its table", 20000, (jid) => document.body.dataset.screen === "done"
      && document.body.dataset.jobId === jid && document.querySelectorAll("#scriptBox .sc-row:not(.head)").length > 0, s.jobId);
  }
  if (!(await app.inPage(() => document.body.classList.contains("agent-open")))) await app.click("#paneAgent");
  await app.waitFor("the conversation to show", 5000, shown, "#assistantLog");
  if (await app.inPage(turnOn)) {
    await app.click("#assistantGo");
    await app.waitFor("the turn left on air to stop", 15000, () => document.body.dataset.agentTurn !== "on");
  }
}

// The pick as the page keeps it.
const pickNow = (app) => app.inPage((k) => {
  try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; }
}, PICK_KEY);

// Through the menu the way a person picks: the assistant's row, then its model's
// row (`model` is the row's words, or "" for the first one that can be picked).
// A row is found by its place in the menu, which the menu redraws as answers land.
const rowAt = (w, models) => {
  const kids = [...document.querySelector("#assistantMenu").children];
  if (!!kids[0]?.querySelector(".menu-back") !== models) return 0;
  return 1 + kids.findIndex((k) => k.matches("button.menu-item") && !k.disabled
    && (!w || k.querySelector(".menu-name").firstChild.nodeValue.trim() === w));
};
async function pick(app, vendor, model) {
  if (await app.inPage(() => document.querySelector("#assistantMenu").hidden)) await app.click("#assistantModelBtn");
  const v = await app.waitFor(`${vendor} in the model menu`, 10000, rowAt, vendor, false);
  await app.click(`#assistantMenu > :nth-child(${v})`);
  // Codex not signed in opens the ChatGPT sign-in instead of its models:
  // closed with its Cancel, never signed in, and the pass skipped.
  const opened = await app.waitFor(`${vendor}'s models`, 30000, () => document.querySelector("#chatgptSignInOverlay").classList.contains("open")
    ? "sign-in" : !!document.querySelector("#assistantMenu .menu-back"));
  if (opened === "sign-in") {
    await app.click("#csCancel");
    await app.waitFor("the sign-in window to close", 5000, (s) => !document.querySelector(s).classList.contains("open"), "#chatgptSignInOverlay");
    throw new Skip(`${vendor} not signed in: its row opened the ChatGPT sign-in, closed with ${app.tr("Cancel")}`);
  }
  const m = await app.waitFor(`${model || "a model that can be picked"} among ${vendor}'s`, 30000, rowAt, model, true);
  const name = await app.inPage((i) => document.querySelector(`#assistantMenu > :nth-child(${i}) .menu-name`).firstChild.nodeValue.trim(), m);
  await app.click(`#assistantMenu > :nth-child(${m})`);
  await app.waitFor("the menu to close", 5000, () => document.querySelector("#assistantMenu").hidden);
  return { name, label: await app.inPage(() => document.querySelector("#assistantModelLabel").textContent.trim()) };
}

// A message typed and sent with the send button; the log's length before it.
async function send(app, text) {
  const before = await app.inPage(() => document.querySelector("#assistantLog").children.length);
  await app.type("#assistantInput", text);
  await app.click("#assistantGo");
  await app.waitFor("the message to go", 5000, () => document.body.dataset.agentTurn === "on");
  return { before, t0: Date.now() };
}

// What the turn put in the log after `before`.
const logSince = (app, before) => app.inPage((i) => {
  const kids = [...document.querySelector("#assistantLog").children].slice(i);
  const words = (k) => k.textContent.replace(/\s+/g, " ").trim();
  return { me: kids.filter((k) => k.matches(".bubble.me")).length,
           ai: kids.filter((k) => k.matches(".bubble.ai")).map(words),
           chips: kids.filter((k) => k.matches(".chip")).map(words),
           errors: kids.filter((k) => k.matches(".assistant-err")).map(words),
           stopped: kids.filter((k) => k.matches(".assistant-stopped")).length,
           cards: kids.filter((k) => k.matches(".offer-card")).map((c) => ({
             title: words(c.querySelector(".offer-title")),
             download: [...c.querySelectorAll("button.btn-primary")].length })) };
}, before);

// The turn to its end, within `ms` of sending; throws on an error line. An
// answer that asks about Perso credits is told no.
async function finish(app, sent, ms, what) {
  await app.waitFor(`${what} to finish`, Math.max(1000, ms - (Date.now() - sent.t0)), () => document.body.dataset.agentTurn !== "on");
  const took = secs(sent.t0);
  const got = await logSince(app, sent.before);
  if (got.errors.length) throw new Error(`${what}: the log says "${said(got.errors.join(" / "))}" after ${took} s`);
  if (!got.ai.length) throw new Error(`${what}: no answer in the log after ${took} s`);
  if (/크레딧|credit/i.test(got.ai.join(" "))) {
    const no = await send(app, "아니요, Perso는 쓰지 마세요.");
    await app.waitFor("the no to Perso to be answered", 60000, () => document.body.dataset.agentTurn !== "on");
    got.perso = (await logSince(app, no.before)).ai.join(" ");
  }
  return { ...got, took, answer: got.ai.join(" ") };
}

const cellText = (app) => app.inPage((s) => (document.querySelector(s)?.textContent || "").trim(), row2);

// Line 2 back to `text` the way the table saves an edit, when the chat did not.
async function putBack(app, jid, text) {
  await app.api(`/api/dub/jobs/${jid}/script/2`, { method: "POST", headers: { "Content-Type": "application/json" },
                                                     body: JSON.stringify({ text }) });
}

function pass(who) {
  const s = (ctx) => ctx.state.agent;
  const steps = [
    { name: `${who}: pick the model`, looks: ["#assistantMenu", "#assistantModelWrap"],
      async run(app, ctx) {
        await ready(app, s(ctx));
        const before = await app.inPage(() => document.querySelector("#assistantModelLabel").textContent.trim());
        let got;
        try {
          got = who === "Claude" ? await pick(app, "Claude", "Opus") : await pick(app, "Codex", "");
        } catch (e) {
          if (e instanceof Skip) s(ctx).out = { ...s(ctx).out, [who]: e.message };
          throw e;
        }
        const p = await pickNow(app);
        const id = who === "Claude" ? "claude" : "codex";
        if (!p || p.agent !== id) throw new Error(`the saved pick is ${JSON.stringify(p)}, not ${id}`);
        if (!got.label.startsWith(who)) throw new Error(`the label says "${got.label}" after picking ${who} · ${got.name}`);
        s(ctx).model = got.name;
        return `label "${before}" → "${got.label}" (picked ${who} · ${got.name}; saved ${p.agent}/${p.model})`;
      } },

    { name: `${who}: ask a question`, looks: ["#assistantLog"],
      async run(app, ctx) {
        await ready(app, s(ctx));
        const sent = await send(app, "이 대본은 몇 줄이야?");
        const got = await finish(app, sent, 90000, "the question");
        // One reply, though Codex says what it is about to do in a bubble of its own before the step.
        if (got.me !== 1) throw new Error(`${got.me} messages went for one press`);
        if (!/3|세\s?줄|셋|three/i.test(got.answer)) throw new Error(`the answer does not say 3: "${said(got.answer)}"`);
        const label = await app.inPage(() => document.querySelector("#assistantModelLabel").textContent.trim());
        return `1 reply (${got.ai.length} bubble(s)) in ${got.took} s, ${got.chips.length} step(s), says 3; label "${label}": "${said(got.answer)}"`;
      } },

    { name: `${who}: line 2 through the chat`, looks: ["#scriptBox", "#assistantLog"],
      async run(app, ctx) {
        const st = s(ctx);
        await ready(app, st);
        const orig = (await script(app, st.jobId))[1].text;
        if (orig === NEW_TEXT) throw new Error(`line 2 already says "${NEW_TEXT}"; a run before left it`);
        await app.js("window.__e2eAgentMark = 'kept'");
        let restored = false;
        try {
          const sent = await send(app, `2번 줄 번역을 '${NEW_TEXT}'로 바꿔 줘`);
          await app.waitFor(`row 2 to say "${NEW_TEXT}"`, 120000, (sel, w) => (document.querySelector(sel)?.textContent || "").trim() === w, row2, NEW_TEXT);
          const shownAt = secs(sent.t0);
          const got = await finish(app, sent, 120000, "the change");
          const api = (await script(app, st.jobId))[1].text;
          if (api !== NEW_TEXT) throw new Error(`the table says "${NEW_TEXT}" but GET script says "${said(api)}"`);
          if ((await app.js("window.__e2eAgentMark || ''")) !== "kept") throw new Error("the page was reloaded");
          const sent2 = await send(app, `2번 줄 번역을 원래 문장 '${orig}'로 되돌려 줘`);
          await app.waitFor("row 2 to say its original words again", 120000, (sel, w) => (document.querySelector(sel)?.textContent || "").trim() === w, row2, orig);
          const backAt = secs(sent2.t0);
          const got2 = await finish(app, sent2, 120000, "the put-back");
          const api2 = (await script(app, st.jobId))[1].text;
          if (api2 !== orig) throw new Error(`the table is back but GET script says "${said(api2)}"`);
          restored = true;
          return `row 2 = "${NEW_TEXT}" ${shownAt} s after sending (turn ${got.took} s, steps ${got.chips.join(", ") || "none"}), GET script agrees, no reload; `
            + `put back to the original ${backAt} s after asking (turn ${got2.took} s), GET agrees: "${said(got.answer)}"`;
        } finally {
          if (!restored && (await script(app, st.jobId))[1].text !== orig) {
            if (await app.inPage(turnOn)) { await app.click("#assistantGo"); await sleep(3000); }
            await putBack(app, st.jobId, orig);
          }
        }
      } },

    { name: `${who}: stop a long turn`, looks: ["#assistantLog", "#assistantGo"],
      async run(app, ctx) {
        const st = s(ctx);
        await ready(app, st);
        const was = (await script(app, st.jobId)).map((l) => l.text);
        const sent = await send(app, "모든 줄을 다시 번역해 줘");
        await sleep(1000);
        const t1 = Date.now();
        const pressedAt = secs(sent.t0);
        await app.click("#assistantGo");
        await app.waitFor("the turn to stop", 10000, () => document.body.dataset.agentTurn !== "on");
        const stopIn = secs(t1);
        const got = await logSince(app, sent.before);
        const free = await app.inPage(() => !document.querySelector("#assistantInput").disabled
          && document.querySelector("#assistantGo").getAttribute("aria-label"));
        if (!got.stopped && !free) throw new Error(`no stopped line and the input is not free after ${stopIn} s`);
        await sleep(5000);
        const now = (await script(app, st.jobId)).map((l) => l.text);
        const changed = now.filter((t, i) => t !== was[i]).length;
        if (changed) throw new Error(`${changed} line(s) changed although the turn was stopped`);
        // Stop promises the next message carries on: one short one, answered and not stopped.
        const next = await send(app, "방금 건 취소할게. '네'라고만 답해 줘.");
        await app.waitFor("the next message to finish", 60000, () => document.body.dataset.agentTurn !== "on");
        const after = await logSince(app, next.before);
        const nextNote = `next message ${after.stopped ? "came back stopped" : after.ai.length ? "answered" : "had no answer"} in ${secs(next.t0)} s`;
        if (after.stopped || !after.ai.length || after.errors.length) {
          throw new Error(`Stop pressed ${pressedAt} s in worked (over ${stopIn} s later, script unchanged), but the ${nextNote}`
            + `${after.errors.length ? `: "${said(after.errors.join(" / "))}"` : ""}`);
        }
        return `Stop pressed ${pressedAt} s after sending, turn over ${stopIn} s later; stopped line ${got.stopped}, `
          + `button "${free}"; steps before the stop ${got.chips.length}; script unchanged 5 s later (${now.length} lines); `
          + `${nextNote}: "${said(after.ai.join(" "))}"`;
      } },

    { name: `${who}: Whisper download`, looks: ["#assistantLog"],
      async run(app, ctx) {
        await ready(app, s(ctx));
        const state = async () => ((await app.api("/api/models")).models.find((m) => m.id === "whisper") || {}).state;
        const was = await state();
        const sent = await send(app, "Whisper 모델 받아 줘");
        const got = await finish(app, sent, 90000, "the Whisper request");
        await sleep(3000);
        const cards = (await logSince(app, sent.before)).cards;
        const now = await state();
        if (now !== was) throw new Error(`whisper went from ${was} to ${now}`);
        const want = was === "ready" ? 0 : 1;
        if (cards.length !== want) throw new Error(`${cards.length} download card(s) with whisper ${was}, not ${want}`);
        return `whisper ${was} before and after; ${cards.length} download card(s)${was === "ready" ? " (already downloaded, so none)" : ", not pressed"} `
          + `in ${got.took} s, steps ${got.chips.join(", ") || "none"}: "${said(got.answer)}"`;
      } },

    { name: `${who}: download button`, looks: ["#assistantLog"],
      async run(app, ctx) {
        await ready(app, s(ctx));
        const rows = (await app.api("/api/models")).models;
        const m = rows.filter((r) => OFFERABLE.includes(r.id) && r.state === "not_downloaded").sort((a, b) => a.bytes - b.bytes)[0];
        if (!m) return `every model the chat can offer (${OFFERABLE.join(", ")}) is downloaded; no button to count`;
        const sent = await send(app, `${m.name} 모델 받아 줘`);
        const got = await finish(app, sent, 90000, `the ${m.name} request`);
        const cards = await app.waitFor("the download card", 10000, (i) => {
          const c = [...document.querySelector("#assistantLog").children].slice(i).filter((k) => k.matches(".offer-card"));
          return c.length ? c.map((k) => ({ title: k.querySelector(".offer-title").textContent.trim(),
                                           download: k.querySelectorAll("button.btn-primary").length })) : null;
        }, sent.before).catch(() => []);
        const buttons = cards.reduce((n, c) => n + c.download, 0);
        const now = ((await app.api("/api/models")).models.find((r) => r.id === m.id) || {}).state;
        if (now !== m.state) throw new Error(`${m.id} went from ${m.state} to ${now}`);
        if (cards.length !== 1 || buttons !== 1) throw new Error(`${cards.length} card(s) and ${buttons} Download button(s), not 1 and 1: "${said(got.answer)}"`);
        return `${m.id} (${(m.bytes / 1e9).toFixed(1)} GB): 1 card "${cards[0].title}" with 1 Download button, not pressed; `
          + `${m.id} still ${now}; ${got.took} s: "${said(got.answer)}"`;
      } },

    { name: `${who}: nothing leaks`, looks: ["#assistantLog"],
      async run(app, ctx) {
        await ready(app, s(ctx));
        const text = await app.inPage(() => document.querySelector("#assistantLog").innerText);
        const at = text.match(/@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g) || [];
        const tokens = text.match(/[A-Za-z0-9_\-+/=]{32,}/g) || [];
        if (at.length || tokens.length) throw new Error(`${at.length} "@domain" and ${tokens.length} long token(s) in the log`);
        return `${text.length} characters in the log: 0 "@domain", 0 tokens of 32+ characters`;
      } },

    { name: `${who}: New chat`, looks: ["#assistantLog", "#assistantNewChat"],
      async run(app, ctx) {
        await ready(app, s(ctx));
        const before = await app.inPage(() => document.querySelector("#assistantLog").children.length);
        await app.click("#assistantNewChat");
        const got = await app.waitFor("the log to be cleared", 5000, () => {
          const kids = [...document.querySelector("#assistantLog").children];
          return kids.length <= 1 ? { n: kids.length, said: kids.map((k) => k.textContent.trim()).join(" ") } : null;
        });
        const notice = app.tr("New conversation.");
        if (got.n === 1 && got.said !== notice) throw new Error(`the one line left says "${said(got.said)}"`);
        return `${before} lines → 0 from the conversation; ${got.n ? `the page's own notice "${notice}" is the only line` : "nothing left"}`;
      } },
  ];
  // The pass's other steps would talk to the assistant picked before: skipped with the pick's reason.
  return steps.map((step, i) => (i === 0 ? step : { ...step, async run(app, ctx) {
    const why = s(ctx).out?.[who];
    if (why) throw new Skip(why);
    return step.run(app, ctx);
  } }));
}

export const steps = [
  { name: "open the newest finished e2e- dub and the conversation", looks: ["#projectsGrid", "#agentStrip"], stopsArea: true,
    async run(app, ctx) {
      const st = ctx.state.agent = {};
      st.pick = await app.js(`localStorage.getItem(${JSON.stringify(PICK_KEY)})`);
      st.label = await app.inPage(() => document.querySelector("#assistantModelLabel").textContent.trim());
      const dialog = await app.js(`document.querySelector(".modal-overlay.open")?.id || ""`);
      if (dialog) throw new Error(`#${dialog} is open; the area starts with no dialog in the way`);
      if (!(await app.inPage(onHome))) await app.click("#homeBtn");
      await app.waitFor("the Home screen", 10000, onHome);
      const { jobs } = await app.api("/api/dub/jobs");
      // Only a dub Home has a card for: a dub that finished after Home last drew its grid has none yet.
      const cards = await app.inPage(() => [...document.querySelectorAll("#projectsGrid .proj-card[data-job]")].map((c) => c.dataset.job));
      const done = jobs.filter((j) => String(j.title || j.project || "").startsWith("e2e-") && j.kind === "dub"
        && j.status === "done" && j.dub_mode === "local" && cards.includes(j.id));
      let job = null;
      for (const j of done) {
        if ((await script(app, j.id)).length === 3) { job = j; break; }
      }
      if (!job) throw new Error(`no finished local e2e- dub of 3 lines among ${done.length}`);
      st.jobId = job.id;
      await app.click(`#projectsGrid .proj-card[data-job="${job.id}"]`, 20000);
      await app.waitFor("the finished dub and its table", 20000, (jid) => document.body.dataset.screen === "done"
        && document.body.dataset.jobId === jid && document.querySelectorAll("#scriptBox .sc-row:not(.head)").length === 3, job.id);
      await ready(app, st);
      return `"${job.title || job.project}" (job ${job.id}, ${job.translator}) open, 3 rows; conversation open; pick at start "${st.label}"`;
    } },
  ...pass("Claude"),
  ...pass("Codex"),
  { name: "put the pick back, close, Home", looks: ["#assistantModelWrap", "#screen-home"],
    async run(app, ctx) {
      const st = ctx.state.agent;
      await ready(app, st);
      let p = null;
      try { p = JSON.parse(st.pick || "null"); } catch { p = null; }
      p = p && p.agent ? p : { agent: "claude", model: "opus" };
      const vendor = p.agent === "claude" ? "Claude" : "Codex";
      await pick(app, vendor, p.agent === "claude" ? (CLAUDE_LABELS[p.model] || p.model) : p.model);
      // The saved words exactly as they were, or none, as at the start.
      await app.inPage((k, v) => { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); return true; }, PICK_KEY, st.pick);
      const label = await app.inPage(() => document.querySelector("#assistantModelLabel").textContent.trim());
      await app.click("#paneAgent");
      await app.waitFor("the conversation to fold", 5000, () => !document.body.classList.contains("agent-open"));
      await app.click("#homeBtn");
      await app.waitFor("Home", 10000, onHome);
      await app.waitFor("the panel to be off Home", 5000, () => !document.querySelector("#agentStrip").getClientRects().length);
      return `picked ${vendor} · ${p.model} again, label "${label}" (was "${st.label}"), saved pick restored; conversation folded, on Home, panel closed`;
    } },
];
