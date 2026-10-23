// The tools screens' remaining controls and their hand-offs into dubbing,
// pressed the way a person does, on a fresh draft of the clip: Separate audio
// (this computer's model only), the timeline's two mute buttons, a cut that
// sets the separation aside and Undo that brings it back, and Dubbing from
// that separation; then Erase subtitles on a new copy (the minutes, the box
// moved and stretched, Original/Erased, Erase another part, Back after a
// cancelled erase, Dubbing from the erased video, not started); then Subtitle
// style's result card and its project of a video and a .srt.
//
// An erase of this clip that an e2e- project already finished (the same box,
// the whole video) is opened from Home instead of erasing again, which takes
// about 7 minutes. With SWEEP_LOCK set to the shared lock folder, the area
// takes it before its first press, gives it back while the dub or the erase
// runs, and takes it again to read the result.
import { copyFileSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sleep, shown, isOpen, onHome, textOf } from "../lib/cdp.mjs";

export const area = "tools2";

const CHOICES_KEY = "persodub.lastChoices";
const LIVE = ["queued", "running", "cancelling"];

// ---- the shared lock ----------------------------------------------------------

const LOCK = process.env.SWEEP_LOCK || "";
const ME = `sweep-tools2 ${process.pid}`;
let held = false;

async function take() {
  if (!LOCK || held) return;
  const end = Date.now() + 90 * 60000;
  for (;;) {
    try {
      mkdirSync(LOCK);
      writeFileSync(join(LOCK, "who"), `${ME} ${new Date().toTimeString().slice(0, 8)}\n`);
      held = true;
      return;
    } catch { /* someone else has it */ }
    if (Date.now() > end) throw new Error(`${LOCK} was not free for 90 minutes`);
    await sleep(15000);
  }
}
function give() {
  if (!LOCK || !held) return;
  held = false;
  try {
    if (!readFileSync(join(LOCK, "who"), "utf8").startsWith(ME)) return;
    unlinkSync(join(LOCK, "who"));
    rmdirSync(LOCK);
  } catch { /* already gone */ }
}
process.on("exit", give);
// Stopped from outside: the lock is given back before the process goes.
for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => { give(); process.exit(130); });

// A job the app runs on its own: followed by its record with the lock given
// back, so others can press the app meanwhile; the lock is taken again after.
async function waitJob(app, jid, ms) {
  give();
  try {
    const end = Date.now() + ms;
    for (;;) {
      const j = await app.api(`/api/dub/jobs/${jid}`);
      if (!LIVE.includes(j.status)) return j;
      if (Date.now() > end) throw new Error(`job ${jid} is still ${j.status} after ${ms / 1000} s`);
      await sleep(5000);
    }
  } finally {
    await take();
  }
}

// ---- the page -----------------------------------------------------------------

async function home(app) {
  if (!(await app.inPage(onHome))) await app.click("#homeBtn");
  await app.waitFor("the Home screen", 10000, onHome);
}

// A press, moves and a release with the mouse, the way a hand drags.
async function drag(app, x, y, dx, dy) {
  const m = (type, px, py, buttons) => app.send("Input.dispatchMouseEvent", { type, x: px, y: py, button: "left", buttons, clickCount: 1 });
  await m("mousePressed", x, y, 1);
  await m("mouseMoved", x + dx / 2, y + dy / 2, 1);
  await m("mouseMoved", x + dx, y + dy, 1);
  await m("mouseReleased", x + dx, y + dy, 0);
}

// The erase box as the page holds it: its place on screen and, read back
// through the picture's scale, the area in the frame's pixels [y0, y1, x0, x1].
const BOX = () => {
  const v = document.querySelector("#eraseVideo"), b = document.querySelector("#eraseBox");
  const st = document.querySelector("#eraseStage").getBoundingClientRect();
  const W = v.videoWidth, H = v.videoHeight;
  const s = Math.min(st.width / W, st.height / H);
  const pl = (st.width - W * s) / 2, pt = (st.height - H * s) / 2;
  const [L, T, w, h] = ["left", "top", "width", "height"].map((k) => parseFloat(b.style[k]));
  return { W, H, s, w, h, area: [(T - pt) / s, (T + h - pt) / s, (L - pl) / s, (L + w - pl) / s].map(Math.round) };
};
// Where on screen to press the box: a corner's handle, or its middle.
const GRIP = (handle) => {
  const el = handle ? document.querySelector(`#eraseBox [data-handle="${handle}"]`) : document.querySelector("#eraseBox");
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  return { x, y, ok: handle ? hit?.dataset.handle === handle : !!hit?.closest("#eraseBox") && !hit.dataset.handle };
};
const near = (a, b, d = 2) => a.every((v, i) => Math.abs(v - b[i]) <= d);

// `get` asked every quarter second until it answers.
async function poll(what, ms, get) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`waited ${ms / 1000} s for ${what}`);
    await sleep(250);
  }
}

async function resetBox(app, offered) {
  await app.click("#eraseResetBtn");
  await poll("the box back where it was offered", 5000, async () => near((await app.inPage(BOX)).area, offered));
}

// The box screen on a held video: the box placed where the subtitles were found.
async function boxPlaced(app, did) {
  const r = await app.waitFor("the box placed where the subtitles were found", 300000, (id) => {
    if (document.body.dataset.screen !== "erase") return null;
    const err = document.querySelector("#eraseError").textContent.trim();
    if (err) return { error: err };
    const b = document.querySelector("#eraseBox"), v = document.querySelector("#eraseVideo");
    const src = v.getAttribute("src") || "";
    return !b.hidden && b.classList.contains("found") && v.videoWidth && (!id || src.endsWith(`/api/downloads/${id}/video`))
      && document.querySelector("#eraseRunBtn").getClientRects().length ? { src } : null;
  }, did || "");
  if (r.error) throw new Error(`the Erase tab says: ${r.error}`);
  return r.src;
}

// The finished erase `jid` on screen with its Erased tab up; opened from its
// Home card when the screen is somewhere else.
async function erasedOnScreen(app, jid) {
  const up = (id) => document.body.dataset.screen === "erase"
    && (document.querySelector("#eraseVideo").getAttribute("src") || "").includes(`/api/erase/${id}/`)
    && document.querySelector("#eraseDubBtn").getClientRects().length > 0 && document.querySelector("#eraseVideo").videoWidth > 0;
  if (await app.inPage(up, jid)) return "on screen";
  await home(app);
  await app.click(`#projectsGrid .proj-card[data-job="${jid}"]`);
  await app.waitFor(`erase ${jid} opened with its result`, 20000, up, jid);
  return "opened from its Home card";
}

// The draft timeline's ruler pressed at `at` seconds of a whole video: the
// playhead goes there, and the video with it.
async function seekRuler(app, video, at, total) {
  const p = await app.inPage((k, tot) => {
    const inner = document.querySelector("#timeline .tl-inner");
    const ruler = inner && inner.querySelector(".tl-ruler");
    const cuts = inner ? [...inner.querySelectorAll(".tl-cut")] : [];
    if (!ruler || !cuts.length) return null;
    const last = cuts[cuts.length - 1];
    const pps = (parseFloat(last.style.left) + parseFloat(last.style.width) + 2) / tot;
    const r = ruler.getBoundingClientRect();
    return { x: inner.getBoundingClientRect().left + k * pps, y: r.top + r.height / 2, pps };
  }, at, total);
  if (!p) throw new Error("the timeline has no ruler or no clip to press");
  let x = p.x;
  for (let i = 0; i < 2; i++) {
    const hit = await app.inPage((px, py) => !!document.elementFromPoint(px, py)?.closest(".tl-ruler"), x, p.y);
    if (!hit) throw new Error(`the ruler is not under (${Math.round(x)}, ${Math.round(p.y)})`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await app.send("Input.dispatchMouseEvent", { type, x, y: p.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
    }
    await sleep(300);
    const got = await app.inPage((v) => document.querySelector(v).currentTime, video);
    if (Math.abs(got - at) <= 0.04) return got;
    x += (at - got) * p.pps;
  }
  throw new Error(`the ruler press did not bring the playhead to ${at} s`);
}

// What a dub started from the prep screen would run on: never Perso.
const choices = () => ({ mode: document.querySelector("#dubModeSelect").value, sep: document.querySelector("#sepSelect").value,
                         stt: document.querySelector("#sttSelect").value });

// A card on Home deleted with its menu and the dialog's Delete: `kind` is
// "more" for a project, "more-draft" for a draft. Only e2e- names.
async function deleteCard(app, kind, id) {
  const sel = `#projectsGrid .proj-more[data-${kind}="${id}"]`;
  const name = await app.inPage((q) => (document.querySelector(q)?.closest(".proj-card")?.querySelector(".proj-name")?.textContent || "").trim(), sel);
  if (!name) return "";
  if (!name.startsWith("e2e-")) throw new Error(`card ${id} is "${name}", not an e2e- card; left alone`);
  // The menu button shows on a card under the pointer or with the focus;
  // a pointer move is not taken by a window another one covers (lib/cdp.mjs),
  // so the card is given the focus, as Tab gives it.
  await app.inPage((q) => { document.querySelector(q).closest(".proj-card").focus(); return true; }, sel);
  await app.click(sel);
  await app.waitFor("the card menu", 5000, shown, "#projectMenuDelete");
  await app.click("#projectMenuDelete");
  await app.waitFor("the delete dialog", 5000, isOpen, "#deleteOverlay");
  await app.click("#deleteConfirmBtn");
  await app.waitFor(`card ${id} to go`, 20000, (q) => !document.querySelector("#deleteOverlay").classList.contains("open") && !document.querySelector(q), sel);
  return name;
}

// ---- the steps ----------------------------------------------------------------

export const steps = [
  { name: "separate", looks: ["#tabAudio"], async run(app, ctx) {
    const s = ctx.state;
    await take();
    s.name = `e2e-tools2-${ctx.stamp}`;
    s.video = join(ctx.out, `${s.name}.mp4`);
    copyFileSync(ctx.video, s.video);
    s.choices = await app.inPage((k) => localStorage.getItem(k), CHOICES_KEY);
    await home(app);
    await app.click("#homeAudioCard");
    await app.waitFor("the Audio tab's Import block", 10000, shown, "#audioZone .import-head");
    await app.feed("#audioZone .import-head", s.video);
    const c = await app.waitFor("the Audio tab's Separate button", 120000, () => {
      const st = document.querySelector("#audioImportStatus");
      if (st.classList.contains("error") && st.textContent.trim()) return { refused: st.textContent.trim() };
      return document.querySelector("#audioRunBtn").getClientRects().length ? { engine: document.querySelector("#audioEngine").value } : null;
    });
    if (c.refused) throw new Error(`the import was refused: ${c.refused}`);
    if (c.engine !== "local") await app.choose("#audioEngine", "local");
    const t0 = Date.now();
    await app.click("#audioRunBtn");
    // Ten minutes: a job of someone else's may be ahead of it in the line.
    const r = await app.waitFor("the Voice and Background rows", 600000, () => {
      const on = (id) => document.getElementById(id).getClientRects().length > 0;
      const error = document.querySelector("#audioError").textContent.trim();
      if (error || on("audioRetryBtn")) return { error: error || document.querySelector("#audioState").textContent.trim() };
      return on("audioVoiceRow") && on("audioBackgroundRow") ? { src: document.querySelector("#audioVoice").getAttribute("src") || "" } : null;
    });
    if (r.error) throw new Error(`separating stopped: ${r.error}`);
    s.sepJob = (/\/api\/dub\/result\/([^/]+)\/stem\//.exec(r.src) || [])[1];
    if (!s.sepJob) throw new Error(`the voice plays from "${r.src}", not a separation's stem`);
    const job = await app.api(`/api/dub/jobs/${s.sepJob}`);
    if (job.separation === "perso") throw new Error(`PERSO CREDITS WERE SPENT: job ${s.sepJob} separated on Perso`);
    if (job.kind !== "separate" || job.status !== "done") throw new Error(`job ${s.sepJob} is ${job.kind} ${job.status}`);
    s.sep = job;
    return `job ${s.sepJob} ${job.kind} ${job.separation}/${job.separation_model} done ${Math.round((Date.now() - t0) / 1000)} s after the press `
      + `(${job.elapsed_seconds} s of work); Voice and Background rows on show`;
  } },

  { name: "lane mutes", looks: ["#timeline"], async run(app, ctx) {
    if (!ctx.state.sepJob) throw new Error("no separation (the step before failed)");
    const said = [];
    for (const [stem, el] of [["voice", "#audioVoice"], ["background", "#audioBackground"]]) {
      const btn = `#timeline .tl-mute[data-stem="${stem}"]`;
      const read = (b, e) => ({ muted: document.querySelector(e).muted, pressed: document.querySelector(b)?.getAttribute("aria-pressed") });
      const was = await app.inPage(read, btn, el);
      if (was.muted || was.pressed !== "false") throw new Error(`the ${stem} starts muted=${was.muted}, aria-pressed ${was.pressed}`);
      for (const want of [true, false]) {
        await app.click(btn);
        await app.waitFor(`${el}.muted ${want}`, 5000, (b, e, w) => document.querySelector(e).muted === w
          && document.querySelector(b).getAttribute("aria-pressed") === String(w), btn, el, want);
      }
      said.push(`${stem}: muted false → true → false`);
    }
    return `${said.join("; ")} (aria-pressed with it)`;
  } },

  { name: "cut sets the separation aside", looks: ["#tabAudio", "#timeline"], async run(app, ctx) {
    const s = ctx.state;
    if (!s.sepJob) throw new Error("no separation");
    const card = () => ({ rows: ["audioVoiceRow", "audioBackgroundRow"].filter((id) => document.getElementById(id).getClientRects().length).length,
                          result: document.querySelector("#audioResult").getClientRects().length > 0,
                          run: document.querySelector("#audioRunBtn").getClientRects().length > 0,
                          len: (document.querySelector("#audioPartCard .vc-len")?.firstChild?.textContent || "").trim(),
                          src: document.querySelector("#audioVoice").getAttribute("src") || "" });
    const total = await app.inPage(() => document.querySelector("#doneVideo").duration);
    const was = await app.inPage(card);
    await seekRuler(app, "#doneVideo", 1, total);
    await app.click("#tlDelLeft");
    const cut = await poll("the result set aside", 5000, async () => {
      const c = await app.inPage(card);
      return c.rows === 0 && c.result && c.run ? c : null;
    });
    await app.click("#tlUndo");
    const back = await poll("the two rows again", 5000, async () => {
      const c = await app.inPage(card);
      return c.rows === 2 && !c.result && c.src.includes(`/result/${s.sepJob}/`) ? c : null;
    });
    if (was.rows !== 2 || cut.len === was.len || back.len !== was.len) throw new Error(`lengths ${was.len} → ${cut.len} → ${back.len}, rows ${was.rows}`);
    return `${was.len}, 2 rows → playhead 1.0, ${app.tr("Delete left of playhead")} → ${cut.len}, 0 rows, "${app.tr("What you get")}" card and Separate back `
      + `→ ${app.tr("Undo")} → ${back.len}, 2 rows of job ${s.sepJob} again`;
  } },

  { name: "dub from the separation", looks: ["#draftSetup", "#progressCard"], async run(app, ctx) {
    const s = ctx.state;
    if (!s.sepJob) throw new Error("no separation");
    await app.click("#audioDubBtn");
    await app.waitFor("the Before dubbing card with Start lit", 30000, () => !document.querySelector("#draftSetup").hidden
      && !document.querySelector("#draftStartBtn").disabled && !!document.querySelector('#leftTabs [data-tab="dubbing"].on'));
    if ((await app.inPage(choices)).mode !== "local") await app.choose("#dubModeSelect", "local");
    for (const sel of ["#sepSelect", "#sttSelect"]) {
      if (await app.inPage((q) => document.querySelector(q).value, sel) === "perso") await app.choose(sel, "local");
    }
    const c = await app.inPage(choices);
    if (c.mode !== "local" || c.sep === "perso" || c.stt === "perso") throw new Error(`the choices would spend Perso credits: ${JSON.stringify(c)}`);
    const t0 = Date.now();
    await app.click("#draftStartBtn");
    const started = await app.waitFor("the dub to start", 60000, () => {
      const b = document.body;
      if (b.dataset.jobId) return `job:${b.dataset.jobId}`;
      const error = document.querySelector("#draftError").textContent.trim();
      if (error) return `refused: ${error}`;
      const d = document.querySelector(".modal-overlay.open");
      return d ? `#${d.id} opened` : "";
    });
    if (!started.startsWith("job:")) {
      if (started.includes("opened")) await app.key("Escape");
      throw new Error(`Start was ${started}`);
    }
    const jid = started.slice(4);
    const first = await app.api(`/api/dub/jobs/${jid}`);
    if (first.dub_mode !== "local" || first.separation === "perso" || first.stt_engine === "perso") {
      throw new Error(`PERSO CREDITS: job ${jid} runs ${first.dub_mode}/${first.separation}/${first.stt_engine}`);
    }
    const job = await waitJob(app, jid, 1800000);
    const took = Math.round((Date.now() - t0) / 1000);
    if (job.status !== "done") throw new Error(`dub ${jid} ended ${job.status}: ${job.error || ""}`);
    const sec = (job.stage_seconds || {}).separate;
    const same = job.separation === s.sep.separation && job.separation_model === s.sep.separation_model && job.download_id === s.sep.download_id;
    if (!same) {
      throw new Error(`dub ${jid} separated ${job.separation}/${job.separation_model} of ${job.download_id}; the separation was `
        + `${s.sep.separation}/${s.sep.separation_model} of ${s.sep.download_id}`);
    }
    if (!(sec <= 1)) throw new Error(`dub ${jid} spent ${sec} s separating (stage_seconds ${JSON.stringify(job.stage_seconds)}): the stems were not reused`);
    // The finished dub on screen for the picture.
    await home(app);
    await app.click(`#projectsGrid .proj-card[data-job="${jid}"]`);
    await app.waitFor("the finished dub", 20000, (id) => document.body.dataset.screen === "done" && document.body.dataset.jobId === id, jid);
    return `dub ${jid} (${job.dub_mode}, ${job.stt_engine}, ${job.translator}, ${job.language_code}) done ${took} s after Start; `
      + `separation ${job.separation}/${job.separation_model} of held ${job.download_id} = job ${s.sepJob}'s; stage_seconds.separate ${sec}`;
  } },

  { name: "erase minutes", looks: ["#eraseAreaCard", "#topbar"], async run(app, ctx) {
    const s = ctx.state;
    await home(app);
    await app.click("#homeEraseCard");
    await app.waitFor("the Erase tab's Import block", 10000, shown, "#eraseZone .import-head");
    const video = join(ctx.out, `${s.name || `e2e-tools2-${ctx.stamp}`}-erase.mp4`);
    copyFileSync(ctx.video, video);
    await app.feed("#eraseZone .import-head", video);
    const src = await boxPlaced(app, "");
    s.did = (/\/api\/downloads\/([^/]+)\/video/.exec(src) || [])[1];
    if (!s.did) throw new Error(`the erase video plays "${src}", not a held video`);
    const before = await app.inPage(BOX);
    s.offered = before.area;
    const { platform } = await app.api("/api/models");
    const read = () => ({ est: document.querySelector("#eraseEst").getClientRects().length ? document.querySelector("#eraseEst").textContent.trim() : "",
                          noGpu: document.querySelector("#eraseNoGpu").getClientRects().length ? document.querySelector("#eraseNoGpu").textContent.trim() : "",
                          result: document.querySelector("#eraseResult").getClientRects().length > 0,
                          big: document.querySelector("#eraseBigBox").getClientRects().length ? document.querySelector("#eraseBigBox").textContent.trim() : "" });
    const a = await app.inPage(read);
    const minutes = (t) => Number((/(\d+)/.exec(t) || [])[1]);
    if (!(minutes(a.est) >= 1)) throw new Error(`the top bar's estimate reads "${a.est}"`);
    const wantNoGpu = platform === "win-cpu";
    if (!!a.noGpu !== wantNoGpu) throw new Error(`on ${platform} the no-graphics-card line is ${a.noGpu ? `"${a.noGpu}"` : "away"}`);
    if (a.result === wantNoGpu) throw new Error(`the result card is ${a.result ? "on show" : "away"} beside ${a.noGpu ? "the warning" : "no warning"}`);
    const g = await app.inPage(GRIP, "se");
    if (!g.ok) throw new Error("the bottom-right handle is covered");
    await drag(app, g.x, g.y, before.w, before.h);
    const after = await app.inPage(BOX);
    await sleep(300);
    const b = await app.inPage(read);
    await resetBox(app, s.offered);
    const grew = ((after.area[1] - after.area[0]) * (after.area[3] - after.area[2])) / ((before.area[1] - before.area[0]) * (before.area[3] - before.area[2]));
    if (grew < 1.5) throw new Error(`the box grew only ${grew.toFixed(2)}x: ${before.area} → ${after.area}`);
    if (!(minutes(b.est) >= minutes(a.est))) throw new Error(`the estimate fell from "${a.est}" to "${b.est}" when the box grew`);
    return `${platform}: "${a.est}", no-graphics-card line ${a.noGpu ? `"${a.noGpu}"` : "away"} (shown only on win-cpu), result card ${a.result ? "on show" : "away"}; `
      + `box ${before.area} dragged +${before.w.toFixed(0)},+${before.h.toFixed(0)} px → ${after.area} (${grew.toFixed(2)}x area) → "${b.est}"`
      + `${b.big ? `, warning "${b.big}"` : ""}; ${app.tr("Reset")} → ${s.offered}`;
  } },

  { name: "erase box drags", looks: ["#eraseAreaCard", "#eraseStage"], async run(app, ctx) {
    const s = ctx.state;
    if (!s.offered) throw new Error("no box (the step before failed)");
    const before = await app.inPage(BOX);
    const m = await app.inPage(GRIP, "");
    if (!m.ok) throw new Error("the middle of the box is not the box's to press");
    await drag(app, m.x, m.y, -30, -30);
    const moved = await app.inPage(BOX);
    const d = 30 / before.s;
    const want = [before.area[0] - d, before.area[1] - d, before.area[2] - d, before.area[3] - d];
    if (!near(moved.area, want, 3)) throw new Error(`moved −30,−30 px: ${before.area} → ${moved.area}, not about ${want.map(Math.round)}`);
    const c = await app.inPage(GRIP, "nw");
    if (!c.ok) throw new Error("the top-left handle is covered");
    await drag(app, c.x, c.y, -20, -10);
    const sized = await app.inPage(BOX);
    const want2 = [moved.area[0] - 10 / before.s, moved.area[1], moved.area[2] - 20 / before.s, moved.area[3]];
    if (!near(sized.area, want2, 3)) throw new Error(`top-left corner −20,−10 px: ${moved.area} → ${sized.area}, not about ${want2.map(Math.round)}`);
    await resetBox(app, s.offered);
    const size = (a) => `${a[3] - a[2]}x${a[1] - a[0]}`;
    return `box ${before.area} (${size(before.area)}, ${before.s.toFixed(3)} screen px a frame px); dragged −30,−30 px → ${moved.area} `
      + `(${size(moved.area)}, moved ${Math.round(d)} frame px); top-left corner −20,−10 px → ${sized.area} (${size(sized.area)}); ${app.tr("Reset")} → ${s.offered}`;
  } },

  { name: "erased result", looks: ["#erasePartCard", "#eraseTabs"], async run(app, ctx) {
    const s = ctx.state;
    if (!s.offered) throw new Error("no box");
    const { jobs } = await app.api("/api/dub/jobs");
    const same = jobs.find((j) => j.kind === "erase" && j.status === "done" && /^e2e-/.test(j.project || "") && !j.trim && !j.ranges
      && Array.isArray(j.area) && near(j.area, s.offered));
    if (same) {
      s.eraseJob = same.id;
      s.reused = true;
      const how = await erasedOnScreen(app, same.id);
      const rec = await app.api(`/api/erase/${same.id}`);
      return `reused "${same.project}" erase ${same.id} of ${same.created} (area ${same.area}, whole video), ${how}; `
        + `check: text in ${rec.check?.frames_with_text} of ${rec.check?.frames_checked} frames`;
    }
    const t0 = Date.now();
    await app.click("#eraseRunBtn");
    s.eraseJob = (await app.waitFor("the erase's job", 30000, () => /\/api\/erase\/([^/]+)\//.exec(document.querySelector("#eraseVideo").getAttribute("src") || "")?.[1]
      || (document.querySelector("#eraseError").textContent.trim() ? "!" + document.querySelector("#eraseError").textContent.trim() : "")));
    if (s.eraseJob.startsWith("!")) throw new Error(`the erase was refused: ${s.eraseJob.slice(1)}`);
    await app.shot("tools2-erase-running");
    const job = await waitJob(app, s.eraseJob, 1800000);
    if (job.status !== "done") throw new Error(`erase ${s.eraseJob} ended ${job.status}: ${job.error || ""}`);
    const how = await erasedOnScreen(app, s.eraseJob);
    const rec = await app.api(`/api/erase/${s.eraseJob}`);
    return `erased ${s.eraseJob} (area ${job.area}) done ${Math.round((Date.now() - t0) / 1000)} s after the press (${job.elapsed_seconds} s of work), ${how}; `
      + `check: text in ${rec.check?.frames_with_text} of ${rec.check?.frames_checked} frames`;
  } },

  { name: "erase compare tabs", looks: ["#eraseTabs", "#eraseVideo"], async run(app, ctx) {
    const s = ctx.state;
    if (!s.eraseJob) throw new Error("no erased video");
    await erasedOnScreen(app, s.eraseJob);
    const said = [];
    for (const [tab, tail] of [["original", "/original"], ["erased", "/video"]]) {
      await app.click(`#eraseTabs [data-erase="${tab}"]`);
      const r = await app.waitFor(`the ${tab} video`, 10000, (t, want) => {
        const v = document.querySelector("#eraseVideo"), src = v.getAttribute("src") || "";
        return document.querySelector(`#eraseTabs [data-erase="${t}"]`).classList.contains("active") && src.endsWith(want) && v.duration > 0
          ? { src, len: v.duration, label: document.querySelector(`#eraseTabs [data-erase="${t}"]`).textContent.trim() } : null;
      }, tab, `/api/erase/${s.eraseJob}${tail}`);
      said.push(`"${r.label}" → ${r.src} ${r.len.toFixed(2)} s`);
    }
    return said.join("; ");
  } },

  { name: "erase again and back", looks: ["#eraseFoot", "#eraseAreaCard"], async run(app, ctx) {
    const s = ctx.state;
    if (!s.eraseJob || !s.did) throw new Error("no erased video or no held one");
    const said = [];
    await erasedOnScreen(app, s.eraseJob);
    const back = await app.inPage(shown, "#eraseBackBtn");
    if (back) throw new Error("Back is on show beside a finished erase");
    if (await app.inPage(shown, "#eraseAgainBtn")) {
      await app.click("#eraseAgainBtn");
      await boxPlaced(app, s.did);
      said.push(`${app.tr("Erase another part")} → the box screen on held ${s.did}`);
    } else {
      // A job opened from Home has no held video behind it: the draft card is the way to one.
      said.push(`${app.tr("Erase another part")} not offered (the erase was opened from Home, no held video)`);
      await home(app);
      await app.click(`#projectsGrid .proj-card[data-draft="${s.did}"]`);
      await boxPlaced(app, s.did);
      said.push(`draft card → the box screen on held ${s.did}`);
    }
    const area = (await app.inPage(BOX)).area;
    // Back is for an erase that stopped: one is started and cancelled at once.
    await app.click("#eraseRunBtn");
    const jid = await app.waitFor("the erase's job", 30000, () => /\/api\/erase\/([^/]+)\//.exec(document.querySelector("#eraseVideo").getAttribute("src") || "")?.[1]);
    s.cancelled = jid;
    await app.click("#eraseCancelBtn");
    const stopped = await app.waitFor("Back after the cancel", 120000, () => document.querySelector("#eraseBackBtn").getClientRects().length
      ? document.querySelector("#eraseState").textContent.trim() : "");
    const j = await app.api(`/api/dub/jobs/${jid}`);
    if (j.status !== "cancelled" || stopped !== app.tr("Erasing was cancelled.")) throw new Error(`erase ${jid} is ${j.status}, the card says "${stopped}"`);
    await app.click("#eraseBackBtn");
    await boxPlaced(app, s.did);
    const again = (await app.inPage(BOX)).area;
    if (!near(again, area)) throw new Error(`Back brought the box to ${again}, not ${area}`);
    said.push(`${app.tr("Erase")} → ${app.tr("Cancel")}: erase ${jid} cancelled, "${stopped}" → ${app.tr("Back")} → the box screen, box ${again} as before`);
    return said.join("; ");
  } },

  { name: "erased to dubbing", looks: ["#draftSetup", "#eraseFoot"], async run(app, ctx) {
    const s = ctx.state;
    if (!s.eraseJob) throw new Error("no erased video");
    await erasedOnScreen(app, s.eraseJob);
    await app.click("#eraseDubBtn");
    const r = await app.waitFor("Before dubbing on the erased video", 30000, () => {
      const err = document.querySelector("#eraseError").textContent.trim();
      if (err) return { error: err };
      if (document.querySelector("#draftSetup").hidden) return null;
      const src = document.querySelector("#doneVideo").getAttribute("src") || "";
      const len = (document.querySelector("#draftPartCard .vc-len")?.textContent || "").trim();
      return src && len ? { src, len, job: document.body.dataset.jobId || "", tab: !!document.querySelector('#leftTabs [data-tab="dubbing"].on') } : null;
    });
    if (r.error) throw new Error(`Dubbing says: ${r.error}`);
    const did = (/\/api\/downloads\/([^/]+)\/video/.exec(r.src) || [])[1];
    if (!did || did === s.did) throw new Error(`the prep video plays "${r.src}", not a new held copy`);
    s.dubDraft = did;
    if (r.len !== "00:10" || r.job || !r.tab) throw new Error(`the card reads ${r.len}, job "${r.job}", Dubbing tab ${r.tab ? "on" : "off"}`);
    // The same file: the held copy is as long in bytes as the erased video.
    const bytes = async (path) => {
      const res = await fetch(app.origin + path, { signal: AbortSignal.timeout(10000) });
      await res.body?.cancel();
      return Number(res.headers.get("content-length"));
    };
    const [held, erased] = [await bytes(`/api/downloads/${did}/video`), await bytes(`/api/erase/${s.eraseJob}/video`)];
    if (!held || held !== erased) throw new Error(`the held copy is ${held} bytes, the erased video ${erased}`);
    return `${app.tr("Dubbing")} → "${await app.inPage(textOf, "#draftSetup .draft-label > span")}", #doneVideo ${r.src} (a new held copy; `
      + `${held} bytes = /api/erase/${s.eraseJob}/video), ${r.len}, no job started`;
  } },

  { name: "subtitle style result card", looks: ["#capResult", "#tabCaptions"], async run(app) {
    await home(app);
    await app.click("#homeDubCard");
    await app.waitFor("the Dubbing tab's Import block", 10000, shown, "#dubbingZone .import-head");
    await app.click('#leftTabs [data-tab="captions"]');
    await app.waitFor("the tab's video and subtitle file blocks", 10000, () =>
      ["#capAlone", "#capZone", "#capSrtZone"].every((q) => document.querySelector(q)?.getClientRects().length > 0));
    const c = await app.inPage(() => {
      const r = document.querySelector("#capResult");
      const box = r.getBoundingClientRect(), col = document.querySelector("#tabCaptions").getBoundingClientRect();
      const inView = box.top >= col.top && box.bottom <= Math.min(col.bottom, innerHeight);
      r.scrollIntoView({ block: "nearest" });
      return { on: r.getClientRects().length > 0, k: r.querySelector(".k").textContent.trim(), m: r.querySelector(".m").textContent.trim(),
               files: document.querySelector("#capFiles").getClientRects().length > 0, inView, top: Math.round(box.top), colBottom: Math.round(col.bottom) };
    });
    const m = app.tr("The video with subtitles burned in, and the subtitle file");
    if (!c.on || c.files || c.k !== app.tr("What you get") || c.m !== m) throw new Error(`the card is ${c.on ? `"${c.k}" / "${c.m}"` : "away"}, files row ${c.files ? "on show" : "away"}`);
    return `before the files: "${c.k}" / "${c.m}" (the subtitled video and the .srt), no files row; `
      + (c.inView ? "in view" : `below the fold (top ${c.top} px, the tab ends at ${c.colBottom} px), scrolled to`);
  } },

  { name: "subtitle style project", looks: ["#capFiles", "#timeline", "#videoTabsNormal"], async run(app, ctx) {
    const s = ctx.state;
    if (!ctx.srt) throw new Error("this step needs --srt");
    const video = join(ctx.out, `${s.name || `e2e-tools2-${ctx.stamp}`}-cap.mp4`);
    copyFileSync(ctx.video, video);
    await app.feed("#capZone .import-head", video);
    await app.waitFor("the video's card in the tab", 120000, shown, "#capVideoCard");
    await app.feed("#capSrtZone", ctx.srt);
    const f = await app.waitFor("the files row", 60000, () => {
      const st = document.querySelector("#capImportStatus");
      if (st.classList.contains("error") && st.textContent.trim()) return { refused: st.textContent.trim() };
      return document.querySelector("#capFiles").getClientRects().length ? { job: document.body.dataset.jobId } : null;
    });
    if (f.refused) throw new Error(`the subtitle file was refused: ${f.refused}`);
    const job = await app.api(`/api/dub/jobs/${f.job}`);
    if (job.kind !== "captions" || job.status !== "done") throw new Error(`job ${f.job} is ${job.kind} ${job.status}`);
    const v = await app.waitFor("the timeline's lanes", 10000, () => {
      const on = (el) => el.getClientRects().length > 0;
      const lanes = [...document.querySelectorAll("#timeline .tl-name")].filter(on).map((n) => n.textContent.trim());
      const legend = document.querySelector("#timeline .tl-legend");
      return lanes.length ? { tabs: [...document.querySelectorAll("#videoTabsNormal .vtab")].filter(on).map((b) => b.textContent.trim()),
                              lanes, legend: legend ? legend.children.length + legend.textContent.trim().length : -1 } : null;
    });
    const want = [app.tr("Video"), app.tr("Captions")];
    if (v.tabs.join() !== app.tr("Original") || v.lanes.join() !== want.join() || v.legend !== 0) {
      throw new Error(`video tabs ${v.tabs.join("/")}, lanes ${v.lanes.join("/")}, legend ${v.legend < 0 ? "missing" : `${v.legend} children+chars`}`);
    }
    return `captions job ${f.job}: video tabs [${v.tabs.join(", ")}], timeline lanes [${v.lanes.join(", ")}], legend empty`;
  } },

  { name: "home", looks: ["#screen-home"], async run(app, ctx) {
    const s = ctx.state;
    try {
      await app.inPage((k, v) => { if (v === null || v === undefined) localStorage.removeItem(k); else localStorage.setItem(k, v); return true; }, CHOICES_KEY, s.choices ?? null);
      const open = await app.inPage(() => document.querySelector(".modal-overlay.open")?.id || "");
      if (open) await app.key("Escape");
      await home(app);
      const gone = [];
      for (const [kind, id] of [["more", s.cancelled], ["more-draft", s.did], ["more-draft", s.dubDraft]]) {
        // Tidying is not the feature under test: a card whose menu will not show (a job still busy, a grid not yet redrawn) is left and named.
        if (id) { try { const n = await deleteCard(app, kind, id); if (n) gone.push(`"${n}" (${id})`); } catch (e) { gone.push(`${id} left (${e.message.slice(0, 60)})`); } }
      }
      const dialog = await app.inPage(() => document.querySelector(".modal-overlay.open")?.id || "");
      if (dialog) throw new Error(`#${dialog} is open`);
      return `Home, no dialog open; ${CHOICES_KEY} put back; deleted ${gone.join(", ") || "nothing"}`;
    } finally {
      give();
    }
  } },
];
