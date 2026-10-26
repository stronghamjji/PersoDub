// Home: the project grid, folding it, its search, What's new, Help, deleting a test
// project from its card's menu, and a finished dub's card opening its screen.
// Only a card named e2e-click-* or e2e-dub* is ever deleted.
import { shown, pressable, isOpen, isClosed, onHome, textOf, isProductionHelp, Skip } from "../lib/cdp.mjs";

export const area = "home";

const DELETABLE = /^(e2e-click-|e2e-dub)/;

async function toHome(app) {
  const dialog = await app.js(`document.querySelector(".modal-overlay.open")?.id || ""`);
  if (dialog) throw new Error(`#${dialog} is open; the step starts with no dialog in the way`);
  if (!(await app.inPage(onHome))) await app.click("#homeBtn");
  await app.waitFor("the Home screen", 10000, onHome);
}

// The pointer moved onto the middle of an element (brought into view first).
// A move waits for the page's next frame, up to 5 s on a covered window.
async function hover(app, sel) {
  const at = await app.inPage((s) => {
    const el = document.querySelector(s);
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sel);
  await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, button: "none" });
}

// The grid's cards as drawn: job or draft id, name, and how many in all.
const cards = () => [...document.querySelectorAll("#projectsGrid .proj-card")].map((c) => ({
  job: c.dataset.job || "", draft: c.dataset.draft || "", name: (c.querySelector(".proj-name")?.textContent || "").trim() }));

export const steps = [
  { name: "project grid", looks: [".home-side", "#projectsGrid"],
    async run(app) {
      await toHome(app);
      const n = await app.waitFor("the project grid to paint", 15000, () => document.querySelectorAll("#projectsGrid .proj-card").length);
      const tools = { "#homeDubCard": "Dubbing", "#homeEraseCard": "Erase subtitles", "#homeCaptionsCard": "Burn in subtitles", "#homeSaveCard": "Save video" };
      for (const [sel, key] of Object.entries(tools)) {
        await app.waitFor(`${sel} on show`, 5000, shown, sel);
        const said = await app.inPage(textOf, `${sel} .home-card-title`);
        if (said !== app.tr(key)) throw new Error(`${sel} is named "${said}", not "${app.tr(key)}"`);
      }
      const pill = await app.inPage(() => {
        const b = document.querySelector("#homePerso"), img = b.querySelector("img");
        return { label: b.getAttribute("aria-label"), alt: img.alt, loaded: img.naturalWidth > 0, on: b.getClientRects().length > 0 };
      });
      if (!pill.on || !pill.loaded || pill.label !== "Perso Dubbing") throw new Error(`the Perso pill: ${JSON.stringify(pill)}`);
      // The production edition has no repository button (ui/src/homeSidebar.mjs).
      let gh = "no GitHub button";
      if (app.production) {
        if (await app.inPage(shown, "#homeGhName")) throw new Error("the production edition shows the GitHub button");
      } else {
        gh = await app.inPage(textOf, "#homeGhName");
        if (gh !== app.tr("PersoDub on GitHub") || !(await app.inPage(pressable, "#homeGhName"))) throw new Error(`the GitHub button reads "${gh}"`);
      }
      return `${n} cards; tool cards ${Object.values(tools).map((k) => app.tr(k)).join(", ")}; Perso pill "${pill.label}" with its wordmark; "${gh}"`;
    } },

  { name: "projects fold and unfold", looks: ["#projectsHead", "#projectsGrid"],
    async run(app) {
      await toHome(app);
      const KEY = "persodub.home.projectsFolded";
      const was = await app.inPage((k) => localStorage.getItem(k), KEY);
      const state = () => ({ grid: !document.querySelector("#projectsGrid").hidden,
        expanded: document.querySelector("#projectFoldBtn").getAttribute("aria-expanded"),
        label: document.querySelector("#projectFoldBtn").textContent.trim() });
      // From open: Collapse, then Expand; a folded start is opened first.
      if (!(await app.inPage(state)).grid) await app.click("#projectFoldBtn");
      const open = await app.waitFor("the grid open", 5000, () => !document.querySelector("#projectsGrid").hidden);
      const s0 = await app.inPage(state);
      if (!open || s0.label !== app.tr("Collapse") || s0.expanded !== "true") throw new Error(`open: ${JSON.stringify(s0)}`);
      await app.click("#projectFoldBtn");
      await app.waitFor("the grid folded", 5000, () => document.querySelector("#projectsGrid").hidden);
      const s1 = await app.inPage(state);
      const kept = await app.inPage((k) => localStorage.getItem(k), KEY);
      await app.shot("home-projects-folded");
      if (s1.label !== app.tr("Expand") || s1.expanded !== "false" || kept !== "1") throw new Error(`folded: ${JSON.stringify(s1)}, stored ${kept}`);
      await app.click("#projectFoldBtn");
      await app.waitFor("the grid back", 5000, () => !document.querySelector("#projectsGrid").hidden);
      const back = await app.inPage((k) => localStorage.getItem(k), KEY);
      if (back !== "0") throw new Error(`unfolded, yet stored ${back}`);
      // The rest of the area presses cards: left open, and the stored value as it was.
      await app.inPage((k, v) => { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); return true; }, KEY, was);
      return `"${s0.label}" folded the grid away (stored ${kept}), "${s1.label}" brought it back (stored ${back}); stored value put back (${was})`;
    } },

  { name: "search filters cards", looks: ["#projectsHead", "#projectsGrid"],
    async run(app) {
      await toHome(app);
      const before = await app.inPage(cards);
      // A word some cards have and others lack: "e2e-", else a card's whole
      // name (a fresh workspace holds only e2e- cards). Matched as the page does.
      const has = (term) => before.filter((c) => c.name.toLowerCase().includes(term)).length;
      const term = ["e2e-", ...before.map((c) => c.name.toLowerCase())].find((w) => w && has(w) > 0 && has(w) < before.length);
      if (!term) throw new Skip(`${before.length} card(s), no name that some have and others lack; nothing for a search to tell apart`);
      const want = has(term);
      await app.click("#projectSearchBtn");
      await app.waitFor("the search box", 5000, shown, "#projectSearchInput");
      await app.type("#projectSearchInput", term);
      const found = await app.waitFor(`${want} cards`, 5000, (n) => {
        const now = [...document.querySelectorAll("#projectsGrid .proj-card")];
        return now.length === n ? now.map((c) => c.querySelector(".proj-name")?.textContent.trim() || "") : null;
      }, want);
      const stray = found.filter((name) => !name.toLowerCase().includes(term));
      if (stray.length) throw new Error(`the search shows ${stray.join(", ")}`);
      const count = await app.inPage(textOf, "#projectsCount");
      const said = app.tr("{shown} of {all}", { shown: want, all: before.length });
      if (count !== said) throw new Error(`the count reads "${count}", not "${said}"`);
      await app.key("Escape");
      await app.waitFor(`${before.length} cards again`, 5000, (n) => document.querySelectorAll("#projectsGrid .proj-card").length === n
        && document.querySelector("#projectSearchBox").hidden, before.length);
      return `${before.length} cards → "${term}" → ${want} ("${count}") → Escape → ${before.length}`;
    } },

  { name: "whats new", looks: ["#updateOverlay"],
    async run(app) {
      await toHome(app);
      const title = await app.inPage(textOf, "#homeWhatsNewTitle");
      await app.click("#homeWhatsNew");
      await app.waitFor("the update window", 5000, isOpen, "#updateOverlay");
      // A production build with no update address names the version in the
      // title alone, and no line under it (ui/src/updateWindow.mjs, check-off).
      const head = await app.waitFor("its version line", 5000, () => {
        const v = document.querySelector("#updCurrent").textContent.trim() || document.querySelector("#updTitle").textContent.trim();
        return /\d+\.\d+\.\d+/.test(v) ? { h: document.querySelector("#updHead").textContent.trim(), v, notes: document.querySelectorAll("#updNotes li").length } : null;
      });
      await app.shot("home-whats-new-open");
      await app.key("Escape");
      await app.waitFor("the update window to close", 5000, isClosed, "#updateOverlay");
      return `"${title}" opened "${head.h}" (${head.v}, ${head.notes} notes); Escape closed it`;
    } },

  { name: "help", looks: ["#helpOverlay"],
    async run(app) {
      await toHome(app);
      const label = await app.inPage(textOf, "#homeHelp");
      if (label !== app.tr("Help")) throw new Error(`the Help button reads "${label}"`);
      // The production edition's Help is Perso's desktop app page in the browser, not the dialog.
      if (app.production) {
        const urls = await app.opened(() => app.click("#homeHelp"));
        if (urls.length !== 1 || !isProductionHelp(urls[0])) throw new Error(`Help opened ${urls.join(", ") || "nothing"}`);
        if (await app.inPage(isOpen, "#helpOverlay")) throw new Error("the production Help opened the Help dialog too");
        const at = new URL(urls[0]);
        return `"${label}" opened ${at.origin}${at.pathname} with utm_content=help, not the Help dialog`;
      }
      await app.click("#homeHelp");
      await app.waitFor("the Help dialog", 5000, isOpen, "#helpOverlay");
      const help = await app.inPage(() => ({ title: document.querySelector("#helpTitle").textContent.trim(),
                                             items: document.querySelectorAll("#helpOverlay .help-item").length }));
      await app.shot("home-help-open");
      // Dubbing, Erase subtitles, Save video and the Dub Agent: Separate audio left the tools (2026-10-23).
      if (help.title !== app.tr("What {app} does") || help.items !== 4) throw new Error(`Help shows "${help.title}" with ${help.items} items`);
      await app.key("Escape");
      await app.waitFor("the Help dialog to close", 5000, isClosed, "#helpOverlay");
      return `"${label}" opened the Help dialog "${help.title}" (${help.items} tools, not an external link); Escape closed it`;
    } },

  { name: "delete a test project", looks: ["#deleteOverlay", "#projectCardMenu", "#projectsGrid"],
    async run(app) {
      await toHome(app);
      const jobs = (await app.api("/api/dub/jobs")).jobs;
      const byId = new Map(jobs.map((j) => [j.id, j]));
      const before = await app.inPage(cards);
      // Job cards only (a draft is not a project), none of whose jobs is still
      // on its way (the server keeps those); the oldest by its record.
      const busy = new Set(jobs.filter((j) => ["queued", "running", "cancelling"].includes(j.status)).map((j) => j.project_id || j.id));
      const pick = before.filter((c) => c.job && DELETABLE.test(c.name) && byId.has(c.job)
        && !busy.has(byId.get(c.job).project_id || c.job))
        .sort((a, b) => String(byId.get(a.job).created).localeCompare(String(byId.get(b.job).created)))[0];
      if (!pick) throw new Error("no card named e2e-click-* or e2e-dub* to delete");
      const job = byId.get(pick.job);
      const members = jobs.filter((j) => (j.project_id || j.id) === (job.project_id || job.id)).map((j) => j.id);
      // Its "..." shows only while the pointer is over the card, as for a person.
      await hover(app, `#projectsGrid .proj-card[data-job="${pick.job}"]`);
      await app.click(`#projectsGrid .proj-more[data-more="${pick.job}"]`);
      await app.waitFor("the card menu", 5000, shown, "#projectMenuDelete");
      await app.click("#projectMenuDelete");
      await app.waitFor("the delete dialog", 5000, isOpen, "#deleteOverlay");
      const title = await app.inPage(textOf, "#deleteTitle");
      await app.shot("home-delete-dialog");
      if (title !== app.tr("Delete this project?")) throw new Error(`the dialog asks "${title}"`);
      await app.click("#deleteConfirmBtn");
      try {
        await app.waitFor("the dialog to close and the card to go", 20000, (id, n) => !document.querySelector("#deleteOverlay").classList.contains("open")
          && !document.querySelector(`#projectsGrid [data-job="${id}"]`) && document.querySelectorAll("#projectsGrid .proj-card").length === n - 1,
        pick.job, before.length);
      } catch (e) {
        const why = await app.inPage(textOf, "#deleteError");
        if (await app.inPage(isOpen, "#deleteOverlay")) await app.click("#deleteCancelBtn");
        throw new Error(`${e.message}${why ? `; the dialog says "${why}"` : ""}`);
      }
      const left = (await app.api("/api/dub/jobs")).jobs.filter((j) => members.includes(j.id));
      if (left.length) throw new Error(`GET /api/dub/jobs still lists ${left.map((j) => j.id).join(", ")}`);
      return `deleted "${pick.name}" (job ${pick.job} of ${job.created}, ${members.length} job(s)); cards ${before.length} → ${before.length - 1}; gone from /api/dub/jobs`;
    } },

  { name: "finished dub opens", looks: ["#doneLayout", "#projectsGrid"],
    async run(app) {
      await toHome(app);
      const jobs = (await app.api("/api/dub/jobs")).jobs;
      const onGrid = new Set((await app.inPage(cards)).map((c) => c.job));
      const job = jobs.find((j) => j.status === "done" && (j.kind || "dub") === "dub" && onGrid.has(j.id));
      if (!job) throw new Error("no finished dub has a card on Home");
      await app.click(`#projectsGrid .proj-card[data-job="${job.id}"]`);
      const got = await app.waitFor("the finished screen", 15000, (id) => document.body.dataset.screen === "done" && document.body.dataset.jobId === id
        && !!document.querySelector("#scriptBox .sc-row, #scriptBox .script-empty") && document.querySelector("#topbarTitle").textContent.trim(), job.id);
      await app.shot("home-finished-screen");
      await app.click("#homeBtn");
      await app.waitFor("the Home screen", 10000, onHome);
      return `card ${job.id} opened data-screen=done, title "${got}"; ${app.tr("Home")} returned`;
    } },
];
