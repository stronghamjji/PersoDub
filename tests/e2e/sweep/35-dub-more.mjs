// The finished-dub screen's remaining controls, on the newest local e2e- dub
// (picked as 30-dub.mjs picks it): the engine line, reverting an edited line,
// Retranslate unfit lines with nothing ticked, a line's block on the timeline, the
// timeline's fit, fold and height, a subtitle block's end, the video pane's
// width, a 9:16 download, the social media preview, renaming by the title,
// the subtitle staying at the foot when dragged, the tab row, and the Erase
// tab inside a dub. Everything stays on this computer, and every value changed is put
// back: by the same control where one does it, and at the end, from what
// step 1 read, for what no control can undo (a retimed subtitle's entry).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { sleep, shown, pressable, isOpen, isClosed, onHome, textOf } from "../lib/cdp.mjs";
import { translatorLabel } from "../../../ui/src/dubApi.mjs";

export const area = "dub2";

// What the area changes in the page's storage, put back at its end.
const KEYS = ["persodub.layout.timelineOpen", "persodub.layout.timelineHeight", "persodub.layout.videoWidth",
              "persodub.exportTicks", "persodub.exportAudio"];
const FFPROBE = process.env.PERSODUB_FFPROBE || "ffprobe";
const EDIT = "여기가 파리에서 제일 멋진 풍경이라고요.";
const RENAMED = "e2e-dub-renamed";

const row = (n) => `#scriptBox .sc-row[data-line="${n}"]`;
// The script as the server has it. Asked again for a moment when it answers
// with no lines: a read that lands while a save rewrites the file does.
async function script(app, jid) {
  for (let i = 0; ; i++) {
    const lines = (await app.api(`/api/dub/jobs/${jid}/script`)).lines || [];
    if (lines.length || i >= 10) return lines;
    await sleep(300);
  }
}
const style = (app, jid) => app.api(`/api/dub/jobs/${jid}/subtitle_style`);
const view = (app, jid) => app.api(`/api/dub/jobs/${jid}/view`);
const secs = (t0) => ((Date.now() - t0) / 1000).toFixed(1);

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

// The middle of an element as drawn (or `fx` of the way across), and what a press there would land on.
const spot = (sel, fx = 0.5) => {
  const el = document.querySelector(sel);
  if (!el || !el.getClientRects().length) return null;
  const r = el.getBoundingClientRect();
  const x = r.left + r.width * fx, y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  return { x, y, w: r.width, h: r.height, top: r.top, bottom: r.bottom, ok: !!hit && (hit === el || el.contains(hit)),
           over: hit ? hit.tagName.toLowerCase() + (hit.id ? `#${hit.id}` : "") + [...hit.classList].map((c) => `.${c}`).join("") : "nothing" };
};
async function spotOf(app, sel, fx = 0.5) {
  const s = await app.inPage(spot, sel, fx);
  if (!s) throw new Error(`${sel} is not on the screen`);
  if (!s.ok) throw new Error(`${sel} is covered by ${s.over}`);
  return s;
}

// A press, moves and a release with the mouse, the way a hand drags.
async function drag(app, x, y, dx, dy) {
  const m = (type, px, py, buttons) => app.send("Input.dispatchMouseEvent", { type, x: px, y: py, button: "left", buttons, clickCount: 1 });
  await m("mousePressed", x, y, 1);
  await m("mouseMoved", x + dx / 2, y + dy / 2, 1);
  await m("mouseMoved", x + dx, y + dy, 1);
  await m("mouseReleased", x + dx, y + dy, 0);
}

// The ruler's seconds to pixels: two labels apart, by their times.
const rulerPps = () => {
  const spans = [...document.querySelectorAll("#timelineTrack .tl-ruler span")];
  if (spans.length < 2) return 0;
  const sec = (el) => el.textContent.trim().split(":").reduce((a, b) => a * 60 + Number(b), 0);
  const [a, b] = spans;
  return (parseFloat(b.style.left) - parseFloat(a.style.left)) / (sec(b) - sec(a));
};

const putBack = (app, key, v) => app.inPage((k, val) => {
  if (val === null) localStorage.removeItem(k); else localStorage.setItem(k, val);
  return true;
}, key, v);

// The finished dub this area works on, on screen: reopened from its card when
// an earlier step left it (a failure, Home).
async function onDub(app, s) {
  if (!s || !s.jobId) throw new Error("no finished dub was opened in step 1");
  const here = await app.inPage((jid) => document.body.dataset.screen === "done" && document.body.dataset.jobId === jid
    && document.querySelectorAll("#scriptBox .sc-row:not(.head)").length > 0, s.jobId);
  if (here) return;
  await tidy(app);
  if (!(await app.inPage(onHome))) await app.click("#homeBtn");
  await app.waitFor("the Home screen", 10000, onHome);
  await app.click(`#projectsGrid .proj-card[data-job="${s.jobId}"]`, 20000);
  await app.waitFor("the finished dub and its table", 20000, (jid) => document.body.dataset.screen === "done"
    && document.body.dataset.jobId === jid && document.querySelectorAll("#scriptBox .sc-row:not(.head)").length > 0, s.jobId);
}

// Anything a failed step may have left open: the Download dialog, a menu, the rename field, another tab.
async function tidy(app) {
  if (await app.inPage(isOpen, "#exportOverlay")) {
    await app.click("#exportCloseBtn", 120000);
    await app.waitFor("the Download dialog to close", 5000, isClosed, "#exportOverlay");
  }
  if (await app.inPage(() => !document.querySelector("#ratioMenu").hidden || !document.querySelector("#previewMenu").hidden)) await app.key("Escape");
  if (await app.inPage(shown, "#topbarRename")) await app.key("Escape");
  const tab = await app.inPage(() => document.querySelector("#leftTabs [aria-selected=true]")?.dataset.tab || "");
  if (tab && tab !== "dubbing" && (await app.inPage(pressable, '#leftTabs [data-tab="dubbing"]'))) await app.click('#leftTabs [data-tab="dubbing"]');
}

// A press on a button the table may still be laying out (the notice above it
// lands after the rows): tried again while something else is where it was.
async function pressSettled(app, sel) {
  for (let i = 0; ; i++) {
    try { return await app.click(sel); } catch (e) {
      if (i >= 5 || !/is covered by/.test(e.message)) throw e;
      await sleep(400);
    }
  }
}

// The words of `n` typed over line n's translation, and Enter.
async function typeLine(app, n, text) {
  const cell = `${row(n)} .sc-dst`;
  await app.click(cell);
  await app.inPage((sel) => { const el = document.querySelector(sel); el.focus(); getSelection().selectAllChildren(el); return true; }, cell);
  await app.send("Input.insertText", { text });
  await app.key("Enter");
}

// The video still on a line's start, the dubbed file on the player, so a subtitle is on the picture.
async function atLine(app, n) {
  if (!(await app.inPage(() => document.querySelector("#vtabDubbed").classList.contains("active")))) {
    await app.click("#vtabDubbed");
    await app.waitFor("the dubbed video", 10000, () => document.querySelector("#vtabDubbed").classList.contains("active")
      && document.querySelector("#doneVideo").readyState >= 2);
  }
  if (!(await app.inPage(() => document.querySelector("#doneVideo").paused))) await app.click("#playToggle");
  await app.click(`${row(n)} .sc-time`);
  // Not while it still seeks: the subtitle on the picture is the old spot's until it lands.
  await app.waitFor(`the video at line ${n}`, 5000, (sel) => !document.querySelector("#doneVideo").seeking
    && Math.abs(document.querySelector("#doneVideo").currentTime - +document.querySelector(sel).dataset.start) < 0.05, row(n));
}

// Download pressed: waits for it to come back, the saved rows and the line under them.
async function download(app, ms) {
  await app.click("#exportGoBtn");
  await app.waitFor("Download to start", 5000, () => document.querySelector("#exportGoBtn").disabled);
  return app.waitFor("the download to finish", ms, () => document.querySelector("#exportGoBtn").disabled ? null
    : { saved: [...document.querySelectorAll("#exportList a.saved")].map((a) => a.dataset.row),
        where: document.querySelector("#exportWhere").textContent.trim() });
}

export const steps = [
  { name: "open a finished local dub", looks: ["#projectsGrid", "#scriptBox"], stopsArea: true,
    async run(app, ctx) {
      const s = ctx.state.dub2 = { saved: {} };
      for (const k of KEYS) s.saved[k] = await app.js(`localStorage.getItem(${JSON.stringify(k)})`);
      const dialog = await app.js(`document.querySelector(".modal-overlay.open")?.id || ""`);
      if (dialog) throw new Error(`#${dialog} is open; the area starts with no dialog in the way`);
      if (!(await app.inPage(onHome))) await app.click("#homeBtn");
      await app.waitFor("the Home screen", 10000, onHome);
      // Projects as Home groups them, newest first, as 30-dub.mjs picks: one language, 3 lines.
      const { jobs } = await app.api("/api/dub/jobs");
      const groups = new Map();
      for (const j of jobs) {
        const k = j.project_id || j.id;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(j);
      }
      const named = [...groups.values()].filter((m) => String(m[0].title || m[0].project || "").startsWith("e2e-"));
      const done = named.filter((m) => m.length === 1 && m[0].kind === "dub" && m[0].status === "done" && m[0].dub_mode === "local");
      let job = null, lines = [];
      for (const [j] of done) {
        lines = await script(app, j.id);
        if (lines.length === 3) { job = j; break; }
      }
      if (!job) throw new Error(`no finished local e2e- dub of 3 lines in one language among ${named.length} e2e- projects`);
      // Another finished dub, opened at the end so the page reads the put-back subtitle style afresh.
      const other = done.map(([j]) => j).find((j) => j.id !== job.id);
      Object.assign(s, { jobId: job.id, job, other: other ? other.id : "", lines,
                         style: await style(app, job.id), view: await view(app, job.id) });
      await app.click(`#projectsGrid .proj-card[data-job="${job.id}"]`, 20000);
      const n = await app.waitFor("the finished dub and its table", 20000, (jid) => document.body.dataset.screen === "done"
        && document.body.dataset.jobId === jid && document.querySelectorAll("#scriptBox .sc-row:not(.head)").length, job.id);
      if (n !== 3) throw new Error(`the table has ${n} rows, not 3`);
      return `card "${job.title || job.project}" (job ${job.id}, ${job.language_code}, local, ${job.translator}) opened: ${n} rows; `
        + `newest of ${done.length} one-language local e2e- dubs`;
    } },

  { name: "D14 what made it", looks: ["#dubbingPaneHead", "#scriptJobNote"],
    async run(app, ctx) {
      const s = ctx.state.dub2;
      await onDub(app, s);
      const job = await app.api(`/api/dub/jobs/${s.jobId}`);
      const got = await app.waitFor("the translator beside Script and the engine line under it", 10000, () => {
        const by = document.querySelector("#scriptModel").textContent.trim();
        const note = document.querySelector("#scriptJobNote");
        return by && !note.hidden && note.textContent.trim() ? { by, note: note.textContent.trim() } : null;
      });
      if (!got.by.toLowerCase().includes(String(job.translator).toLowerCase())) throw new Error(`#scriptModel says "${got.by}", the job's translator is ${job.translator}`);
      // The model as the page names it (ui/src/dubApi.mjs): its id in brackets
      // ("ChatGPT (gpt-5.6-luna)"), or a name that says it ("Hunyuan 1.8B" for hy-mt2:1.8b).
      const want = `${app.tr("Translation")} ${translatorLabel(job)}`;
      if (got.by !== want) throw new Error(`#scriptModel says "${got.by}", not "${want}" for ${job.translator} ${job.translator_model || "(no model)"}`);
      const [langs, ...engines] = got.note.split(" · ");
      if (!langs.includes("→")) throw new Error(`the engine line starts "${langs}", not the two languages`);
      if (engines.length < 3) throw new Error(`the engine line names ${engines.length} engines: "${got.note}"`);
      return `#scriptModel "${got.by}" (job translator ${job.translator}, ${job.translator_model || "no model"}); `
        + `engine line "${got.note}": languages + ${engines.length} parts`;
    } },

  { name: "D3 revert line 2", looks: ["#scriptBox", "#scriptSaving"],
    async run(app, ctx) {
      const s = ctx.state.dub2;
      await onDub(app, s);
      const before = (await script(app, s.jobId))[1];
      if (before.edited) throw new Error(`line 2 is hand-edited already ("${before.text}", the translation "${before.was}")`);
      const text = EDIT === before.text ? `${EDIT} 네` : EDIT;
      await typeLine(app, 2, text);
      const edited = await until("line 2 saved with the new words", 10000, async () => {
        const l = (await script(app, s.jobId))[1];
        return l.text === text ? l : null;
      });
      await app.waitFor("line 2's revert button", 10000, (sel) => !!document.querySelector(sel), `${row(2)} .sc-undo[data-undo="2"]`);
      const t0 = Date.now();
      await app.click(`${row(2)} .sc-undo[data-undo="2"]`);
      const after = await until("line 2 back to its translation", 10000, async () => {
        const l = (await script(app, s.jobId))[1];
        return l.text === before.text && !l.edited ? l : null;
      });
      await app.waitFor("the row to show the translation again", 10000, (sel, w) => document.querySelector(sel).textContent === w
        && !document.querySelector(`${sel.replace(" .sc-dst", "")} .sc-undo`), `${row(2)} .sc-dst`, before.text);
      if (after.voice_stale !== before.voice_stale) throw new Error(`voice_stale ${before.voice_stale} → ${after.voice_stale} after the revert`);
      return `line 2 "${before.text}" → "${text}" (edited ${edited.edited}, voice_stale ${edited.voice_stale}); `
        + `revert pressed: API text = the translation again in ${secs(t0)} s, edited false, voice_stale ${after.voice_stale}`;
    } },

  { name: "D7 retranslate the unfit lines", looks: ["#scriptBox", "#scriptSaving"],
    async run(app, ctx) {
      const s = ctx.state.dub2;
      await onDub(app, s);
      const before = await script(app, s.jobId);
      // Nothing ticked: only the lines that do not fit (red on their row) go.
      if (await app.inPage(() => document.querySelectorAll("#scriptBox .sc-pick[data-pick]:checked").length)) {
        throw new Error("lines are ticked before Translate again; it would translate those only");
      }
      const count = await app.inPage(textOf, "#scriptPickCount");
      if (count) throw new Error(`"${count}" beside Script with nothing ticked`);
      const unfit = await app.inPage(() => document.querySelectorAll("#scriptBox .sc-len.sc-v-over").length);
      const rests = await app.inPage(() => document.querySelector("#retranslateBtn").disabled);
      // Every line fits: the button rests, and its title says to tick lines.
      if (!unfit) {
        if (!rests) throw new Error("every line fits and nothing is ticked, yet the button can be pressed");
        const title = await app.inPage(() => document.querySelector("#retranslateBtn").title);
        const want = app.tr("No line's length is off (marked red). Select the lines you want translated again.");
        if (!title.endsWith(want)) throw new Error(`the resting button's title is "${title}"`);
        return `every line fits, nothing ticked: the button rests, title ends "${want}"`;
      }
      if (rests) throw new Error(`${unfit} line(s) do not fit, yet the button rests`);
      const asks = [app.tr("1 line you edited will be replaced by the new translation too. Press again to go ahead."),
        ...[2, 3].map((n) => app.tr("{n} lines you edited will be replaced by the new translation too. Press again to go ahead.", { n }))];
      // The page's own word for it while it works: as many lines as are red.
      const rx = (w) => new RegExp(`^${w.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace("{with}", ".+").replace("{n}", String(unfit))}$`);
      const allLines = unfit === 1 ? [rx(app.tr("Translating 1 line {with}…")), rx(app.tr("Translating 1 line…"))]
        : [rx(app.tr("Translating {n} lines {with}…")), rx(app.tr("Translating {n} lines…"))];
      const t0 = Date.now();
      await app.click("#retranslateBtn");
      let presses = 1;
      let said = await app.waitFor("Translate again to start or ask", 10000, (w) => {
        const text = document.querySelector("#scriptSaving").textContent.trim();
        return w.includes(text) ? `ask:${text}` : document.querySelector("#retranslateBtn").disabled && text ? `going:${text}` : "";
      }, asks);
      if (said.startsWith("ask:")) {
        await app.click("#retranslateBtn");
        presses = 2;
        said = await app.waitFor("Translate again to start", 10000, () => {
          const text = document.querySelector("#scriptSaving").textContent.trim();
          return document.querySelector("#retranslateBtn").disabled && text ? `going:${text}` : "";
        });
      }
      const going = said.slice(6);
      if (!allLines.some((r) => r.test(going))) throw new Error(`Translate again with nothing ticked said "${going}", not the ${unfit} unfit line(s)`);
      // Done once the working words are gone (the button may rest after: no
      // line left that does not fit).
      const end = await app.waitFor("Translate again to finish", 120000, (w) => {
        const text = document.querySelector("#scriptSaving").textContent.trim();
        return text === w ? null : text || "(cleared)";
      }, going);
      const after = await script(app, s.jobId);
      const changed = after.filter((l, i) => l.text !== before[i].text).map((l) => l.line);
      const n = changed.length;
      const want = !n ? app.tr("Same words. Nothing changed.") : n === 1 ? app.tr("1 line translated again. Press Remake voices to hear it.")
        : app.tr("{n} lines translated again. Press Remake voices to hear them.", { n });
      if (end !== "(cleared)" && end !== want) throw new Error(`the page says "${end}", the server changed ${n} line(s)`);
      // Back to the words it had: Revert on each line that changed (or the old words typed, for a line that was hand-edited).
      for (const ln of changed) {
        const was = before[ln - 1];
        if (was.edited) await typeLine(app, ln, was.text);
        else {
          await app.waitFor(`line ${ln}'s revert button`, 10000, (sel) => !!document.querySelector(sel), `${row(ln)} .sc-undo`);
          await pressSettled(app, `${row(ln)} .sc-undo`);
        }
        await until(`line ${ln} back to "${was.text}"`, 10000, async () => (await script(app, s.jobId))[ln - 1].text === was.text);
      }
      const back = await script(app, s.jobId);
      const off = back.filter((l, i) => l.text !== before[i].text || l.voice_stale !== before[i].voice_stale).map((l) => l.line);
      if (off.length) throw new Error(`line(s) ${off.join(", ")} did not come back as they were`);
      return `nothing ticked, ${unfit} unfit, ${presses} press(es)${presses === 2 ? " (hand-edited lines asked first)" : ""}; page said "${going}"; `
        + `${changed.length} of 3 lines changed in ${secs(t0)} s (${changed.map((ln) => `${ln}: "${before[ln - 1].text}" → "${after[ln - 1].text}"`).join("; ") || "same words"}); `
        + `end "${end}"; reverted ${changed.length}, script and voice_stale as before`;
    } },

  { name: "T3 a line's block plays it", looks: ["#timeline", "#videoPane"],
    async run(app, ctx) {
      const s = ctx.state.dub2;
      await onDub(app, s);
      const l = (await script(app, s.jobId))[1];
      const blk = `#timeline .tl-lane-dub .tl-blk[data-start="${l.start}"]`;
      await app.inPage(() => {
        const v = document.querySelector("#doneVideo");
        window.__e2eSeek = null;
        v.addEventListener("seeked", () => { window.__e2eSeek = v.currentTime; }, { once: true });
        return true;
      });
      await app.click(blk);
      const at = await app.waitFor("the seek the block makes", 5000, () => (window.__e2eSeek == null ? null : { t: window.__e2eSeek }));
      const played = await app.waitFor("the video to play", 3000, () => !document.querySelector("#doneVideo").paused
        ? { src: document.querySelector("#doneVideo").getAttribute("src") } : null);
      await sleep(500);
      if (await app.inPage(() => !document.querySelector("#doneVideo").paused)) await app.click("#playToggle");
      await app.waitFor("the video to pause", 3000, () => document.querySelector("#doneVideo").paused);
      if (Math.abs(at.t - l.start) > 0.05) throw new Error(`the block put the video at ${at.t.toFixed(3)} s, line 2 starts at ${l.start} s`);
      if (played.src.includes("/original")) throw new Error(`the dubbing lane's block played ${played.src}`);
      return `line 2's block in the dubbing lane (${l.start}-${l.end} s): seeked to ${at.t.toFixed(3)} s (±${Math.abs(at.t - l.start).toFixed(3)}), `
        + `played the dubbed file, then paused`;
    } },

  { name: "T2 fit, fold, height", looks: ["#timeline"],
    async run(app, ctx) {
      const s = ctx.state.dub2;
      await onDub(app, s);
      const dur = await app.js(`document.querySelector("#doneVideo").duration`);
      await app.click("#tlZoomFit");
      const fit = await app.waitFor("the whole video in view", 5000, (d) => {
        const track = document.querySelector("#timelineTrack");
        const clip = document.querySelector("#timelineTrack .tl-lane-video .tl-vclip");
        const pps = (() => {
          const spans = [...document.querySelectorAll("#timelineTrack .tl-ruler span")];
          if (spans.length < 2) return 0;
          const sec = (el) => el.textContent.trim().split(":").reduce((a, b) => a * 60 + Number(b), 0);
          return (parseFloat(spans[1].style.left) - parseFloat(spans[0].style.left)) / (sec(spans[1]) - sec(spans[0]));
        })();
        if (!clip || !pps) return null;
        const c = clip.getBoundingClientRect(), t = track.getBoundingClientRect();
        const inner = parseFloat(document.querySelector("#timelineTrack .tl-inner").style.width);
        return inner <= track.clientWidth + 1 && c.right <= t.right && track.scrollLeft === 0 && Math.abs(c.width - d * pps) < 3
          ? { view: track.clientWidth, inner, clip: Math.round(c.width), pps } : null;
      }, dur);
      // Fold and back.
      const h0 = await app.js(`document.querySelector("#timeline").offsetHeight`);
      await app.click("#timelineFold");
      const folded = await app.waitFor("the timeline folded", 5000, () => document.querySelector("#timeline").classList.contains("folded")
        && document.querySelector("#timeline").offsetHeight);
      await app.click("#timelineFold");
      const open = await app.waitFor("the timeline open", 5000, (h) => !document.querySelector("#timeline").classList.contains("folded")
        && Math.abs(document.querySelector("#timeline").offsetHeight - h) <= 1 && document.querySelector("#timeline").offsetHeight, h0);
      if (folded >= h0) throw new Error(`folded the timeline is ${folded} px, open ${h0} px`);
      // The handle above it, 40 px up and back.
      const g = await spotOf(app, "#gripTimeline");
      await drag(app, g.x, g.y, 0, -40);
      const taller = await app.waitFor("the timeline 40 px taller", 5000, (h) => {
        const now = document.querySelector("#timeline").offsetHeight;
        return Math.abs(now - h - 40) <= 2 ? now : null;
      }, h0).catch(async () => { throw new Error(`after a 40 px drag the timeline is ${await app.js(`document.querySelector("#timeline").offsetHeight`)} px (was ${h0})`); });
      const g2 = await spotOf(app, "#gripTimeline");
      await drag(app, g2.x, g2.y, 0, 40);
      const again = await app.waitFor("the timeline its height again", 5000, (h) => {
        const now = document.querySelector("#timeline").offsetHeight;
        return Math.abs(now - h) <= 2 ? now : null;
      }, h0);
      for (const k of ["persodub.layout.timelineOpen", "persodub.layout.timelineHeight"]) await putBack(app, k, s.saved[k]);
      return `fit: video clip ${fit.clip} px = ${dur.toFixed(1)} s × ${fit.pps.toFixed(1)} px/s, strip ${fit.inner}/${fit.view} px, scrolled 0; `
        + `fold ${h0} → ${folded} → ${open} px; handle −40 px: ${h0} → ${taller} px, +40 px: ${again} px; storage put back`;
    } },

  { name: "T4 a subtitle block's end", looks: ["#timeline"],
    async run(app, ctx) {
      const s = ctx.state.dub2;
      await onDub(app, s);
      const l = (await script(app, s.jobId))[1];
      const st0 = await style(app, s.jobId);
      const end0 = st0.cues?.["2"] ? +st0.cues["2"].end : l.end;
      const hdl = '#timeline .tl-lane-caps .tl-cap[data-idx="1"] .tl-hdl.r';
      const pps = await app.inPage(rulerPps);
      if (!pps) throw new Error("no ruler to read the scale from");
      const h = await spotOf(app, hdl);
      await drag(app, h.x, h.y, -0.5 * pps, 0);
      const cut = await until("the saved cue end 0.5 s sooner", 10000, async () => {
        const c = (await style(app, s.jobId)).cues?.["2"];
        return c && Math.abs(end0 - c.end - 0.5) <= 0.1 ? c : null;
      }).catch(async () => { throw new Error(`after a ${(0.5 * pps).toFixed(1)} px drag the saved cue is ${JSON.stringify((await style(app, s.jobId)).cues?.["2"])} (end was ${end0})`); });
      const shown1 = await app.inPage((sel) => document.querySelector(sel).closest(".tl-cap").getBoundingClientRect().width, hdl);
      // And back: the same end dragged 0.5 s later (the API entry itself is put back at the area's end).
      const h2 = await spotOf(app, hdl);
      await drag(app, h2.x, h2.y, 0.5 * pps, 0);
      const back = await until("the saved cue end back", 10000, async () => {
        const c = (await style(app, s.jobId)).cues?.["2"];
        return c && Math.abs(c.end - end0) <= 0.1 ? c : null;
      });
      return `line 2's subtitle (${l.start}-${end0} s) right end dragged ${(-0.5 * pps).toFixed(1)} px (${pps.toFixed(1)} px/s): `
        + `saved cue ${cut.start}-${cut.end} s (−${(end0 - cut.end).toFixed(2)} s), block ${shown1.toFixed(0)} px; dragged back: ${back.start}-${back.end} s`;
    } },

  { name: "V1 video pane width", looks: ["#videoPane", "#gripPanes"],
    async run(app, ctx) {
      const s = ctx.state.dub2;
      await onDub(app, s);
      const m = await app.inPage(() => ({ w: document.querySelector("#videoPane").offsetWidth,
                                           room: document.querySelector("#doneMain").offsetWidth }));
      // Wider by 80 when there is room for it, else narrower by 80.
      const dx = m.w + 80 <= m.room - 7 - 380 ? -80 : 80;
      const g = await spotOf(app, "#gripPanes");
      await drag(app, g.x, g.y, dx, 0);
      const w1 = await app.waitFor("the video pane 80 px wider", 5000, (w, d) => {
        const now = document.querySelector("#videoPane").offsetWidth;
        return Math.abs(now - (w - d)) <= 2 ? now : null;
      }, m.w, dx).catch(async () => { throw new Error(`after a ${dx} px drag the video pane is ${await app.js(`document.querySelector("#videoPane").offsetWidth`)} px (was ${m.w})`); });
      const g2 = await spotOf(app, "#gripPanes");
      await drag(app, g2.x, g2.y, -dx, 0);
      const w2 = await app.waitFor("the video pane its width again", 5000, (w) => {
        const now = document.querySelector("#videoPane").offsetWidth;
        return Math.abs(now - w) <= 2 ? now : null;
      }, m.w);
      await putBack(app, "persodub.layout.videoWidth", s.saved["persodub.layout.videoWidth"]);
      return `handle ${dx > 0 ? "+" : ""}${dx} px: video pane ${m.w} → ${w1} px (${w1 - m.w > 0 ? "+" : ""}${w1 - m.w}), back ${w2} px; storage put back`;
    } },

  { name: "V2 a 9:16 download", looks: ["#exportOverlay", "#videoPane"],
    async run(app, ctx) {
      const s = ctx.state.dub2;
      await onDub(app, s);
      const job = await app.api(`/api/dub/jobs/${s.jobId}`);
      const dir = join(homedir(), "Downloads", job.day, job.project);
      const t0 = Date.now();
      try {
        await app.click("#ratioBtn");
        await app.waitFor("the Ratio menu", 5000, () => !document.querySelector("#ratioMenu").hidden);
        await app.click('#ratioMenu [data-id="9:16"]');
        await until("the saved ratio 9:16", 10000, async () => (await view(app, s.jobId)).ratio === "9:16");
        await app.click("#exportBtn");
        await app.waitFor("the Download dialog and its rows", 10000, () => document.querySelector("#exportOverlay")
          .classList.contains("open") && document.querySelectorAll("#exportList a[data-row]").length);
        for (const r of await app.inPage(() => [...document.querySelectorAll("#exportList a[data-row]")]
          .map((a) => ({ id: a.dataset.row, on: a.getAttribute("aria-checked") === "true" })))) {
          if (r.on === (r.id === "video")) continue;
          await app.click(`#exportList a[data-row="${r.id}"]`);
          await app.waitFor(`${r.id} ${r.on ? "unticked" : "ticked"}`, 5000, (id, on) => document.querySelector(`#exportList a[data-row="${id}"]`)
            .getAttribute("aria-checked") === String(on), r.id, !r.on);
        }
        const end = await download(app, 180000);
        if (!end.saved.includes("video")) throw new Error(`the download stopped: ${end.where}`);
        // The new file, out of Downloads into the run's folder.
        const fresh = existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith(".") && f.endsWith(".mp4")
          && statSync(join(dir, f)).mtimeMs >= t0 - 1000) : [];
        if (fresh.length !== 1) throw new Error(`${dir} has ${fresh.length} new .mp4 file(s)`);
        const into = join(ctx.out, "dub2-export-9x16");
        mkdirSync(into, { recursive: true });
        const path = join(into, fresh[0]);
        copyFileSync(join(dir, fresh[0]), path);
        unlinkSync(join(dir, fresh[0]));
        for (const d of [dir, dirname(dir)]) {
          try { rmdirSync(d); } catch { /* not empty: something else is kept there */ }
        }
        const r = spawnSync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                                      "-of", "csv=p=0", path], { encoding: "utf8" });
        if (r.status !== 0) throw new Error(`ffprobe could not read ${fresh[0]}: ${(r.stderr || "").trim().slice(0, 200)}`);
        const [w, h] = r.stdout.trim().split(",").map(Number);
        if (Math.abs(w - h * 9 / 16) > 1) throw new Error(`${fresh[0]} is ${w}x${h}, not 9:16 (${(h * 9 / 16).toFixed(1)} wide)`);
        return `ratio 9:16 picked (saved), ${app.tr("Dubbed video")} alone downloaded in ${secs(t0)} s: ${fresh[0]} ${w}x${h} `
          + `(9:16 wants ${(h * 9 / 16).toFixed(1)}), ${(statSync(path).size / 1e6).toFixed(2)} MB, moved into dub2-export-9x16/; "${end.where}"`;
      } finally {
        if (await app.inPage(isOpen, "#exportOverlay")) {
          await app.click("#exportCloseBtn", 120000);
          await app.waitFor("the Download dialog to close", 5000, isClosed, "#exportOverlay");
        }
        for (const k of ["persodub.exportTicks", "persodub.exportAudio"]) await putBack(app, k, s.saved[k]);
        if ((await view(app, s.jobId)).ratio !== s.view.ratio) {
          await app.click("#ratioBtn");
          await app.click(`#ratioMenu [data-id="${s.view.ratio}"]`);
          await until(`the saved ratio back to ${s.view.ratio}`, 10000, async () => (await view(app, s.jobId)).ratio === s.view.ratio);
        }
      }
    } },

  { name: "V3 social media preview", looks: ["#videoPane", "#previewMenu"],
    async run(app, ctx) {
      const s = ctx.state.dub2;
      await onDub(app, s);
      // The page's own saves from here on, counted.
      await app.inPage(() => {
        window.__subPuts = 0;
        if (!window.__subPutsHooked) {
          window.__subPutsHooked = true;
          const f = window.fetch;
          window.fetch = (u, o) => {
            if (/subtitle_style/.test(String(u)) && o && o.method === "PUT") window.__subPuts++;
            return f(u, o);
          };
        }
        return true;
      });
      const v0 = await view(app, s.jobId), st0 = JSON.stringify(await style(app, s.jobId));
      await app.click("#previewBtn");
      const items = await app.waitFor("the preview menu", 5000, () => !document.querySelector("#previewMenu").hidden
        && [...document.querySelectorAll("#previewMenu [data-id]")].map((b) => b.dataset.id));
      if (items.length !== 4) throw new Error(`the preview menu has ${items.length} entries: ${items.join(", ")}`);
      await app.click('#previewMenu [data-id="reels"]');
      const phone = await app.waitFor("the phone frame", 5000, () => {
        const p = document.querySelector("#ratioPreview");
        const r = p.getBoundingClientRect();
        return !p.hidden && p.children.length && !document.querySelector("#ratioCanvas").hidden && r.height > r.width
          ? { w: Math.round(r.width), h: Math.round(r.height), parts: p.children.length,
              on: document.querySelector("#previewBtn").classList.contains("on") } : null;
      });
      await sleep(500);
      await app.shot("dub2-reels-preview");
      await sleep(1500);   // past any save a pick could make
      const v1 = await view(app, s.jobId), st1 = JSON.stringify(await style(app, s.jobId));
      await app.click("#previewBtn");
      await app.click('#previewMenu [data-id="none"]');
      await app.waitFor("the preview gone", 5000, () => document.querySelector("#ratioPreview").hidden
        && !document.querySelector("#previewBtn").classList.contains("on"));
      if (v1.ratio !== v0.ratio || st1 !== st0) {
        const a = JSON.parse(st0), b = JSON.parse(st1);
        const keys = Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
        const puts = await app.inPage(() => window.__subPuts);
        throw new Error(`Reels changed what is saved: ratio ${v0.ratio} → ${v1.ratio}, style ${st0 === st1 ? "same"
          : `changed (${keys.join(", ")}; ${puts} save(s) from the page)`}`);
      }
      return `menu ${items.join(", ")}; Reels: phone frame ${phone.w}x${phone.h} px, ${phone.parts} parts drawn, button lit ${phone.on}; `
        + `saved ratio ${v1.ratio} and subtitle style unchanged; None took it off`;
    } },

  { name: "V5 rename by the title", looks: ["#topbarTitle", "#topbarRename", "#projectsGrid"],
    async run(app, ctx) {
      const s = ctx.state.dub2;
      await onDub(app, s);
      const was = (await app.api(`/api/dub/jobs/${s.jobId}`)).title || "";
      const rename = async (text) => {
        await app.click("#topbarTitle");
        await app.waitFor("the rename field", 5000, shown, "#topbarRename");
        await app.inPage(() => { const f = document.querySelector("#topbarRename"); f.focus(); f.select(); return true; });
        if (text) await app.send("Input.insertText", { text });
        else {
          for (const type of ["keyDown", "keyUp"]) {
            await app.send("Input.dispatchKeyEvent", { type, key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
          }
        }
        await app.key("Enter");
        await app.waitFor("the title again", 5000, () => !document.querySelector("#topbarTitle").hidden);
      };
      await rename(RENAMED);
      await until(`the API title ${RENAMED}`, 10000, async () => (await app.api(`/api/dub/jobs/${s.jobId}`)).title === RENAMED);
      const bar = await app.waitFor("the top bar's new name", 5000, (w) => document.querySelector("#topbarTitle").textContent.trim() === w && w, RENAMED);
      await app.click("#homeBtn");
      await app.waitFor("the Home screen", 10000, onHome);
      const card = await app.waitFor("the card's new name", 10000, (sel, w) => {
        const n = document.querySelector(sel);
        return n && n.textContent.trim() === w ? w : null;
      }, `#projectsGrid .proj-card[data-job="${s.jobId}"] .proj-name`, RENAMED);
      await onDub(app, s);
      // Back: the old name typed, or the field emptied when it had none of its own (the folder's name shows).
      await rename(was);
      const back = await until("the old title", 10000, async () => {
        const j = await app.api(`/api/dub/jobs/${s.jobId}`);
        return (j.title || "") === was ? j : null;
      });
      const bar2 = await app.inPage(textOf, "#topbarTitle");
      return `title → "${bar}": API title "${RENAMED}", Home card "${card}"; back to "${was}" (API ${JSON.stringify(back.title)}, top bar "${bar2}")`;
    } },

  // Fixed at the foot of the picture (owner, 2026-10-23): a drag moves
  // nothing, saves nothing, and brings up no tab.
  { name: "V7 the subtitle stays at the foot when dragged", looks: ["#videoPane", "#subOverlay"],
    async run(app, ctx) {
      const s = ctx.state.dub2;
      await onDub(app, s);
      const st0 = await style(app, s.jobId);
      const eye = async (want) => {
        if ((await style(app, s.jobId)).enabled === want) return;
        await app.click("#tlSubEye");
        await until(`the saved enabled=${want}`, 10000, async () => (await style(app, s.jobId)).enabled === want);
      };
      await eye(true);
      await atLine(app, 2);
      await app.waitFor("the subtitle on the picture", 5000, () => {
        const r = document.querySelector("#subOverlayText").getBoundingClientRect();
        return !document.querySelector("#subOverlay").hidden && document.querySelector("#subOverlayText").textContent.trim() && r.height > 0;
      });
      const geo = () => {
        const v = document.querySelector("#doneVideo").getBoundingClientRect();
        const tx = document.querySelector("#subOverlayText").getBoundingClientRect();
        return { bottom: tx.bottom - v.top, tab: document.querySelector("#leftTabs .left-tab.on")?.dataset.tab || "" };
      };
      const g0 = await app.inPage(geo);
      const before = await style(app, s.jobId);
      const p = await spotOf(app, "#subOverlayText", 0.15);
      await drag(app, p.x, p.y, 0, -40);
      await sleep(800);   // past the page's debounced save, had there been one
      const g1 = await app.inPage(geo);
      const after = await style(app, s.jobId);
      await app.shot("dub2-subtitle-not-moved");
      await eye(st0.enabled);
      if (Math.abs(g1.bottom - g0.bottom) > 1) throw new Error(`a 40 px drag moved the subtitle's foot ${g0.bottom.toFixed(0)} → ${g1.bottom.toFixed(0)} px`);
      if (after.pos !== 93 || after.pos !== before.pos) throw new Error(`the saved pos went ${before.pos} → ${after.pos}`);
      if (g1.tab !== "dubbing") throw new Error(`the press brought up the ${g1.tab} tab`);
      return `dragged 40 px up: foot ${g0.bottom.toFixed(0)} → ${g1.bottom.toFixed(0)} px, saved pos ${before.pos} → ${after.pos}, `
        + `tab still ${g1.tab}; eye back to ${st0.enabled}`;
    } },

  // The project screen's tabs, in Home's order (owner, 2026-10-23).
  { name: "V8 the tab row in a dub", looks: ["#leftTabs"],
    async run(app, ctx) {
      const s = ctx.state.dub2;
      await onDub(app, s);
      const row = await app.inPage(() => [...document.querySelectorAll("#leftTabs .left-tab")]
        .map((b) => b.dataset.tab || b.id).filter(Boolean));
      const want = ["homeBtn", "dubbing", "erase", "captions", "save", "newProjectBtn"];
      if (JSON.stringify(row) !== JSON.stringify(want)) throw new Error(`the tab row is ${row.join(", ")}`);
      const words = await app.inPage(() => ["captions", "save"].map((t) => document.querySelector(`#leftTabs [data-tab="${t}"]`).textContent.trim()));
      if (words[0] !== app.tr("Burn in subtitles") || words[1] !== app.tr("Save video")) throw new Error(`the two read ${words.join(", ")}`);
      return `${row.join(", ")}; "${words.join('", "')}"`;
    } },

  { name: "V9 Erase tab in a dub", looks: ["#tabErase", "#erasePane"],
    async run(app, ctx) {
      const s = ctx.state.dub2;
      await onDub(app, s);
      const job = await app.api(`/api/dub/jobs/${s.jobId}`);
      await app.click('#leftTabs [data-tab="erase"]');
      const got = await app.waitFor("the project's video in the Erase tab", 20000, () => {
        const v = document.querySelector("#eraseVideo");
        const src = v.getAttribute("src") || "";
        return document.body.dataset.screen === "erase" && src && v.readyState >= 1
          ? { src, dur: v.duration, error: document.querySelector("#eraseDropError")?.textContent.trim() || "" } : null;
      });
      const erasing = await app.inPage(() => !document.querySelector("#eraseCancelBtn").hidden);
      await app.shot("dub2-erase-tab");
      await app.click('#leftTabs [data-tab="dubbing"]');
      await app.waitFor("the dub again", 20000, (jid) => document.body.dataset.screen === "done" && document.body.dataset.jobId === jid
        && document.querySelectorAll("#scriptBox .sc-row:not(.head)").length, s.jobId);
      if (!/\/api\/downloads\/[^/]+\/video/.test(got.src)) throw new Error(`#eraseVideo plays ${got.src}, not this project's video held again`);
      if (Math.abs(got.dur - job.duration) > 0.5) throw new Error(`the Erase tab's video is ${got.dur} s, the project ${job.duration} s`);
      if (erasing) throw new Error("an erase is running");
      return `Erase tab: #eraseVideo ${got.src} (${got.dur.toFixed(2)} s, the project ${job.duration} s), nothing erased; back on the dub`;
    } },

  { name: "홈", looks: ["#screen-home"],
    async run(app, ctx) {
      const s = ctx.state.dub2;
      const notes = [];
      await tidy(app).catch(() => {});
      if (!(await app.inPage(onHome)) && (await app.inPage(pressable, "#homeBtn"))) await app.click("#homeBtn");
      await app.waitFor("the Home screen", 10000, onHome);
      if (!s || !s.jobId) return "no dub was opened";
      await sleep(1500);   // past the page's last debounced save
      // The subtitle style as step 1 read it: a retimed subtitle and a dragged one leave entries no control removes.
      const now = await style(app, s.jobId);
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      if (!same(now, s.style)) {
        await app.api(`/api/dub/jobs/${s.jobId}/subtitle_style`, { method: "PUT", headers: { "Content-Type": "application/json" },
                                                                   body: JSON.stringify(s.style) });
        // The page keeps the style of the dub it opened last; another dub opened and left makes it read this one afresh.
        if (s.other) {
          await app.click(`#projectsGrid .proj-card[data-job="${s.other}"]`, 20000);
          await app.waitFor("the other dub", 20000, (jid) => document.body.dataset.screen === "done" && document.body.dataset.jobId === jid, s.other);
          await app.click("#homeBtn");
          await app.waitFor("the Home screen", 10000, onHome);
        }
        notes.push(`subtitle style put back (${JSON.stringify(s.style.cues)} cues, pos ${s.style.pos})`);
      }
      // A line a failed step left changed: back to its translation, by the route its Revert button takes.
      for (const [i, l] of (await script(app, s.jobId)).entries()) {
        if (l.text === s.lines[i].text || s.lines[i].edited) continue;
        await app.api(`/api/dub/jobs/${s.jobId}/script/${l.line}/revert`, { method: "POST" });
        notes.push(`line ${l.line} reverted`);
      }
      for (const k of KEYS) await putBack(app, k, s.saved[k]);
      const v = await view(app, s.jobId), st = await style(app, s.jobId), lines = await script(app, s.jobId);
      const j = await app.api(`/api/dub/jobs/${s.jobId}`);
      const off = [];
      if (v.ratio !== s.view.ratio) off.push(`ratio ${v.ratio}`);
      if (!same(st, s.style)) off.push("subtitle style");
      if ((j.title || "") !== (s.job.title || "")) off.push(`title "${j.title}"`);
      lines.forEach((l, i) => { if (l.text !== s.lines[i].text) off.push(`line ${l.line}`); });
      const dialog = await app.js(`document.querySelector(".modal-overlay.open")?.id || ""`);
      if (dialog) off.push(`#${dialog} open`);
      if (off.length) throw new Error(`not as it was: ${off.join(", ")}`);
      return `on Home, no dialog; ratio ${v.ratio}, subtitle style, title and 3 lines as step 1 read them; ${notes.join("; ") || "nothing to put back by the API"}; storage put back`;
    } },
];
