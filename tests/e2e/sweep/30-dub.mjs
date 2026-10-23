// The finished-dub screen: a local dub of the e2e clip opened from Home, then
// its script table (length marks, play, edit and remake a line, Translate
// again, the speaker chip, Remake voices), the timeline (zoom, captions eye,
// clock), the video panel (Original / Dubbed, Ratio, Full screen), Subtitle
// style, the Download dialog, and + Add language. Everything stays on this
// computer: a Perso-only button is read, never pressed.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { sleep, shown, pressable, isOpen, isClosed, onHome, textOf } from "../lib/cdp.mjs";

export const area = "dub";

// What the area changes in the page's storage, put back at its end.
const KEYS = ["persodub.lastChoices", "persodub.exportTicks", "persodub.exportAudio"];
const FFPROBE = process.env.PERSODUB_FFPROBE || "ffprobe";
// The two words line 2 is edited to, whichever it does not say already.
const EDITS = ["여기가 파리에서 제일 멋진 풍경이에요.", "파리에서 가장 아름다운 풍경이에요."];

const row = (n) => `#scriptBox .sc-row[data-line="${n}"]`;
const script = (app, jid) => app.api(`/api/dub/jobs/${jid}/script`).then((d) => d.lines || []);
const style = (app, jid) => app.api(`/api/dub/jobs/${jid}/subtitle_style`);
const secs = (t0) => ((Date.now() - t0) / 1000).toFixed(1);

function seconds(path) {
  const r = spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration",
                                "-of", "default=noprint_wrappers=1:nokey=1", path], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffprobe could not read ${basename(path)}: ${(r.stderr || r.error?.message || "").trim().slice(0, 200)}`);
  return Number(r.stdout.trim());
}

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

// The app makes one local job at a time, and a line's voice waits for the
// voice engine too: wait for nobody's job to be queued or running, or throw
// naming them, before pressing anything that makes a voice.
async function quiet(app, ms) {
  const busy = async () => (await app.api("/api/dub/jobs")).jobs.filter((j) => ["queued", "running"].includes(j.status));
  const free = await until("the app's queue to empty", ms, async () => !(await busy()).length).catch(() => false);
  if (!free) throw new Error(`the app is still busy after ${ms / 1000} s with ${(await busy()).map((j) => `${j.project} ${j.kind} ${j.status}`).join(", ")}; not pressed`);
}

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
  await app.click(`#projectsGrid .proj-card[data-job="${s.cardId}"]`, 20000);
  await app.waitFor("the finished dub and its table", 20000, (jid) => document.body.dataset.screen === "done"
    && document.body.dataset.jobId === jid && document.querySelectorAll("#scriptBox .sc-row:not(.head)").length > 0, s.jobId);
}

// Anything a failed step may have left open: the Download dialog, the looks, full screen.
async function tidy(app) {
  if (await app.inPage(() => !!document.fullscreenElement)) await app.js("document.exitFullscreen().catch(() => {})");
  if (await app.inPage(isOpen, "#exportOverlay")) {
    await app.click("#exportCloseBtn", 120000);
    await app.waitFor("the Download dialog to close", 5000, isClosed, "#exportOverlay");
  }
  if (await app.inPage(() => !document.querySelector("#videoStylePop").hidden)) await app.key("Escape");
}

// The ruler's seconds to pixels: two labels apart, by their times.
const rulerPps = () => {
  const spans = [...document.querySelectorAll("#timelineTrack .tl-ruler span")];
  if (spans.length < 2) return 0;
  const sec = (el) => el.textContent.trim().split(":").reduce((a, b) => a * 60 + Number(b), 0);
  const [a, b] = spans;
  return (parseFloat(b.style.left) - parseFloat(a.style.left)) / (sec(b) - sec(a));
};

// The Download dialog's rows as drawn.
const exportRows = () => [...document.querySelectorAll("#exportList a[data-row]")]
  .map((a) => ({ id: a.dataset.row, ticked: a.getAttribute("aria-checked") === "true", saved: a.classList.contains("saved") }));

// Rows ticked exactly as `want`, pressed the way a person presses them.
async function tickOnly(app, want) {
  for (const r of await app.inPage(exportRows)) {
    if (r.ticked === want.includes(r.id)) continue;
    await app.click(`#exportList a[data-row="${r.id}"]`);
    await app.waitFor(`${r.id} ${r.ticked ? "unticked" : "ticked"}`, 5000, (id, on) => document.querySelector(`#exportList a[data-row="${id}"]`)
      .getAttribute("aria-checked") === String(on), r.id, !r.ticked);
  }
}

// Download pressed: waits for it to come back, the saved rows and the line under them.
async function download(app, ms) {
  await app.click("#exportGoBtn");
  await app.waitFor("Download to start", 5000, () => document.querySelector("#exportGoBtn").disabled);
  return app.waitFor("the download to finish", ms, () => document.querySelector("#exportGoBtn").disabled ? null
    : { saved: [...document.querySelectorAll("#exportList a.saved")].map((a) => a.dataset.row),
        where: document.querySelector("#exportWhere").textContent.trim() });
}

// A job's saved files out of Downloads/<day>/<project> into the run's folder,
// as click.mjs moves them: [name, path, bytes] for each.
function moveOut(job, count, into) {
  const dir = join(homedir(), "Downloads", job.day, job.project);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith(".")) : [];
  if (files.length !== count) throw new Error(`${dir} holds ${files.length} file(s) for ${count} saved`);
  mkdirSync(into, { recursive: true });
  const moved = [];
  for (const f of files) {
    const size = statSync(join(dir, f)).size;
    if (!size) throw new Error(`${f} was saved empty`);
    copyFileSync(join(dir, f), join(into, f));
    unlinkSync(join(dir, f));
    moved.push([f, join(into, f), size]);
  }
  for (const d of [dir, dirname(dir)]) {
    try { rmdirSync(d); } catch { /* not empty: something else is kept there */ }
  }
  return moved;
}

export const steps = [
  { name: "open a finished local dub", looks: ["#projectsGrid", "#scriptBox"], stopsArea: true,
    async run(app, ctx) {
      const s = ctx.state.dub = { saved: {} };
      for (const k of KEYS) s.saved[k] = await app.js(`localStorage.getItem(${JSON.stringify(k)})`);
      const dialog = await app.js(`document.querySelector(".modal-overlay.open")?.id || ""`);
      if (dialog) throw new Error(`#${dialog} is open; the area starts with no dialog in the way`);
      if (!(await app.inPage(onHome))) await app.click("#homeBtn");
      await app.waitFor("the Home screen", 10000, onHome);
      // Projects as Home groups them, newest first; a card wears its newest dubbing's id.
      const { jobs } = await app.api("/api/dub/jobs");
      const groups = new Map();
      for (const j of jobs) {
        const k = j.project_id || j.id;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(j);
      }
      // One language only, so + Add language has the project to itself.
      const named = [...groups.values()].filter((m) => String(m[0].title || m[0].project || "").startsWith("e2e-"));
      const done = named.filter((m) => m.length === 1 && m[0].kind === "dub" && m[0].status === "done" && m[0].dub_mode === "local");
      let job = null, lines = [];
      for (const [j] of done) {
        lines = await script(app, j.id);
        // A dub of the clip itself: every line heard in it and given a speaker.
        if (lines.length === 3 && lines.every((l) => l.source && l.speaker)) { job = j; break; }
      }
      if (!job) throw new Error(`no finished local e2e- dub of 3 spoken lines in one language among ${named.length} e2e- projects`);
      Object.assign(s, { jobId: job.id, cardId: job.id, job });
      await app.click(`#projectsGrid .proj-card[data-job="${job.id}"]`, 20000);
      const n = await app.waitFor("the finished dub and its table", 20000, (jid) => document.body.dataset.screen === "done"
        && document.body.dataset.jobId === jid && document.querySelectorAll("#scriptBox .sc-row:not(.head)").length, job.id);
      if (n !== 3) throw new Error(`the table has ${n} rows, not 3`);
      return `card "${job.title || job.project}" (job ${job.id}, ${job.language_code}, local, ${job.translator}) opened: screen done, ${n} rows; `
        + `newest of ${done.length} one-language local e2e- dubs`;
    } },

  { name: "length column", looks: ["#scriptBox"],
    async run(app, ctx) {
      await onDub(app, ctx.state.dub);
      const c = await app.inPage(() => {
        const rows = [...document.querySelectorAll("#scriptBox .sc-row:not(.head)")];
        return { rows: rows.map((r) => ({ line: r.dataset.line, tick: !!r.querySelector(".sc-len .sc-tick"),
                                         dot: !!r.querySelector(".sc-len .sc-dot"),
                                         diff: (r.querySelector(".sc-diff")?.textContent || "").trim() })),
                 body: document.body.innerText };
      });
      const cut = app.tr("{length} cut", { length: "" }).trim();
      for (const r of c.rows) {
        if (!r.tick && !r.dot) throw new Error(`line ${r.line} has neither a tick nor a dot`);
        if (r.dot && !/^[+−-]\d+\.\d/.test(r.diff)) throw new Error(`line ${r.line}'s dot comes with "${r.diff}", not signed seconds`);
      }
      if (c.body.includes(cut)) throw new Error(`"${cut}" is on the screen`);
      return c.rows.map((r) => `line ${r.line} ${r.tick ? "tick" : `dot ${r.diff}`}`).join(", ") + `; "${cut}" nowhere`;
    } },

  { name: "play a line", looks: ["#scriptBox", "#videoPane"],
    async run(app, ctx) {
      const s = ctx.state.dub;
      await onDub(app, s);
      const l = (await script(app, s.jobId))[1];
      const t0 = Date.now();
      await app.click(`${row(2)} [data-play]`);
      const at = await app.waitFor(`the video inside line 2 (${l.start}-${l.end} s)`, 2000, (a, b) => {
        const v = document.querySelector("#doneVideo");
        return !v.paused && v.currentTime >= a && v.currentTime <= b + 0.1 ? v.currentTime : 0;
      }, l.start, l.end);
      const took = secs(t0);
      if (await app.inPage(() => !document.querySelector("#doneVideo").paused)) await app.click("#playToggle");
      await app.waitFor("the video to pause", 3000, () => document.querySelector("#doneVideo").paused);
      return `line 2 (${l.start}-${l.end} s): playing at ${at.toFixed(2)} s ${took} s after the press, then paused`;
    } },

  { name: "edit line 2 and remake its voice", looks: ["#scriptBox", "#scriptSaving"],
    async run(app, ctx) {
      const s = ctx.state.dub;
      await onDub(app, s);
      const before = (await script(app, s.jobId))[1];
      const text = EDITS.find((w) => w !== before.text);
      const cell = `${row(2)} .sc-dst`;
      // Into the cell, everything in it selected (as Cmd+A does), the new words typed, Enter.
      await app.click(cell);
      await app.inPage((sel) => { const el = document.querySelector(sel); el.focus(); getSelection().selectAllChildren(el); return true; }, cell);
      await app.send("Input.insertText", { text });
      await app.key("Enter");
      await until("line 2 saved with the new words", 10000, async () => (await script(app, s.jobId))[1].text === text);
      await app.waitFor("line 2's voice button to say the words changed", 10000, (sel) => !!document.querySelector(sel), `${row(2)} .sc-wave.stale`);
      await quiet(app, 120000);
      const t0 = Date.now();
      await app.click(`${row(2)} [data-voice]`);
      // Done is the press coming back: the button wears the new voice (the server
      // has the voice a while before, the video being rebuilt around it).
      // A redraw meanwhile (the script's stamp moves) gives a new button, so the line under the table is what says it went wrong.
      const done = await app.waitFor("line 2's button to show the new voice", 180000, (sel, busy, ok) => {
        if (document.querySelector(`${sel} [data-voice]`).classList.contains("fresh")) return "fresh";
        const said = document.querySelector("#scriptSaving").textContent.trim();
        return said && said !== busy && said !== ok ? `refused: ${said}` : "";
      }, row(2), app.tr("Remaking line {line}…", { line: 2 }), app.tr("Line {line} done", { line: 2 }));
      const took = secs(t0);
      if (done !== "fresh") throw new Error(`the remake was ${done}`);
      const after = (await script(app, s.jobId))[1];
      if (after.text !== text || after.voice_stale) throw new Error(`line 2 reads "${after.text}", voice_stale ${after.voice_stale} after the remake`);
      if (took > 240) throw new Error(`line 2's voice took ${took} s, over 240 s`);
      return `line 2 "${before.text}" → "${text}"; voice remade in ${took} s, audio ${before.audio_sec} → ${after.audio_sec} s, voice_stale false`;
    } },

  { name: "translate line 2 again", looks: ["#scriptBox", "#scriptSaving"],
    async run(app, ctx) {
      const s = ctx.state.dub;
      await onDub(app, s);
      const before = (await script(app, s.jobId))[1];
      await app.click(`${row(2)} label.sc-n`);
      await app.waitFor("line 2 ticked", 5000, (sel) => document.querySelector(sel).checked, `${row(2)} .sc-pick`);
      const picked = await app.inPage(textOf, "#scriptPickCount");
      const t0 = Date.now();
      await app.click("#retranslateBtn");
      // Words written by hand ask for a second press before they are replaced.
      const again = app.tr("1 line you edited will be replaced by the new translation too. Press again to go ahead.");
      const first = await app.waitFor("Translate again to start or ask again", 10000, (w) => {
        const said = document.querySelector("#scriptSaving").textContent.trim();
        return said === w ? "ask" : document.querySelector("#retranslateBtn").disabled || said ? "going" : "";
      }, again);
      if (first === "ask") await app.click("#retranslateBtn");
      const after = await until("line 2's translation to change", 90000, async () => {
        const l = (await script(app, s.jobId))[1];
        return l.text !== before.text ? l : null;
      });
      await app.waitFor("the row to show the new words", 10000, (sel, w) => document.querySelector(sel).textContent === w, `${row(2)} .sc-dst`, after.text);
      return `ticked line 2 ("${picked}"), ${app.tr("Retranslate unfit lines")}${first === "ask" ? " pressed twice (it was hand-edited)" : ""}: `
        + `"${before.text}" → "${after.text}" in ${secs(t0)} s, voice_stale ${after.voice_stale}`;
    } },

  { name: "speaker of line 1", looks: ["#scriptBox"],
    async run(app, ctx) {
      const s = ctx.state.dub;
      await onDub(app, s);
      const l = (await script(app, s.jobId))[0];
      const chip = await app.inPage((sel) => {
        const el = document.querySelector(sel);
        return el && { tag: el.tagName.toLowerCase(), title: el.title, text: el.textContent.trim() };
      }, `${row(1)} .spk-chip`);
      if (!chip) throw new Error("line 1 has no speaker chip");
      // Only a Perso dub's chip is a button: it gives the line a new voice on Perso's side, for credits.
      if (chip.tag !== "span") throw new Error(`line 1's chip is a ${chip.tag} on a local dub; it would spend Perso credits, not pressed`);
      return `local dub: line 1's chip is a plain label "${chip.title}" (${chip.text}), API speaker ${l.speaker}; `
        + "the speaker picker is on Perso dubs only (it spends credits), so nothing to press here";
    } },

  { name: "remake voices", looks: ["#scriptPane", "#scriptSaving"],
    async run(app, ctx) {
      const s = ctx.state.dub;
      await onDub(app, s);
      const all = await app.inPage(() => { const b = document.querySelector("#allAtOnceBtn"); return { off: b.disabled, tip: b.title }; });
      if (!all.off || all.tip !== app.tr("Only for projects dubbed with the Perso API.")) {
        throw new Error(`${app.tr("All at once")} on a local dub is ${all.off ? "off" : "on"} with "${all.tip}"`);
      }
      const before = await script(app, s.jobId);
      const stale = before.filter((l) => l.voice_stale).map((l) => l.line);
      if (!stale.length) throw new Error("no line waits for its voice, so Remake voices rests (step 5 left none changed)");
      const count = await app.inPage(textOf, "#remakeVoicesCount");
      await quiet(app, 120000);
      const t0 = Date.now();
      await app.click("#remakeVoicesBtn");
      const after = await until(`line(s) ${stale.join(", ")} voiced again`, 150000, async () => {
        const ls = await script(app, s.jobId);
        return ls.every((l) => !l.voice_stale) ? ls : null;
      });
      // The server has the voices a while before the press comes back (the video is rebuilt first):
      // done is the table drawn again with nothing waiting, under the same limit.
      await app.waitFor("the table drawn again with no line waiting", Math.max(10000, 150000 - (Date.now() - t0)), () =>
        document.querySelector("#scriptChanged").hidden && !document.querySelector("#remakeVoicesCount").textContent
        && !document.querySelector("#scriptBox .sc-wave.stale"));
      const took = secs(t0);
      const audio = stale.map((n) => `line ${n} ${before[n - 1].audio_sec} → ${after[n - 1].audio_sec} s`).join(", ");
      return `${app.tr("All at once")} off on a local dub ("${all.tip}"), not pressed; ${app.tr("Remake voices")}${count}: ${audio} in ${took} s`;
    } },

  { name: "timeline zoom, captions eye, clock", looks: ["#timeline"],
    async run(app, ctx) {
      const s = ctx.state.dub;
      await onDub(app, s);
      await app.waitFor("the timeline's ruler", 10000, rulerPps);
      const pps0 = await app.inPage(rulerPps);
      const [, inPps] = await zoomVia(app, "#tlZoomIn", pps0);
      const [, back] = await zoomVia(app, "#tlZoomOut", inPps);
      const [, outPps] = await zoomVia(app, "#tlZoomOut", back);
      const [, end] = await zoomVia(app, "#tlZoomIn", outPps);
      if (!(inPps > pps0 && outPps < back)) throw new Error(`zoom in ${pps0.toFixed(1)} → ${inPps.toFixed(1)}, out ${back.toFixed(1)} → ${outPps.toFixed(1)} px/s`);
      // The eye: the lane flips and the saved style says so, then back. Subtitles
      // start off on a new dub (owner, 2026-10-23), so the first press turns them on.
      const eye = [];
      const was = (await style(app, s.jobId)).enabled === true;
      for (const want of [!was, was]) {
        await app.click("#tlSubEye");
        await app.waitFor(`the captions lane ${want ? "on" : "off"}`, 5000, (on) => document.querySelector("#timeline .tl-lane-caps")
          .classList.contains("off") === !on, want);
        await until(`the saved style enabled=${want}`, 10000, async () => (await style(app, s.jobId)).enabled === want);
        eye.push(await app.inPage(() => (document.querySelector("#timeline .tl-lane-caps").classList.contains("off") ? "off" : "on")));
      }
      // A second of play, then the clock against the video.
      const t0 = await app.js(`document.querySelector("#doneVideo").currentTime`);
      await app.click("#playToggle");
      await app.waitFor("the video to play", 3000, () => !document.querySelector("#doneVideo").paused);
      await sleep(1000);
      await app.click("#playToggle");
      await app.waitFor("the video to pause", 3000, () => document.querySelector("#doneVideo").paused);
      await sleep(300);
      const c = await app.inPage(() => ({ at: document.querySelector("#doneVideo").currentTime,
                                          tl: document.querySelector("#timelineClock").textContent.trim(),
                                          under: document.querySelector("#videoTime").textContent.trim() }));
      const clock = (text) => text.split("/")[0].trim().split(":").reduce((a, b) => a * 60 + Number(b), 0);
      for (const [where, text] of [["timeline", c.tl], ["player", c.under]]) {
        if (Math.abs(clock(text) - c.at) > 0.15) throw new Error(`the ${where} clock says "${text}", the video is at ${c.at.toFixed(2)} s`);
      }
      const played = c.at - t0;
      if (played < 0.5 || played > 2) throw new Error(`a second of play moved the video ${played.toFixed(2)} s`);
      return `px/s ${pps0.toFixed(1)} → in ${inPps.toFixed(1)} → out ${back.toFixed(1)} → out ${outPps.toFixed(1)} → in ${end.toFixed(1)}; `
        + `eye ${eye.join(" then ")} (saved enabled false, true); played ${played.toFixed(2)} s, clock "${c.tl}" at ${c.at.toFixed(2)} s`;
    } },

  { name: "video panel tabs, ratio, full screen", looks: ["#videoPane"],
    async run(app, ctx) {
      const s = ctx.state.dub;
      await onDub(app, s);
      const src = () => document.querySelector("#doneVideo").getAttribute("src") || "";
      const srcs = [await app.inPage(src)];
      for (const tab of ["#vtabOriginal", "#vtabDubbed"]) {
        await app.click(tab);
        await app.waitFor(`${tab} lit and its own video loaded`, 10000, (sel, was) => {
          const v = document.querySelector("#doneVideo");
          return document.querySelector(sel).classList.contains("active") && v.getAttribute("src") !== was && v.readyState >= 2;
        }, tab, srcs[srcs.length - 1]);
        srcs.push(await app.inPage(src));
      }
      if (!srcs[1].includes("/original") || srcs[1] === srcs[0] || srcs[2] !== srcs[0]) throw new Error(`the sources were ${srcs.join(" → ")}`);
      // Ratio: its menu, 9:16 on the player, then Original again.
      const box = () => { const r = document.querySelector("#doneVideo").getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
      const size0 = await app.inPage(box);
      await app.click("#ratioBtn");
      const offered = await app.waitFor("the Ratio menu", 5000, () => !document.querySelector("#ratioMenu").hidden
        && [...document.querySelectorAll("#ratioMenu [data-id]")].map((b) => b.dataset.id));
      await app.click('#ratioMenu [data-id="9:16"]');
      const tall = await app.waitFor("the 9:16 canvas", 5000, () => {
        const w = document.querySelector("#videoWrap");
        const c = document.querySelector("#ratioCanvas").getBoundingClientRect();
        return w.classList.contains("has-ratio") && !document.querySelector("#ratioCanvas").hidden && c.height > c.width
          ? { canvas: [Math.round(c.width), Math.round(c.height)], btn: document.querySelector("#ratioBtn").textContent.trim() } : null;
      });
      const size1 = await app.inPage(box);
      if (size1[0] >= size0[0]) throw new Error(`the video stayed ${size1.join("x")} (was ${size0.join("x")}) in 9:16`);
      await app.click("#ratioBtn");
      await app.click('#ratioMenu [data-id="original"]');
      await app.waitFor("the Original shape again", 5000, () => !document.querySelector("#videoWrap").classList.contains("has-ratio"));
      await until("the saved ratio back to original", 10000, async () => (await app.api(`/api/dub/jobs/${s.jobId}/view`)).ratio === "original");
      // Full screen and back: the button, then Escape (or the page's own exit if Escape is not taken).
      const win = await app.inPage(() => [innerWidth, innerHeight]);
      await app.click("#fullscreenBtn");
      const fs = await app.waitFor("full screen", 10000, () => document.fullscreenElement?.id || "");
      await sleep(1500);
      await app.shot("dub-fullscreen");
      await app.key("Escape");
      let how = "Escape";
      try {
        await app.waitFor("full screen to end", 4000, () => !document.fullscreenElement);
      } catch {
        how = "document.exitFullscreen() (Escape over CDP did not end it)";
        await app.js("document.exitFullscreen()");
        await app.waitFor("full screen to end", 5000, () => !document.fullscreenElement);
      }
      await app.waitFor("the window back to its size", 10000, (w, h) => innerWidth === w && innerHeight === h, win[0], win[1]);
      return `src ${srcs.map((x) => x.split("/").slice(-2).join("/")).join(" → ")}; ratio offers ${offered.join(", ")}; `
        + `9:16 canvas ${tall.canvas.join("x")}, video ${size0.join("x")} → ${size1.join("x")}, button "${tall.btn}", back to original (saved); `
        + `full screen on #${fs}, ended by ${how}, window ${win.join("x")} again`;
    } },

  // A dub's subtitles (owner, 2026-10-23): off until the timeline's eye turns
  // them on, fixed at the foot of the picture, and their looks behind the
  // Subtitle style chip just above them while the video stands still.
  { name: "subtitle style chip", looks: ["#subStyleChip", "#videoStylePop", "#timeline"],
    async run(app, ctx) {
      const s = ctx.state.dub;
      await onDub(app, s);
      const was = await style(app, s.jobId);
      const eye = async (want) => {
        if ((await style(app, s.jobId)).enabled === want) return;
        await app.click("#tlSubEye");
        await until(`the saved enabled=${want}`, 10000, async () => (await style(app, s.jobId)).enabled === want);
      };
      // The video at line 2, still, so a subtitle is on the picture once they are on.
      await app.click(`${row(2)} .sc-time`);
      await app.waitFor("the video at line 2", 5000, (sel) => Math.abs(document.querySelector("#doneVideo").currentTime
        - +document.querySelector(sel).dataset.start) < 0.05, row(2));
      await eye(false);
      await app.waitFor("no subtitle and no chip while they are off", 5000, () => document.querySelector("#subOverlay").hidden);
      await eye(true);
      const geo = () => {
        const v = document.querySelector("#doneVideo"), r = v.getBoundingClientRect();
        // The picture inside the player's box (object-fit: contain).
        const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
        const pic = { top: r.top + (r.height - v.videoHeight * k) / 2, h: v.videoHeight * k };
        const tx = document.querySelector("#subOverlayText").getBoundingClientRect();
        const c = document.querySelector("#subStyleChip").getBoundingClientRect();
        return { foot: pic.top + pic.h - tx.bottom, h: pic.h, gap: tx.top - c.bottom };
      };
      await app.waitFor("the subtitle and the chip over it", 5000, () => !document.querySelector("#subOverlay").hidden
        && !document.querySelector("#subStyleChip").hidden);
      const g0 = await app.inPage(geo);
      // 7 % of the picture up from its foot, and the chip about 10px over the words.
      if (Math.abs(g0.foot - 0.07 * g0.h) > 3) throw new Error(`the subtitle's foot is ${g0.foot.toFixed(1)} px up, not 7 % of ${g0.h.toFixed(0)} px`);
      if (Math.abs(g0.gap - 10) > 3) throw new Error(`the chip is ${g0.gap.toFixed(1)} px over the words, not about 10`);
      const pick = async (preset) => {
        await app.click("#subStyleChip");
        const pop = await app.waitFor("the looks over the video", 5000, () => {
          const p = document.querySelector("#videoStylePop");
          if (p.hidden) return null;
          const tiles = [...document.querySelectorAll("#videoStyleGrid .cap-pv")];
          return { bottom: p.getBoundingClientRect().bottom, tiles: tiles.length,
                   bg: tiles.filter((t) => getComputedStyle(t).backgroundImage !== "none").length,
                   words: document.querySelector("#videoStyleGrid .cap-sample")?.textContent.trim() };
        });
        const chipTop = (await app.inPage(() => document.querySelector("#subStyleChip").getBoundingClientRect().top));
        if (pop.bottom > chipTop) throw new Error(`the looks open down to ${pop.bottom.toFixed(0)} px, past the chip's top ${chipTop.toFixed(0)}`);
        if (pop.tiles !== 12 || pop.bg || pop.words !== app.tr("Abc 123")) throw new Error(`the looks: ${JSON.stringify(pop)}`);
        await app.click(`#videoStyleGrid [data-preset="${preset}"]`);
        await app.waitFor("the looks to close on the pick", 5000, () => document.querySelector("#videoStylePop").hidden);
        const t0 = Date.now();
        const st = await until(`the saved look ${preset}`, 10000, async () => { const v = await style(app, s.jobId); return v.preset === preset && v; });
        if (st.pos !== 93) throw new Error(`the look ${preset} saved pos ${st.pos}, not 93`);
        const g = await app.inPage(geo);
        if (Math.abs(g.foot - g0.foot) > 3) throw new Error(`${preset} moved the subtitle's foot ${g0.foot.toFixed(1)} → ${g.foot.toFixed(1)} px`);
        return `${preset} ${Date.now() - t0} ms`;
      };
      const looks = [await pick("clean"), await pick("bold-punch")];
      // Playing, the chip goes; still again, it is back.
      await app.click("#playToggle");
      await app.waitFor("the chip gone while it plays", 5000, () => !document.querySelector("#doneVideo").paused
        && document.querySelector("#subStyleChip").hidden);
      await app.click("#playToggle");
      await app.waitFor("the video still", 5000, () => document.querySelector("#doneVideo").paused);
      // Burn in subtitles here is no style of this dub's: it starts a burn-in project from this video.
      await app.click('#leftTabs [data-tab="captions"]');
      const burn = await app.waitFor("Burn in subtitles' start", 5000, () => !document.querySelector("#capAlone").hidden
        && document.querySelector("#capMain").inert && document.querySelector("#capZone").hidden
        && document.querySelector("#capVideoCard").textContent.trim());
      await app.click('#leftTabs [data-tab="dubbing"]');
      await app.waitFor("the Dubbing tab", 5000, shown, "#scriptBox");
      // The look and the switch it had, back.
      if (was.preset !== "bold-punch") looks.push(`back to ${await pick(was.preset)}`);
      await eye(was.enabled);
      return `off, then on by the eye; foot ${g0.foot.toFixed(1)} px up of ${g0.h.toFixed(0)} px, chip ${g0.gap.toFixed(1)} px over the words; `
        + `picks opened above the chip, plain tiles "${app.tr("Abc 123")}", saved ${looks.join(", ")} at pos 93, foot unmoved; `
        + `chip gone while playing; ${app.tr("Burn in subtitles")} shows this video "${burn}" to start from; eye back to ${was.enabled}`;
    } },

  { name: "download every row", looks: ["#exportOverlay"],
    async run(app, ctx) {
      const s = ctx.state.dub;
      await onDub(app, s);
      const job = await app.api(`/api/dub/jobs/${s.jobId}`);
      try {
        await app.click("#exportBtn");
        await app.waitFor("the Download dialog and its rows", 10000, () => document.querySelector("#exportOverlay")
          .classList.contains("open") && document.querySelectorAll("#exportList a[data-row]").length);
        const rows = await app.inPage(exportRows);
        const ids = rows.map((r) => r.id);
        await tickOnly(app, ids);
        const end = await download(app, 180000);
        if (ids.some((id) => !end.saved.includes(id))) throw new Error(`the download stopped: ${end.where}`);
        const moved = moveOut(job, ids.length, join(ctx.out, "dub-export"));
        const measured = [];
        for (const [f, path] of moved.filter(([f]) => /\.(mp4|mp3|wav)$/.test(f))) {
          const sec = seconds(path);
          if (Math.abs(sec - job.duration) > 1) throw new Error(`${f} is ${sec.toFixed(2)} s, the dub ${job.duration} s`);
          measured.push(`${f} ${sec.toFixed(2)} s`);
        }
        // WAV on Dubbed audio, then that row alone.
        await app.click('#exportList a[data-row="audio"] [data-fmt="wav"]');
        await app.waitFor("WAV picked", 5000, () => document.querySelector('#exportList a[data-row="audio"] [data-fmt="wav"]')
          .getAttribute("aria-checked") === "true");
        await tickOnly(app, ["audio"]);
        const end2 = await download(app, 90000);
        if (!end2.saved.includes("audio")) throw new Error(`the WAV download stopped: ${end2.where}`);
        const [wav] = moveOut(job, 1, join(ctx.out, "dub-export-wav"));
        if (!wav[0].endsWith(".wav")) throw new Error(`the next download saved ${wav[0]}, not a .wav`);
        const wavSec = seconds(wav[1]);
        if (Math.abs(wavSec - job.duration) > 1) throw new Error(`${wav[0]} is ${wavSec.toFixed(2)} s`);
        // The format as it was remembered; the ticks are put back in storage below.
        const fmt = s.saved["persodub.exportAudio"] === "wav" ? "wav" : "mp3";
        await app.click(`#exportList a[data-row="audio"] [data-fmt="${fmt}"]`);
        return `${ids.length} rows (${ids.join(", ")}) ticked and saved: ${moved.map(([f, , b]) => `${f} ${(b / 1e6).toFixed(2)} MB`).join(", ")}; `
          + `${measured.join(", ")}; WAV on ${app.tr("Dubbed audio")} → ${wav[0]} ${wavSec.toFixed(2)} s; "${end2.where}"; moved into dub-export*/`;
      } finally {
        if (await app.inPage(isOpen, "#exportOverlay")) {
          await app.click("#exportCloseBtn", 120000);
          await app.waitFor("the Download dialog to close", 5000, isClosed, "#exportOverlay");
        }
        for (const k of ["persodub.exportTicks", "persodub.exportAudio"]) {
          await app.inPage((key, v) => { if (v === null) localStorage.removeItem(key); else localStorage.setItem(key, v); return true; }, k, s.saved[k]);
        }
      }
    } },

  { name: "add a language", looks: ["#langRow", "#draftSetup", "#progressCard"],
    async run(app, ctx) {
      const s = ctx.state.dub;
      let jid = "";
      try {
        await onDub(app, s);
        const first = await app.api(`/api/dub/jobs/${s.jobId}`);
        await quiet(app, 180000);
        await app.click("#langAddBtn");
        await app.waitFor("the Before dubbing card with Start lit", 60000, () => !document.querySelector("#draftSetup").hidden
          && !document.querySelector("#draftStartBtn").disabled);
        // Everything on this computer: the card takes the dubbing's own picks, and a cloud one is put back.
        if (await app.js(`document.querySelector("#dubModeSelect").value`) !== "local") await app.choose("#dubModeSelect", "local");
        for (const sel of ["#sepSelect", "#sttSelect"]) {
          if (await app.js(`document.querySelector(${JSON.stringify(sel)}).value`) === "perso") await app.choose(sel, "local");
        }
        const offered = await app.inPage(() => [...document.querySelector("#targetLangSelect").options].map((o) => o.value));
        const lang = ["ja", ...offered].find((c) => offered.includes(c) && c !== first.language_code && c !== first.source_lang);
        await app.choose("#targetLangSelect", lang);
        await app.click("#draftStartBtn");
        const started = await app.waitFor("the dub to start", 120000, (was) => {
          const b = document.body;
          if (b.dataset.screen === "running" && b.dataset.jobId && b.dataset.jobId !== was) return `job:${b.dataset.jobId}`;
          const error = document.querySelector("#draftError").textContent.trim();
          if (error) return `refused: ${error}`;
          const d = document.querySelector(".modal-overlay.open");
          return d ? `#${d.id} opened ("${d.textContent.replace(/\s+/g, " ").trim().slice(0, 200)}")` : "";
        }, s.jobId);
        if (!started.startsWith("job:")) throw new Error(`Start was ${started}`);
        jid = started.slice(4);
        const j = await app.api(`/api/dub/jobs/${jid}`);
        if (j.separation === "perso" || j.stt_engine === "perso" || j.dub_mode !== "local") {
          throw new Error(`PERSO CREDITS ARE BEING SPENT: job ${jid} dubs ${j.dub_mode}, separates ${j.separation}, transcribes ${j.stt_engine}. Stop it now`);
        }
        if (j.language_code !== lang || (j.project_id || j.id) !== (first.project_id || first.id)) {
          throw new Error(`the new dub is ${j.language_code} in project ${j.project_id}, not ${lang} in ${first.id}`);
        }
        // Timed from when it leaves the queue; waited past 900 s so the report says how long it really took.
        const t0 = await until(`job ${jid} to leave the queue`, 60000, async () =>
          ((await app.api(`/api/dub/jobs/${jid}`)).status !== "queued" ? Date.now() : 0));
        const end = await app.waitFor("the second dub to finish", 900000, (id) => {
          const b = document.body;
          if (b.dataset.jobId !== id) return `left: ${b.dataset.screen} ${b.dataset.jobId || ""}`;
          if (b.dataset.screen === "failed") return `failed: ${document.querySelector("#doneFailWhy").textContent.trim()}`;
          return b.dataset.screen === "done" && document.querySelectorAll("#scriptBox .sc-row:not(.head)").length ? "done" : "";
        }, jid);
        const took = (Date.now() - t0) / 1000;
        if (end !== "done") throw new Error(`the ${lang} dub ${end}`);
        const chips = await app.waitFor("two languages in the row", 10000, () => {
          const cs = [...document.querySelectorAll("#langRow .lang-chip[data-job]")];
          return cs.length === 2 && cs.map((c) => ({ job: c.dataset.job, name: c.textContent.trim(), on: c.classList.contains("on") }));
        });
        const words = () => [...document.querySelectorAll("#scriptBox .sc-dst")].map((c) => c.textContent);
        const theirs = await app.inPage(words);
        await app.shot("dub-languages");
        await app.click(`#langRow .lang-chip[data-job="${s.jobId}"]`);
        const ours = await app.waitFor("the first language's table", 20000, (id, them) => {
          if (document.body.dataset.jobId !== id || document.body.dataset.screen !== "done") return null;
          const now = [...document.querySelectorAll("#scriptBox .sc-dst")].map((c) => c.textContent);
          return now.length && JSON.stringify(now) !== JSON.stringify(them) ? now : null;
        }, s.jobId, theirs);
        if (took > 900) throw new Error(`the ${lang} dub took ${took.toFixed(0)} s, over 900 s`);
        return `${lang}${lang === "ja" ? "" : " (일본어 not offered)"} dubbed locally (job ${jid}, ${j.translator}) in ${took.toFixed(0)} s; `
          + `row ${chips.map((c) => `${c.name}${c.on ? "*" : ""}`).join(" + ")}; ${chips.find((c) => !c.on).name} → line 1 `
          + `"${theirs[0]}" → "${ours[0]}"`;
      } finally {
        // A dub of ours left unfinished would take the app from whoever presses it next.
        if (jid && !["done", "failed", "cancelled"].includes((await app.api(`/api/dub/jobs/${jid}`).catch(() => ({}))).status)) {
          await app.api(`/api/dub/jobs/${jid}/cancel`, { method: "POST" }).catch(() => {});
        }
        await app.inPage((key, v) => { if (v === null) localStorage.removeItem(key); else localStorage.setItem(key, v); return true; },
                         "persodub.lastChoices", s.saved["persodub.lastChoices"]).catch(() => {});
        // The area ends on Home, as it began.
        await tidy(app).catch(() => {});
        if (!(await app.inPage(onHome)) && (await app.inPage(pressable, "#homeBtn"))) await app.click("#homeBtn");
        await app.waitFor("the Home screen", 10000, onHome).catch(() => {});
      }
    } },
];

// One zoom press and the scale after it, read off the ruler.
async function zoomVia(app, btn, was) {
  await app.click(btn);
  const now = await until(`${btn} to change the scale`, 5000, async () => {
    const p = await app.inPage(rulerPps);
    return Math.abs(p - was) > 0.5 ? p : 0;
  });
  return [was, now];
}
