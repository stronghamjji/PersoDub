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
// queue makes step 4 wait (30 minutes at most), then lays subtitles of its own
// on the same video with no dub. Writes NN-<step>.png, report.md and
// report.json into <folder> and exits 1 when a step fails. ffprobe (PATH, or
// PERSODUB_FFPROBE) measures the files the subtitle step downloads.
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { connect, isClosed, isOpen, onHome, shown, sleep } from "./lib/cdp.mjs";

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
// A Burn in subtitles project: the same video under a name of its
// own, so its card and its Downloads folder are not the dub's, and a subtitle
// file of three lines inside the video's first ten seconds.
const CAP_PROJECT = `${PROJECT}-cap`;
const capVideo = join(out, `${CAP_PROJECT}.mp4`);
copyFileSync(opt.video, capVideo);
const CUES = [[0.5, 3, "The first line"], [3.5, 6, "The second line"], [6.5, 9, "The third line"]];
const srtTime = (sec) => new Date(sec * 1000).toISOString().slice(11, 23).replace(".", ",");
const capSrt = join(out, `${CAP_PROJECT}.srt`);
writeFileSync(capSrt, CUES.map(([a, b, text], i) => `${i + 1}\n${srtTime(a)} --> ${srtTime(b)}\n${text}\n`).join("\n"));
const CHOICES_KEY = "persodub.lastChoices";
// The Download dialog's remembered ticks, which the subtitle step changes.
const TICKS_KEY = "persodub.exportTicks";
const FFPROBE = process.env.PERSODUB_FFPROBE || "ffprobe";
function seconds(path) {
  const r = spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration",
                                "-of", "default=noprint_wrappers=1:nokey=1", path], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffprobe could not read ${basename(path)}: ${(r.stderr || r.error?.message || "").trim().slice(0, 200)}`);
  return Number(r.stdout.trim());
}

// ---- the control port ------------------------------------------------------
// The connection and the presses are tests/e2e/lib/cdp.mjs's, shared with the other runs.
const app = await connect({ port: opt.port, out });
const { origin, page, send, js, inPage, waitFor, api, click, choose, feed, shot, snippet, tr } = app;

// The look a project has saved, once its debounced save lands: how long that took.
async function savedLook(jid, preset) {
  const t0 = Date.now();
  for (;;) {
    const style = await api(`/api/dub/jobs/${jid}/subtitle_style`);
    if (style.preset === preset) return Date.now() - t0;
    if (Date.now() - t0 > 10000) throw new Error(`job ${jid}'s saved look is ${style.preset}, not ${preset}, 10 s after the press`);
    await sleep(250);
  }
}
// The Download dialog opened by its button, and its rows as drawn.
async function openExport() {
  await click("#exportBtn");
  return waitFor("the Download dialog and its rows", 10000, () => {
    if (!document.querySelector("#exportOverlay").classList.contains("open")) return null;
    const list = [...document.querySelectorAll("#exportList a[data-row]")];
    return list.length ? list.map((a) => ({ id: a.dataset.row, ticked: a.getAttribute("aria-checked") === "true",
                                            label: a.textContent.trim() })) : null;
  });
}
// Its Download pressed: which rows came back saved and the line under them,
// or null when it had not come back after 90 s.
async function downloadTicked() {
  await click("#exportGoBtn");
  return waitFor("the export to finish", 90000, () => {
    if (document.querySelector("#exportGoBtn").disabled) return null;
    return { saved: [...document.querySelectorAll("#exportList a.saved")].map((a) => a.dataset.row),
             where: document.querySelector("#exportWhere").textContent.trim() };
  }).catch(() => null);
}
async function closeExport() {
  await click("#exportCloseBtn");
  await waitFor("the Download dialog to close", 5000, isClosed, "#exportOverlay");
}
// A job's saved files, out of the person's Downloads and into the run's
// folder, so a nightly run leaves nothing behind there -- and only ever out of
// this run's own folder: [name, path, bytes] for each.
function moveOut(job, project, count, into) {
  if (job.project !== project) throw new Error(`the job's project is "${job.project}", not ${project}; Downloads left alone`);
  const dir = join(homedir(), "Downloads", job.day, job.project);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith(".")) : [];
  if (files.length !== count) throw new Error(`${dir} holds ${files.length} file(s) for ${count} saved`);
  mkdirSync(join(out, into), { recursive: true });
  const moved = [];
  for (const f of files) {
    const size = statSync(join(dir, f)).size;
    if (!size) throw new Error(`${f} was saved empty`);
    copyFileSync(join(dir, f), join(out, into, f));
    unlinkSync(join(dir, f));
    moved.push([f, join(out, into, f), size]);
  }
  for (const d of [dir, dirname(dir)]) {
    try { rmdirSync(d); } catch { /* not empty: something else is kept there */ }
  }
  return moved;
}
// ---- the app as it stands --------------------------------------------------
// Step 3's picks are remembered for the person's next project; the run puts
// back what was there before it. Every pick that can spend Perso credits
// (dubbing, audio separation, speech-to-text) is set to this computer, so a run
// spends none; the translator is the app's own unless --translator names one.
const savedChoices = await js(`localStorage.getItem(${JSON.stringify(CHOICES_KEY)})`);
const savedTicks = await js(`localStorage.getItem(${JSON.stringify(TICKS_KEY)})`);
const run = { jobId: "", job: null, capJobId: "" };

// ---- the steps -------------------------------------------------------------
async function homeStep() {
  const dialog = await js(`document.querySelector(".modal-overlay.open")?.id || ""`);
  if (dialog) throw new Error(`#${dialog} is open; the run starts with no dialog in the way`);
  if (!(await inPage(onHome))) await click("#homeBtn");
  await waitFor("the Home screen", 10000, onHome);
  // The production edition has no repository button.
  const repo = app.production ? [] : ["#homeGhName"];
  for (const sel of ["#homePerso", ...repo, "#homeDubCard", "#homeEraseCard", "#homeCaptionsCard", "#homeSaveCard"]) {
    await waitFor(`${sel} on show`, 5000, shown, sel);
  }
  if (!(await js(`document.querySelector("#homePerso img").naturalWidth`))) throw new Error("the Perso pill's wordmark did not load");
  const grid = await waitFor("the project grid to paint", 15000, () => {
    const g = document.querySelector("#projectsGrid");
    const n = g.querySelectorAll(".proj-card").length;
    return n ? `${n} cards` : g.querySelector(".projects-empty") ? "no projects yet" : "";
  });
  return { note: `Perso pill, ${app.production ? "no GitHub button (production)" : "GitHub button"}, four tool cards; grid ${grid}` };
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
  await feed("#dubbingZone .import-head", video);
  const ready = await waitFor("the draft card with Start lit", 120000, () => {
    const s = document.querySelector("#dubbingImportStatus");
    if (s.classList.contains("error") && s.textContent.trim()) return `refused: ${s.textContent.trim()}`;
    return !document.querySelector("#draftSetup").hidden && !document.querySelector("#draftStartBtn").disabled ? "ready" : "";
  });
  if (ready !== "ready") throw new Error(`the import was ${ready}`);
  // The mode first: changing it refills the target list. Then separation and
  // speech-to-text, which keep whatever the person last chose: Perso there
  // spends credits (5 on one run's separation, 2026-10-21).
  await choose("#dubModeSelect", "local");
  await choose("#sepSelect", "local");
  await choose("#sttSelect", "local");
  await choose("#targetLangSelect", "ko");
  // Without --translator the dub keeps the one the app starts a new project
  // on, which hangs on whoever used the app last; with it, that translator is
  // picked in its row, always in sight under Dubbing step settings.
  if (opt.translator) await choose("#translateSelect", opt.translator);
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
  if (j.separation === "perso" || j.stt_engine === "perso") {
    throw new Error(`PERSO CREDITS ARE BEING SPENT: job ${run.jobId} separates with ${j.separation} and transcribes `
      + `with ${j.stt_engine}, though both were set to this computer. Stop it in the app now`);
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
             noDot: rows.filter((r) => !r.querySelector(".sc-dot, .sc-tick")).map((r) => r.dataset.line),
             legend: (document.querySelector("#timeline .tl-legend")?.textContent || "").replace(/\s+/g, " ").trim(),
             empty: (document.querySelector("#scriptBox .script-empty")?.textContent || "").trim() };
  });
  await snap();
  if (!c.rows) throw new Error(`the script table has no rows${c.empty ? `: ${c.empty}` : ""}`);
  const want = c.narrow ? tr("Length") : tr("Original / Translated (s)");
  if (c.header !== want) throw new Error(`the length column is headed "${c.header}", not "${want}"`);
  if (c.noDot.length) throw new Error(`line(s) ${c.noDot.join(", ")} have no length mark (.sc-dot or .sc-tick)`);
  if (!c.legend.includes(tr("Much shorter"))) throw new Error(`the timeline legend reads "${c.legend}", without "${tr("Much shorter")}"`);
  const secs = (ms) => Math.round(ms / 1000);
  const took = began ? `${secs(began - t0)} s in the queue, dubbed in ${secs(Date.now() - began)} s`
    : `done ${secs(Date.now() - t0)} s after Start`;
  return { note: `${took}; ${c.rows} rows (${Object.entries(c.kinds).map(([k, n]) => `${n} ${k}`).join(", ")}); `
    + `header "${c.header}"; legend has "${tr("Much shorter")}"` };
}

async function lookStep(snap, base) {
  // A dub's subtitles start off (2026-10-23): the timeline's eye turns them
  // on, and the chip just above them, while the video stands still, opens the
  // twelve looks over the picture.
  if (!(await inPage(() => document.querySelector("#tlSubEye").classList.contains("on")))) await click("#tlSubEye");
  await click('#scriptBox .sc-row[data-line="1"] .sc-time');
  await waitFor("the Subtitle style chip over the subtitle", 10000, () => !document.querySelector("#subOverlay").hidden
    && !document.querySelector("#subStyleChip").hidden && document.querySelector("#doneVideo").paused);
  await click("#subStyleChip");
  const pop = await waitFor("the looks over the video", 5000, () => {
    if (document.querySelector("#videoStylePop").hidden) return null;
    const cards = [...document.querySelectorAll("#videoStyleGrid [data-preset]")];
    return cards.length ? { looks: cards.length, label: document.querySelector("#videoStylePop .cap-label").textContent.trim(),
                            sticker: document.querySelector('#videoStyleGrid [data-preset="sticker"] .cap-nm')?.textContent.trim() } : null;
  });
  await shot(`${base}-looks`);
  if (pop.looks !== 12) throw new Error(`Subtitle style opened ${pop.looks} looks, not 12`);
  if (pop.sticker !== tr("Sticker")) throw new Error(`the sticker tile is named "${pop.sticker}", not "${tr("Sticker")}"`);
  await click('#videoStyleGrid [data-preset="sticker"]');
  await waitFor("the looks to close", 5000, () => document.querySelector("#videoStylePop").hidden);
  const ms = await savedLook(run.jobId, "sticker");
  const rows = await openExport();
  await snap();
  const want = [["subtitled", tr("Dubbed video with subtitles")], ["script", tr("Script (original + translation, .xlsx)")]];
  for (const [id, label] of want) {
    const row = rows.find((r) => r.id === id);
    if (!row || !row.label.startsWith(label)) throw new Error(`no row "${label}" (${id}) among ${rows.map((r) => `${r.id} "${r.label}"`).join(", ")}`);
  }
  await closeExport();
  return { note: `${pop.looks} looks under "${pop.label}"; ${tr("Sticker")} pressed, the panel closed, saved as sticker `
    + `${ms} ms after; Download has ${rows.length} rows with "${want[0][1]}" and "${want[1][1]}"` };
}

async function exportStep(snap) {
  const rows = await openExport();
  const ticked = rows.filter((r) => r.ticked).map((r) => r.id);
  if (!ticked.length) throw new Error("the Export dialog opened with nothing ticked");
  // The desktop shell saves a dubbing's files into Downloads without asking.
  // Anything else -- a save window the shell had to fall back on, which CDP
  // cannot press -- leaves the dialog working, and the run says so.
  const end = await downloadTicked();
  await snap();
  if (!end) return { result: "needs the desktop shell", note: `rows ${rows.map((r) => r.id).join(", ")}; Export had not come back after 90 s` };
  if (ticked.some((id) => !end.saved.includes(id))) throw new Error(`the export stopped: ${end.where}`);
  const job = await api(`/api/dub/jobs/${run.jobId}`);
  const moved = moveOut(job, PROJECT, ticked.length, "export").map(([f, , size]) => `${f} ${(size / 1e6).toFixed(2)} MB`);
  await closeExport();
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

async function captionsStep(snap, base) {
  if (!(await inPage(onHome))) await click("#homeBtn");
  await waitFor("the Home screen", 10000, onHome);
  // Home's Burn in subtitles card: an empty new project on that tab, which takes a video and a subtitle file.
  await click("#homeCaptionsCard");
  await waitFor("the tab's Import block and subtitle file block", 10000, () =>
    ["#capAlone", "#capZone", "#capSrtZone"].every((s) => document.querySelector(s)?.getClientRects().length > 0));
  await feed("#capZone .import-head", capVideo);
  const card = await waitFor("the video's card in the tab", 120000, () => {
    const s = document.querySelector("#capImportStatus");
    if (s.classList.contains("error") && s.textContent.trim()) return `refused: ${s.textContent.trim()}`;
    return document.querySelector("#capVideoCard").getClientRects().length ? "ready" : "";
  });
  if (card !== "ready") throw new Error(`the video's import was ${card}`);
  await feed("#capSrtZone", capSrt);
  const files = await waitFor("the files row over the looks", 60000, () => {
    const s = document.querySelector("#capImportStatus");
    if (s.classList.contains("error") && s.textContent.trim()) return { refused: s.textContent.trim() };
    if (!document.querySelector("#capFiles").getClientRects().length) return null;
    const text = (id) => document.querySelector(id).textContent.trim();
    return { job: document.body.dataset.jobId, screen: document.body.dataset.screen, srt: text("#capFileSrtName"),
             lines: text("#capFileSrtLines"), video: text("#capFileVideo").replace(/\s+/g, " ") };
  });
  if (files.refused) throw new Error(`the subtitle file was refused: ${files.refused}`);
  run.capJobId = files.job;
  await shot(`${base}-files`);
  const lines = tr("{n} lines", { n: CUES.length });
  if (files.srt !== basename(capSrt) || files.lines !== lines) {
    throw new Error(`the files row names "${files.srt}", "${files.lines}", not "${basename(capSrt)}", "${lines}"`);
  }
  const job = await api(`/api/dub/jobs/${files.job}`);
  if (job.kind !== "captions" || job.status !== "done") throw new Error(`job ${files.job} is ${job.kind} ${job.status}, not a done captions job`);
  await click('#subStyleMenu [data-preset="sticker"]');
  const ms = await savedLook(files.job, "sticker");
  const rows = await openExport();
  const want = [["subtitled", tr("Video with subtitles")], ["srt", tr("Subtitles (.srt)")]];
  if (rows.length !== 2 || want.some(([id, label], i) => rows[i].id !== id || !rows[i].label.startsWith(label))) {
    throw new Error(`Download has ${rows.map((r) => `${r.id} "${r.label}"`).join(", ")}, not "${want[0][1]}" and "${want[1][1]}"`);
  }
  // Both ticked, the way a person ticks them.
  for (const r of rows.filter((r) => !r.ticked)) {
    await click(`#exportList a[data-row="${r.id}"]`);
    await waitFor(`${r.id} ticked`, 5000, (id) => document.querySelector(`#exportList a[data-row="${id}"]`)
      .getAttribute("aria-checked") === "true", r.id);
  }
  const end = await downloadTicked();
  await snap();
  if (!end) throw new Error("Download had not come back after 90 s");
  if (want.some(([id]) => !end.saved.includes(id))) throw new Error(`the download stopped: ${end.where}`);
  const moved = moveOut(job, CAP_PROJECT, 2, "export-captions");
  const mp4 = moved.find(([f]) => f.endsWith(".mp4")), srt = moved.find(([f]) => f.endsWith(".srt"));
  if (!mp4 || !srt) throw new Error(`saved ${moved.map(([f]) => f).join(", ")}: not one .mp4 and one .srt`);
  const [got, input] = [seconds(mp4[1]), seconds(capVideo)];
  if (Math.abs(got - input) > 1) throw new Error(`${mp4[0]} is ${got.toFixed(2)} s, the video ${input.toFixed(2)} s`);
  const cues = (readFileSync(srt[1], "utf8").match(/-->/g) || []).length;
  if (cues !== CUES.length) throw new Error(`${srt[0]} has ${cues} cues, not ${CUES.length}`);
  await closeExport();
  return { note: `job ${files.job} (${job.kind}); files row "${files.video}" + "${files.srt}" "${files.lines}"; `
    + `${tr("Sticker")} saved ${ms} ms after; Download rows "${want[0][1]}", "${want[1][1]}"; saved ${mp4[0]} `
    + `${got.toFixed(2)} s (video ${input.toFixed(2)} s), ${srt[0]} ${cues} cues (moved into export-captions/)` };
}

async function captionsDubStep(snap, base) {
  // Its Dubbing tab is one card, whose button opens a new project on the same video.
  await click('#leftTabs [data-tab="dubbing"]');
  const said = await waitFor("the Dubbing tab's card", 10000, () => {
    const b = document.querySelector("#dubbingCaptionsBtn");
    return b && b.getClientRects().length ? b.textContent.trim() : "";
  });
  await shot(`${base}-card`);
  if (said !== tr("Prepare this video for dubbing")) throw new Error(`the card's button reads "${said}", not "${tr("Prepare this video for dubbing")}"`);
  await click("#dubbingCaptionsBtn");
  const prep = await waitFor("the prep screen with Back", 60000, () => {
    const error = document.querySelector("#dubbingCaptionsError").textContent.trim();
    if (error) return { refused: error };
    const on = (id) => document.querySelector(id).getClientRects().length > 0;
    return on("#draftSetup") && on("#draftBackBtn") && !document.body.dataset.jobId
      ? { back: document.querySelector("#draftBackBtn").textContent.trim(), start: document.querySelector("#draftStartBtn").textContent.trim() }
      : null;
  });
  if (prep.refused) throw new Error(`the button was refused: ${prep.refused}`);
  // The screenshot shows the way back, which sits at the top of the prep card.
  await js(`document.querySelector("#draftBackBtn").scrollIntoView({ block: "center" })`);
  await snap();
  if (prep.back !== tr("Back")) throw new Error(`the prep screen's way back reads "${prep.back}", not "${tr("Back")}"`);
  await click("#draftBackBtn");
  await waitFor("the subtitles project again", 15000, (jid) => document.body.dataset.jobId === jid
    && document.body.dataset.screen === "done", run.capJobId);
  // The run ends where it began.
  await click("#homeBtn");
  await waitFor("the Home screen", 10000, onHome);
  return { note: `card button "${said}"; prep screen with "${prep.back}" and "${prep.start}"; ${prep.back} reopened job ${run.capJobId}; Home` };
}

const STEPS = [
  { id: "home", title: "Home", look: [".home-side"], run: homeStep },
  { id: "settings", title: "Settings > Models", look: ["#settingsPanel-models"], run: settingsStep },
  { id: "new-project", title: "New dubbing into Korean", look: ["#draftSetup", "#dubbingImport"], run: newProjectStep },
  { id: "dub", title: "Dub finished: script and timeline", look: ["#doneFail", "#scriptBox"], run: dubStep },
  { id: "look", title: "Subtitles on, the Subtitle style chip, Sticker", look: ["#videoStylePop", "#exportOverlay"], run: lookStep },
  { id: "export", title: "Export", look: ["#exportOverlay"], run: exportStep },
  { id: "back-home", title: "Home again, new card", look: ["#projectsGrid"], run: backHomeStep },
  { id: "captions", title: "Burn in subtitles from Home: video + .srt, Sticker, Download", look: ["#capAlone", "#capFiles", "#exportOverlay"], run: captionsStep },
  { id: "captions-dub", title: "Its Dubbing tab: prepare for dubbing, Back", look: ["#dubbingCaptions", "#draftSetup"], run: captionsDubStep },
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
  for (const [key, saved] of [[CHOICES_KEY, savedChoices], [TICKS_KEY, savedTicks]]) {
    await inPage((k, value) => { if (value === null) localStorage.removeItem(k); else localStorage.setItem(k, value); },
                 key, saved).catch((e) => console.error(`could not put back ${key}: ${e.message}`));
  }
  await send("Runtime.releaseObjectGroup", { objectGroup: "e2e" }).catch(() => {});
  app.close();
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
