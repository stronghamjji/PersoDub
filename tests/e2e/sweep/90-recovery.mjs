// What a person does when a dubbing fails: the voice engine killed with no
// job running and started again by Start dubbing on its own (N18), killed in
// the middle of a dub's voices so the dub fails (R7), Resume on that failure
// (R8), Start over on a stopped dub (R9), the Home cards of both, and the app
// left with its engine up. Only the voice engine of the kit the app on the
// control port runs from is killed, found with `ps` (macOS and Linux) or
// PowerShell's process list and taskkill (Windows), and only while no one
// else's job is running or queued. Local dubs only.
//
// A desktop app run from the repository has no bundled files, and its shell
// then refuses to start a dead engine again ("no bundled files to install
// from"). The area says so, and starts the engine the way the shell does:
// this file run as `node 90-recovery.mjs --keep-engine <kit> <shell pid>`
// starts desktop/src's sidecarArgv, announces it in runtime.json, starts it
// again when it exits 75 (its memory restart), and stops with the shell.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep, shown, onHome, textOf, Skip } from "../lib/cdp.mjs";

export const area = "recovery";

const CHOICES_KEY = "persodub.lastChoices";
const BUSY = ["running", "queued", "cancelling"];
const WIN = process.platform === "win32";
// The backend's and the voice engine's command lines after the kit's folder:
// a venv's bin/uvicorn, or on Windows its Scripts\uvicorn.exe.
const BACKEND = WIN ? "\\app_venv\\Scripts\\uvicorn.exe app.main:app" : "/app_venv/bin/uvicorn app.main:app";
const ENGINE = WIN ? "\\engines_venv\\Scripts\\uvicorn.exe server:app" : "/engines_venv/bin/uvicorn server:app";
const INSTALLED = WIN ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "PersoDub")
  : join(homedir(), "Library", "Application Support", "PersoDub");
const secs = (t0) => Math.round((Date.now() - t0) / 1000);

async function until(what, ms, test) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await test();
    if (v) return v;
    if (Date.now() > end) throw new Error(`waited ${ms / 1000} s for ${what}`);
    await sleep(1000);
  }
}

// Every process as "pid ppid command line". Windows has no ps: PowerShell
// lists them, in UTF-8 so a Korean folder name comes through, and the quotes
// around a path with a space are dropped so a command line reads as on macOS.
function psLines() {
  const r = WIN
    ? spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding = [Text.Encoding]::UTF8; "
      + "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CommandLine }"],
                { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    : spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  if (r.status !== 0) throw new Skip(WIN ? "PowerShell's process list (Get-CimInstance Win32_Process) did not run" : "ps did not run");
  return (WIN ? r.stdout.replace(/"/g, "") : r.stdout).split(/\r?\n/).map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }));
}

// Gone at once, the way a crash ends it. On Windows the program started is a
// launcher (uvicorn.exe) with Python under it, so its whole tree goes.
function killNow(pid) {
  if (WIN) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else process.kill(pid, "SIGKILL");
}

// The kit the backend on the app's port runs from (<kit>/app_venv/bin/uvicorn),
// and the desktop shell that started it. The installed app's own kit is never
// this area's to kill in.
function kitOf(app) {
  const port = new URL(app.origin).port;
  const lines = psLines().filter(({ cmd }) => cmd.includes(BACKEND) && new RegExp(`--port ${port}(\\s|$)`).test(cmd));
  // The topmost of them: on Windows the launcher's Python child says the same.
  const line = lines.find((l) => !lines.some((o) => o.pid === l.ppid));
  if (!line) throw new Error(`no backend on port ${port} in the process list`);
  const head = line.cmd.slice(0, line.cmd.indexOf(BACKEND));
  // The path that ends there: from its drive letter on Windows, from its "/" elsewhere.
  const kit = WIN ? head.replace(/^.*(?:^|\s)(?=[A-Za-z]:\\)/, "") : head.slice(head.lastIndexOf(" /") + 1);
  if (WIN ? kit.toLowerCase() === INSTALLED.toLowerCase() : kit === INSTALLED) {
    throw new Skip(`the app on port ${port} runs from the installed app's kit; this area runs against a test kit only`);
  }
  return { kit, shell: line.ppid };
}
const enginePids = (kit) => psLines().filter(({ cmd }) => cmd.includes(`${kit}${ENGINE}`)).map((p) => p.pid);
function runtimeOf(kit) {
  try { return JSON.parse(readFileSync(join(kit, "runtime.json"), "utf8")); } catch { return {}; }
}

// The voice engine as GET /api/engines says it is and as it is: the process
// runtime.json names alive, and answering its health probe.
async function engine(app, { kit }) {
  const said = (await app.api("/api/engines")).local_engines.voice.state;
  const rt = runtimeOf(kit);
  const alive = !!rt.tts_pid && enginePids(kit).includes(rt.tts_pid);
  const answers = !!rt.tts_url && await fetch(`${rt.tts_url}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  return { said, pid: rt.tts_pid || 0, up: said === "running" && alive && answers };
}

// No one else's job running or queued: killing the engine would fail theirs.
async function othersIdle(app, mine) {
  await until("other jobs to finish", 5 * 60000, async () => !(await app.api("/api/dub/jobs")).jobs
    .some((j) => BUSY.includes(j.status) && !mine.includes(j.id)));
}

// The engine process killed the way a crash ends it.
async function killEngine(app, k, mine = []) {
  const { kit } = k;
  await othersIdle(app, mine);
  const { pid } = await engine(app, k);
  if (!pid || !enginePids(kit).includes(pid)) throw new Error(`runtime.json names engine ${pid || "none"}, ps shows ${enginePids(kit).join(", ") || "none"}`);
  killNow(pid);
  await until(`engine ${pid} to be gone`, 10000, () => !enginePids(kit).includes(pid));
  return pid;
}

const engineUp = (app, k, ms) => until("the voice engine to answer", ms, async () => { const e = await engine(app, k); return e.up && e; });

// The engine started by this file's --keep-engine, for a shell that refused to.
async function keeperStart(app, k, out) {
  // Never a second engine beside one that is there.
  if (enginePids(k.kit).length) throw new Error(`an engine of this kit is running already (${enginePids(k.kit).join(", ")})`);
  const fd = openSync(join(out, "keep-engine.log"), "a");
  spawn(process.execPath, [fileURLToPath(import.meta.url), "--keep-engine", k.kit, String(k.shell)],
        { detached: true, windowsHide: true, stdio: ["ignore", fd, fd] }).unref();
  return engineUp(app, k, 180000);
}

// The engine started again: first the way Start dubbing asks for it (the
// desktop app's install-pack, which starts a pack that is on disk), then, if
// the shell refuses, by the keeper. `how` says which, the refusal quoted.
async function bringBack(app, k, out) {
  const was = await engine(app, k);
  if (was.up) throw new Error(`the engine is up (${was.pid}); nothing to bring back`);
  const r = await app.send("Runtime.evaluate", { expression: `window.persodubShell.installPack("engine")`,
                                                 awaitPromise: true, returnByValue: true }, 330000);
  const v = r.result.value || {};
  if (v.ok) return { e: await engineUp(app, k, 30000), how: "the desktop app started it" };
  return { e: await keeperStart(app, k, out), how: `FINDING: the desktop app refused to start it ("${v.reason}"); started the way the shell does (--keep-engine)` };
}

async function home(app) {
  if (!(await app.inPage(onHome))) await app.click("#homeBtn");
  await app.waitFor("the Home screen", 10000, onHome);
}

// A new local dub of a copy of ctx.video into Korean, started from the Dubbing tab.
async function startDub(app, ctx, tag) {
  const dialog = await app.js(`document.querySelector(".modal-overlay.open")?.id || ""`);
  if (dialog) throw new Error(`#${dialog} is open`);
  await home(app);
  const video = join(ctx.out, `e2e-recovery-${ctx.stamp}-${tag}.mp4`);
  copyFileSync(ctx.video, video);
  await app.click("#homeDubCard");
  await app.waitFor("the Dubbing tab's Import block", 10000, shown, "#dubbingZone .import-head");
  await app.feed("#dubbingZone .import-head", video);
  const ready = await app.waitFor("the Before dubbing card with Start lit", 120000, () => {
    const s = document.querySelector("#dubbingImportStatus");
    if (s.classList.contains("error") && s.textContent.trim()) return `refused: ${s.textContent.trim()}`;
    return !document.querySelector("#draftSetup").hidden && !document.querySelector("#draftStartBtn").disabled ? "ready" : "";
  });
  if (ready !== "ready") throw new Error(`the import was ${ready}`);
  await app.choose("#dubModeSelect", "local");
  await app.choose("#sepSelect", "local");
  await app.choose("#sttSelect", "local");
  await app.choose("#targetLangSelect", "ko");
  return pressStart(app);
}

// Start dubbing pressed: the job it started, or `refused` with the words under it.
async function pressStart(app) {
  const before = await app.js(`document.body.dataset.jobId || ""`);
  const t0 = Date.now();
  await app.click("#draftStartBtn");
  const started = await app.waitFor("the dub to start", 60000, (was) => {
    const b = document.body;
    if (b.dataset.screen === "running" && b.dataset.jobId && b.dataset.jobId !== was) return `job:${b.dataset.jobId}`;
    const d = document.querySelector(".modal-overlay.open");
    if (d) return `#${d.id} opened`;
    const error = document.querySelector("#draftError").textContent.trim();
    return error && !error.endsWith("…") ? `refused: ${error}` : "";
  }, before);
  if (started.startsWith("refused: ")) return { refused: started.slice(9) };
  if (!started.startsWith("job:")) throw new Error(`Start was ${started}`);
  const id = started.slice(4);
  const job = await app.api(`/api/dub/jobs/${id}`);
  if (job.dub_mode !== "local" || job.separation === "perso" || job.stt_engine === "perso") {
    throw new Error(`PERSO CREDITS: job ${id} runs ${job.dub_mode}/${job.separation}/${job.stt_engine}; stop it now`);
  }
  return { id, took: secs(t0), job };
}

// The job's screen, opened from its Home card unless it is up already.
async function open(app, id, screen) {
  const here = () => app.inPage((jid, sc) => document.body.dataset.jobId === jid && document.body.dataset.screen === sc, id, screen);
  if (await here()) return;
  await home(app);
  await app.click(`#projectsGrid .proj-card[data-job="${id}"]`, 20000);
  await app.waitFor(`job ${id} on the ${screen} screen`, 20000, (jid, sc) => document.body.dataset.jobId === jid
    && document.body.dataset.screen === sc && document.querySelector("#doneFailWhy").textContent.trim(), id, screen);
}

// Resume or Start over pressed on the failure card: the job it runs (the same
// one, or a new one), and what happened when the engine was not up for it.
async function press(app, k, out, sel, from) {
  const taken = () => app.waitFor(`${sel} to start a job`, 60000, (was, same) => {
    const b = document.body;
    if (b.dataset.screen === "running" && b.dataset.jobId && (b.dataset.jobId === was) === same) return `job:${b.dataset.jobId}`;
    const e = document.querySelector("#doneRetryError").textContent.trim();
    return e ? `refused: ${e}` : "";
  }, from, sel === "#doneResume");
  await app.click(sel);
  let r = await taken(), said = "";
  if (r.startsWith("refused: ")) {
    if ((await engine(app, k)).up) throw new Error(`${sel} was refused with the engine up: ${r.slice(9)}`);
    const { e, how } = await bringBack(app, k, out);
    said = `FINDING: refused with "${r.slice(9)}", the engine left down; ${how}, engine ${e.pid} up; pressed again`;
    await app.click(sel);
    r = await taken();
    if (!r.startsWith("job:")) throw new Error(`${sel} was ${r} with the engine up`);
  }
  return { id: r.slice(4), said };
}

// The job finished, its table drawn.
async function waitDone(app, id, ms) {
  const t0 = Date.now();
  await until(`job ${id} to finish`, ms, async () => {
    const j = await app.api(`/api/dub/jobs/${id}`);
    if (j.status === "error" || j.status === "cancelled") throw new Error(`job ${id} ended ${j.status}: ${j.error_shown || j.error || ""}`);
    return j.status === "done";
  });
  const rows = await app.waitFor("the script table", 20000, (jid) => document.body.dataset.jobId === jid && document.body.dataset.screen === "done"
    && document.querySelectorAll("#scriptBox .sc-row:not(.head)").length, id);
  const lines = (await app.api(`/api/dub/jobs/${id}/script`)).lines || [];
  if (rows !== 3 || lines.length !== 3) throw new Error(`job ${id} finished with ${rows} rows and ${lines.length} script lines, not 3`);
  return secs(t0);
}

// What an earlier step made; skipped when it did not get that far, since that
// step's own failure (or skip) already says why.
function need(ctx, key, what) {
  const s = ctx.state.recovery;
  if (!s || !s[key]) throw new Skip(`no ${what} from an earlier step`);
  return s;
}

const sentences = (s) => (s.match(/[.?!](\s|$)/g) || []).length;

export const steps = [
  { name: "engine killed, Start starts it", looks: ["#draftSetup", "#progressCard"],
    async run(app, ctx) {
      const s = ctx.state.recovery = { k: kitOf(app), choices: await app.js(`localStorage.getItem(${JSON.stringify(CHOICES_KEY)})`) };
      const was = await engine(app, s.k);
      if (!was.up) throw new Error(`the voice engine is not up before the kill (/api/engines "${was.said}")`);
      const killed = await killEngine(app, s.k);
      const stale = (await engine(app, s.k)).said;
      let d = await startDub(app, ctx, "stop"), how = "the page had the desktop app start it";
      if (d.refused) {
        // Start asked the shell to start the engine and was told no.
        const up = await keeperStart(app, s.k, ctx.out);
        how = `FINDING: Start was refused ("${d.refused.replace(/\n/g, " / ")}"); started the way the shell does (--keep-engine), engine ${up.pid}; pressed Start again`;
        d = await pressStart(app);
        if (d.refused) throw new Error(`Start was refused again with the engine up: ${d.refused}`);
      }
      const e = await engine(app, s.k);
      if (!e.up || e.pid === killed) throw new Error(`job ${d.id} runs but the engine is not back (/api/engines "${e.said}", pid ${e.pid})`);
      const error = await app.inPage(textOf, "#draftError");
      if (error) throw new Error(`#draftError says "${error}"`);
      // Stopped here, and Start over is pressed on it in step 4.
      await app.waitFor("the running card", 10000, shown, "#progressCard");
      await app.click("#cancelBtn", 10000);
      if (await app.waitFor("the stop question", 3000, (sel) => document.querySelector(sel).classList.contains("open"), "#cancelDubOverlay").catch(() => false)) {
        await app.click("#cancelDubConfirmBtn");
      }
      await until(`job ${d.id} to be cancelled`, 60000, async () => (await app.api(`/api/dub/jobs/${d.id}`)).status === "cancelled");
      await app.waitFor("the stopped card", 15000, (jid) => document.body.dataset.jobId === jid && document.body.dataset.screen === "failed", d.id);
      s.stopped = d.id;
      return `engine ${killed} killed, no job running (/api/engines still said "${stale}"); Start → job ${d.id} running ${d.took} s after the press; `
        + `engine ${e.pid} answers (/api/engines "${e.said}"); #draftError empty; dub cancelled (kept for Start over); ${how}`;
    } },

  { name: "engine killed mid-voices, failure card", looks: ["#doneFail", "#progressCard"],
    async run(app, ctx) {
      const s = need(ctx, "k", "kit");
      const was = await engine(app, s.k);
      if (!was.up) throw new Error(`the voice engine is not up (/api/engines "${was.said}")`);
      const d = await startDub(app, ctx, "fail");
      s.failed = d.id;
      const t0 = Date.now();
      const title = await until("the voice stage", 300000, async () => {
        const j = await app.api(`/api/dub/jobs/${d.id}`);
        if (!BUSY.includes(j.status)) throw new Error(`job ${d.id} ended ${j.status} before its voices`);
        const t = await app.inPage(textOf, "#progressTitle");
        return t === app.tr("Dubbing") && (j.logs || []).some((l) => l.startsWith("4/")) && t;
      });
      const reached = secs(t0);
      const killed = await killEngine(app, s.k, [d.id]);
      const t1 = Date.now();
      await until(`job ${d.id} to fail`, 120000, async () => {
        const j = await app.api(`/api/dub/jobs/${d.id}`);
        if (j.status === "done" || j.status === "cancelled") throw new Error(`job ${d.id} ended ${j.status}, not failed`);
        return j.status === "error";
      });
      const failedIn = secs(t1);
      const c = await app.waitFor("the failure card", 15000, (jid) => {
        const b = document.body, why = document.querySelector("#doneFailWhy").textContent.trim();
        const btn = (sel) => { const el = document.querySelector(sel); return el.getClientRects().length > 0 && !el.disabled ? el.textContent.trim() : ""; };
        return b.dataset.jobId === jid && b.dataset.screen === "failed" && why
          && { why, notice: document.querySelector("#doneNotice").textContent.replace(/\s+/g, " ").trim(),
               resume: btn("#doneResume"), retry: btn("#doneRetry") };
      }, d.id);
      await app.shot("recovery-failure-card");
      if (!/[가-힣]/.test(c.why) || sentences(c.why) !== 1) throw new Error(`#doneFailWhy is not one Korean sentence: "${c.why}"`);
      if (!/[가-힣]/.test(c.notice) || /[A-Za-z]{4,}/.test(c.notice.replace(/PersoDubbing|PersoDub|Perso API/g, ""))) {
        throw new Error(`the cause under it is not plain Korean: "${c.notice}"`);
      }
      if (c.resume !== app.tr("Resume") || c.retry !== app.tr("Start over")) throw new Error(`the buttons read "${c.resume}" and "${c.retry}"`);
      // Home says so too, and its card brings the failure card back.
      await home(app);
      s.failedChip = await app.waitFor("the failed card's chip", 20000, (sel) => (document.querySelector(sel)?.textContent || "").trim(), `#projChip-${d.id}`);
      if (s.failedChip !== app.tr("Failed")) throw new Error(`the Home card says "${s.failedChip}", not "${app.tr("Failed")}"`);
      await open(app, d.id, "failed");
      return `job ${d.id} at "${title}" ${reached} s in; engine ${killed} killed; failed ${failedIn} s later; #doneFailWhy "${c.why}"; `
        + `cause under it (#doneNotice) "${c.notice}"; buttons "${c.resume}" "${c.retry}"; Home chip "${s.failedChip}", card reopens it`;
    } },

  { name: "Resume the failed dub", looks: ["#doneFail", "#progressCard", "#scriptBox"],
    async run(app, ctx) {
      const s = need(ctx, "failed", "failed dub");
      await open(app, s.failed, "failed");
      const r = await press(app, s.k, ctx.out, "#doneResume", s.failed);
      if (r.id !== s.failed) throw new Error(`Resume runs job ${r.id}, not ${s.failed}`);
      const e = await engine(app, s.k);
      const took = await waitDone(app, s.failed, 300000);
      s.resumed = true;
      return `${app.tr("Resume")}: job ${r.id} running again (engine ${e.pid}, /api/engines "${e.said}"), done ${took} s later, 3 rows and 3 script lines`
        + (r.said ? `; ${r.said}` : "; the engine was up already");
    } },

  { name: "Start over the stopped dub", looks: ["#doneFail", "#progressCard", "#scriptBox"],
    async run(app, ctx) {
      const s = need(ctx, "stopped", "stopped dub");
      await open(app, s.stopped, "failed");
      const why = await app.inPage(textOf, "#doneFailWhy");
      if (why !== app.tr("This dubbing was stopped.")) throw new Error(`the stopped card says "${why}"`);
      const r = await press(app, s.k, ctx.out, "#doneRetry", s.stopped);
      s.retried = r.id;
      const took = await waitDone(app, r.id, 300000);
      const old = (await app.api(`/api/dub/jobs/${s.stopped}`)).status;
      if (old !== "cancelled") throw new Error(`the stopped job ${s.stopped} is ${old} now`);
      return `card "${why}" → ${app.tr("Start over")}: new job ${r.id} done ${took} s later, 3 rows; job ${s.stopped} still ${old}` + (r.said ? `; ${r.said}` : "");
    } },

  { name: "Home cards", looks: ["#projectsGrid"],
    async run(app, ctx) {
      const s = need(ctx, "k", "kit");
      await home(app);
      const want = [[s.failed, "", "failed, then resumed"], [s.stopped, app.tr("Cancelled"), "stopped"], [s.retried, "", "started over"]].filter(([id]) => id);
      if (want.length < 3) throw new Error(`only ${want.length} of the three jobs were made`);
      const cards = await app.waitFor("the three cards", 20000, (ids) => {
        const got = ids.map((id) => {
          const card = document.querySelector(`#projectsGrid .proj-card[data-job="${id}"]`);
          return card && { chip: (card.querySelector(".proj-chip")?.textContent || "").trim(), meta: card.querySelector(".proj-meta").textContent.trim() };
        });
        return got.every(Boolean) && got;
      }, want.map(([id]) => id));
      const bad = want.map(([id, chip], i) => (cards[i].chip === chip ? "" : `${id} says "${cards[i].chip}", not "${chip}"`)).filter(Boolean);
      if (bad.length) throw new Error(bad.join("; "));
      return want.map(([id, , what], i) => `${what} ${id}: ${cards[i].chip ? `chip "${cards[i].chip}"` : "no chip (done)"}, "${cards[i].meta}"`).join("; ")
        + (s.failedChip ? `; the failed one said "${s.failedChip}" before Resume` : "");
    } },

  { name: "tidy", looks: ["#screen-home"],
    async run(app, ctx) {
      const s = ctx.state.recovery || {};
      if (s.k === undefined) s.k = kitOf(app);
      let e = await engine(app, s.k), started = "";
      if (!e.up) {
        const b = await bringBack(app, s.k, ctx.out);
        e = b.e;
        started = ` (down: ${b.how})`;
      }
      if ("choices" in s) {
        await app.inPage((k, v) => { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); return true; }, CHOICES_KEY, s.choices);
      }
      await home(app);
      // A step that failed may have left its dub running or queued: stopped here.
      const mine = [s.stopped, s.failed, s.retried].filter(Boolean);
      const busy = (await app.api("/api/dub/jobs")).jobs.filter((j) => mine.includes(j.id) && BUSY.includes(j.status)).map((j) => j.id);
      for (const id of busy) await app.api(`/api/dub/jobs/${id}/cancel`, { method: "POST" });
      await until("this area's jobs to stop", 60000, async () => !(await app.api("/api/dub/jobs")).jobs
        .some((j) => mine.includes(j.id) && BUSY.includes(j.status)));
      return `none of this area's ${mine.length} jobs running${busy.length ? ` (stopped ${busy.join(", ")})` : ""}; `
        + `engine ${e.pid} answers, /api/engines "${e.said}"${started}; ${CHOICES_KEY} put back; Home`;
    } },
];

// The engine kept the way the desktop shell keeps it (orchestrator.js
// startPackProcesses and watchRestart), for a shell that cannot: started from
// its own kit.env, announced in runtime.json once it answers, started again
// when it exits 75, and stopped when the shell is gone. Any other end (a
// kill) ends the keeper too.
async function keepEngine(kit, shellPid) {
  const src = (f) => import(new URL(`../../../desktop/src/${f}`, import.meta.url));
  const [{ parseEnvFile, KIT_ENV }, { applyBinDir, sidecarArgv }, { getFreePort }, { writeRuntime, clearRuntime }] =
    await Promise.all(["kitEnv.js", "orchestrator.js", "freePort.js", "runtimeFile.js"].map(src));
  const env = applyBinDir({ ...process.env, ...parseEnvFile(readFileSync(join(kit, KIT_ENV), "utf8")) });
  const say = (line) => console.log(`${new Date().toLocaleString("sv-SE")} ${line}`);
  for (;;) {
    clearRuntime(kit, ["tts_url", "tts_pid"]);
    writeRuntime(kit, { tts_state: "starting" });
    const port = await getFreePort();
    const [cmd, ...args] = sidecarArgv(kit, port);
    const child = spawn(cmd, args, { cwd: join(kit, "sidecar"), env, detached: true, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
    // Its process group on macOS and Linux; on Windows taskkill takes the tree.
    const stop = (signal) => {
      if (WIN) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      else try { process.kill(-child.pid, signal); } catch { /* gone */ }
    };
    const ended = new Promise((ok) => child.once("exit", (code, signal) => ok(code ?? signal)));
    let done = null;
    ended.then((v) => { done = v; });
    say(`engine START pid ${child.pid} port ${port}`);
    const up = await until("the engine", 5 * 60000, async () => done !== null || await fetch(`http://127.0.0.1:${port}/health`,
      { signal: AbortSignal.timeout(2000) }).then((r) => r.json(), () => ({})).then((b) => b.status === "ok")).catch(() => false);
    if (!up || done !== null) {
      writeRuntime(kit, { tts_state: "failed" });
      say(`engine FAILED (${done ?? "no answer"})`);
      stop("SIGKILL");
      return;
    }
    writeRuntime(kit, { tts_url: `http://127.0.0.1:${port}`, tts_pid: child.pid });
    clearRuntime(kit, ["tts_state", "tts_failure"]);
    say(`engine READY pid ${child.pid}`);
    const watch = setInterval(() => {
      try { process.kill(shellPid, 0); } catch { stop("SIGTERM"); }
    }, 10000);
    const how = await ended;
    clearInterval(watch);
    say(`engine EXITED pid ${child.pid} (${how})`);
    if (how !== 75) return;
  }
}

if (process.argv[2] === "--keep-engine" && process.argv[1] === fileURLToPath(import.meta.url)) {
  await keepEngine(process.argv[3], Number(process.argv[4]));
}
