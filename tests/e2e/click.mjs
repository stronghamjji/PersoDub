// Click-through regression run against the real desktop app. It talks to the
// app's page over the Chrome DevTools Protocol and presses the app's own
// buttons the way a person does -- a mouse press and release on the element's
// box -- one step after another, with a screenshot and a time for each. Not
// part of any test suite: it needs the app running with a control port and a
// short video with speech,
//
//   cd desktop && npx electron . --remote-debugging-port=9333
//   node tests/e2e/click.mjs --video clip.mp4 --out <folder>
//
// It dubs that video into Korean on this computer, so a dub already in the
// queue makes step 4 wait (30 minutes at most). Writes NN-<step>.png,
// report.md and report.json into <folder> and exits 1 when a step fails.
import { parseArgs } from "node:util";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const { values: opt } = parseArgs({ options: {
  video: { type: "string" }, out: { type: "string" }, port: { type: "string", default: "9333" },
  translator: { type: "string" } } });
if (!opt.video || !existsSync(opt.video)) {
  console.error("usage: node tests/e2e/click.mjs --video <short mp4 with speech> [--out <folder>] [--port 9333] [--translator hunyuan]");
  process.exit(2);
}
const startedAt = new Date();
// "2026-10-21 00:40:12": the computer's own clock, as the report says it.
const clock = (d = new Date()) => d.toLocaleString("sv-SE");
const stamp = clock(startedAt).replace(/[-:]/g, "").replace(" ", "-");
const out = resolve(opt.out || `e2e-click-${stamp}`);
mkdirSync(out, { recursive: true });
// The draft is named after its file, and the project after the draft: a copy
// under this name is what makes the new card findable on Home.
const PROJECT = `e2e-click-${stamp}`;
const video = join(out, `${PROJECT}.mp4`);
copyFileSync(opt.video, video);
const CHOICES_KEY = "persodub.lastChoices";

// ---- the control port ------------------------------------------------------
const START_IT = `start the app with --remote-debugging-port=${opt.port}`;
const targets = await fetch(`http://127.0.0.1:${opt.port}/json`, { signal: AbortSignal.timeout(5000) })
  .then((r) => r.json(), () => { throw new Error(`nothing answers on port ${opt.port}; ${START_IT}`); });
const target = targets.find((t) => t.type === "page" && t.url.startsWith("http://127.0.0.1:"));
if (!target) throw new Error(`no app page on port ${opt.port}; ${START_IT}`);
const origin = new URL(target.url).origin;
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error(`cannot open ${target.webSocketDebuggerUrl}`)); });
let seq = 0;
const pending = new Map();
const handlers = new Map();
ws.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  if (!m.id) { for (const fn of handlers.get(m.method) || []) fn(m.params); return; }
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.error) p.no(new Error(`${p.method}: ${m.error.message}`)); else p.ok(m.result);
};
ws.onclose = () => { for (const p of pending.values()) p.no(new Error("the app closed its control port")); };

// Every call has a limit: a page that stops answering ends the run instead of hanging it.
function send(method, params = {}, ms = 30000) {
  return new Promise((ok, no) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); no(new Error(`${method}: no answer in ${ms / 1000} s`)); }, ms);
    pending.set(id, { method, ok: (v) => { clearTimeout(timer); ok(v); }, no: (e) => { clearTimeout(timer); no(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function nextEvent(method, ms) {
  return new Promise((ok, no) => {
    const set = handlers.get(method) || new Set();
    handlers.set(method, set);
    const fn = (params) => { set.delete(fn); clearTimeout(timer); ok(params); };
    const timer = setTimeout(() => { set.delete(fn); no(new Error(`no ${method} in ${ms / 1000} s`)); }, ms);
    set.add(fn);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function js(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(`in the page: ${(r.exceptionDetails.exception?.description || r.exceptionDetails.text).split("\n")[0]}`);
  }
  return r.result.value;
}
// fn goes to the page as source, so it may use only its arguments and the page's globals.
const inPage = (fn, ...args) => js(`(${fn})(...${JSON.stringify(args)})`);
async function waitFor(what, ms, fn, ...args) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await inPage(fn, ...args);
    if (v) return v;
    if (Date.now() > end) throw new Error(`waited ${ms / 1000} s for ${what}`);
    await sleep(250);
  }
}
async function api(path) {
  const r = await fetch(origin + path, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
  return r.json();
}

const shown = (s) => { const el = document.querySelector(s); return !!el && el.getClientRects().length > 0; };
const pressable = (s) => { const el = document.querySelector(s); return !!el && el.getClientRects().length > 0 && !el.disabled; };
const isOpen = (s) => document.querySelector(s).classList.contains("open");
const isClosed = (s) => !document.querySelector(s).classList.contains("open");
const onHome = () => document.body.dataset.screen === "home" && !document.querySelector("#screen-home").hidden;
// What a person would hit at (x, y): a dialog or a toast over the button takes the click instead.
const HIT = function (x, y) {
  const hit = document.elementFromPoint(x, y);
  if (hit && (hit === this || this.contains(hit))) return "";
  return hit ? hit.tagName.toLowerCase() + (hit.id ? `#${hit.id}` : "") + [...hit.classList].map((c) => `.${c}`).join("") : "nothing";
}.toString();

// A press and a release at the middle of the element's box. No mouse move
// first: on a window that another one covers, the page takes a move only
// with its next frame, which does not come (5 s a move, measured 2026-10-21),
// while a press and a release are taken at once.
async function click(sel, ms = 10000) {
  await waitFor(`${sel} to be pressable`, ms, pressable, sel);
  const { result } = await send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(sel)})`, objectGroup: "e2e" });
  await send("DOM.scrollIntoViewIfNeeded", { objectId: result.objectId });
  const b = (await send("DOM.getBoxModel", { objectId: result.objectId })).model.border;
  const x = (b[0] + b[2] + b[4] + b[6]) / 4, y = (b[1] + b[3] + b[5] + b[7]) / 4;
  const over = (await send("Runtime.callFunctionOn", { objectId: result.objectId, functionDeclaration: HIT,
                                                       arguments: [{ value: x }, { value: y }], returnByValue: true })).result.value;
  if (over) throw new Error(`${sel} is covered by ${over}`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
  }
}
// A <select> opens a native menu on macOS that CDP cannot press, so the
// option is picked the way that menu leaves it: the value, then the input
// and change events the page listens for. Nothing fires when it is on it already.
async function choose(sel, value) {
  const ok = await inPage((s, v) => {
    const el = document.querySelector(s);
    if (!el || ![...el.options].some((o) => o.value === v)) return false;
    if (el.value !== v) {
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return true;
  }, sel, value);
  if (!ok) throw new Error(`${sel} has no option ${value}`);
}
async function shot(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(out, `${name}.png`), Buffer.from(data, "base64"));
  return `${name}.png`;
}
// The first of a step's areas that is on screen: a failed dub shows its card,
// not the table. Only areas named here, never the Settings dialog as a whole,
// which can hold account details.
const snippet = (looks) => inPage((sels) => {
  const els = sels.map((s) => document.querySelector(s)).filter(Boolean);
  const el = els.find((e) => e.getClientRects().length > 0) || els[0];
  const html = el ? el.outerHTML.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ") : `(none of ${sels})`;
  return `screen=${document.body.dataset.screen} ${html.slice(0, 1500)}`;
}, looks);

// ---- the app as it stands --------------------------------------------------
await send("Page.enable");
const page = await inPage(() => ({ lang: document.documentElement.lang || "en", width: innerWidth, height: innerHeight,
                                   visibility: document.visibilityState }));
// The page's words, looked up the way its own t() does: the English is the key.
const words = page.lang === "en" ? {}
  : await (await fetch(`${origin}/i18n/ui.${page.lang}.json`, { signal: AbortSignal.timeout(10000) })).json();
const tr = (key) => (Object.hasOwn(words, key) ? words[key] : key);
// Step 3's picks are remembered for the person's next project; the run puts
// back what was there before it.
const savedChoices = await js(`localStorage.getItem(${JSON.stringify(CHOICES_KEY)})`);
const run = { jobId: "", job: null };

// ---- the steps -------------------------------------------------------------
async function homeStep() {
  const dialog = await js(`document.querySelector(".modal-overlay.open")?.id || ""`);
  if (dialog) throw new Error(`#${dialog} is open; the run starts with no dialog in the way`);
  if (!(await inPage(onHome))) await click("#homeBtn");
  await waitFor("the Home screen", 10000, onHome);
  for (const sel of ["#homePerso", "#homeGhName", "#homeDubCard", "#homeAudioCard", "#homeEraseCard", "#homeSaveCard"]) {
    await waitFor(`${sel} on show`, 5000, shown, sel);
  }
  if (!(await js(`document.querySelector("#homePerso img").naturalWidth`))) throw new Error("the Perso pill's wordmark did not load");
  const grid = await waitFor("the project grid to paint", 15000, () => {
    const g = document.querySelector("#projectsGrid");
    const n = g.querySelectorAll(".proj-card").length;
    return n ? `${n} cards` : g.querySelector(".projects-empty") ? "no projects yet" : "";
  });
  return { note: `Perso pill, GitHub button, four tool cards; grid ${grid}` };
}

async function settingsStep(snap) {
  await click("#homeNavSettings");
  await waitFor("the Settings dialog", 10000, isOpen, "#settingsOverlay");
  await click("#settingsTab-models");
  const rows = await waitFor("the Models list to paint", 15000, () => !document.querySelector("#settingsPanel-models").hidden
    && document.querySelectorAll("#modelsList .model-row").length);
  const groups = await js(`document.querySelectorAll("#modelsList .model-group-head").length`);
  await snap();
  await click("#settingsCancelBtn");
  await waitFor("the Settings dialog to close", 5000, isClosed, "#settingsOverlay");
  return { note: `${rows} model rows in ${groups} groups` };
}

async function newProjectStep(snap, base) {
  await click("#homeDubCard");
  await waitFor("the Dubbing tab's Import block", 10000, shown, "#dubbingZone .import-head");
  // The block's click opens the file picker. Intercepted, the picker is not
  // drawn; the page names its file input instead, and the video goes into it.
  await send("Page.setInterceptFileChooserDialog", { enabled: true });
  try {
    const chooser = nextEvent("Page.fileChooserOpened", 5000);
    chooser.catch(() => {});
    await click("#dubbingZone .import-head");
    const { backendNodeId } = await chooser;
    await send("DOM.setFileInputFiles", { files: [video], backendNodeId });
  } finally {
    await send("Page.setInterceptFileChooserDialog", { enabled: false });
  }
  const ready = await waitFor("the draft card with Start lit", 120000, () => {
    const s = document.querySelector("#dubbingImportStatus");
    if (s.classList.contains("error") && s.textContent.trim()) return `refused: ${s.textContent.trim()}`;
    return !document.querySelector("#draftSetup").hidden && !document.querySelector("#draftStartBtn").disabled ? "ready" : "";
  });
  if (ready !== "ready") throw new Error(`the import was ${ready}`);
  // The mode first: changing it refills the target list.
  await choose("#dubModeSelect", "local");
  await choose("#targetLangSelect", "ko");
  // Without --translator the dub keeps the one the app starts a new project
  // on, which hangs on whoever used the app last; with it, Advanced options
  // is opened with its own button and that translator picked.
  if (opt.translator) {
    if (!(await inPage(shown, "#translateSelect"))) await click("#advancedBtn");
    await choose("#translateSelect", opt.translator);
  }
  await shot(`${base}-draft`);
  const before = await js(`document.body.dataset.jobId || ""`);
  await click("#draftStartBtn");
  const started = await waitFor("the dub to start", 120000, (was) => {
    const b = document.body;
    if (b.dataset.screen === "running" && b.dataset.jobId && b.dataset.jobId !== was) return `job:${b.dataset.jobId}`;
    const error = document.querySelector("#draftError").textContent.trim();
    if (error) return `refused: ${error}`;
    const d = document.querySelector(".modal-overlay.open");
    const said = d && [...d.querySelectorAll("h2, p")].map((e) => e.textContent.trim()).filter(Boolean).join(" ");
    return d ? `#${d.id} opened ("${said.slice(0, 200)}")` : "";
  }, before);
  if (!started.startsWith("job:")) throw new Error(`Start was ${started}`);
  run.jobId = started.slice(4);
  run.job = await api(`/api/dub/jobs/${run.jobId}`);
  const j = run.job;
  if (j.language_code !== "ko" || j.dub_mode !== "local" || (opt.translator && j.translator !== opt.translator)) {
    throw new Error(`the dub went to ${j.language_code} via ${j.dub_mode} with ${j.translator}`);
  }
  await snap();
  return { note: `${PROJECT}.mp4 → ko on this computer; job ${run.jobId} ${j.status}; `
    + `stt ${j.stt_engine}, translator ${j.translator}, voice ${j.tts}, separation ${j.separation}` };
}

async function dubStep(snap, base) {
  const t0 = Date.now();
  // began: when the card first said something past "Waiting to start", so the
  // time in the queue and the time dubbing are told apart.
  let seen = false, said = "", began = 0;
  for (;;) {
    const s = await inPage(() => {
      const b = document.body, card = document.querySelector("#progressCard");
      return { screen: b.dataset.screen, job: b.dataset.jobId || "", card: card.getClientRects().length > 0,
               line: `${document.querySelector("#progressTitle").textContent} ${document.querySelector("#progressPct").textContent}`.trim(),
               table: !!document.querySelector("#scriptBox .sc-row.head, #scriptBox .script-empty"),
               // The card's sentence, then the reason under it ("the key was refused").
               why: ["#doneFailWhy", "#doneNotice"].map((id) => document.querySelector(id).textContent.trim())
                 .filter(Boolean).join(" ") };
    });
    if (s.job !== run.jobId) throw new Error(`the screen left the dub (now ${s.screen}, job ${s.job || "none"})`);
    if (s.screen === "failed") throw new Error(`the dub failed: ${s.why}`);
    if (s.screen === "running" && s.card && !seen) { seen = true; await shot(`${base}-running`); }
    if (s.screen === "running" && s.line !== said) { said = s.line; console.log(`   ${clock()} ${s.line}`); }
    if (s.screen === "running" && !began && !s.line.startsWith(tr("Waiting to start"))) began = Date.now();
    if (s.screen === "done" && s.table) break;
    if (Date.now() - t0 > 30 * 60000) throw new Error(`not finished after 30 min (last: ${said || s.screen})`);
    await sleep(1000);
  }
  if (!seen) throw new Error("the script came without the progress card ever showing");
  const c = await inPage(() => {
    const rows = [...document.querySelectorAll("#scriptBox .sc-row:not(.head)")];
    const head = [...document.querySelectorAll("#scriptBox .sc-h-len, #scriptBox .sc-h-len-narrow")]
      .find((el) => getComputedStyle(el).display !== "none");
    const kinds = {};
    for (const r of rows) {
      const k = (/sc-v-(\w+)/.exec(r.querySelector(".sc-len")?.className || "") || [])[1] || "none";
      kinds[k] = (kinds[k] || 0) + 1;
    }
    return { rows: rows.length, kinds, header: head ? head.textContent.trim() : "",
             narrow: !!head && head.classList.contains("sc-h-len-narrow"),
             noDot: rows.filter((r) => !r.querySelector(".sc-dot")).map((r) => r.dataset.line),
             legend: (document.querySelector("#timeline .tl-legend")?.textContent || "").replace(/\s+/g, " ").trim(),
             empty: (document.querySelector("#scriptBox .script-empty")?.textContent || "").trim() };
  });
  await snap();
  if (!c.rows) throw new Error(`the script table has no rows${c.empty ? `: ${c.empty}` : ""}`);
  const want = c.narrow ? tr("Length") : tr("Original / Translated (s)");
  if (c.header !== want) throw new Error(`the length column is headed "${c.header}", not "${want}"`);
  if (c.noDot.length) throw new Error(`line(s) ${c.noDot.join(", ")} have no .sc-dot`);
  if (!c.legend.includes(tr("Much shorter"))) throw new Error(`the timeline legend reads "${c.legend}", without "${tr("Much shorter")}"`);
  const secs = (ms) => Math.round(ms / 1000);
  const took = began ? `${secs(began - t0)} s in the queue, dubbed in ${secs(Date.now() - began)} s`
    : `done ${secs(Date.now() - t0)} s after Start`;
  return { note: `${took}; ${c.rows} rows (${Object.entries(c.kinds).map(([k, n]) => `${n} ${k}`).join(", ")}); `
    + `header "${c.header}"; legend has "${tr("Much shorter")}"` };
}

async function exportStep(snap) {
  await click("#exportBtn");
  const rows = await waitFor("the Export dialog and its rows", 10000, () => {
    if (!document.querySelector("#exportOverlay").classList.contains("open")) return null;
    const list = [...document.querySelectorAll("#exportList a[data-row]")];
    return list.length ? list.map((a) => ({ id: a.dataset.row, ticked: a.getAttribute("aria-checked") === "true" })) : null;
  });
  const ticked = rows.filter((r) => r.ticked).map((r) => r.id);
  if (!ticked.length) throw new Error("the Export dialog opened with nothing ticked");
  await click("#exportGoBtn");
  // The desktop shell saves a dubbing's files into Downloads without asking.
  // Anything else -- a save window the shell had to fall back on, which CDP
  // cannot press -- leaves the dialog working, and the run says so.
  let end;
  try {
    end = await waitFor("the export to finish", 90000, () => {
      if (document.querySelector("#exportGoBtn").disabled) return null;
      return { saved: [...document.querySelectorAll("#exportList a.saved")].map((a) => a.dataset.row),
               where: document.querySelector("#exportWhere").textContent.trim() };
    });
  } catch {
    await snap();
    return { result: "needs the desktop shell", note: `rows ${rows.map((r) => r.id).join(", ")}; Export had not come back after 90 s` };
  }
  await snap();
  if (ticked.some((id) => !end.saved.includes(id))) throw new Error(`the export stopped: ${end.where}`);
  // Out of the person's Downloads and into the run's folder, so a nightly run
  // leaves nothing behind there -- and only ever out of this run's own folder.
  const job = await api(`/api/dub/jobs/${run.jobId}`);
  if (job.project !== PROJECT) throw new Error(`the job's project is "${job.project}", not ${PROJECT}; Downloads left alone`);
  const dir = join(homedir(), "Downloads", job.day, job.project);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith(".")) : [];
  if (files.length !== ticked.length) throw new Error(`${dir} holds ${files.length} file(s) for ${ticked.length} saved`);
  mkdirSync(join(out, "export"), { recursive: true });
  const moved = [];
  for (const f of files) {
    const size = statSync(join(dir, f)).size;
    if (!size) throw new Error(`${f} was saved empty`);
    copyFileSync(join(dir, f), join(out, "export", f));
    unlinkSync(join(dir, f));
    moved.push(`${f} ${(size / 1e6).toFixed(2)} MB`);
  }
  for (const d of [dir, dirname(dir)]) {
    try { rmdirSync(d); } catch { /* not empty: something else is kept there */ }
  }
  await click("#exportCloseBtn");
  await waitFor("the Export dialog to close", 5000, isClosed, "#exportOverlay");
  return { note: `rows ${rows.map((r) => r.id).join(", ")}; saved ${moved.join(", ")} (moved into export/); "${end.where}"` };
}

async function backHomeStep(snap) {
  await click("#homeBtn");
  await waitFor("the Home screen", 10000, onHome);
  const card = await waitFor(`a card named ${PROJECT} in the grid`, 20000, (name) => {
    const el = [...document.querySelectorAll("#projectsGrid .proj-card")]
      .find((c) => c.querySelector(".proj-name")?.textContent.trim() === name);
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    return el.querySelector(".proj-meta").textContent.trim() || "(no line under its name)";
  }, PROJECT);
  await snap();
  return { note: `card ${PROJECT}: ${card}` };
}

const STEPS = [
  { id: "home", title: "Home", look: [".home-side"], run: homeStep },
  { id: "settings", title: "Settings > Models", look: ["#settingsPanel-models"], run: settingsStep },
  { id: "new-project", title: "New dubbing into Korean", look: ["#draftSetup", "#dubbingImport"], run: newProjectStep },
  { id: "dub", title: "Dub finished: script and timeline", look: ["#doneFail", "#scriptBox"], run: dubStep },
  { id: "export", title: "Export", look: ["#exportOverlay"], run: exportStep },
  { id: "back-home", title: "Home again, new card", look: ["#projectsGrid"], run: backHomeStep },
];

// ---- the run ---------------------------------------------------------------
const results = [];
let failed = false;
try {
  for (const [i, step] of STEPS.entries()) {
    const base = `${String(i + 1).padStart(2, "0")}-${step.id}`;
    const r = { n: i + 1, step: step.title, result: "not run", seconds: 0, note: "", shot: "" };
    results.push(r);
    if (failed) continue;
    console.log(`== ${base}  ${clock()}`);
    const t0 = Date.now();
    try {
      const got = await step.run(async () => { r.shot = await shot(base); }, base);
      r.result = got.result || "pass";
      r.note = got.note;
    } catch (e) {
      failed = true;
      r.result = "fail";
      r.note = e.message;
      r.dom = await snippet(step.look).catch((err) => `(no snippet: ${err.message})`);
      r.shot = await shot(base).catch(() => "");
    }
    r.seconds = Math.round((Date.now() - t0) / 100) / 10;
    if (!r.shot) r.shot = await shot(base).catch(() => "");
    console.log(`   ${r.result}, ${r.seconds} s: ${r.note}`);
  }
} finally {
  await inPage((key, value) => { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); },
               CHOICES_KEY, savedChoices).catch((e) => console.error(`could not put back ${CHOICES_KEY}: ${e.message}`));
  await send("Runtime.releaseObjectGroup", { objectGroup: "e2e" }).catch(() => {});
  ws.close();
}

// ---- the report ------------------------------------------------------------
const finishedAt = new Date();
const passed = results.filter((r) => r.result === "pass").length;
const report = {
  started: clock(startedAt), finished: clock(finishedAt), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  app: { origin, ...page }, video: { from: resolve(opt.video), as: basename(video) }, project: PROJECT,
  job: run.job && { id: run.jobId, ...Object.fromEntries(["language_code", "dub_mode", "stt_engine", "translator", "tts",
                                                          "separation", "quality"].map((k) => [k, run.job[k]])) },
  ok: !failed, steps: results,
};
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\s+/g, " ");
const md = [
  "# PersoDub click-through", "",
  `- Run: ${report.started} to ${clock(finishedAt).slice(11)} (${report.timeZone}), ${Math.round((finishedAt - startedAt) / 1000)} s`,
  `- App: ${origin}, page in ${page.lang}, ${page.width}x${page.height}, page ${page.visibility} at the start`,
  `- Video: ${basename(opt.video)}, put in as ${basename(video)}`,
  `- Result: ${failed ? "FAIL" : "PASS"}, ${passed} of ${results.length} steps passed`, "",
  "| # | Step | Result | Seconds | Note |", "|---|---|---|---:|---|",
  ...results.map((r) => `| ${r.n} | ${r.shot ? `[${cell(r.step)}](${r.shot})` : cell(r.step)} | ${r.result} | ${r.seconds} | ${cell(r.note)} |`),
  ...results.filter((r) => r.dom).flatMap((r) => ["", `## Step ${r.n} failed`, "", cell(r.note), "", `Screenshot: ${r.shot}`, "",
                                                  "```html", r.dom, "```"]),
  "",
].join("\n");
writeFileSync(join(out, "report.md"), md);
console.log(`\n${md}\nWritten to ${out}`);
process.exit(failed ? 1 : 0);
