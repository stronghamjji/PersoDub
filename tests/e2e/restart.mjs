// The restart run: what only a boot shows. It stops and starts an isolated
// test app (its own kit folder and user data, never the installed app) with
// one kit.env line changed, checks what the app shows, and puts the line back:
// the Download dialog's folder (picked, gone, Use default, and the erased video
// and Save video under it), the app reopening on the screen it was closed on,
// the shell's "could not start" screen and its Try again, and the
// not-installed screen. Not part of any test suite.
//
//   node tests/e2e/restart.mjs --kit <kit> --user-data <dir> --video <clip> [--out <folder>] [--port 9333] [--lock <dir>]
//
// The app must be running already (desktop/, PERSODUB_KIT_DIR=<kit>,
// --user-data-dir=<dir>, --remote-debugging-port=<port>); it is left running
// the same way, on Home, on the backend port it had. kit.env is copied to
// kit.env.e2e-backup first and put back byte for byte after each stop. With
// --lock the app is stopped only while holding that folder (mkdir takes it,
// rmdir gives it back) and only when no job is running or queued.
// Writes NN-<id>.png, report.md and report.json into <folder>; exits 1 when a step fails.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmdirSync, statSync,
         unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { connect, sleep, shown, isOpen, isClosed, onHome } from "./lib/cdp.mjs";
import { parseEnvFile, withKitEnvValue } from "../../desktop/src/kitEnv.js";

const { values: opt } = parseArgs({ options: {
  kit: { type: "string" }, "user-data": { type: "string" }, video: { type: "string" }, out: { type: "string" },
  port: { type: "string", default: "9333" }, lock: { type: "string" } } });
if (!opt.kit || !opt["user-data"] || !opt.video || !existsSync(join(opt.kit, "kit.env")) || !existsSync(opt.video)) {
  console.error("usage: node tests/e2e/restart.mjs --kit <kit> --user-data <dir> --video <short mp4> [--out <folder>] [--port 9333] [--lock <dir>]");
  process.exit(2);
}
const KIT = resolve(opt.kit);
const UD = resolve(opt["user-data"]);
const KIT_ENV = join(KIT, "kit.env");
const BACKUP = `${KIT_ENV}.e2e-backup`;
const SHELL_LOG = join(UD, "logs", "shell.log");
const DESKTOP = join(import.meta.dirname, "..", "..", "desktop");
const DOWNLOADS = join(homedir(), "Downloads");
const DIR_KEY = "PERSODUB_DOWNLOAD_DIR";
// The one kit.env line the shell starts an engine with: the backend's folder.
const APP_KEY = "PERSODUB_APP_REPO_DIR";

const startedAt = new Date();
const clock = (d = new Date()) => d.toLocaleString("sv-SE");
const stamp = clock(startedAt).replace(/[-:]/g, "").replace(" ", "-");
const out = resolve(opt.out || `e2e-restart-${stamp}`);
mkdirSync(out, { recursive: true });
const DL = join(out, "dl");
const secs = (t0) => Math.round((Date.now() - t0) / 100) / 10;

// ---- kit.env ----
const kitText = () => readFileSync(KIT_ENV, "utf8");
const kitValue = (key) => parseEnvFile(kitText())[key];
const setKit = (key, value) => writeFileSync(KIT_ENV, withKitEnvValue(kitText(), key, value));
const sameAsBackup = () => readFileSync(KIT_ENV).equals(readFileSync(BACKUP));
// Use default writes kit.env.bak as the app always does; that file is put back too.
const BAK = `${KIT_ENV}.bak`;
const bakCopy = join(out, "kit.env.bak.before");
function putKitBack() {
  copyFileSync(BACKUP, KIT_ENV);
  if (existsSync(bakCopy)) copyFileSync(bakCopy, BAK);
}

// ---- the test app's processes: its Electron, and the engines it runs from the kit ----
function procs() {
  const ps = spawnSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" }).stdout;
  return ps.split("\n").map((l) => l.trim()).filter(Boolean)
    .map((l) => ({ pid: Number(l.slice(0, l.indexOf(" "))), cmd: l.slice(l.indexOf(" ") + 1) }));
}
const shellProcs = () => procs().filter((p) => /\/MacOS\/Electron( |$)/.test(p.cmd) && p.cmd.includes(`--user-data-dir=${UD}`));
const engineProcs = () => procs().filter((p) => p.cmd.includes(`${KIT}/`) && /uvicorn (app\.main:app|server:app)/.test(p.cmd));
const logLines = () => (existsSync(SHELL_LOG) ? readFileSync(SHELL_LOG, "utf8").split("\n").filter(Boolean) : []);

// The shell's line matching `re` written after line `from`.
async function logLine(from, re, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const hit = logLines().slice(from).map((l) => re.exec(l)).find(Boolean);
    if (hit) return hit;
    if (Date.now() > end) throw new Error(`no "${re.source}" in shell.log in ${ms / 1000} s`);
    await sleep(500);
  }
}
const count = (from, re) => logLines().slice(from).filter((l) => re.test(l)).length;

// A normal quit (SIGTERM, which Electron takes as one): the shell stops its engines on the way out.
async function quit() {
  const from = logLines().length;
  const shell = shellProcs();
  if (!shell.length) throw new Error("the test app is not running");
  for (const p of shell) process.kill(p.pid, "SIGTERM");
  let end = Date.now() + 30000, forced = false;
  while (shellProcs().length || engineProcs().length) {
    if (Date.now() > end) {
      if (forced) throw new Error(`still running after a forced stop: ${[...shellProcs(), ...engineProcs()].map((p) => p.pid)}`);
      for (const p of [...shellProcs(), ...engineProcs()]) process.kill(p.pid, "SIGKILL");
      forced = true;
      end = Date.now() + 10000;
    }
    await sleep(500);
  }
  return { quitLine: count(from, /QUIT: stopping engines/) === 1, forced };
}

let launches = 0;
function launch(kitDir) {
  launches += 1;
  const fd = openSync(join(out, `app-${String(launches).padStart(2, "0")}.log`), "a");
  spawn("npx", ["electron", ".", `--remote-debugging-port=${opt.port}`, `--user-data-dir=${UD}`],
        { cwd: DESKTOP, env: { ...process.env, PERSODUB_KIT_DIR: kitDir }, detached: true, stdio: ["ignore", fd, fd] }).unref();
  closeSync(fd);
}

// The backend port every boot must come up on: the one the app had at the start.
let PORT = 0;
const ports = [];
const api = (path) => fetch(`http://127.0.0.1:${PORT}${path}`, { signal: AbortSignal.timeout(10000) })
  .then((r) => { if (!r.ok) throw new Error(`GET ${path}: ${r.status}`); return r.json(); });

// A boot with the real kit, up to three times while it lands on another port.
async function bootNormally() {
  for (let i = 1; i <= 3; i++) {
    const from = logLines().length;
    launch(KIT);
    const port = Number((await logLine(from, /backend START \(port (\d+)\)/, 120000))[1]);
    await logLine(from, /PERSODUB_READY /, 120000);
    ports.push(port);
    if (port === PORT) return enginesUp();
    console.log(`  the backend came up on port ${port}, not ${PORT}: quit and boot again`);
    await quit();
  }
  throw new Error(`three boots in a row came up on another port than ${PORT}`);
}
// Every engine on this kit running: none starting or failed.
async function enginesUp(ms = 120000) {
  const end = Date.now() + ms;
  for (;;) {
    const e = (await api("/api/engines").catch(() => null))?.local_engines;
    if (e && e.voice?.state === "running" && !Object.values(e).some((x) => ["starting", "failed"].includes(x.state))) {
      return Object.entries(e).map(([k, v]) => `${k} ${v.state}`).join(", ");
    }
    if (Date.now() > end) throw new Error(`engines not running in ${ms / 1000} s: ${JSON.stringify(e)}`);
    await sleep(1000);
  }
}

// The window's page whatever it shows (the app or one of the shell's own
// screens, which cdp.mjs does not open): its address, its text, a press, a picture.
async function windowPage() {
  const targets = await fetch(`http://127.0.0.1:${opt.port}/json`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
  const t = targets.find((x) => x.type === "page");
  if (!t) throw new Error(`no page on port ${opt.port}`);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error("cannot open the window's page")); });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); if (m.error) p.no(new Error(m.error.message)); else p.ok(m.result); }
  };
  const send = (method, params = {}) => new Promise((ok, no) => {
    const id = ++seq;
    pending.set(id, { ok, no });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) no(new Error(`${method}: no answer in 30 s`)); }, 30000);
  });
  const js = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
  return {
    js,
    url: () => js("location.href"),
    async click(sel) {
      const r = await js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", { type, x: r[0], y: r[1], button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
      }
    },
    async shot(name) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(out, `${name}.png`), Buffer.from(data, "base64"));
      return `${name}.png`;
    },
    close: () => ws.close(),
  };
}
// The window once it shows `file` (one of the shell's screens), with its words.
async function shellScreen(file, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const w = await windowPage().catch(() => null);
    const text = w && await w.js(`location.href.includes(${JSON.stringify(file)}) && document.readyState === "complete"
      ? [...document.querySelectorAll("h2, p, li, button")].map((e) => e.innerText.trim()).filter(Boolean) : null`).catch(() => null);
    if (text) return { w, text };
    w?.close();
    if (Date.now() > end) throw new Error(`the window did not show ${file} in ${ms / 1000} s`);
    await sleep(500);
  }
}

// ---- the lock, and no job in the way ----
let heldSince = 0;
const holds = [];
async function take(what) {
  for (;;) {
    if (opt.lock) {
      try { mkdirSync(opt.lock); } catch { await sleep(15000); continue; }
      writeFileSync(join(opt.lock, "who"), `restart.mjs pid ${process.pid} ${clock()} (${what})\n`);
    }
    heldSince = Date.now();
    const { jobs } = await api("/api/dub/jobs");
    const busy = jobs.filter((j) => ["running", "queued", "cancelling"].includes(j.status));
    if (!busy.length) return;
    console.log(`  ${busy.length} job(s) running or queued (${busy.map((j) => j.id)}): waiting`);
    give();
    await sleep(15000);
  }
}
function give() {
  if (!opt.lock || !existsSync(opt.lock)) return;
  try { unlinkSync(join(opt.lock, "who")); } catch { /* no name in it */ }
  rmdirSync(opt.lock);
}
process.on("SIGINT", () => { if (existsSync(BACKUP)) putKitBack(); give(); process.exit(130); });

// ---- the page ----
let app = null;
async function attach() {
  app?.close();
  app = await connect({ port: opt.port, out });
  if (new URL(app.origin).port !== String(PORT)) throw new Error(`the page is on ${app.origin}, not port ${PORT}`);
  return app;
}
async function toHome() {
  for (const id of ["#exportOverlay", "#deleteOverlay"]) {
    if (await app.inPage(isOpen, id).catch(() => false)) await app.key("Escape");
  }
  if (!(await app.inPage(onHome))) await app.click("#homeBtn", 20000);
  await app.waitFor("the Home screen", 10000, onHome);
}
const dubOnScreen = (jid) => document.body.dataset.screen === "done" && document.body.dataset.jobId === jid
  && document.querySelectorAll("#scriptBox .sc-row:not(.head)").length > 0;

// The newest finished e2e- dub of this computer, opened from its Home card.
async function openNewestDub() {
  await toHome();
  const { jobs } = await app.api("/api/dub/jobs");
  const groups = new Map();
  for (const j of jobs) {
    const k = j.project_id || j.id;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(j);
  }
  const m = [...groups.values()].find((g) => String(g[0].title || g[0].project || "").startsWith("e2e-")
    && g[0].kind === "dub" && g[0].status === "done" && g[0].dub_mode === "local");
  if (!m) throw new Error("no finished local e2e- dub on Home");
  const job = await app.api(`/api/dub/jobs/${m[0].id}`);
  await app.click(`#projectsGrid .proj-card[data-job="${job.id}"]`, 20000);
  await app.waitFor("the finished dub and its table", 20000, dubOnScreen, job.id);
  return job;
}

// ---- the Download dialog ----
const where = () => document.querySelector("#exportWhere").textContent.trim();
async function openExport() {
  await app.click("#exportBtn");
  return app.waitFor("the Download dialog and its rows", 10000, () => document.querySelector("#exportOverlay").classList.contains("open")
    && document.querySelectorAll("#exportList a[data-row]").length && !document.querySelector("#exportFolder").hidden
    && [...document.querySelectorAll("#exportList a[data-row]")].map((a) => a.dataset.row));
}
async function closeExport() {
  if (!(await app.inPage(isOpen, "#exportOverlay"))) return;
  await app.click("#exportCloseBtn", 120000);
  await app.waitFor("the Download dialog to close", 5000, isClosed, "#exportOverlay");
}
// `row` alone ticked, Download pressed, and the row saved: the line under the rows then.
async function downloadRow(row, ms = 120000) {
  const rows = await app.inPage(() => [...document.querySelectorAll("#exportList a[data-row]")]
    .map((a) => [a.dataset.row, a.getAttribute("aria-checked") === "true"]));
  for (const [id, on] of rows) {
    if (on === (id === row)) continue;
    await app.click(`#exportList a[data-row="${id}"]`);
    await app.waitFor(`${id} ${on ? "unticked" : "ticked"}`, 5000, (i, v) => document.querySelector(`#exportList a[data-row="${i}"]`)
      .getAttribute("aria-checked") === String(v), id, !on);
  }
  await app.click("#exportGoBtn");
  return app.waitFor(`${row} saved`, ms, (r) => !document.querySelector("#exportGoBtn").disabled
    && document.querySelector(`#exportList a[data-row="${r}"].saved`) && document.querySelector("#exportWhere").textContent.trim(), row);
}

// Files (not folders) under the folders named, three levels down. Downloads
// itself may not be listable from a terminal (macOS privacy); its dated folders are.
function filesIn(dirs, depth = 3) {
  return [dirs].flat().flatMap((dir) => {
    let names;
    try { names = readdirSync(dir); } catch { return []; }
    return names.filter((f) => !f.startsWith(".")).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? (depth > 1 ? filesIn(p, depth - 1) : []) : [p];
    });
  });
}
const added = (before, dirs) => filesIn(dirs).filter((p) => !before.includes(p));
// Where a download could land in Downloads: the dated folders, and the file's name loose in it.
const today = () => new Date().toLocaleDateString("sv-SE");
const downloadsDirs = (day) => [...new Set([today(), day])].map((d) => join(DOWNLOADS, d));
const loose = (before, day, name) => [...added(before, downloadsDirs(day)), ...(existsSync(join(DOWNLOADS, name)) ? [join(DOWNLOADS, name)] : [])];
// A saved file out of Downloads into the run's folder, its emptied folders after it.
function moveOut(path, into) {
  mkdirSync(into, { recursive: true });
  const to = join(into, basename(path));
  copyFileSync(path, to);
  unlinkSync(path);
  for (let d = dirname(path); d !== DOWNLOADS; d = dirname(d)) {
    try { rmdirSync(d); } catch { break; }
  }
  return to;
}
const rel = (p) => p.replace(`${out}/`, "<out>/").replace(`${DOWNLOADS}/`, "~/Downloads/");

// ---- the steps ----
const s = {};
const steps = [
  { id: "P2", hold: "downloads", name: "picked download folder and Use default", async run() {
    mkdirSync(DL, { recursive: true });
    setKit(DIR_KEY, DL);
    const job = s.job = await openNewestDub();
    s.ticks = await app.js(`localStorage.getItem("persodub.exportTicks")`);
    const rows = await openExport();
    const line = await app.inPage(where);
    const want = app.tr("Saved in {folder} / {day} / {project}", { folder: "dl", day: job.day, project: job.project });
    if (line !== want) throw new Error(`the folder line says "${line}", not "${want}"`);
    if (!(await app.inPage(shown, "#exportFolderReset"))) throw new Error(`${app.tr("Use default")} is not shown`);
    const row = rows.includes("srt") ? "srt" : "audio";
    const before = filesIn(DL);
    const after = await downloadRow(row);
    const files = added(before, DL);
    const into = join(DL, job.day, job.project);
    if (files.length !== 1 || dirname(files[0]) !== into) throw new Error(`${files.length} new file(s) under dl: ${files.map(rel)}`);
    await app.click("#exportFolderReset");
    const home = app.tr("Saved in Downloads / {day} / {project}", { day: job.day, project: job.project });
    await app.waitFor(`the line to say "${home}"`, 5000, (w) => document.querySelector("#exportWhere").textContent.trim() === w
      && document.querySelector("#exportFolderResetWrap").hidden, home);
    const v = kitValue(DIR_KEY);
    if (v !== "") throw new Error(`kit.env's ${DIR_KEY} is "${v}" after ${app.tr("Use default")}`);
    await app.shot("p2-use-default");
    await closeExport();
    return `job ${job.id} "${job.project}": line "${line}", ${app.tr("Use default")} shown; ${row} → "${after}", 1 file `
      + `${rel(files[0])}; ${app.tr("Use default")} → "${home}", ${app.tr("Use default")} hidden, kit.env ${DIR_KEY}=""`;
  } },

  { id: "P3", hold: "downloads", name: "picked folder gone", async run() {
    const gone = join(out, "gone");
    setKit(DIR_KEY, gone);
    const job = s.job;
    if (!(await app.inPage(dubOnScreen, job.id))) await openNewestDub();
    const rows = await openExport();
    const said = app.tr("Cannot find {folder}.", { folder: "gone" });
    const times = (t) => t.split(said).length - 1;
    const dialogText = () => document.querySelector("#exportOverlay").innerText;
    const line = await app.inPage(where);
    const n1 = times(await app.inPage(dialogText));
    if (n1 !== 1) throw new Error(`the dialog says "${said}" ${n1} times before the download: "${line}"`);
    const row = rows.includes("srt") ? "srt" : "audio";
    const into = join(DOWNLOADS, job.day, job.project);
    const before = filesIn([into, DL]);
    const after = await downloadRow(row);
    const n2 = times(await app.inPage(dialogText));
    if (n2 !== 1) throw new Error(`the dialog says "${said}" ${n2} times after the download: "${after}"`);
    await app.shot("p3-folder-gone");
    const files = added(before, into);
    if (files.length !== 1) throw new Error(`${files.length} new file(s) in ~/Downloads/${job.day}/${job.project}`);
    if (existsSync(gone)) throw new Error("the app made the missing folder");
    if (added(before, DL).length) throw new Error(`a file went into dl: ${added(before, DL).map(rel)}`);
    const kept = moveOut(files[0], join(out, "p3"));
    await closeExport();
    return `before "${line}" (1 time), after ${row} "${after}" (1 time); ${basename(kept)} landed in ~/Downloads/${job.day}/${job.project}, moved to ${rel(kept)}`;
  } },

  { id: "P4", hold: "downloads", name: "erased video and Save video under the picked folder", async run() {
    setKit(DIR_KEY, DL);
    const notes = [];
    // The erased video: the newest finished e2e- erase, from its Home card.
    await toHome();
    const { jobs } = await app.api("/api/dub/jobs");
    const er = jobs.find((j) => j.kind === "erase" && j.status === "done" && String(j.project || "").startsWith("e2e-"));
    if (!er) notes.push("erase: skipped, no finished e2e- erase");
    else {
      const job = await app.api(`/api/dub/jobs/${er.id}`);
      await app.click(`#projectsGrid .proj-card[data-job="${er.id}"]`, 20000);
      await app.waitFor("the erased video", 20000, () => {
        const tab = document.querySelector('#eraseTabs [data-erase="erased"]');
        return document.body.dataset.screen === "erase" && tab && tab.classList.contains("active") && !tab.disabled;
      });
      const rows = await openExport();
      if (!rows.includes("video")) throw new Error(`the erase's Download has no video row: ${rows}`);
      const before = filesIn([DL, ...downloadsDirs(job.day)]);
      const after = await downloadRow("video", 300000);
      const files = added(before, DL);
      const into = join(DL, job.day, job.project);
      if (files.length !== 1 || dirname(files[0]) !== into || !files[0].endsWith(".mp4")) throw new Error(`erase: new under dl: ${files.map(rel)}`);
      const stray = loose(before, job.day, basename(files[0]));
      if (stray.length) throw new Error(`erase: ${stray.length} new file(s) under ~/Downloads: ${stray.map(rel)}`);
      await app.shot("p4-erase-saved");
      await closeExport();
      notes.push(`erase ${er.id}: "${after}", ${rel(files[0])} ${(statSync(files[0]).size / 1e6).toFixed(2)} MB, 0 new under ~/Downloads`);
    }
    // Save video: a copy of the clip through Home's banner, the Video row alone.
    await toHome();
    const drafts = await app.js(`localStorage.getItem("persodub.drafts") || "[]"`);
    mkdirSync(join(out, "in"), { recursive: true });
    const clip = join(out, "in", `e2e-restart-save-${stamp}.mp4`);
    copyFileSync(opt.video, clip);
    await app.click("#homeSaveCard");
    await app.waitFor("the link field asked for", 5000, () => document.activeElement === document.querySelector("#linkInput"));
    await app.feed("#uploadZone .home-banner-head", clip);
    await app.waitFor("the held video with Start lit", 120000, () => !document.querySelector("#draftSetup").hidden
      && !document.querySelector("#draftStartBtn").disabled);
    const rows = await openExport();
    if (!rows.includes("video")) throw new Error(`Save video's Download has no video row: ${rows}`);
    const before = filesIn([DL, ...downloadsDirs(today())]);
    const after = await downloadRow("video");
    const files = added(before, DL);
    const into = join(DL, today(), basename(clip, ".mp4"));
    if (files.length !== 1 || dirname(files[0]) !== into || !files[0].endsWith(".mp4")) throw new Error(`save video: new under dl: ${files.map(rel)}`);
    const stray = loose(before, today(), basename(files[0]));
    if (stray.length) throw new Error(`save video: ${stray.length} new file(s) under ~/Downloads: ${stray.map(rel)}`);
    await app.shot("p4-save-video-saved");
    await closeExport();
    notes.push(`save video: "${after}", ${rel(files[0])} ${(statSync(files[0]).size / 1e6).toFixed(2)} MB, 0 new under ~/Downloads`);
    // The draft card the held video left on Home goes again.
    await toHome();
    const left = await app.js(`JSON.parse(localStorage.getItem("persodub.drafts") || "[]").map((d) => d.downloadId)`);
    for (const id of left.filter((id) => !JSON.parse(drafts).some((d) => d.downloadId === id))) {
      await app.click(`#projectsGrid .proj-more[data-more-draft="${id}"]`);
      await app.waitFor("the card menu", 5000, shown, "#projectMenuDelete");
      await app.click("#projectMenuDelete");
      await app.waitFor("the delete dialog", 5000, isOpen, "#deleteOverlay");
      await app.click("#deleteConfirmBtn");
      await app.waitFor("the draft card gone", 10000, (d) => !document.querySelector(`#projectsGrid .proj-card[data-draft="${d}"]`), id);
      notes.push(`its draft card ${id} deleted`);
    }
    putKitBack();
    return notes.join("; ");
  } },

  { id: "H18", hold: "reopen", name: "reopens on the screen it was closed on", async run() {
    const job = s.job || await openNewestDub();
    if (!(await app.inPage(dubOnScreen, job.id))) {
      await toHome();
      await app.click(`#projectsGrid .proj-card[data-job="${job.id}"]`, 20000);
      await app.waitFor("the finished dub", 20000, dubOnScreen, job.id);
    }
    await sleep(2000);   // the page's storage, on disk before the quit
    app.close();
    app = null;
    const q = await quit();
    const t0 = Date.now();
    const from = logLines().length;
    launch(KIT);
    let sec = 0;
    for (const end = t0 + 60000; !sec;) {
      const a = await connect({ port: opt.port, out }).catch(() => null);
      if (a && await a.inPage(dubOnScreen, job.id).catch(() => false)) sec = secs(t0);
      a?.close();
      if (!sec && Date.now() > end) throw new Error(`the dub's screen did not come back in 60 s`);
      if (!sec) await sleep(250);
    }
    const port = Number((await logLine(from, /backend START \(port (\d+)\)/, 5000))[1]);
    ports.push(port);
    if (port !== PORT) throw new Error(`the backend came up on port ${port}, not ${PORT}`);
    await enginesUp();
    await attach();
    await app.shot("h18-reopened");
    const screen = await app.js(`[document.body.dataset.screen, document.body.dataset.jobId]`);
    await toHome();
    if (sec > 15) throw new Error(`the dub's screen came back in ${sec} s, over 15`);
    return `quit on job ${job.id} (QUIT line ${q.quitLine ? "written" : "missing"}${q.forced ? ", forced" : ""}); launch → screen ${screen[0]}, `
      + `job ${screen[1]} in ${sec} s (port ${port}); then Home`;
  } },

  { id: "S2", hold: "engines fail", name: "could not start, and Try again", async run() {
    await toHome();
    app.close();
    app = null;
    await quit();
    setKit(APP_KEY, join(out, "no-such-app-folder"));
    const from = logLines().length;
    launch(KIT);
    const port = Number((await logLine(from, /backend START \(port (\d+)\)/, 120000))[1]);
    ports.push(port);
    await logLine(from, /backend FAILED/, 150000);
    const first = await shellScreen("error.html", 30000);
    await first.w.shot("s2-could-not-start");
    const starts1 = count(from, /backend START \(port/);
    await first.w.click("button");
    first.w.close();
    const end = Date.now() + 180000;
    while (count(from, /backend FAILED/) < 2) {
      if (Date.now() > end) throw new Error("no second failure in 180 s after Try again");
      await sleep(1000);
    }
    const again = await shellScreen("error.html", 30000);
    const shot2 = await again.w.shot("s2-after-try-again");
    again.w.close();
    const starts2 = count(from, /backend START \(port/);
    const same = JSON.stringify(again.text) === JSON.stringify(first.text);
    putKitBack();
    await quit();
    await bootNormally();
    await attach();
    await app.waitFor("Home", 20000, onHome);
    if (starts1 !== 1 || starts2 !== 2) throw new Error(`backend START lines: ${starts1} then ${starts2}, not 1 then 2`);
    if (!same) throw new Error(`the screen after Try again differs: ${JSON.stringify(again.text)}`);
    if (port !== PORT) throw new Error(`the failing boot used port ${port}`);
    return `${APP_KEY}=<missing folder>: "${first.text.slice(0, 3).join(" / ")}" (${first.text.at(-1)}); `
      + `${first.text.at(-1)} → backend START ${starts1} → ${starts2}, same screen again (${shot2}); kit.env back, booted normally on port ${PORT}`;
  } },

  { id: "S3", hold: "not installed", name: "not installed", async run() {
    await toHome();
    app.close();
    app = null;
    await quit();
    const empty = join(out, "empty-kit");
    mkdirSync(empty, { recursive: true });
    launch(empty);
    const { w, text } = await shellScreen("not-installed.html", 60000);
    await w.shot("s3-not-installed");
    const kitShown = await w.js(`document.querySelector("#kitDir").textContent`);
    const missing = await w.js(`document.querySelectorAll("#missing li").length`);
    w.close();
    // A terminal command in the words a person reads: a script to run, or a tool's name.
    const words = text.join(" ").replace(kitShown, "");
    const commands = words.match(/\b[\w-]+\.sh\b|\b(curl|bash|sudo|brew|npm|npx|pip3?|python3?|git)\b/g) || [];
    await quit();
    // What the boot wrote into the empty folder, file by file, then its folders.
    const left = readdirSync(empty, { recursive: true }).map((f) => join(empty, f));
    const files = left.filter((p) => !statSync(p).isDirectory());
    for (const f of files) unlinkSync(f);
    for (const d of left.filter((p) => !files.includes(p)).sort().reverse()) rmdirSync(d);
    rmdirSync(empty);
    await bootNormally();
    await attach();
    await app.waitFor("Home", 20000, onHome);
    if (kitShown !== empty) throw new Error(`the screen names the kit "${kitShown}", not the empty folder`);
    if (missing !== 4) throw new Error(`the screen lists ${missing} missing files, not 4`);
    return `"${text.join(" / ")}"; kit shown = the empty folder, ${missing} missing; terminal commands in its words: `
      + `${commands.length}${commands.length ? ` (${commands.join(", ")})` : ""}; ${files.length} file(s) the app wrote there removed; booted normally`;
  } },
];

// ---- the run ----
if (existsSync(BACKUP) && !sameAsBackup()) {
  console.error(`${BACKUP} is there and differs from kit.env: an earlier run stopped before putting kit.env back. Compare them and put the right one back first.`);
  process.exit(2);
}
copyFileSync(KIT_ENV, BACKUP);
if (existsSync(BAK)) copyFileSync(BAK, bakCopy);
PORT = JSON.parse(readFileSync(join(UD, "ports.json"), "utf8")).backend;
await attach();
console.log(`app on port ${PORT}; out ${out}`);

const results = [];
let n = 0;
for (const hold of [...new Set(steps.map((x) => x.hold))]) {
  await take(hold);
  console.log(`[lock taken: ${hold}]`);
  // Someone changed kit.env through the app since the last hold: that is the file to put back.
  if (!sameAsBackup()) copyFileSync(KIT_ENV, BACKUP);
  try {
    for (const step of steps.filter((x) => x.hold === hold)) {
      n += 1;
      const tag = `${String(n).padStart(2, "0")}-${step.id}`;
      const t0 = Date.now();
      const row = { id: step.id, step: step.name, result: "pass", seconds: 0, note: "", shot: "" };
      try {
        if (!app) await attach();
        row.note = await step.run();
      } catch (e) {
        row.result = "fail";
        row.note = e.message;
      }
      row.seconds = secs(t0);
      try { const w = await windowPage(); row.shot = await w.shot(tag); w.close(); } catch { /* no picture */ }
      results.push(row);
      console.log(`${row.result === "pass" ? "ok  " : "FAIL"} ${step.id} · ${row.seconds}s · ${row.note.slice(0, 160)}`);
    }
  } finally {
    // As found: kit.env, the app booted normally on its port, on Home.
    putKitBack();
    try {
      if (app && s.ticks !== undefined) await app.js(`(${(v) => { if (v === null) localStorage.removeItem("persodub.exportTicks"); else localStorage.setItem("persodub.exportTicks", v); }})(${JSON.stringify(s.ticks)})`);
      if (!app) await attach();
      await toHome();
    } catch (e) {
      console.log(`  putting the app back: ${e.message}`);
      app?.close();
      app = null;
      if (shellProcs().length) await quit();
      await bootNormally();
      await attach();
      await toHome();
    }
    s.home = await app.inPage(onHome);
    holds.push(`${hold} ${secs(heldSince)} s`);
    give();
    console.log(`[lock given back: ${hold}, held ${secs(heldSince)} s]`);
  }
}

// The app as the run found it, and the lock free of this run.
{
  const t0 = Date.now();
  const row = { id: "final", step: "app as found", result: "pass", seconds: 0, note: "", shot: "" };
  try {
    const health = await api("/health").then(() => "answers", () => "no answer");
    const engines = await enginesUp(30000);
    const cmp = spawnSync("cmp", [KIT_ENV, BACKUP]).status;
    const mine = opt.lock && existsSync(join(opt.lock, "who")) && readFileSync(join(opt.lock, "who"), "utf8").includes(`pid ${process.pid} `);
    const fails = [health !== "answers" && `port ${PORT} gives no answer`, cmp !== 0 && "kit.env differs from the backup",
                   !s.home && "not on Home", mine && "the lock is still this run's", holds.some((h) => Number(h.split(" ").at(-2)) > 900) && "a hold over 15 minutes"]
      .filter(Boolean);
    row.note = `port ${PORT} ${health}; engines ${engines}; cmp kit.env kit.env.e2e-backup → ${cmp === 0 ? "same" : "differs"}; `
      + `on Home ${s.home}; lock ${mine ? "still held" : "given back"}; holds ${holds.join(", ")}; backend ports seen ${[...new Set(ports)].join(", ") || "none"}`;
    if (fails.length) throw new Error(`${fails.join("; ")}: ${row.note}`);
    unlinkSync(BACKUP);
  } catch (e) {
    row.result = "fail";
    row.note = e.message;
  }
  row.seconds = secs(t0);
  results.push(row);
  console.log(`${row.result === "pass" ? "ok  " : "FAIL"} final · ${row.note}`);
}
app?.close();

const passed = results.filter((r) => r.result === "pass").length;
const failed = results.length - passed;
const md = [
  "# PersoDub restart run", "",
  `- Run: ${clock(startedAt)} to ${clock()} (${Intl.DateTimeFormat().resolvedOptions().timeZone}), ${Math.round((Date.now() - startedAt) / 1000)} s`,
  `- Test app: kit ${KIT}, user data ${UD}, backend port ${PORT} (seen: ${[...new Set(ports)].join(", ") || "none"}), ${launches} launches`,
  `- Holds: ${holds.join(", ")}`,
  `- Result: ${failed ? "FAIL" : "PASS"}, ${passed} of ${results.length} steps passed (${failed} failed)`, "",
  "| # | Id | Step | Result | Seconds | Note |", "|---|---|---|---|---:|---|",
  ...results.map((r, i) => `| ${i + 1} | ${r.id} | ${r.shot ? `[${r.step}](${r.shot})` : r.step} | ${r.result} | ${r.seconds} | ${r.note.replace(/\|/g, "/")} |`),
  "",
];
writeFileSync(join(out, "report.md"), md.join("\n"));
writeFileSync(join(out, "report.json"), JSON.stringify({ startedAt, port: PORT, ports, holds, results }, null, 2));
console.log(`\n${failed ? "FAIL" : "PASS"}: ${passed}/${results.length}; ${out}/report.md`);
process.exit(failed ? 1 : 0);
