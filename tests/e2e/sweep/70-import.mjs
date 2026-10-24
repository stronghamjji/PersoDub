// Every way a video gets in, and the odd inputs: the Home Dubbing card's
// Import block, two videos at once through the New project window (its
// dialog, Cancel, then Start and both stopped from the queue), a file that is
// not a video, a silent video dubbed to its end, a video over 30 minutes and
// Remove, the Home link field (not a link, a link that cannot be fetched),
// Save video and a kept stretch saved to Downloads, a draft kept on Home and
// opened again, the remembered choices, and every card the area made deleted.
// Each video goes in as a copy named e2e-imp-<what>-<stamp> in the run's
// folder, and only cards named e2e-imp-* are deleted. Nothing here spends
// credits: every dub started runs on this computer, and a real video site
// link is never typed.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { homedir } from "node:os";
import { sleep, shown, pressable, isOpen, isClosed, onHome, textOf, Skip } from "../lib/cdp.mjs";

export const area = "import";

const FFPROBE = process.env.PERSODUB_FFPROBE || "ffprobe";
// The kit's ffmpeg beside its ffprobe (ffmpeg.exe on Windows), else PATH's.
const FFMPEG = process.env.PERSODUB_FFMPEG
  || (process.env.PERSODUB_FFPROBE ? join(dirname(FFPROBE), basename(FFPROBE).replace("ffprobe", "ffmpeg")) : "ffmpeg");
// What the area changes in the page's storage, put back as found at its end.
const KEYS = ["persodub.lastChoices", "persodub.exportTicks"];
const MINE = /^e2e-imp-/;
// Words no person can act on: a library's or the server's own.
const RAW = /Traceback|Exception|Errno|\bError:|stderr|\.py\b|status code|HTTP \d{3}|\b5\d\d\b/;

// The odd inputs, in the fixtures folder (--fixtures, else --video's folder);
// one missing is made there the way the first ones were, with ffmpeg.
const MAKE = {
  "silent-10s.mp4": ["-f", "lavfi", "-i", "color=c=gray:s=320x180:r=25:d=10", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "10"],
  "long-31min.mp4": ["-f", "lavfi", "-i", "color=c=black:s=160x90:r=10:d=1860", "-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono", "-t", "1860"],
};
function fixture(ctx, name) {
  const p = join(ctx.fixtures, name);
  if (existsSync(p)) return p;
  mkdirSync(ctx.fixtures, { recursive: true });
  if (name === "not-a-video.txt") {
    writeFileSync(p, "This is not a video.\n");
    return p;
  }
  const r = spawnSync(FFMPEG, ["-v", "error", "-y", ...MAKE[name], "-pix_fmt", "yuv420p", "-c:a", "aac", p], { encoding: "utf8" });
  if (r.status !== 0) {
    try { unlinkSync(p); } catch { /* not written */ }
    throw new Skip(`no fixture ${p}, and ffmpeg (${FFMPEG}) could not make it: ${(r.stderr || r.error?.message || "").trim().slice(0, 200)}`);
  }
  return p;
}
// A copy of `src` named e2e-imp-<tag>-<stamp>, in the run's folder.
function copyIn(ctx, tag, src) {
  const dir = join(ctx.out, "in");
  mkdirSync(dir, { recursive: true });
  const to = join(dir, `e2e-imp-${tag}-${ctx.stamp}${extname(src)}`);
  copyFileSync(src, to);
  return to;
}

function seconds(path) {
  const r = spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration",
                                "-of", "default=noprint_wrappers=1:nokey=1", path], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffprobe could not read ${basename(path)}: ${(r.stderr || r.error?.message || "").trim().slice(0, 200)}`);
  return Number(r.stdout.trim());
}

async function toHome(app) {
  const dialog = await app.js(`document.querySelector(".modal-overlay.open")?.id || ""`);
  if (dialog) throw new Error(`#${dialog} is open; the step starts with no dialog in the way`);
  if (!(await app.inPage(onHome))) await app.click("#homeBtn");
  await app.waitFor("the Home screen", 10000, onHome);
}

// The draft's screen is up: the Before dubbing card, no job.
const onPrep = () => !document.querySelector("#draftSetup").hidden && !document.body.dataset.jobId
  && document.body.dataset.screen === "done";
const card = () => ({ name: (document.querySelector("#draftPartCard .vc-name")?.textContent || "").trim(),
                      len: (document.querySelector("#draftPartCard .vc-len")?.textContent || "").trim(),
                      label: (document.querySelector("#draftSetup .draft-label > span")?.textContent || "").trim(),
                      src: document.querySelector("#doneVideo").getAttribute("src") || "" });
// The six stage rows' labels where the options block is now.
const rowLabels = (within) => [...document.querySelectorAll(`${within} #advancedBody .opt-row > label`)].map((l) => l.textContent.trim());
// Home's cards as drawn.
const cards = () => [...document.querySelectorAll("#projectsGrid .proj-card")].map((c) => ({
  job: c.dataset.job || "", draft: c.dataset.draft || "", name: (c.querySelector(".proj-name")?.textContent || "").trim(),
  meta: (c.querySelector(".proj-meta")?.textContent || "").trim(), chip: (c.querySelector(".proj-chip")?.textContent || "").trim() }));
const keptDrafts = () => { try { return JSON.parse(localStorage.getItem("persodub.drafts") || "[]"); } catch { return []; } };

// The lines a refusal is said on. A refusal an earlier step left there
// (the Dubbing tab keeps its line until the next import) is not this one's.
const REFUSALS = ["dubbingImportStatus", "draftImportStatus", "formError", "newProjError"];
const refusalLines = (ids) => Object.fromEntries(ids.map((id) => [id, (document.querySelector(`#${id}`)?.textContent || "").trim()]));

// The Before dubbing card with Start lit, or why the import was refused.
async function waitPrep(app, ms = 120000, before = {}) {
  const ready = await app.waitFor("the Before dubbing card with Start lit", ms, (ids, was) => {
    for (const id of ids) {
      const s = document.querySelector(`#${id}`), text = (s?.textContent || "").trim();
      if (text && text !== was[id] && (s.classList.contains("error") || s.classList.contains("form-error"))) return `refused: ${text}`;
    }
    return !document.querySelector("#draftSetup").hidden && !document.querySelector("#draftStartBtn").disabled ? "ready" : "";
  }, REFUSALS, before);
  if (ready !== "ready") throw new Error(`the import was ${ready}`);
  return app.inPage(card);
}

// Home → Dubbing card → its Import block → `src` as a copy: the Before dubbing card.
async function newDraft(app, ctx, tag, src = ctx.video, ms = 120000) {
  const file = copyIn(ctx, tag, src);
  await toHome(app);
  await app.click("#homeDubCard");
  await app.waitFor("the Dubbing tab's Import block", 10000, shown, "#dubbingZone .import-head");
  const before = await app.inPage(refusalLines, REFUSALS);
  await app.feed("#dubbingZone .import-head", file);
  const c = await waitPrep(app, ms, before);
  if (c.name !== basename(file)) throw new Error(`the video card reads "${c.name}", not ${basename(file)}`);
  return { file, ...c, id: (c.src.match(/\/api\/downloads\/([0-9a-f]{8})\//) || [])[1] || "" };
}

// feed() for several files: the picker is intercepted and they all go in at once.
async function feedMany(app, sel, files) {
  await app.send("Page.setInterceptFileChooserDialog", { enabled: true });
  try {
    const chooser = app.nextEvent("Page.fileChooserOpened", 5000);
    chooser.catch(() => {});
    await app.click(sel);
    const { backendNodeId } = await chooser;
    await app.send("DOM.setFileInputFiles", { files, backendNodeId });
  } finally {
    await app.send("Page.setInterceptFileChooserDialog", { enabled: false });
  }
}

// What a dub started from here would run on: never Perso.
const choices = () => ({ mode: document.querySelector("#dubModeSelect").value, sep: document.querySelector("#sepSelect").value,
                         stt: document.querySelector("#sttSelect").value, translator: document.querySelector("#translateSelect").value,
                         target: document.querySelector("#targetLangSelect").value });
function assertNoCredits(c) {
  if (c.mode !== "local" || c.sep === "perso" || c.stt === "perso") throw new Error(`the choices would spend Perso credits: ${JSON.stringify(c)}`);
}
function assertLocalJob(job) {
  if (job.dub_mode === "perso" || job.separation === "perso" || job.stt_engine === "perso") {
    throw new Error(`PERSO CREDITS: job ${job.id} runs ${job.dub_mode}/${job.separation}/${job.stt_engine}`);
  }
}

// A key the page reads by its code too: Backspace deletes only with one.
async function rawKey(app, key, code, vk, commands) {
  for (const type of ["keyDown", "keyUp"]) {
    await app.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: vk, ...(type === "keyDown" && commands ? { commands } : {}) });
  }
}
async function emptyField(app, sel) {
  await app.click(sel);
  await rawKey(app, "a", "KeyA", 65, ["selectAll"]);
  await rawKey(app, "Backspace", "Backspace", 8);
}

// The Target language: its list, a search, a press on the language.
async function pickTarget(app, words, code) {
  await app.click("#targetLangBtn");
  await app.waitFor("the language list", 5000, () => document.activeElement === document.querySelector("#targetLangList input"));
  await app.type("#targetLangList input", words);
  await app.waitFor(`${code} among the rows`, 5000, (c) => !!document.querySelector(`#targetLangList .model-opt[data-lang="${c}"]`), code);
  await app.click(`#targetLangList .model-opt[data-lang="${code}"]`);
  await app.waitFor(`the language on ${code}`, 5000, (c) => document.querySelector("#targetLangSelect").value === c && !document.querySelector("#targetLangList"), code);
  return app.inPage(textOf, "#targetLangBtn");
}
// The Number of speakers field to `value` ("" is Auto-detect); the field let go, so its change is said.
async function setSpeakers(app, value) {
  await emptyField(app, "#numSpeakers");
  if (value) await app.type("#numSpeakers", value);
  // The field remembers its value on change, which a person's blur fires; typing over CDP needs it said.
  await app.inPage(() => { const el = document.querySelector("#numSpeakers"); el.dispatchEvent(new Event("change", { bubbles: true })); return true; });
  await app.click("#draftSetup .draft-label > span");
  const now = await app.inPage(() => document.querySelector("#numSpeakers").value);
  if (now !== value) throw new Error(`the speakers field holds "${now}", not "${value}"`);
}

// A press and a release at (x, y) on the element `sel` is to be hit there.
async function pressAt(app, sel, x, y) {
  const over = await app.inPage((s, px, py) => {
    const hit = document.elementFromPoint(px, py);
    return hit && hit.closest(s) ? "" : hit ? hit.tagName.toLowerCase() + (hit.id ? `#${hit.id}` : "") + [...hit.classList].map((c) => `.${c}`).join("") : "nothing";
  }, sel, x, y);
  if (over) throw new Error(`${sel} at ${Math.round(x)},${Math.round(y)} is covered by ${over}`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await app.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
  }
}
// The ruler and the one clip: seconds per pixel off the clip's width.
const strip = () => {
  const inner = document.querySelector("#timeline .tl-inner"), ruler = document.querySelector("#timeline .tl-ruler");
  const cut = document.querySelector("#timeline .tl-cut[data-i='0']");
  if (!inner || !ruler || !cut || document.querySelectorAll("#timeline .tl-cut").length !== 1) return null;
  const r = ruler.getBoundingClientRect();
  return { left: inner.getBoundingClientRect().left, width: cut.getBoundingClientRect().width + 2, y: r.top + r.height / 2 };
};
// The playhead to `sourceSec`: the strip is the kept seconds laid end to end.
async function playheadTo(app, sourceSec, keptFrom, keptLen) {
  const s = await app.waitFor("the timeline's ruler and one clip", 5000, strip);
  await pressAt(app, ".tl-ruler", s.left + (sourceSec - keptFrom) * (s.width / keptLen), s.y);
  return app.waitFor(`the playhead at ${sourceSec} s`, 3000, (want) => {
    const v = document.querySelector("#doneVideo").currentTime;
    return Math.abs(v - want) < 0.05 ? v : null;
  }, sourceSec);
}

const TERMINAL = new Set(["done", "error", "failed", "cancelled"]);
async function jobsNow(app) { return (await app.api("/api/dub/jobs")).jobs; }

// The .mp4 files written under `dir` (two levels) since `t0`.
function newFiles(dir, t0) {
  const out = [];
  const walk = (d, depth) => {
    if (!existsSync(d)) return;
    for (const f of readdirSync(d)) {
      if (f.startsWith("._")) continue;
      const p = join(d, f);
      const st = statSync(p);
      if (st.isDirectory()) { if (depth > 0) walk(p, depth - 1); }
      else if (f.endsWith(".mp4") && st.mtimeMs >= t0) out.push(p);
    }
  };
  walk(dir, 2);
  return out;
}

// A card's "..." shows while the pointer is over the card (app.css): the
// pointer goes there first, the way a person's does, then the menu's Delete.
// The card is scrolled to the middle first: its menu opens under it, and
// under a card on the bottom row that is past the window's edge.
async function deleteCard(app, card, more) {
  const box = await app.inPage((s) => {
    const el = document.querySelector(s);
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 3 };
  }, card);
  await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, buttons: 0 }, 15000);
  // A window another one covers takes the move only with its next frame
  // (lib/cdp.mjs): then the card is reached the keyboard's way, which shows
  // the "..." as well (:focus-within).
  const hovered = await app.waitFor("the card's ...", 3000, pressable, more).catch(() => false);
  if (!hovered) await app.inPage((s) => { document.querySelector(s).focus(); return true; }, card);
  await app.click(more, 5000);
  await app.waitFor("the card menu", 5000, shown, "#projectMenuDelete");
  await app.click("#projectMenuDelete");
  await app.waitFor("the delete dialog", 5000, isOpen, "#deleteOverlay");
  const title = await app.inPage(textOf, "#deleteTitle");
  await app.click("#deleteConfirmBtn");
  return title;
}

export const steps = [
  { name: "Dubbing card import", looks: ["#dubbingImport", "#draftSetup", "#newProjOverlay"],
    async run(app, ctx) {
      await toHome(app);
      ctx.state.impKeys = {};
      for (const k of KEYS) ctx.state.impKeys[k] = await app.js(`localStorage.getItem(${JSON.stringify(k)})`);
      ctx.state.impCardsAtStart = (await app.inPage(cards)).length;
      ctx.state.impJobs = [];
      await app.click("#homeDubCard");
      // Whatever the card opens: the empty Dubbing tab's Import block, or the New project window.
      const way = await app.waitFor("an Import block", 10000, () => {
        if (document.querySelector("#newProjOverlay").classList.contains("open")) return { sel: "#newProjDrop .import-head", what: "the New project window" };
        const head = document.querySelector("#dubbingZone .import-head");
        return head && head.getClientRects().length ? { sel: "#dubbingZone .import-head", what: "the Dubbing tab's Import block",
          title: document.querySelector("#dubbingImport .tab-empty-title").textContent.trim(), head: head.textContent.trim() } : null;
      });
      const file = copyIn(ctx, "card", ctx.video);
      const was = await app.inPage(refusalLines, REFUSALS);
      await app.feed(way.sel, file);
      const c = await waitPrep(app, 120000, was);
      if (c.label !== app.tr("Before dubbing")) throw new Error(`the card is headed "${c.label}", not "${app.tr("Before dubbing")}"`);
      if (c.name !== basename(file) || c.len !== "00:10") throw new Error(`the video card reads "${c.name}" "${c.len}"`);
      ctx.state.impPrepRows = await app.inPage(rowLabels, "#draftOptionsSlot");
      if (ctx.state.impPrepRows.length !== 6) throw new Error(`Before dubbing has ${ctx.state.impPrepRows.length} stage rows: ${ctx.state.impPrepRows.join(", ")}`);
      await app.click("#homeBtn");
      await app.waitFor("the Home screen", 10000, onHome);
      return `${app.tr("Dubbing")} card → ${way.what} ("${way.title || ""}" / "${way.head || ""}") → ${c.name} → "${c.label}" ${c.len}, ${ctx.state.impPrepRows.length} stage rows; ${app.tr("Home")}`;
    } },

  { name: "two videos at once", looks: ["#projectOverlay", "#newProjOverlay", "#queueCard"],
    async run(app, ctx) {
      const a = copyIn(ctx, "batchA", ctx.video), b = copyIn(ctx, "batchB", ctx.video);
      await newDraft(app, ctx, "host");
      // First the top bar's + over a project with a video: the window with
      // the Import block. Cancel goes to Home, so the second time it is the
      // Home banner, the other way in that takes several.
      const openDialog = async (way) => {
        if (way === "window") {
          await app.click("#newProjectBtn");
          await app.waitFor("the New project window", 5000, isOpen, "#newProjOverlay");
          await feedMany(app, "#newProjDrop .import-head", [a, b]);
        } else {
          await toHome(app);
          await feedMany(app, "#uploadZone .home-banner-head", [a, b]);
        }
        return app.waitFor("the New project dialog", 10000, () => {
          const err = document.querySelector("#newProjError").textContent.trim();
          if (err) return { refused: err };
          if (!document.querySelector("#projectOverlay").classList.contains("open")) return null;
          const box = document.querySelector("#projectOverlay .modal");
          return { title: document.querySelector("#projectTitle").textContent.trim(), text: box.innerText,
                   dur: document.querySelector("#projectDur").textContent.trim(), len: document.querySelector("#projectLength").textContent.trim() };
        });
      };
      const d = await openDialog("window");
      if (d.refused) throw new Error(`the window refused the two videos: ${d.refused}`);
      const want = app.tr("New project · {n} videos", { n: 2 });
      if (d.title !== want) throw new Error(`the dialog is titled "${d.title}", not "${want}"`);
      const rows = await app.inPage(rowLabels, "#projectOverlay");
      if (JSON.stringify(rows) !== JSON.stringify(ctx.state.impPrepRows || [])) {
        throw new Error(`the dialog's stage rows (${rows.join(", ")}) are not Before dubbing's (${(ctx.state.impPrepRows || []).join(", ")})`);
      }
      const named = [a, b].filter((f) => d.text.includes(basename(f))).length;
      await app.shot("import-two-videos-dialog");
      await app.click("#projectClose");
      await app.waitFor("the dialog to close", 5000, isClosed, "#projectOverlay");
      const closedTo = await app.js("document.body.dataset.screen");
      // Again, and Start this time: both go in line, and both are stopped from the queue.
      const d2 = await openDialog("banner");
      if (d2.refused || d2.title !== want) throw new Error(`the Home banner gave ${JSON.stringify(d2).slice(0, 200)}`);
      const c = await app.inPage(choices);
      assertNoCredits(c);
      const before = new Set((await jobsNow(app)).map((j) => j.id));
      const t0 = Date.now();
      await app.click("#startBtn");
      const mine = [];
      let how = [];
      try {
        const started = await app.waitFor("two jobs and Home", 60000, () => {
          const err = document.querySelector("#projectError").textContent.trim();
          if (err) return { refused: err };
          const open = document.querySelector(".modal-overlay.open");
          if (open && open.id !== "projectOverlay") return { refused: `#${open.id} opened` };
          return document.body.dataset.screen === "home" && !open ? { home: true } : null;
        });
        for (const j of await jobsNow(app)) if (!before.has(j.id)) mine.push(j.id);
        ctx.state.impJobs.push(...mine);
        if (started.refused) throw new Error(`Start was refused: ${started.refused}`);
        if (mine.length !== 2) throw new Error(`${mine.length} new job(s) after Start, not 2`);
        for (const id of mine) assertLocalJob(await app.api(`/api/dub/jobs/${id}`));
        const queued = await app.waitFor("the two in the queue card", 10000, (s) => {
          const names = [...document.querySelectorAll("#queueRows .queue-line .q-name")].map((n) => n.textContent.trim());
          return names.filter((n) => n.includes(s)).length === 2 ? names.filter((n) => n.includes(s)) : null;
        }, ctx.stamp);
        // Each one's X in the queue card: a waiting one goes quietly, the running one asks first.
        for (const tag of ["batchA", "batchB"]) {
          const i = await app.waitFor(`${tag}'s row`, 10000, (t, s) => {
            const lines = [...document.querySelectorAll("#queueRows .queue-line")];
            const k = lines.findIndex((l) => l.querySelector(".q-name").textContent.includes(`${t}-${s}`));
            return k >= 0 && lines[k].querySelector(".queue-x") ? k + 1 : null;
          }, tag, ctx.stamp).catch(() => 0);
          if (!i) { how.push(`${tag}: no X (already on its way out)`); continue; }
          await app.click(`#queueRows .queue-line:nth-child(${i}) .queue-x`);
          const asked = await app.waitFor("the stop question", 2000, isOpen, "#cancelDubOverlay").catch(() => false);
          if (asked) await app.click("#cancelDubConfirmBtn");
          how.push(`${tag}: X${asked ? " + Stop dubbing confirmed" : " (waiting, went quietly)"}`);
        }
        const end = t0 + 60000;
        let st;
        for (;;) {
          st = await Promise.all(mine.map((id) => app.api(`/api/dub/jobs/${id}`).then((j) => j.status)));
          if (st.every((s) => s === "cancelled") || Date.now() > end) break;
          await sleep(1000);
        }
        if (!st.every((s) => s === "cancelled")) throw new Error(`the two jobs are ${st.join(", ")} 60 s after Start`);
        const took = Math.round((Date.now() - t0) / 1000);
        return `"${d.title}", names shown ${named} of 2${named ? "" : " (GAP: the dialog lists no names or lengths, only the count)"}, length "${d.dur || d.len || "none"}"; `
          + `stage rows the same 6 as ${app.tr("Before dubbing")} (${rows.join(", ")}); ${app.tr("Cancel")} closed it (to ${closedTo}); again from the Home banner, ${app.tr("Start dubbing")} (${c.mode}, ${c.translator}) → `
          + `jobs ${mine.join(", ")} in the queue card (${queued.length} rows) → ${how.join("; ")} → both cancelled ${took} s after Start`;
      } finally {
        // A refused Start leaves the dialog up with its reason: it is closed, as Cancel does.
        if (await app.inPage(isOpen, "#projectOverlay").catch(() => false)) {
          await app.click("#projectClose").catch(() => app.key("Escape"));
        }
        // Never leave them running: whatever the queue card did not stop, the API does.
        for (const id of mine) {
          const j = await app.api(`/api/dub/jobs/${id}`).catch(() => null);
          if (j && !TERMINAL.has(j.status) && j.status !== "cancelling") {
            await app.api(`/api/dub/jobs/${id}/cancel`, { method: "POST" }).catch(() => {});
            how.push(`${id}: stopped by the API`);
          }
        }
      }
    } },

  { name: "not a video", looks: ["#dubbingImport", "#formError"],
    async run(app, ctx) {
      const txt = fixture(ctx, "not-a-video.txt");
      await toHome(app);
      await app.click("#homeDubCard");
      await app.waitFor("the Dubbing tab's Import block", 10000, shown, "#dubbingZone .import-head");
      await app.feed("#dubbingZone .import-head", txt);
      const said = await app.waitFor("the refusal under the block", 10000, () => {
        const s = document.querySelector("#dubbingImportStatus");
        return s.classList.contains("error") && s.textContent.trim();
      });
      const stayed = await app.inPage(() => !document.querySelector("#dubbingImport").hidden && document.querySelector("#draftSetup").hidden
        && document.body.dataset.screen === "done" && !document.querySelector(".modal-overlay.open"));
      await app.shot("import-not-a-video-tab");
      if (!stayed) throw new Error("the Dubbing tab did not stay empty after the refusal");
      if (said !== app.tr("Please choose an MP4 or MOV video file.")) throw new Error(`the tab says "${said}"`);
      // The Home banner, the other way in, says the same.
      await app.click("#homeBtn");
      await app.waitFor("the Home screen", 10000, onHome);
      await app.feed("#uploadZone .home-banner-head", txt);
      const home = await app.waitFor("the refusal under the banner", 10000, () => document.querySelector("#formError").textContent.trim());
      const still = await app.inPage(() => document.body.dataset.screen === "home" && !document.querySelector(".modal-overlay.open"));
      if (!still) throw new Error("the banner's refusal left Home");
      if (home !== said) throw new Error(`the banner says "${home}", the tab "${said}"`);
      return `not-a-video.txt → Dubbing tab: "${said}", tab stays empty; Home banner: "${home}", stays on Home`;
    } },

  { name: "silent video", looks: ["#doneFail", "#progressCard", "#scriptBox", "#draftSetup"],
    async run(app, ctx) {
      const d = await newDraft(app, ctx, "silent", fixture(ctx, "silent-10s.mp4"));
      if (d.len !== "00:10") throw new Error(`the card reads ${d.len}`);
      const c = await app.inPage(choices);
      assertNoCredits(c);
      // Other people's dubs ahead of it in the line are named in the note.
      const ahead = (await jobsNow(app)).filter((j) => ["running", "queued", "cancelling"].includes(j.status)).map((j) => j.project || j.id);
      await app.click("#draftStartBtn");
      const started = await app.waitFor("the dub to start", 60000, () => {
        const b = document.body;
        if (b.dataset.screen === "running" && b.dataset.jobId) return `job:${b.dataset.jobId}`;
        const error = document.querySelector("#draftError").textContent.trim();
        if (error) return `refused: ${error}`;
        const o = document.querySelector(".modal-overlay.open");
        return o ? `#${o.id} opened` : "";
      });
      if (!started.startsWith("job:")) { await app.key("Escape"); throw new Error(`Start was ${started}`); }
      const id = started.slice(4);
      ctx.state.impJobs.push(id);
      const t0 = Date.now();
      assertLocalJob(await app.api(`/api/dub/jobs/${id}`));
      // The 240 s run from when it leaves the line: other people's dubs ahead
      // of it are not its time. 480 s in the line at most, so the app lock
      // is held under 15 minutes.
      let job, ranAt = 0;
      for (;;) {
        job = await app.api(`/api/dub/jobs/${id}`);
        if (TERMINAL.has(job.status)) break;
        if (!ranAt && job.status !== "queued") ranAt = Date.now();
        const over = ranAt ? Date.now() - ranAt > 240000 : Date.now() - t0 > 480000;
        if (over) {
          await app.api(`/api/dub/jobs/${id}/cancel`, { method: "POST" }).catch(() => {});
          throw new Error(`job ${id} is still ${job.status} ${ranAt ? "240 s after it began" : `480 s in the line behind ${ahead.join(", ")}`} (stopped by the API)`);
        }
        await sleep(2000);
      }
      const queued = Math.round(((ranAt || Date.now()) - t0) / 1000);
      const took = Math.round((Date.now() - (ranAt || t0)) / 1000);
      // What the screen says about it, once it says anything.
      const said = await app.waitFor("the screen to say how it ended", 20000, (jid) => {
        const b = document.body;
        if (b.dataset.jobId !== jid || b.dataset.screen === "running") return null;
        const why = document.querySelector("#doneFailWhy")?.textContent.trim();
        // The heading, then the reason the page puts under it (#doneNotice;
        // the folded work log, #rawLogDetails, is the engine's own words on
        // purpose), then the buttons offered.
        if (b.dataset.screen === "failed" && why) {
          const reason = (document.querySelector("#doneFailBody #doneNotice")?.textContent || "").replace(/\s+/g, " ").trim();
          const buttons = [...document.querySelectorAll("#doneFailActions button")].filter((x) => x.getClientRects().length).map((x) => x.textContent.trim());
          return { screen: "failed", text: reason ? `${why} / ${reason}` : why, reason, buttons };
        }
        const empty = document.querySelector("#scriptBox .script-empty")?.textContent.trim();
        if (b.dataset.screen === "done" && empty) return { screen: "done", text: empty };
        const rows = document.querySelectorAll("#scriptBox .sc-row:not(.head)").length;
        return b.dataset.screen === "done" && rows ? { screen: "done", text: `${rows} script line(s)` } : null;
      }, id);
      await app.shot("import-silent-ended");
      await app.click("#homeBtn");
      await app.waitFor("the Home screen", 10000, onHome);
      if (RAW.test(said.text)) throw new Error(`job ${id} ${job.status} in ${took} s with raw words: "${said.text}"`);
      if (said.screen === "done" && /line\(s\)$/.test(said.text)) throw new Error(`a silent video came out with ${said.text}`);
      if (said.screen === "failed" && !said.reason) throw new Error(`job ${id} failed with no reason under "${said.text}"`);
      return `silent-10s → ${c.mode}/${c.translator} → job ${id} ${job.status} ${took} s after it began (${queued} s in the line behind ${ahead.length ? ahead.join(", ") : "nothing"}); the ${said.screen} screen says "${said.text}"${said.buttons ? `, buttons ${said.buttons.join(" / ")}` : ""}`;
    } },

  { name: "over 30 minutes", looks: ["#draftSetup", "#deleteOverlay"],
    async run(app, ctx) {
      const d = await newDraft(app, ctx, "long", fixture(ctx, "long-31min.mp4"), 180000);
      const hint = await app.waitFor("the 30-minute line", 5000, () => {
        const h = document.querySelector("#draftLongHint");
        return !h.hidden && h.getClientRects().length ? h.textContent.trim() : null;
      });
      await app.shot("import-over-30-minutes");
      if (d.len !== "31:00") throw new Error(`the card reads "${d.len}", not 31:00`);
      await app.click("#draftRemoveBtn");
      await app.waitFor("the delete dialog", 5000, isOpen, "#deleteOverlay");
      const title = await app.inPage(textOf, "#deleteTitle");
      if (title !== app.tr("Delete this draft?")) throw new Error(`the dialog asks "${title}"`);
      await app.click("#deleteConfirmBtn");
      await app.waitFor("the empty Dubbing tab, no draft kept", 20000, (id) => !document.querySelector("#deleteOverlay").classList.contains("open")
        && document.querySelector("#draftSetup").hidden && !document.querySelector("#dubbingImport").hidden
        && !JSON.parse(localStorage.getItem("persodub.drafts") || "[]").some((k) => k.downloadId === id), d.id);
      await toHome(app);
      const left = (await app.inPage(cards)).filter((k) => k.name === basename(d.file)).length;
      if (left) throw new Error(`Home still has a card for ${basename(d.file)}`);
      return `long-31min → card "${d.len}", "${hint}"; ${app.tr("Remove")} → "${title}" → ${app.tr("Delete")}: empty Dubbing tab, no Home card`;
    } },

  { name: "link field", looks: ["#linkCard", "#uploadZone"],
    async run(app) {
      await toHome(app);
      try {
        await app.type("#linkInput", "not a link");
        await app.key("Enter");
        const no = await app.waitFor("the not-a-link line", 5000, () => {
          const c = document.querySelector("#linkCard");
          return !c.hidden && c.classList.contains("error") ? c.querySelector(".lc-msg")?.textContent.trim() : null;
        });
        const kept = await app.inPage(() => document.querySelector("#linkInput").value);
        if (no !== app.tr("That is not a link. Paste one that starts with https://")) throw new Error(`the card says "${no}"`);
        if (kept !== "not a link" || !(await app.inPage(onHome))) throw new Error(`the field holds "${kept}" on ${await app.js("document.body.dataset.screen")}`);
        await emptyField(app, "#linkInput");
        const t0 = Date.now();
        await app.type("#linkInput", "https://example.com/video");
        await app.key("Enter");
        const got = await app.waitFor("the link to be refused", 60000, () => {
          if (document.body.dataset.screen !== "home") return { left: document.body.dataset.screen };
          const c = document.querySelector("#linkCard");
          return !c.hidden && c.classList.contains("error")
            ? { msg: c.querySelector(".lc-msg")?.textContent.trim(), sub: c.querySelector(".lc-sub")?.textContent.trim() || "" } : null;
        });
        await app.shot("import-link-refused");
        if (got.left) throw new Error(`the link opened the ${got.left} screen`);
        if (RAW.test(got.msg)) throw new Error(`the link card shows raw words: "${got.msg}"`);
        return `"not a link" + Enter → "${no}", field kept; "https://example.com/video" + Enter → in ${((Date.now() - t0) / 1000).toFixed(1)} s "${got.msg}" / "${got.sub}"`;
      } finally {
        await emptyField(app, "#linkInput").catch(() => {});
      }
    } },

  { name: "save video", looks: ["#exportOverlay", "#linkCard", "#timeline"],
    async run(app, ctx) {
      await toHome(app);
      await app.click("#homeSaveCard");
      const told = await app.waitFor("the link field asked for", 5000, () => {
        const c = document.querySelector("#linkCard");
        return !c.hidden && document.activeElement === document.querySelector("#linkInput") ? c.querySelector(".lc-msg")?.textContent.trim() : null;
      });
      if (told !== app.tr("Paste a link and the video is fetched to this computer. Then Download saves it.")) throw new Error(`the card says "${told}"`);
      // The card takes a link only. The video itself through the banner beside it.
      const file = copyIn(ctx, "save", ctx.video);
      const was = await app.inPage(refusalLines, REFUSALS);
      await app.feed("#uploadZone .home-banner-head", file);
      const c = await waitPrep(app, 120000, was);
      if (c.name !== basename(file)) throw new Error(`the video card reads "${c.name}"`);
      const a = await playheadTo(app, 2.0, 0, 10);
      await app.click("#tlDelLeft");
      await app.waitFor("8 s kept", 5000, () => document.querySelector("#draftPartCard .vc-len").textContent.startsWith("00:08"));
      const b = await playheadTo(app, 6.0, a, 10 - a);
      await app.click("#tlDelRight");
      // The card floors its seconds: 3.96 s kept reads 00:03. ffprobe below is the measure.
      const kept4 = await app.waitFor("about 4 s kept", 5000, () => {
        const len = document.querySelector("#draftPartCard .vc-len").textContent.trim();
        return /^00:0[34]/.test(len) ? len.slice(0, 5) : null;
      });
      await app.click("#exportBtn");
      await app.waitFor("the Download dialog", 10000, isOpen, "#exportOverlay");
      try {
        const rows = await app.inPage(() => [...document.querySelectorAll("#exportList a[data-row]")].map((r) => ({ id: r.dataset.row, ticked: r.getAttribute("aria-checked") === "true" })));
        if (!rows.some((r) => r.id === "video")) throw new Error(`the dialog has no Video row: ${rows.map((r) => r.id).join(", ")}`);
        for (const r of rows) {
          if (r.ticked !== (r.id === "video")) await app.click(`#exportList a[data-row="${r.id}"]`);
        }
        await app.waitFor("Video alone ticked", 5000, () => [...document.querySelectorAll("#exportList a[data-row]")]
          .every((r) => (r.getAttribute("aria-checked") === "true") === (r.dataset.row === "video")));
        const t0 = Date.now() - 2000;
        await app.click("#exportGoBtn");
        const where = await app.waitFor("the Video row saved", 60000, () => document.querySelector('#exportList a[data-row="video"].saved')
          ? { ok: document.querySelector("#exportWhere").textContent.trim() } : null)
          .catch(async () => { throw new Error(`the Video row was not saved in 60 s; the dialog says "${await app.inPage(textOf, "#exportWhere")}"`); });
        await app.shot("import-save-video-saved");
        const day = new Date().toLocaleDateString("sv-SE");
        const found = newFiles(join(homedir(), "Downloads", day), t0);
        if (found.length !== 1) throw new Error(`${found.length} new .mp4 file(s) under Downloads/${day} (the dialog says "${where.ok}")`);
        const into = join(ctx.out, "save");
        mkdirSync(into, { recursive: true });
        const kept = join(into, basename(found[0]));
        copyFileSync(found[0], kept);
        unlinkSync(found[0]);
        try { rmdirSync(dirname(found[0])); } catch { /* not empty: something else is kept there */ }
        const len = seconds(kept);
        if (Math.abs(len - 4.0) > 0.2) throw new Error(`${basename(kept)} is ${len.toFixed(2)} s, not 4.0 ± 0.2`);
        return `${app.tr("Save video")} → "${told}"; ${c.name} through the banner, playhead ${a.toFixed(2)}→${app.tr("Delete left of playhead")}, ${b.toFixed(2)}→${app.tr("Delete right of playhead")} (card "${kept4}"); `
          + `${app.tr("Download")}, Video alone → "${where.ok}"; ${basename(kept)} ${len.toFixed(2)} s by ffprobe, moved to save/`;
      } finally {
        if (await app.inPage(isOpen, "#exportOverlay")) {
          await app.click("#exportCloseBtn", 60000);
          await app.waitFor("the Download dialog to close", 5000, isClosed, "#exportOverlay");
        }
        await app.click("#homeBtn").catch(() => {});
      }
    } },

  { name: "kept draft", looks: ["#projectsGrid", "#draftSetup", "#deleteOverlay"],
    async run(app, ctx) {
      const d = await newDraft(app, ctx, "kept");
      if (!d.id) throw new Error(`no held video id in the player's address "${d.src}"`);
      await toHome(app);
      const sel = `#projectsGrid .proj-card[data-draft="${d.id}"]`;
      const k = await app.waitFor("the draft's card on Home", 10000, (id) => {
        const c = document.querySelector(`#projectsGrid .proj-card[data-draft="${id}"]`);
        return c ? { name: c.querySelector(".proj-name").textContent.trim(), meta: c.querySelector(".proj-meta").textContent.trim(),
                     chip: c.querySelector(".proj-chip").textContent.trim(), dur: c.querySelector(".proj-dur").textContent.trim() } : null;
      }, d.id);
      if (k.name !== basename(d.file) || k.meta !== app.tr("Not dubbed yet") || k.chip !== app.tr("Draft")) {
        throw new Error(`the card reads "${k.name}" / "${k.meta}" / "${k.chip}"`);
      }
      await app.click(sel);
      await waitPrep(app, 30000);
      const back = await app.waitFor("the draft's own video in the player", 10000, (id) => {
        const src = document.querySelector("#doneVideo").getAttribute("src") || "";
        return src.includes(id) ? { name: document.querySelector("#draftPartCard .vc-name").textContent.trim(), src,
          len: document.querySelector("#draftPartCard .vc-len").textContent.trim(),
          label: document.querySelector("#draftSetup .draft-label > span").textContent.trim() } : null;
      }, d.id).catch(async () => ({ ...(await app.inPage(card)) }));
      await app.shot("import-kept-draft-reopened");
      if (back.name !== d.name || back.len !== d.len || !back.src.includes(d.id)) {
        throw new Error(`it reopened "${back.name}" ${back.len} on ${back.src}, not "${d.name}" ${d.len} on ${d.id}`);
      }
      await toHome(app);
      const title = await deleteCard(app, sel, `#projectsGrid .proj-more[data-more-draft="${d.id}"]`);
      if (title !== app.tr("Delete this draft?")) throw new Error(`the dialog asked "${title}"`);
      await app.waitFor("the card and its record to go", 20000, (id) => !document.querySelector("#deleteOverlay").classList.contains("open")
        && !document.querySelector(`#projectsGrid [data-draft="${id}"]`)
        && !JSON.parse(localStorage.getItem("persodub.drafts") || "[]").some((x) => x.downloadId === id), d.id);
      return `draft ${d.id} → ${app.tr("Home")}: card "${k.name}" "${k.chip}" "${k.meta}" ${k.dur} → pressed: "${back.label}" ${back.name} ${back.len}, same video → `
        + `${app.tr("Delete")} "${title}" → card and persodub.drafts entry gone`;
    } },

  { name: "remembered options", looks: ["#langGrid", "#advancedBody"],
    async run(app, ctx) {
      const remembered = () => { try { return JSON.parse(localStorage.getItem("persodub.lastChoices") || "{}"); } catch { return {}; } };
      await newDraft(app, ctx, "pick");
      const ja = await pickTarget(app, "일본어", "ja");
      await setSpeakers(app, "1");
      const r1 = await app.inPage(remembered);
      if (r1.target?.value !== "ja" || r1.speakers?.value !== "1") throw new Error(`persodub.lastChoices holds target ${r1.target?.value}, speakers ${r1.speakers?.value}`);
      await newDraft(app, ctx, "again");
      const shownNow = await app.waitFor("일본어 and 1 on the new project", 15000, () => {
        const t = document.querySelector("#targetLangSelect").value, s = document.querySelector("#numSpeakers").value;
        return t === "ja" && s === "1" ? { target: document.querySelector("#targetLangBtn").textContent.trim(), speakers: s } : null;
      }).catch(async () => { throw new Error(`the new project shows ${JSON.stringify(await app.inPage(choices))}, speakers "${await app.js("document.querySelector('#numSpeakers').value")}"`); });
      await app.shot("import-remembered-options");
      const ko = await pickTarget(app, "한국어", "ko");
      await setSpeakers(app, "");
      const r2 = await app.inPage(remembered);
      if (r2.target?.value !== "ko" || r2.speakers?.value !== "") throw new Error(`put back, persodub.lastChoices holds target ${r2.target?.value}, speakers "${r2.speakers?.value}"`);
      await toHome(app);
      return `picked "${ja}" and ${app.tr("Number of speakers")} 1 → ${app.tr("Home")} → new project shows "${shownNow.target}", ${shownNow.speakers}; put back "${ko}" and ${app.tr("Auto-detect")}`;
    } },

  { name: "tidy up", looks: ["#projectsGrid", "#deleteOverlay"],
    async run(app, ctx) {
      try {
        await toHome(app);
        await app.waitFor("the project grid to paint", 15000, () => document.querySelectorAll("#projectsGrid .proj-card").length);
        const before = await app.inPage(cards);
        const todo = before.filter((c) => MINE.test(c.name));
        let drafts = 0, projects = 0;
        for (const c of todo) {
          const sel = c.draft ? `#projectsGrid .proj-card[data-draft="${c.draft}"]` : `#projectsGrid .proj-card[data-job="${c.job}"]`;
          await deleteCard(app, sel, c.draft ? `#projectsGrid .proj-more[data-more-draft="${c.draft}"]` : `#projectsGrid .proj-more[data-more="${c.job}"]`);
          await app.waitFor(`${c.name}'s card to go`, 20000, (sel) => !document.querySelector("#deleteOverlay").classList.contains("open")
            && !document.querySelector(sel), c.draft ? `#projectsGrid [data-draft="${c.draft}"]` : `#projectsGrid [data-job="${c.job}"]`);
          if (c.draft) drafts += 1; else projects += 1;
        }
        const after = await app.inPage(cards);
        const stray = after.filter((c) => MINE.test(c.name));
        if (stray.length) throw new Error(`still on Home: ${stray.map((c) => c.name).join(", ")}`);
        const jobs = new Set((await jobsNow(app)).map((j) => j.id));
        const kept = (ctx.state.impJobs || []).filter((id) => jobs.has(id));
        if (kept.length) throw new Error(`GET /api/dub/jobs still lists ${kept.join(", ")}`);
        return `cards ${before.length} → ${after.length} (${drafts} drafts, ${projects} projects named e2e-imp-* deleted through their cards; ${ctx.state.impCardsAtStart ?? "?"} at the area's start)`;
      } finally {
        if (await app.inPage(shown, "#projectMenuDelete").catch(() => false)) await app.key("Escape");
        for (const [k, v] of Object.entries(ctx.state.impKeys || {})) {
          await app.inPage((key, value) => { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); return true; }, k, v);
        }
      }
    } },
];
