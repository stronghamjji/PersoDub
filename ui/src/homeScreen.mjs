// The Home screen's Projects grid: the mockup's shape for a project list --
// square thumbnail cards instead of the sidebar's row of dots -- reading the
// same GET /api/dub/jobs list ui/src/projects.mjs already draws into the
// sidebar and the Up next card. This module never asks the server for that
// list itself: it is wired through initProjectsUi's onJobs/onRunningPct hooks
// (see projects.mjs), so the sidebar, the queue card and this grid all repaint
// off one fetch.
//
// Owns #projectsGrid, #projectsCount, #projectFoldBtn, #projectSearchBtn/#projectSearchBox/
// #projectSearchInput and the "..." card menu (#projectCardMenu with
// #projectMenuRename/#projectMenuDelete). Delete reuses the page's own
// confirm dialog through onDeleteJob, exactly as the sidebar's Delete button
// does -- this file adds no dialog of its own for it. Rename is the one new
// mutation here, and it uses the same POST /api/dub/jobs/{id}/title the top
// bar's own rename already sends.
//
// A draft that was left before it was dubbed (ui/src/keptDrafts.mjs) is a
// card too, ahead of the projects, marked "Draft": a press opens it again
// with its cuts, and its "..." has Delete alone.
//
// One card per project, not per language (ui/src/languageRow.mjs): the card
// is the project's newest dubbing, says its languages when it has several,
// opens that newest one, and its Rename and Delete reach every language.
import { escapeHtml, fmtLength } from "./format.mjs";
import { lucide } from "./icons.mjs";
import { isErase, isSeparate, doingWord, projectMeta, shownName } from "./projects.mjs";
import { groupProjects, projectKey, projectLanguages, languageLabel } from "./languageRow.mjs";
import { t } from "./i18n.mjs";

// Where Collapse is remembered: "1" while the grid is folded away.
export const FOLD_KEY = "persodub.home.projectsFolded";

// The chip's colour follows the same states the sidebar's dot does
// (JOB_DOT in projects.mjs) -- done gets no chip at all, a finished card
// needs nothing more said about it. Getters, so the word is read in the
// page's language when the card is drawn.
const CHIP = {
  get error() { return [t("Failed"), "bad"]; },
  get cancelled() { return [t("Cancelled"), "muted"]; },
  // Made, its file on Perso's site: a free-plan workspace cannot download it.
  get on_perso() { return [t("See it on Perso"), "muted"]; },
  get queued() { return [t("Queued"), "queued"]; },
};

/**
 * Wire the Projects grid to a page.
 *
 * @param {object} deps
 * @param {(id: string) => any} deps.$
 * @param {(code: string) => string|null} deps.langName
 * @param {(jobId: string) => void} deps.onOpenJob
 * @param {(job: object, members: object[]) => void} deps.onDeleteJob  the
 *        page's own delete confirm dialog, with every job of the project.
 * @param {(text: string) => void} [deps.onError]  one line for something that
 *        did not work (a rename the server refused)
 * @param {(downloadId: string) => void} [deps.onOpenDraft]  open a kept draft again
 * @param {(draft: object) => void} [deps.onDeleteDraft]  ask, then let it go
 * @param {{getItem: Function, setItem: Function}} [deps.storage]  where the
 *        grid's being folded is remembered
 * @returns {{renderProjects: (jobs: object[]) => void,
 *            renderDrafts: (drafts: object[]) => void,
 *            setRunningPct: (jobId: string, pct: number|null) => void}}
 */
export function initHomeScreen({ $, langName, onOpenJob, onDeleteJob, onError = () => {},
                                 onOpenDraft = () => {}, onDeleteDraft = () => {}, storage = null }) {
  let jobs = [];
  let drafts = [];
  let menuDraftId = null;
  let query = "";
  let menuJobId = null;
  let renamingId = null;
  // What the grid last drew: the search, the card being renamed and its
  // cards in order. While those stay the same, the cards stay.
  let drawn = "";

  function cardDuration(job) {
    if (job.trim) return fmtLength(job.trim.end - job.trim.start);
    if (job.duration != null) return fmtLength(job.duration);
    return "";
  }

  function cardChip(job) {
    if (job.status === "running" || job.status === "cancelling") {
      const doing = doingWord(job);
      const pct = job._pct;
      return [pct != null ? `${doing} ${pct}%` : `${doing}…`, "run"];
    }
    return CHIP[job.status] || null;
  }

  // A project of several languages says them; one of a single language says
  // which way it went and how long it is, as before.
  function cardMeta(members) {
    const langs = projectLanguages(members);
    return langs.length > 1 ? langs.map((j) => languageLabel(j, langName)).join(" · ")
      : projectMeta(members[0], langName);
  }

  // A project's picture. One the server has none for yet (a link still coming
  // down) takes itself off and leaves the plain tile.
  const thumbImg = (job) => `<img class="proj-img" src="/api/dub/jobs/${encodeURIComponent(job.id)}/thumb" loading="lazy" alt=""
             onerror="this.remove()">`;

  // The eraser on an erase's card, and on a draft's left on the Erase tab.
  const eraseKind = () => `<span class="proj-kind" title="${t("Erase subtitles")}"><svg viewBox="0 0 24 24" width="12" height="12"><rect x="2.5" y="5" width="15" height="11" rx="2"/><path d="M13.5 21l6.8-6.8a1.6 1.6 0 0 0 0-2.3l-1.7-1.7a1.6 1.6 0 0 0-2.3 0L9.5 17z"/></svg></span>`;

  function cardHtml(members) {
    const job = members[0];
    const chip = cardChip(job);
    const dur = cardDuration(job);
    const name = shownName(job);
    const nameHtml = job.id === renamingId
      ? `<input class="proj-rename" data-rename="${job.id}" maxlength="80" value="${escapeHtml(name)}">`
      : `<div class="proj-name">${escapeHtml(name)}</div>`;
    return `<div class="proj-card" data-job="${escapeHtml(job.id)}" tabindex="0" role="button" aria-label="${t("Open {name}", { name: escapeHtml(name) })}">
      <div class="proj-thumb">
        ${thumbImg(job)}
        ${isErase(job) ? eraseKind() : ""}
        ${isSeparate(job) ? `<span class="proj-kind" title="${t("Separate audio")}"><svg viewBox="0 0 24 24" width="12" height="12"><path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/></svg></span>` : ""}
        ${chip ? `<span id="projChip-${escapeHtml(job.id)}" class="proj-chip proj-chip-${chip[1]}">${escapeHtml(chip[0])}</span>` : ""}
        ${dur ? `<span class="proj-dur">${escapeHtml(dur)}</span>` : ""}
      </div>
      <div class="proj-row">
        <div class="proj-info">${nameHtml}<div class="proj-meta">${escapeHtml(cardMeta(members))}</div></div>
        <button class="proj-more" type="button" data-more="${escapeHtml(job.id)}"
                aria-haspopup="menu" aria-label="${t("More for {name}", { name: escapeHtml(name) })}">${lucide("ellipsis", 14)}</button>
      </div>
    </div>`;
  }

  // How many seconds of a draft its cuts keep.
  const keptOf = (d) => d.ranges.reduce((s, [a, b]) => s + (b - a), 0);

  // What a draft was being made into (2026-10-21): one left on the Erase
  // tab says so; one left on Dubbing is not dubbed yet. The English is
  // the Dubbing card's way of saying it: "Erase subtitles · Not finished" ran
  // past the card's 124px (2026-10-22). The Korean names the tool.
  const draftMeta = (d) => (d.tab === "erase" ? t("Not erased yet") : t("Not dubbed yet"));

  // A kept draft: a frame of its video (the held file itself, stopped near
  // its start -- a draft has no thumbnail made for it), how much of it the
  // cuts kept, and "Draft" where a project says what state it is in.
  function draftCardHtml(d) {
    const name = d.name || t("Draft");
    const kept = keptOf(d);
    return `<div class="proj-card" data-draft="${escapeHtml(d.downloadId)}" tabindex="0" role="button" aria-label="${t("Open the draft {name}", { name: escapeHtml(name) })}">
      <div class="proj-thumb">
        <video class="proj-img" src="/api/downloads/${encodeURIComponent(d.downloadId)}/video#t=0.5" preload="metadata"
               muted playsinline tabindex="-1" onerror="this.remove()"></video>
        ${d.tab === "erase" ? eraseKind() : ""}
        <span class="proj-chip proj-chip-muted">${t("Draft")}</span>
        <span class="proj-dur">${escapeHtml(fmtLength(kept))}</span>
      </div>
      <div class="proj-row">
        <div class="proj-info"><div class="proj-name">${escapeHtml(name)}</div><div class="proj-meta">${escapeHtml(draftMeta(d))}</div></div>
        <button class="proj-more" type="button" data-more-draft="${escapeHtml(d.downloadId)}"
                aria-haspopup="menu" aria-label="${t("More for {name}", { name: escapeHtml(name) })}">${lucide("ellipsis", 14)}</button>
      </div>
    </div>`;
  }

  // A card still on show, brought up to date where it is: its name (renamed
  // on another screen, or put back), the words under it, its chip and length,
  // and a picture the server had none for when the card was drawn.
  function patchCard(card, members) {
    const job = members[0];
    const name = shownName(job);
    setName(card, name, t("Open {name}", { name }));
    card.querySelector(".proj-meta").textContent = cardMeta(members);
    const thumb = card.querySelector(".proj-thumb");
    const chip = cardChip(job);
    setLabel(thumb, ".proj-chip", chip && chip[0], chip && `proj-chip proj-chip-${chip[1]}`, `projChip-${job.id}`);
    setLabel(thumb, ".proj-dur", cardDuration(job), "proj-dur");
    if (!thumb.querySelector(".proj-img")) thumb.insertAdjacentHTML("afterbegin", thumbImg(job));
  }

  // A draft's name, and how much its cuts keep, change as it is worked on.
  function patchDraft(card, d) {
    const name = d.name || t("Draft");
    setName(card, name, t("Open the draft {name}", { name }));
    card.querySelector(".proj-dur").textContent = fmtLength(keptOf(d));
  }

  // The name is a field while its card is being renamed, and is left as typed.
  function setName(card, name, label) {
    const el = card.querySelector(".proj-name");
    if (el) el.textContent = name;
    card.setAttribute("aria-label", label);
    card.querySelector(".proj-more").setAttribute("aria-label", t("More for {name}", { name }));
  }

  // A label on a card's picture said again: taken off when there is nothing
  // to say, put on where there was none -- the chip ahead of the length, as
  // cardHtml has them.
  function setLabel(thumb, sel, text, className, id) {
    let el = thumb.querySelector(sel);
    if (!text) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement("span");
      if (id) el.id = id;
      thumb.insertBefore(el, thumb.querySelector(".proj-dur"));
    }
    el.className = className;
    el.textContent = text;
  }

  // Every job of the project the card for `jobId` stands for.
  const membersOf = (jobId) => {
    const job = jobs.find((j) => j.id === jobId);
    return job ? jobs.filter((j) => projectKey(j) === projectKey(job)) : [];
  };

  function finishRename(jobId, save, value) {
    const job = jobs.find((j) => j.id === jobId);
    renamingId = null;
    const was = job ? shownName(job) : "";
    const trimmed = (value || "").trim();
    if (save && job && trimmed && trimmed !== was) {
      // Every language of the project is called the same.
      for (const j of membersOf(jobId)) {
        const old = j.title;
        j.title = trimmed;   // painted now; the next list refresh says what stuck
        fetch(`/api/dub/jobs/${j.id}/title`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: trimmed }),
        }).then((r) => { if (!r.ok) throw new Error("rename failed"); }).catch(() => {
          // The old name back, and a line saying why it came back.
          j.title = old;
          paint();
          onError(t("Could not rename the project. Try again."));
        });
      }
    }
    paint();
  }

  function wireCard(card) {
    const draftId = card.dataset.draft;
    const open = () => (draftId ? onOpenDraft(draftId) : onOpenJob(card.dataset.job));
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => {
      // Only the card's own keys: Enter on its "..." button is that button's.
      if (e.target && e.target !== card) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  }

  function wireMore(btn) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openMenu(btn.dataset.more || null, btn, btn.dataset.moreDraft || null);
    });
  }

  function wireRename(input) {
    const id = input.dataset.rename;
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finishRename(id, true, input.value); }
      if (e.key === "Escape") { e.preventDefault(); finishRename(id, false); }
    });
    input.addEventListener("blur", () => finishRename(id, true, input.value));
  }

  function paint() {
    const grid = $("projectsGrid");
    const q = query.toLowerCase();
    const projects = groupProjects(jobs);
    const shown = projects.filter((m) => !q || shownName(m[0]).toLowerCase().includes(q));
    const shownDrafts = drafts.filter((d) => !q || (d.name || "").toLowerCase().includes(q));
    // With a search typed: how many it found, out of how many there are.
    // Draft cards are counted: the number is how many cards there are.
    const all = projects.length + drafts.length;
    if ($("projectsCount")) $("projectsCount").textContent = !all ? ""
      : q ? t("{shown} of {all}", { shown: shown.length + shownDrafts.length, all }) : String(all);
    // A draft's tab is in it: the card's eraser and words change with it.
    const layout = JSON.stringify([q, renamingId, shownDrafts.map((d) => [d.downloadId, d.tab]), shown.map((m) => m[0].id)]);
    // Patched, not drawn again: a redraw loaded every draft's <video> again (it flickered) and lost clicks.
    if (layout === drawn && (shown.length || shownDrafts.length)) {
      for (const card of grid.querySelectorAll(".proj-card")) {
        if (card.dataset.draft) patchDraft(card, shownDrafts.find((d) => d.downloadId === card.dataset.draft));
        else patchCard(card, shown.find((m) => m[0].id === card.dataset.job));
      }
      return;
    }
    drawn = layout;
    grid.innerHTML = shown.length || shownDrafts.length
      ? shownDrafts.map(draftCardHtml).join("") + shown.map(cardHtml).join("")
      : `<div class="projects-empty">${jobs.length || drafts.length ? t("No projects match your search.") : t("No projects yet.")}</div>`;
    for (const card of grid.querySelectorAll(".proj-card")) wireCard(card);
    for (const btn of grid.querySelectorAll(".proj-more")) wireMore(btn);
    for (const input of grid.querySelectorAll(".proj-rename")) wireRename(input);
    if (renamingId && shown.some((m) => m[0].id === renamingId)) {
      const input = grid.querySelector(`[data-rename="${renamingId}"]`);
      if (input && input.focus) { input.focus(); if (input.select) input.select(); }
    }
  }

  function renderProjects(list) {
    jobs = list || [];
    if (renamingId && !jobs.some((j) => j.id === renamingId)) renamingId = null;
    paint();
  }

  /** The drafts that were kept, newest first (ui/src/keptDrafts.mjs). */
  function renderDrafts(list) {
    drafts = list || [];
    paint();
  }

  function setRunningPct(jobId, pct) {
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return;
    job._pct = pct;
    // Only the running card's chip changes, so only its words are replaced.
    // Repainting the whole grid on every percent made each draft card's
    // video load again, and the drafts flickered for the length of a dub
    // (owner, 0.8.1). A card without a chip yet is drawn again as before.
    const chip = $(`projChip-${jobId}`);
    const next = cardChip(job);
    if (chip && next) { chip.textContent = next[0]; return; }
    paint();
  }

  // -- the "..." menu: one shared popover, moved to whichever card asked -----
  function closeMenu() {
    menuJobId = null;
    menuDraftId = null;
    if ($("projectCardMenu")) $("projectCardMenu").hidden = true;
  }

  function openMenu(jobId, anchor, draftId = null) {
    const menu = $("projectCardMenu");
    if (!menu) return;
    menuJobId = jobId;
    menuDraftId = draftId;
    // A draft has no name of its own to change: it is called what its video is.
    if ($("projectMenuRename")) $("projectMenuRename").hidden = !!draftId;
    if (typeof anchor.getBoundingClientRect === "function") {
      const r = anchor.getBoundingClientRect();
      menu.style.top = `${r.bottom + 4}px`;
      menu.style.left = `${Math.max(8, r.right - 150)}px`;
    }
    menu.hidden = false;
  }

  if ($("projectMenuRename")) {
    $("projectMenuRename").addEventListener("click", () => {
      const id = menuJobId;
      closeMenu();
      if (id) { renamingId = id; paint(); }
    });
  }
  if ($("projectMenuDelete")) {
    $("projectMenuDelete").addEventListener("click", () => {
      const members = membersOf(menuJobId);
      const draft = drafts.find((d) => d.downloadId === menuDraftId);
      closeMenu();
      if (draft) onDeleteDraft(draft);
      else if (members.length) onDeleteJob(members[0], members);
    });
  }
  document.addEventListener("click", (e) => {
    const menu = $("projectCardMenu");
    if (!menu || menu.hidden) return;
    if (e.target !== menu && !(menu.contains && menu.contains(e.target))) closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (menuJobId || menuDraftId)) closeMenu();
  });

  // -- fold --------------------------------------------------------------
  // A long list is a lot to face (owner, 2026-10-23): Collapse folds the
  // cards away to the heading row, Expand brings them back, and the choice
  // is there again at the next start.
  let folded = false;
  try { folded = !!storage && storage.getItem(FOLD_KEY) === "1"; } catch { /* private window */ }
  function paintFold() {
    $("projectsGrid").hidden = folded;
    const btn = $("projectFoldBtn");
    btn.setAttribute("aria-expanded", String(!folded));
    btn.innerHTML = `${lucide(folded ? "chevron-down" : "chevron-up", 12)}<span>${t(folded ? "Expand" : "Collapse")}</span>`;
  }
  function setFolded(on) {
    folded = on;
    try { if (storage) storage.setItem(FOLD_KEY, folded ? "1" : "0"); } catch { /* private window */ }
    paintFold();
  }
  $("projectFoldBtn").addEventListener("click", () => setFolded(!folded));
  paintFold();

  // -- search ------------------------------------------------------------
  function closeSearch() {
    $("projectSearchBox").hidden = true;
    query = "";
    $("projectSearchInput").value = "";
    paint();
  }
  if ($("projectSearchBtn")) {
    $("projectSearchBtn").addEventListener("click", () => {
      const box = $("projectSearchBox");
      if (!box.hidden) { closeSearch(); return; }
      box.hidden = false;
      // What is found has to be on show.
      if (folded) setFolded(false);
      if ($("projectSearchInput").focus) $("projectSearchInput").focus();
    });
  }
  if ($("projectSearchInput")) {
    $("projectSearchInput").addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
    });
    $("projectSearchInput").addEventListener("input", () => {
      query = $("projectSearchInput").value;
      paint();
    });
  }

  return { renderProjects, renderDrafts, setRunningPct };
}
