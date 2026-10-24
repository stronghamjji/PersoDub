// The tools tabs of the work screen, pressed the way a person does: Erase
// subtitles on a new project (the box, the part, the erase itself and its
// download), then Burn in subtitles from Home with a video and a .srt (the
// twelve looks, the size, the scope, Show, and two looks burned in).
//
// It moves every file it downloads out of Downloads into <out>/erase and
// captions, and puts back the Download dialog's remembered ticks and audio
// format at the end. ffprobe and ffmpeg (PATH, or PERSODUB_FFPROBE /
// PERSODUB_FFMPEG) measure what it downloads. The erase of a 10 s clip takes
// about 7 minutes on an M4 MacBook Air.
//
// SWEEP_TOOLS=erase,captions (the default) runs both; either alone runs that
// part and the last step, so a shared app can be held for one part at a time.
// A job's limit (600 s to erase) counts from when it
// leaves the app's queue: the app does one local job at a time, and a job of
// someone else's ahead of it is waiting, not this tab being slow.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { homedir } from "node:os";
import { sleep, shown, onHome, textOf } from "../lib/cdp.mjs";

export const area = "tools";

const TICKS_KEY = "persodub.exportTicks";
const AUDIO_KEY = "persodub.exportAudio";
const FFPROBE = process.env.PERSODUB_FFPROBE || "ffprobe";
const FFMPEG = process.env.PERSODUB_FFMPEG || "ffmpeg";
const DOWNLOADS = join(homedir(), "Downloads");

// ---- files ------------------------------------------------------------------

function seconds(path) {
  const r = spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration",
                                "-of", "default=noprint_wrappers=1:nokey=1", path], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffprobe could not read ${basename(path)}: ${(r.stderr || r.error?.message || "").trim().slice(0, 200)}`);
  return Number(r.stdout.trim());
}

// One frame at `at` seconds, 160x90 in grey levels.
function frame(path, at) {
  const r = spawnSync(FFMPEG, ["-v", "error", "-ss", String(at), "-i", path, "-frames:v", "1",
                               "-vf", "scale=160:90,format=gray", "-f", "rawvideo", "-"], { maxBuffer: 1 << 20 });
  if (r.status !== 0 || r.stdout.length !== 160 * 90) throw new Error(`ffmpeg could not read a frame of ${basename(path)} at ${at} s`);
  return r.stdout;
}

// Whether `p` is somewhere under Downloads, judged by path.relative, which
// takes Windows' backslashes and drive letters (in either case) as they are.
const inDownloads = (p) => { const r = relative(DOWNLOADS, p); return !!r && !r.startsWith("..") && !isAbsolute(r); };

// Files the run saved, out of Downloads and into <out>/<into>; only files
// under Downloads, and their folders only when that leaves them empty.
function moveOut(ctx, paths, into) {
  mkdirSync(join(ctx.out, into), { recursive: true });
  return paths.map((p) => {
    if (!inDownloads(p)) throw new Error(`${p} is not in Downloads; left alone`);
    const size = statSync(p).size;
    if (!size) throw new Error(`${basename(p)} was saved empty`);
    const to = join(ctx.out, into, basename(p));
    copyFileSync(p, to);
    unlinkSync(p);
    for (let d = dirname(p); inDownloads(d); d = dirname(d)) {
      try { rmdirSync(d); } catch { break; }
    }
    return { name: basename(p), path: to, size };
  });
}

// ---- the page -----------------------------------------------------------------

async function home(app) {
  if (!(await app.inPage(onHome))) await app.click("#homeBtn");
  await app.waitFor("the Home screen", 10000, onHome);
}

// The desktop shell reports each download it wrote; the page keeps a list of
// them from here on, so a step reads back exactly the files its press saved.
async function downloadsSoFar(app) {
  const n = await app.inPage(() => {
    if (!window.persodubShell?.onDownloadDone) return -1;
    if (!window.__e2eDownloads) {
      window.__e2eDownloads = [];
      window.persodubShell.onDownloadDone((info) => window.__e2eDownloads.push(info));
    }
    return window.__e2eDownloads.length;
  });
  if (n < 0) throw new Error("no desktop shell on this page: its downloads cannot be followed");
  return n;
}
const downloadsSince = (app, n) => app.inPage((from) => window.__e2eDownloads.slice(from), n);

async function openExport(app, button) {
  await app.click(button);
  return app.waitFor("the Download dialog and its rows", 10000, () => {
    if (!document.querySelector("#exportOverlay").classList.contains("open")) return null;
    const list = [...document.querySelectorAll("#exportList a[data-row]")];
    return list.length ? list.map((a) => ({ id: a.dataset.row, ticked: a.getAttribute("aria-checked") === "true",
                                            label: [...a.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim(), fmts: [...a.querySelectorAll("[data-fmt]")].map((f) => f.dataset.fmt) })) : null;
  });
}
// Ticks exactly `ids`, each by a press on its row.
async function tickOnly(app, ids) {
  const rows = await app.inPage(() => [...document.querySelectorAll("#exportList a[data-row]")]
    .map((a) => [a.dataset.row, a.getAttribute("aria-checked") === "true"]));
  for (const [id, on] of rows) {
    if (on === ids.includes(id)) continue;
    await app.click(`#exportList a[data-row="${id}"] > svg.icon`);
    await app.waitFor(`${id} ${on ? "unticked" : "ticked"}`, 5000, (r, want) =>
      document.querySelector(`#exportList a[data-row="${r}"]`).getAttribute("aria-checked") === String(want), id, !on);
  }
}
async function downloadTicked(app) {
  await app.click("#exportGoBtn");
  return app.waitFor("the download to finish", 120000, () => {
    if (document.querySelector("#exportGoBtn").disabled) return null;
    return { saved: [...document.querySelectorAll("#exportList a.saved")].map((a) => a.dataset.row),
             where: document.querySelector("#exportWhere").textContent.trim() };
  });
}
async function closeExport(app) {
  await app.click("#exportCloseBtn");
  await app.waitFor("the Download dialog to close", 5000, () => !document.querySelector("#exportOverlay").classList.contains("open"));
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

// The timeline's ruler pressed at `kept` seconds of the kept time: the
// playhead goes there, and the erase video with it. `total` is the kept
// length the strip is drawn for; `want` the video's own time it should land on.
async function seekRuler(app, kept, total, want) {
  const at = await app.inPage((k, tot) => {
    const inner = document.querySelector("#timeline .tl-inner");
    const ruler = inner && inner.querySelector(".tl-ruler");
    const cuts = inner ? [...inner.querySelectorAll(".tl-cut")] : [];
    if (!ruler || !cuts.length) return null;
    const last = cuts[cuts.length - 1];
    const pps = (parseFloat(last.style.left) + parseFloat(last.style.width) + 2) / tot;
    const r = ruler.getBoundingClientRect();
    return { x: inner.getBoundingClientRect().left + k * pps, y: r.top + r.height / 2, pps };
  }, kept, total);
  if (!at) throw new Error("the timeline has no ruler or no clip to press");
  let x = at.x;
  for (let i = 0; i < 2; i++) {
    const hit = await app.inPage((px, py) => !!document.elementFromPoint(px, py)?.closest(".tl-ruler"), x, at.y);
    if (!hit) throw new Error(`the ruler is not under (${Math.round(x)}, ${Math.round(at.y)})`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await app.send("Input.dispatchMouseEvent", { type, x, y: at.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
    }
    await sleep(300);
    const got = await app.inPage(() => document.querySelector("#eraseVideo").currentTime);
    if (Math.abs(got - want) <= 0.04) return got;
    x += (want - got) * at.pps;
  }
  throw new Error(`the ruler press did not bring the playhead to ${want} s`);
}

// Kept as the page writes it: 00:00:02.0.
const clockTenths = (sec) => {
  const tenths = Math.round(sec * 10), t = Math.floor(tenths / 10);
  return `${[Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60].map((n) => String(n).padStart(2, "0")).join(":")}.${tenths % 10}`;
};

// The localStorage values the last step puts back: the Download dialog's ticks and format.
async function remember(app, ctx) {
  if (!ctx.state.kept) ctx.state.kept = await app.inPage((keys) => keys.map((k) => [k, localStorage.getItem(k)]), [TICKS_KEY, AUDIO_KEY]);
}

async function savedStyle(app, jid, what, ok) {
  const t0 = Date.now();
  for (;;) {
    const style = await app.api(`/api/dub/jobs/${jid}/subtitle_style`);
    if (ok(style)) return Date.now() - t0;
    if (Date.now() - t0 > 10000) throw new Error(`job ${jid}'s saved style is not ${what} 10 s after the press: ${JSON.stringify(style).slice(0, 200)}`);
    await sleep(250);
  }
}

// ---- the steps ----------------------------------------------------------------

const ALL = [
  { group: "erase", name: "erase area", looks: ["#eraseAreaCard", "#tabErase"], async run(app, ctx) {
    const s = ctx.state;
    await remember(app, ctx);
    await downloadsSoFar(app);
    if (s.name) {
      await app.click('#leftTabs [data-tab="erase"]');
    } else {
      s.name = `e2e-tools-${ctx.stamp}-erase`;
      s.video = join(ctx.out, `${s.name}.mp4`);
      copyFileSync(ctx.video, s.video);
      await home(app);
      await app.click("#homeEraseCard");
      await app.waitFor("the Erase tab's Import block", 10000, shown, "#eraseZone .import-head");
      await app.feed("#eraseZone .import-head", s.video);
    }
    // The held video's id is in the picture's address from the start.
    // A fresh file plays from a blob: address until the upload lands; the held id comes with it.
    const src = await app.waitFor("the erase video from its held copy", 60000, () => document.body.dataset.screen === "erase"
      && /\/api\/downloads\/[^/]+\/video/.test(document.querySelector("#eraseVideo").getAttribute("src") || "")
      && document.querySelector("#eraseVideo").getAttribute("src"));
    s.did = (/\/api\/downloads\/([^/]+)\/video/.exec(src) || [])[1];
    if (!s.did) throw new Error(`the erase video plays "${src}", not a held video`);
    // What the app suggests for this video, asked the way the page asks and
    // at the same time: each look starts the detector afresh, which takes
    // up to 180 s (app/eraser.py SUGGEST_TIMEOUT).
    const fd = new FormData();
    fd.append("download_id", s.did);
    const t0 = Date.now();
    // A refusal is reported with the server's reason (its detail, a home folder
    // left out) and when it came, so a one-off 503 says why the next time.
    let refused = "";
    const asked = fetch(`${app.origin}/api/erase/suggest`, { method: "POST", body: fd, signal: AbortSignal.timeout(200000) })
      .then(async (r) => {
        if (r.ok) return { ...(await r.json()), ms: Date.now() - t0 };
        const body = await r.text();
        let why = body;
        try { why = JSON.parse(body).detail ?? body; } catch { /* not JSON: the text as it came */ }
        why = String(typeof why === "string" ? why : JSON.stringify(why)).replace(/\/Users\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+/gi, "~");
        throw new Error(`POST /api/erase/suggest: ${r.status} after ${((Date.now() - t0) / 1000).toFixed(1)} s: "${why.slice(0, 300)}"`);
      });
    asked.catch((e) => { refused = e.message; });
    const placed = await app.waitFor("the box placed where the subtitles were found", 200000, () => {
      const b = document.querySelector("#eraseBox"), err = document.querySelector("#eraseError").textContent.trim();
      if (err) return { error: err };
      return !b.hidden && b.classList.contains("found") && document.querySelector("#eraseVideo").videoWidth ? { ok: true } : null;
    });
    const boxMs = Date.now() - t0;
    if (placed.error) throw new Error(`the Erase tab says: ${placed.error}${refused ? `; the same question here: ${refused}` : ""}`);
    const found = await asked;
    const before = await app.inPage(BOX);
    const close = (a, b, d = 2) => a.every((v, i) => Math.abs(v - b[i]) <= d);
    if (!close(before.area, found.area)) throw new Error(`the box is ${before.area}, the suggestion ${found.area}`);
    const h = await app.inPage(() => {
      const r = document.querySelector('#eraseBox [data-handle="se"]').getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      return { x, y, over: document.elementFromPoint(x, y)?.dataset.handle || "" };
    });
    if (h.over !== "se") throw new Error("the bottom-right handle is covered");
    await drag(app, h.x, h.y, 40, 20);
    const after = await app.inPage(BOX);
    // Frame pixels: the drag times the scale, short of the frame's edge.
    const wantW = Math.min(40 / before.s, before.W - before.area[3]), wantH = Math.min(20 / before.s, before.H - before.area[1]);
    const grewW = (after.area[3] - after.area[2]) - (before.area[3] - before.area[2]);
    const grewH = (after.area[1] - after.area[0]) - (before.area[1] - before.area[0]);
    if (Math.abs(grewW - wantW) > 3 || Math.abs(grewH - wantH) > 3) {
      throw new Error(`the box grew ${grewW}x${grewH} frame px (${(after.w - before.w).toFixed(1)}x${(after.h - before.h).toFixed(1)} on screen), not about ${wantW.toFixed(0)}x${wantH.toFixed(0)}`);
    }
    await app.click("#eraseResetBtn");
    const back = await app.waitFor("the box back where it was offered", 5000, (want) => {
      const v = document.querySelector("#eraseVideo"), b = document.querySelector("#eraseBox");
      const st = document.querySelector("#eraseStage").getBoundingClientRect();
      const sc = Math.min(st.width / v.videoWidth, st.height / v.videoHeight);
      const a = [(parseFloat(b.style.top) - (st.height - v.videoHeight * sc) / 2) / sc, 0, (parseFloat(b.style.left) - (st.width - v.videoWidth * sc) / 2) / sc, 0];
      a[1] = a[0] + parseFloat(b.style.height) / sc; a[3] = a[2] + parseFloat(b.style.width) / sc;
      const r = a.map(Math.round);
      return r.every((x, i) => Math.abs(x - want[i]) <= 2) ? r : null;
    }, found.area);
    return `box found ${Math.round(boxMs / 1000)} s after the video came in, suggest answered in ${Math.round(found.ms / 1000)} s: ${found.found ? "found" : "did not find"} ${found.area} of ${found.width}x${found.height}, box ${before.area} `
      + `(${before.w.toFixed(0)}x${before.h.toFixed(0)} px); corner dragged +40,+20 px → ${after.area}, grew ${grewW}x${grewH} frame px `
      + `(${(after.w - before.w).toFixed(1)}x${(after.h - before.h).toFixed(1)} px; wanted ${wantW.toFixed(0)}x${wantH.toFixed(0)}); ${app.tr("Reset")} → ${back}`;
  } },

  { group: "erase", name: "erase part", looks: ["#eraseVideoCard", "#timeline"], async run(app) {
    const range = () => app.inPage(() => (document.querySelector("#eraseVideoCard .erase-range")?.textContent || "").trim());
    const total = await app.inPage(() => document.querySelector("#eraseVideo").duration);
    if (!(total > 8)) throw new Error(`the video is ${total} s long; the part 2-8 s needs more`);
    const whole = await range();
    if (!whole.includes(app.tr("Whole video"))) throw new Error(`the card's line reads "${whole}" before any cut`);
    await seekRuler(app, 2, total, 2);
    await app.click("#tlDelLeft");
    await app.waitFor("the part to start at 2 s", 5000, (w) => !(document.querySelector("#eraseVideoCard .erase-range")?.textContent || "").includes(w), app.tr("Whole video"));
    await seekRuler(app, 6, total - 2, 8);
    await app.click("#tlDelRight");
    const want = `${app.tr("Part to erase")} · ${app.tr("{from} – {to}", { from: clockTenths(2), to: clockTenths(8) })}`;
    const narrow = await app.waitFor(`the card to read "${want}"`, 5000, (w) => {
      const t = (document.querySelector("#eraseVideoCard .erase-range")?.textContent || "").trim();
      return t === w ? { t, len: document.querySelector("#eraseVideoCard .vc-len").textContent.trim() } : null;
    }, want);
    await app.click("#tlUndo");
    await app.click("#tlUndo");
    const back = await app.waitFor("the whole video again", 5000, (w) => {
      const t = (document.querySelector("#eraseVideoCard .erase-range")?.textContent || "").trim();
      return t.includes(w) ? t : null;
    }, app.tr("Whole video"));
    return `"${whole}" → playhead 2.0, ${app.tr("Delete left of playhead")}, 8.0, right → "${narrow.t}" (${narrow.len}); ${app.tr("Undo")} x2 → "${back}"`;
  } },

  { group: "erase", name: "erase column", looks: ["#eraseBody"], async run(app) {
    const c = await app.inPage(() => {
      const body = document.querySelector("#eraseBody"), res = document.querySelector("#eraseResult");
      const areaCard = document.querySelector("#eraseAreaCard");
      return { w: innerWidth, h: innerHeight, scroll: body.scrollHeight, client: body.clientHeight, on: res.getClientRects().length > 0,
               k: res.querySelector(".k").textContent.trim(), m: res.querySelector(".m").textContent.trim(),
               top: res.getBoundingClientRect().top, under: areaCard.getBoundingClientRect().bottom,
               after: res.previousElementSibling?.id || "" };
    });
    if (c.w !== 1280 || c.h !== 800) throw new Error(`the window is ${c.w}x${c.h}; this check is for 1280x800`);
    if (!c.on || c.m !== app.tr("The video with its subtitles erased")) throw new Error(`the result card is ${c.on ? `"${c.k}" / "${c.m}"` : "not on show"}`);
    if (c.after !== "eraseAreaCard" || c.top < c.under - 0.5) throw new Error(`the result card follows #${c.after} at y ${c.top}, the Area card ends at ${c.under}`);
    if (c.scroll !== c.client) throw new Error(`the left column scrolls: scrollHeight ${c.scroll}, clientHeight ${c.client}`);
    return `${c.w}x${c.h}; "${c.k}" / "${c.m}" at y ${c.top.toFixed(1)} under ${app.tr("Area")} (ends ${c.under.toFixed(1)}); column scrollHeight ${c.scroll} = clientHeight ${c.client}`;
  } },

  { group: "erase", name: "erase run", looks: ["#erasePartCard", "#tabErase"], async run(app, ctx) {
    const s = ctx.state;
    const t0 = Date.now();
    // The button wakes once the suggestion and the estimate are in, and the engine may be busy with another job.
    await app.click("#eraseRunBtn", 120000);
    const said = [];
    let r, snapped = false, began = 0;
    for (;;) {
      if (!began && s.eraseJob && (await app.api(`/api/dub/jobs/${s.eraseJob}`)).status !== "queued") began = Date.now();
      r = await app.inPage(() => {
        const on = (id) => document.getElementById(id).getClientRects().length > 0;
        return { key: document.querySelector("#erasePartKey").textContent.trim(), state: document.querySelector("#eraseState").textContent.trim(),
                 src: document.querySelector("#eraseVideo").getAttribute("src") || "", error: document.querySelector("#eraseError").textContent.trim(),
                 again: on("eraseAgainBtn"), failed: on("eraseRetryBtn") };
      });
      if (r.state && r.state !== said[said.length - 1]) said.push(r.state);
      if (!s.eraseJob) s.eraseJob = (/\/api\/erase\/([^/]+)\//.exec(r.src) || [])[1];
      if (r.error || r.failed) throw new Error(`the erase stopped: ${r.error || r.state}`);
      if (!snapped && said.length) { snapped = true; await app.shot("tools-erase-running"); }
      if (r.again && r.key === app.tr("Erased")) break;
      if (began && Date.now() - began > 600000) throw new Error(`not erased 600 s after it left the queue (last "${r.state}")`);
      if (!began && Date.now() - t0 > 900000) throw new Error(`job ${s.eraseJob || "?"} still in the queue after 15 min`);
      await sleep(1000);
    }
    const queued = Math.round(((began || t0) - t0) / 1000), took = Math.round((Date.now() - (began || t0)) / 1000);
    if (said.length < 2) throw new Error(`the progress line never changed: ${said.join(" > ")}`);
    const v = await app.waitFor("the Erased tab on show", 10000, (jid) => {
      const tab = document.querySelector('#eraseTabs [data-erase="erased"]');
      const src = document.querySelector("#eraseVideo").getAttribute("src") || "";
      return tab.classList.contains("active") && !tab.disabled && src.endsWith(`/api/erase/${jid}/video`)
        ? { tab: tab.textContent.trim(), again: document.querySelector("#eraseAgainBtn").textContent.trim() } : null;
    }, s.eraseJob);
    const job = await app.api(`/api/dub/jobs/${s.eraseJob}`);
    const rec = await app.api(`/api/erase/${s.eraseJob}`);
    const check = rec.check || {};
    return `job ${s.eraseJob} ${job.kind} ${job.status}, ${queued} s in the queue, erased in ${took} s, area ${job.area}; ${said.length} lines (${said[0]} … ${said[said.length - 1]}); `
      + `"${v.tab}" tab up on the erased video; "${v.again}" shown; check: text in ${check.frames_with_text} of ${check.frames_checked} frames`;
  } },

  { group: "erase", name: "erase download", looks: ["#exportOverlay"], async run(app, ctx) {
    const s = ctx.state;
    if (!s.eraseJob) throw new Error("no erased video to download (the erase failed)");
    const rows = await openExport(app, "#exportBtn");
    const want = [["video", app.tr("Video")], ["audio", app.tr("Audio only")]];
    if (rows.length !== 2 || want.some(([id, label], i) => rows[i].id !== id || !rows[i].label.startsWith(label))) {
      throw new Error(`Download offers ${rows.map((r) => `${r.id} "${r.label}"`).join(", ")}, not "${want[0][1]}" and "${want[1][1]}"`);
    }
    await tickOnly(app, ["video"]);
    const t0 = Date.now() - 2000;
    const end = await downloadTicked(app);
    if (!end.saved.includes("video")) throw new Error(`the download stopped: ${end.where}`);
    // The app writes this one itself, into Downloads/<day>/<project>.
    const job = await app.api(`/api/dub/jobs/${s.eraseJob}`);
    const dir = join(DOWNLOADS, job.day, job.project);
    const fresh = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".mp4") && statSync(join(dir, f)).mtimeMs >= t0) : [];
    if (fresh.length !== 1) throw new Error(`${dir} has ${fresh.length} new .mp4 file(s) after the download`);
    const [f] = moveOut(ctx, [join(dir, fresh[0])], "erase");
    const sec = seconds(f.path);
    if (Math.abs(sec - 10) > 1) throw new Error(`${f.name} is ${sec.toFixed(2)} s, not 10.0 ± 1`);
    await closeExport(app);
    return `rows "${rows[0].label}", "${rows[1].label}"; saved ${f.name} ${sec.toFixed(2)} s ${(f.size / 1e6).toFixed(2)} MB (moved into erase/); "${end.where}"`;
  } },

  { group: "erase", name: "erase then burn in subtitles", looks: ["#tabCaptions", "#leftTabs"], async run(app) {
    const tab = '#leftTabs [data-tab="captions"]';
    const dim = await app.inPage((q) => { const b = document.querySelector(q); return b.disabled ? b.title || "disabled" : ""; }, tab);
    if (dim) throw new Error(`the Burn in subtitles tab is dim after the erase ("${dim}")`);
    await app.click(tab);
    const c = await app.waitFor("the tab's own import face", 10000, () => {
      const on = (id) => document.getElementById(id).getClientRects().length > 0;
      if (!on("capAlone") || !on("capSrtZone")) return null;
      return { video: on("capVideoCard") ? document.querySelector("#capVideoCard .vc-name").textContent.trim() : "",
               zone: on("capZone"), srt: document.querySelector("#capSrtZone .import-head").textContent.trim() };
    });
    if (!c.video || c.zone) throw new Error(`the tab asks for ${c.zone ? "a video" : "nothing"} though the video is known`);
    return `tab lit, not dim; its face shows the video "${c.video}" and asks for "${c.srt}"`;
  } },

  { group: "captions", name: "captions files", looks: ["#capAlone", "#capFiles"], async run(app, ctx) {
    const s = ctx.state;
    if (!ctx.srt) throw new Error("this step needs --srt");
    await remember(app, ctx);
    await downloadsSoFar(app);
    s.capVideo = join(ctx.out, `e2e-tools-${ctx.stamp}-cap.mp4`);
    copyFileSync(ctx.video, s.capVideo);
    // Home's Burn in subtitles card: an empty new project on that tab (2026-10-23).
    await home(app);
    await app.click("#homeCaptionsCard");
    await app.waitFor("the tab's Import block and subtitle file block", 10000, () =>
      ["#capAlone", "#capZone", "#capSrtZone"].every((q) => document.querySelector(q)?.getClientRects().length > 0));
    await app.feed("#capZone .import-head", s.capVideo);
    const card = await app.waitFor("the video's card in the tab", 120000, () => {
      const st = document.querySelector("#capImportStatus");
      if (st.classList.contains("error") && st.textContent.trim()) return `refused: ${st.textContent.trim()}`;
      return document.querySelector("#capVideoCard").getClientRects().length ? "ready" : "";
    });
    if (card !== "ready") throw new Error(`the video's import was ${card}`);
    await app.feed("#capSrtZone", ctx.srt);
    const f = await app.waitFor("the files row over the looks", 60000, () => {
      const st = document.querySelector("#capImportStatus");
      if (st.classList.contains("error") && st.textContent.trim()) return { refused: st.textContent.trim() };
      if (!document.querySelector("#capFiles").getClientRects().length) return null;
      const txt = (q) => document.querySelector(q).textContent.trim();
      return { job: document.body.dataset.jobId, len: txt("#capFileVideo .vc-len"), srt: txt("#capFileSrtName"), lines: txt("#capFileSrtLines") };
    });
    if (f.refused) throw new Error(`the subtitle file was refused: ${f.refused}`);
    s.capJob = f.job;
    const lines = app.tr("{n} lines", { n: 3 });
    if (f.len !== "00:10" || f.lines !== lines) throw new Error(`the files row says ${f.len} and "${f.lines}", not 00:10 and "${lines}"`);
    const job = await app.api(`/api/dub/jobs/${f.job}`);
    if (job.kind !== "captions" || job.status !== "done") throw new Error(`job ${f.job} is ${job.kind} ${job.status}`);
    return `job ${f.job} (${job.kind}); files row ${f.len} + "${f.srt}" ${f.lines}`;
  } },

  { group: "captions", name: "captions looks", looks: ["#subStyleMenu"], async run(app, ctx) {
    const s = ctx.state;
    if (!s.capJob) throw new Error("no subtitles project (the step before failed)");
    const ids = await app.inPage(() => [...document.querySelectorAll("#subStyleMenu [data-preset]")].map((c) => c.dataset.preset));
    if (ids.length !== 12) throw new Error(`${ids.length} looks, not 12`);
    const ms = [];
    for (const id of ids) {
      await app.click(`#subStyleMenu [data-preset="${id}"]`);
      ms.push(await savedStyle(app, s.capJob, id, (st) => st.preset === id));
      if (!(await app.inPage((p) => document.querySelector(`#subStyleMenu [data-preset="${p}"]`).classList.contains("on"), id))) {
        throw new Error(`${id} saved but its tile is not ringed`);
      }
    }
    return `12 looks saved in turn (${Math.max(...ms)} ms at most): ${ids.join(", ")}`;
  } },

  { group: "captions", name: "captions size scope show", looks: ["#subToolbar"], async run(app, ctx) {
    const s = ctx.state;
    if (!s.capJob) throw new Error("no subtitles project");
    const size = async () => (await app.api(`/api/dub/jobs/${s.capJob}/subtitle_style`)).size ?? 100;
    const from = await size();
    const sizes = [];
    for (const [btn, step] of [["#subBigger", 10], ["#subBigger", 10], ["#subSmaller", -10], ["#subSmaller", -10]]) {
      const want = (sizes.length ? sizes[sizes.length - 1] : from) + step;
      await app.click(btn);
      await savedStyle(app, s.capJob, `size ${want}`, (st) => (st.size ?? 100) === want);
      const shownPct = await app.inPage(() => document.querySelector("#subSizeLv").textContent.trim());
      if (shownPct !== `${want}%`) throw new Error(`the size reads ${shownPct}, saved ${want}`);
      sizes.push(want);
    }
    // All lines / This line is there for the looks with a box.
    if (!(await app.inPage(shown, "#subScopeSeg"))) {
      await app.click('#subStyleMenu [data-preset="sticker"]');
      await savedStyle(app, s.capJob, "sticker", (st) => st.preset === "sticker");
    }
    const scope = [];
    for (const [btn, other] of [["#subScopeOne", "#subScopeAll"], ["#subScopeAll", "#subScopeOne"]]) {
      await app.click(btn);
      await app.waitFor(`${btn} on`, 5000, (a, b) => document.querySelector(a).classList.contains("on") && !document.querySelector(b).classList.contains("on"), btn, other);
      scope.push(`${await app.inPage(textOf, btn)}${(await app.inPage(shown, "#capHint")) ? ` (hint "${await app.inPage(textOf, "#capHint")}")` : ""}`);
    }
    const view = () => app.inPage(() => ({ on: document.querySelector("#subShow").getAttribute("aria-checked"), overlay: !document.querySelector("#subOverlay").hidden }));
    const was = await view();
    await app.click("#subShow");
    await savedStyle(app, s.capJob, "hidden", (st) => st.enabled === false);
    const off = await view();
    if (off.on !== "false" || off.overlay) throw new Error(`${app.tr("Show")} off left the switch ${off.on} and the overlay ${off.overlay ? "on" : "off"}`);
    await app.click("#subShow");
    await savedStyle(app, s.capJob, "shown", (st) => st.enabled !== false);
    const on = await view();
    if (on.on !== "true" || on.overlay !== was.overlay) throw new Error(`${app.tr("Show")} on left the switch ${on.on} and the overlay ${on.overlay ? "on" : "off"}`);
    return `size ${from} → ${sizes.join(" → ")} saved; scope ${scope.join(", then ")}; ${app.tr("Show")} overlay ${was.overlay ? "on" : "off"} → off (saved) → ${on.overlay ? "on" : "off"} (saved)`;
  } },

  { group: "captions", name: "captions download", looks: ["#exportOverlay"], async run(app, ctx) {
    const s = ctx.state;
    if (!s.capJob) throw new Error("no subtitles project");
    const out = {};
    let cues = 0, labels = "";
    for (const look of ["neon", "clean"]) {
      await app.click(`#subStyleMenu [data-preset="${look}"]`);
      await savedStyle(app, s.capJob, look, (st) => st.preset === look);
      const rows = await openExport(app, "#exportBtn");
      const want = [["subtitled", app.tr("Video with subtitles")], ["srt", app.tr("Subtitles (.srt)")]];
      if (rows.length !== 2 || want.some(([id, label], i) => rows[i].id !== id || !rows[i].label.startsWith(label))) {
        throw new Error(`Download offers ${rows.map((r) => `${r.id} "${r.label}"`).join(", ")}, not "${want[0][1]}" and "${want[1][1]}"`);
      }
      labels = rows.map((r) => `"${r.label}"`).join(", ");
      const ids = look === "neon" ? ["subtitled", "srt"] : ["subtitled"];
      await tickOnly(app, ids);
      const n = await downloadsSoFar(app);
      const end = await downloadTicked(app);
      if (ids.some((id) => !end.saved.includes(id))) throw new Error(`the download stopped: ${end.where}`);
      const got = await downloadsSince(app, n);
      if (got.length !== ids.length || got.some((d) => d.state !== "completed")) throw new Error(`the shell reported ${JSON.stringify(got.map((d) => [d.filename, d.state]))}`);
      const moved = moveOut(ctx, got.map((d) => d.path), "captions");
      const mp4 = moved.find((f) => f.name.endsWith(".mp4")), srt = moved.find((f) => f.name.endsWith(".srt"));
      if (!mp4) throw new Error(`saved ${moved.map((f) => f.name)}: no .mp4`);
      const sec = seconds(mp4.path);
      if (Math.abs(sec - 10) > 0.1) throw new Error(`${mp4.name} is ${sec.toFixed(3)} s, not 10.0 ± 0.1`);
      out[look] = { ...mp4, sec };
      if (srt) {
        cues = (readFileSync(srt.path, "utf8").match(/-->/g) || []).length;
        if (cues !== 3) throw new Error(`${srt.name} has ${cues} cues, not 3`);
        out.srt = srt.name;
      }
      await closeExport(app);
    }
    // The same moment in the two: the looks differ where the words are.
    const [a, b] = [frame(out.neon.path, 5), frame(out.clean.path, 5)];
    let sum = 0, far = 0;
    for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); sum += d; if (d > 40) far += 1; }
    if (far < 50) throw new Error(`the frames at 5 s differ in only ${far} of 14400 pixels by more than 40 levels (mean ${(sum / a.length).toFixed(2)})`);
    return `rows ${labels}; ${out.neon.name} ${out.neon.sec.toFixed(3)} s, ${out.clean.name} ${out.clean.sec.toFixed(3)} s, ${out.srt} ${cues} cues `
      + `(moved into captions/); frame at 5 s: ${far} of 14400 px differ by >40, mean difference ${(sum / a.length).toFixed(2)}`;
  } },

  { group: "end", name: "home", looks: ["#screen-home"], async run(app, ctx) {
    const kept = ctx.state.kept || [];
    await app.inPage((pairs) => { for (const [k, v] of pairs) { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } return true; }, kept);
    const dialog = await app.inPage(() => document.querySelector(".modal-overlay.open")?.id || "");
    if (dialog) throw new Error(`#${dialog} is open`);
    await home(app);
    return `Home, no dialog open; the Download dialog's ticks and format put back (${kept.map(([k]) => k).join(", ") || "none read"})`;
  } },
];

const PARTS = (process.env.SWEEP_TOOLS || "erase,captions").split(",");
export const steps = ALL.filter((st) => st.group === "end" || PARTS.includes(st.group));
