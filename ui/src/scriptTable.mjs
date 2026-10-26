// The script table on the finished screen: one row per line of the dub --
// number, speaker, time, the source line, the line itself (editable), and at
// the row's right end play, how long its voice runs, and make that voice again. The whole loop of
// reading a dub and fixing it lives here: draw the table, take an edit,
// save it, revert it, re-speak one line.
//
// The same reading the assistant works from. Editing a cell writes to
// edited.srt through /api/dub/jobs/{id}/script/{line} -- the identical path
// app/mcp_server.py's edit_script_line takes, so a person and the assistant
// cannot end up looking at two different scripts.
//
// What is NOT here: the timeline under the table, the player above it and the
// assistant's two page events stay on the page. The timeline and the table
// draw the same lines, but the timeline is also dragged, zoomed and scrubbed --
// that is its own screen, and this file only hands it the lines it just
// fetched (renderTimeline). The player is the finished screen's: this file
// asks it to show the dub and play a range, and to fetch itself again after a
// remake, through deps rather than by reaching for #doneVideo. The
// `persodub:script-changed` / `persodub:voices-remade` listeners stay on the
// page too -- they are the bridge from the assistant strip, not part of the
// table, and they only need getJobId/countStale/renderScript to do their work.
//
// lineVerdict (and lineOverBy under it) is exported on its own, without init:
// the timeline colours its bars by the same verdict, and one rule said in two
// places is how the two would come to disagree.
//
// The elements this file touches: #scriptBox, #scriptSaving, #scriptCount --
// the count beside the pane's own name -- and the pane head's three buttons
// (Translate again, Remake voices, All at once) with the strip under them
// (#scriptChanged), all inside the script pane. It never reaches the top bar,
// the timeline or `state`.
import { escapeHtml, fmtClockTenths, errorText } from "./format.mjs";
import { lucide } from "./icons.mjs";
import { numberSpeakers, speakerLetter } from "./speakers.mjs";
import { withTranslator } from "./translatorChoice.mjs";
import { translatorLabel } from "./dubApi.mjs";
import { t } from "./i18n.mjs";

// A hair over the slot is not "too long" -- the assembly step lets a line spill
// that much into the silence after it.
const OVER_TOLERANCE = 0.05;

// A cut under a tenth of a second reads "0.0s": the assembly took nothing
// anybody hears, so it is no cut, on its row or in the notice above the
// table (owner, 2026-10-22).
const MIN_CUT = 0.1;

// How long a line actually takes to say: the voice that was made for it if that
// is still on disk, otherwise the estimate from its characters.
function lineLength(l) {
  return l.audio_sec != null ? l.audio_sec : l.estimated;
}

// By how much a line runs past its slot, or 0 when it does not -- the one rule
// for "too long" wherever the screen says so. With no voice on disk there is no
// overshoot to measure, so the server's own verdict stands: its window forgives
// a small overrun (and also fails lines that are too SHORT, which is not this).
export function lineOverBy(l) {
  if (l.audio_sec == null && l.fits) return 0;
  const over = lineLength(l) - l.slot;
  return over > OVER_TOLERANCE ? over : 0;
}

// What a line's length comes to, in one word, and the seconds behind it
// (owner, 2026-10-20): "over" by what the assembly step cut off (clippedMap,
// from job.result.clipped, the cuts of MIN_CUT or more) -- whatever its own
// numbers say, because the true story is not "it fits", it is "it was made to
// fit by force" -- and said as any overrun is, never as a word of its own
// (owner, 2026-10-22); else "over" by the line's own overrun; "short" by the
// shortfall, once more than a second of the slot, or more than a fifth of it,
// is left empty; and "fit" in between.
export function lineVerdict(l, clippedMap) {
  const cut = clippedMap && clippedMap.get(l.line);
  if (cut != null) return { kind: "over", by: cut };
  const over = lineOverBy(l);
  if (over) return { kind: "over", by: over };
  const under = l.slot - lineLength(l);
  if (under > 1.0 || under > 0.2 * l.slot) return { kind: "short", by: under };
  return { kind: "fit", by: 0 };
}

// The row's three buttons, all Lucide now (script-same.html mockup,
// 2026-09-29): a solid play triangle to listen, a turning arrow to remake a
// voice (coloured by CSS, never a different glyph), and a curled-back arrow
// to revert an edited line. Sized by the stylesheet, not here.
const PLAY_ICON = lucide("play", 14, true);
const WAVE_ICON = lucide("refresh-cw", 14);
const UNDO_ICON = lucide("undo-2", 14);
// The length's mark for a line that fits: a tick in the dot's place, as a
// lone green dot said nothing in particular (owner, 2026-10-22).
const FIT_MARK = `<span class="sc-tick">${lucide("check", 12)}</span>`;

/**
 * Wire the script table to a page.
 *
 * @param {object} deps
 * @param {(id: string) => any} deps.$  the page's getElementById helper
 * @param {() => {source: string, target: string}} deps.scriptLangNames  the two
 *        language names this table heads its columns with -- the page's own,
 *        because the timeline labels its lanes with the same pair and the two
 *        must never disagree
 * @param {() => boolean} deps.isPersoJob  whether the open job was dubbed by
 *        Perso; that kind arrives as a finished video, so it has no script to
 *        show and says so instead
 * @param {(lines: object[], duration: number) => void} deps.renderTimeline  draw
 *        the strip under the table from the lines just fetched
 * @param {() => void} deps.paintPlayhead  put the playhead back where the video
 *        is, once the strip has been redrawn
 * @param {() => any} deps.getVideo  the finished screen's player -- read late,
 *        and only for its duration and to play a range in it
 * @param {(which: string) => Promise} deps.showVideoSource  swap the player to
 *        the dub or the original, answering when it is really showing it
 * @param {(video: any, start: number, end: number) => Promise} deps.playRange
 *        the page's shared "play only this much and stop" helper
 * @param {() => void} deps.reloadVideo  the finished video changed under the
 *        player (a line was re-spoken), so fetch it afresh
 * @param {() => object} [deps.getJob]  the open job's own status object (the
 *        page's `state.job`), read only for `result.clipped` /
 *        `result.clipped_count` -- the lines the assembly step cut short
 *        (point 3, user 2026-09-29). Absent on a job finished before this was
 *        added, so its absence means "unknown", not "nothing was cut".
 * @param {number} [deps.persoPollMs]  how often a Perso proofread under way is
 *        asked after; the tests make it 0
 * @param {(notice: object, pick: (translator: string) => any) => void} [deps.askTranslator]
 *        ChatGPT stopped Translate again (its limit, or signed out): the
 *        dubbing's own popup, whose translator buttons call pick
 * @param {(detail: object, retry: () => any) => void} [deps.needModels]  the
 *        translator's model is not downloaded: the download dialog, then retry
 * @param {(start: number) => void} [deps.onSeekLine]  a line was pressed: put
 *        the video at the start of it, still
 * @returns the operations the rest of the page calls.
 */
export function initScriptTableUi({ $, scriptLangNames, isPersoJob, renderTimeline,
                                    paintPlayhead, getVideo, showVideoSource,
                                    playRange, reloadVideo, getJob = () => null,
                                    persoPollMs = 5000, askTranslator = () => {},
                                    needModels = () => {}, onSeekLine = () => {} }) {
  // Which job's script is on screen. The page reads it back (getJobId) because
  // the assistant's events arrive with no job attached to them.
  let scriptJobId = null;
  // The lines whose voice was made again in this sitting, keyed `job:line`.
  // Kept here rather than asked of the server, because the table is redrawn
  // after every remake and the green tick has to survive the redraw.
  const freshLines = new Set();
  // The lines ticked for Translate again, on the job on screen.
  const picked = new Set();
  // The lines that do not fit (red on their row: cut off, or running past
  // their slot), which the button translates when none is ticked; and the
  // job whose Translate again is still under way.
  let unfit = [];
  let retranslating = null;
  // What the script said about editing this job through Perso (its
  // perso_edit): null on a job Perso never dubbed. While it is available a
  // line's voice is remade by Perso, in the voice Perso dubbed with.
  let persoEdit = null;
  // A project whose voices are Perso's: its lines have no voice button of
  // their own, and Remake voices sends every changed line to Perso at once.
  // Not one a voice was made for on this computer: that one is edited here.
  const viaPerso = () => !!persoEdit
    && (persoEdit.available || !!persoEdit.working || persoEdit.unfetched);
  // Whether Perso's voice is one that cannot remake a single line
  // (NIGHTINGALE), as last heard; null until Perso has said.
  let nightingale = null;
  // The lines on screen, as the script last gave them.
  let shown = [];
  // Whether the job on screen kept a voice for its lines (a dub made on this
  // computer): only then is a written line with none one whose voice could
  // not be made -- the dub skips it and the video is silent there.
  let voicedJob = false;
  // The line last pressed (its number), marked through every redraw of the
  // same project's table; another project's table starts with none.
  let selectedLine = null;
  // The script's stamp when it was last drawn: ui/src/scriptWatch.mjs draws
  // again when the server's moves on (the agent or another window).
  let drawnStamp = null;
  // Lines whose words came from Translate again in this sitting, keyed
  // `job:line`: translating those again overwrites nothing written by hand.
  const translated = new Set();
  // A press that spends Perso credits is pressed twice: the first says what
  // it costs, the second, within ten seconds, goes ahead. Not a dialog:
  // window.confirm() freezes every event in the Electron shell.
  let armed = null;
  function pressedTwice(what) {
    const yes = !!armed && armed.what === what && Date.now() - armed.at < 10000;
    armed = yes ? null : { what, at: Date.now() };
    return yes;
  }
  const CONFIRMED = {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: true }),
  };

  function scriptRow(l, speakers, clippedMap) {
    const n = speakers.get(l.speaker);
    // The name is a title as well as words, so a chip the narrow table has
    // squeezed still says who is speaking on hover.
    // On a Perso dub the chip is also the way to give the line a new speaker
    // (point 4, user 2026-09-29): Perso's own change, so it runs only there --
    // a local dub's chip stays a plain span.
    // Not on a NIGHTINGALE dub: Perso makes none of its lines' voices alone.
    const chip = !n ? "" : isPersoJob() && !nightingale
      ? `<button type="button" class="spk-chip" data-speaker="${l.line}"
         title="${t("Speaker {n}. Perso can give this line a new voice.", { n })}"
         aria-label="${t("Speaker {n}. Give this line a new voice", { n })}"><b>${speakerLetter(n)}</b></button>`
      : `<span class="spk-chip" title="${t("Speaker {n}", { n })}" aria-label="${t("Speaker {n}", { n })}"><b>${speakerLetter(n)}</b></span>`;
    // "1.9 / 2.5s · +0.6s": the time the line has, how long its voice runs
    // (in bold) and the difference, behind a dot in the verdict's colour --
    // red over time (or cut off by that much), orange much shorter. A line
    // that fits has a green tick instead and says nothing past its numbers
    // (owner, 2026-10-20 and 2026-10-22).
    const verdict = lineVerdict(l, clippedMap);
    const by = verdict.by.toFixed(1);
    const diffText = verdict.kind === "over" ? `+${t("{s}s", { s: by })}`
      : verdict.kind === "short" ? `−${t("{s}s", { s: by })}` : "";
    const diff = diffText && `<span class="sc-diff">${diffText}</span>`;
    const mark = verdict.kind === "fit" ? FIT_MARK : '<span class="sc-dot"></span>';
    // The mark and the difference are the answer; the two numbers are the
    // working. A narrow table drops the working (the stylesheet hides .sc-num)
    // and keeps the answer, so the row still says whether the line fits.
    // A line the translator gave nothing (app/dub_script.py load_lines sets
    // `untranslated`) has no words and no voice, so no length either: the cell
    // stays empty and the words' own cell says what is missing -- in red, in
    // the wide column where the translation belongs, via data-empty (the
    // stylesheet shows it only while the cell is empty and not being typed in,
    // so it never becomes part of the words). Play and remake rest until the
    // line is written: there is nothing to hear, and a remake of nothing was
    // refused (user decision 2026-09-18).
    const untr = !!l.untranslated;
    // Written, and no voice in a dub that has voices: said under the words,
    // the way Words changed is; its voice button makes it.
    const mute = voicedJob && !untr && l.audio_sec == null;
    const lengthCell = untr ? ""
      : `${mark}<span class="sc-num">${l.slot.toFixed(1)} / ${t("{s}s", { s: `<b>${lineLength(l).toFixed(1)}</b>` })}${diff ? " · " : ""}</span>${diff}`;
    const verdictClass = untr ? "" : ` sc-v-${verdict.kind}`;
    const off = untr ? " sc-off" : "";
    const offAttr = untr ? " disabled" : "";
    const WRITE_FIRST = t("You can press it once the translation is written");
    // Filled means "the voice does not say these words". The app decides that
    // per line now (app/dub_script.py), so it is taken as said: a line edited,
    // remade and put back is NOT edited, and its voice still says the edit.
    const stale = l.voice_stale;
    const fresh = freshLines.has(`${scriptJobId}:${l.line}`);
    // Every line below the first of a template is HTML the browser receives, so
    // its indentation is output, not layout: it is deliberately NOT stepped in
    // with the rest of this file. The rows read byte for byte as they did when
    // this lived inline in static/index.html.
    // An empty span rather than nothing at all: the tools cell is four fixed
    // slots, and a missing third slot would slide the remake button left on
    // the one row that has been edited (user, 2026-09-11).
    const undo = l.edited
      ? `<button class="sc-undo" data-undo="${l.line}" type="button"
         title="${t("Revert to the original translation")}" aria-label="${t("Revert to the original translation")}">${UNDO_ICON}</button>` : "<span></span>";
    // A Perso project has no voice button on its lines: revert takes its place
    // at the row's end, and Remake voices in the pane's head does them all.
    const wave = `<button class="sc-wave${stale ? " stale" : fresh ? " fresh" : ""}${off}" data-voice="${l.line}"
        type="button"${offAttr} title="${untr ? WRITE_FIRST : stale ? t("The words changed - press to make this line's voice again") : fresh ? t("New voice - press to make it once more") : t("Make this line's voice again")}">${WAVE_ICON}</button>`;
    // Perso put its own words in place of the user's when it made the voice
    // (app/perso_edit.py mark_reworded): said under the line, with the
    // user's words on hover. Revert is the way back.
    const reworded = l.reworded
      ? ` data-note="${t("Perso reworded this line.")}" title="${t("You wrote: {words}", { words: escapeHtml(l.reworded) })}"` : "";
    const tick = picked.has(l.line);
    return `<div class="sc-row${tick ? " sc-picked" : ""}${l.line === selectedLine ? " sc-sel" : ""}" data-line="${l.line}" data-start="${l.start}" data-end="${l.end}">
    <label class="sc-n"><input class="sc-pick" type="checkbox" data-pick="${l.line}"${tick ? " checked" : ""}
      aria-label="${t("Choose line {n}", { n: l.line })}"><span>${l.line}</span></label>
    <div>${chip}</div>
    <div class="sc-time"><span class="sc-t-a">${escapeHtml(fmtClockTenths(l.start))}</span><span
      class="sc-t-b"> – ${escapeHtml(fmtClockTenths(l.end))}</span></div>
    <div class="sc-src">${escapeHtml(l.source || "")}</div>
    <button class="sc-listen${off}" data-play="${l.line}" type="button"${offAttr}
      title="${untr ? WRITE_FIRST : t("Play this line in the video")}">${PLAY_ICON}</button>
    <div class="sc-dst" contenteditable="plaintext-only" spellcheck="false"
      data-line="${l.line}"${untr ? ` data-empty="${t("Not translated")}"` : ""}${stale && !untr ? ` data-note="${t("Words changed")}"` : mute ? ` data-note="${t("No sound")}"` : reworded}>${escapeHtml(l.text)}</div>
    <div class="sc-tools"><span class="sc-len${verdictClass}">${lengthCell}</span>${viaPerso() ? `<span></span>${undo}` : `${undo}${wave}`}</div>
  </div>`;
  }

  // A press on `revert` begins with mousedown, and mousedown lands BEFORE the
  // edited cell's blur. Without this flag blur saved the cell, saveLine redrew
  // the whole table, and the button the finger was still on no longer existed
  // when the click arrived -- the press hit nothing. Reverting is what the user
  // asked for, so a cell blurred into a revert press simply drops its edit.
  // The line being reverted, not a plain yes/no: one flag for the whole table
  // dropped the edit on line 3 when the revert being pressed was line 5's.
  let revertPressedLine = null;
  // mouseup comes before click, and only blur ever reads this, so clearing it
  // here covers the press that slid off the button and never became a click.
  document.addEventListener("mouseup", () => { revertPressedLine = null; });

  // A press on a line's time, its words, its length or an empty part of its
  // row marks the line and puts the video at its start, still (owner,
  // 2026-10-21). Its buttons, tick box and translation keep their own press,
  // and a drag that selects words is a selection, not a press. On the box,
  // once: the rows are drawn again and again, the box is not.
  $("scriptBox").addEventListener("click", (e) => {
    const row = e.target.closest(".sc-row[data-start]");
    if (!row || e.target.closest("button, input, label, a, [contenteditable]")) return;
    if (document.getSelection?.()?.isCollapsed === false) return;
    for (const was of $("scriptBox").querySelectorAll(".sc-row.sc-sel")) was.classList.remove("sc-sel");
    row.classList.add("sc-sel");
    selectedLine = +row.dataset.line;
    onSeekLine(+row.dataset.start);
  });

  // An answer that lands after another project was opened (or this one was
  // left for Home) is not this screen's to draw: every late writer asks first.
  const left = (jobId) => scriptJobId !== jobId;

  async function renderScript(jobId) {
    const box = $("scriptBox");
    if (!box) return;
    if (scriptJobId !== jobId) {
      picked.clear();
      selectedLine = null;
      // The project left may still be waiting on its Translate again; this
      // one's button is its own.
      $("retranslateBtn").disabled = false;
      nightingale = null;
    }
    scriptJobId = jobId;
    const data = await fetch(`/api/dub/jobs/${jobId}/script`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    // Another job was opened while this one's script was on its way: a slow
    // answer (a Perso job's took seconds) emptied the table and the timeline
    // of the job on screen (Windows, 2026-09-29).
    if (scriptJobId !== jobId) return;
    persoEdit = (data && data.perso_edit) || null;
    if (persoEdit && typeof persoEdit.nightingale === "boolean") nightingale = persoEdit.nightingale;
    shown = (data && data.lines) || [];
    drawnStamp = (data && data.stamp) || null;
    // Beside the pane's name: how much script there is. Empty when there is
    // none, so the label reads as "Script" alone.
    const count = $("scriptCount");
    if (count) count.textContent = data && data.lines && data.lines.length
      ? t("{n} lines", { n: data.lines.length }) : "";
    // Beside it, in grey: what translated these lines ("Translation ChatGPT
    // (gpt-5.6-luna)"), in sight of Translate again.
    const by = $("scriptModel");
    if (by) {
      const open = getJob();
      const label = data && data.lines && data.lines.length && open && open.id === jobId ? translatorLabel(open) : "";
      by.textContent = label ? `${t("Translation")} ${label}` : "";
      by.title = by.textContent;
    }
    if (!data || !data.lines || !data.lines.length) {
      const perso = isPersoJob();
      box.innerHTML = `<div class="script-empty">${perso
        ? t("Perso dubbing arrives as a finished video, so this project has no script.")
        : t("No script was recorded for this project.")}</div>`;
      renderTimeline([], 0);
      wirePicks(box, 0, false);
      return;
    }

    // English words ("Original", "Translated"), said in the page's language where drawn.
    const { source: sourceName, target: targetName } = scriptLangNames();
    const speakers = numberSpeakers(data.lines);
    // The lines the assembly step had to cut short, keyed by line number (a
    // finished job before this version carries no `clipped` at all -- absent
    // means unknown, not "nothing was cut", so job/result stay optional).
    const job = getJob();
    // The script's own list wins: a remade line changed it after the job
    // record was written. A cut under MIN_CUT is no cut, here or above.
    const clipped = (data.clipped
      || (job && job.id === jobId && job.result && job.result.clipped) || []).filter((c) => c.cut_s >= MIN_CUT);
    const clippedMap = new Map(clipped.map((c) => [c.line, c.cut_s]));
    unfit = data.lines.filter((l) => lineVerdict(l, clippedMap).kind === "over").map((l) => l.line);
    voicedJob = !isPersoJob() && data.lines.some((l) => l.audio_sec != null);
    // Same rule as scriptRow: what follows the backtick is output, so it keeps
    // the column it had inline rather than stepping in with this file.
    box.innerHTML = `
    <div class="sc-row head">
      <label class="sc-h-n"><input class="sc-pick" type="checkbox" data-pick="all" aria-label="${t("Choose every line")}">#</label><div class="sc-h-spk">${t("Who")}</div><div class="sc-h-t">${t("Time")}</div><div class="sc-h-src">${escapeHtml(t(sourceName))}</div>
      <div class="sc-h-dst">${escapeHtml(t(targetName))}</div>
      <div class="sc-tools"><span><span class="sc-h-len">${t("Original / Translated (s)")}</span><span class="sc-h-len-narrow">${t("Length")}</span></span><span></span>${viaPerso() ? "<span></span>" : `<span class="sc-h-voice">${t("Voice")}</span>`}</div>
    </div>
    ${data.lines.map((l) => scriptRow(l, speakers, clippedMap)).join("")}`;
    // The timeline draws the same lines, under the table, to the video's real
    // length -- or to the last line's end until the browser has the metadata,
    // which paintPlayhead redraws for the moment it lands.
    const duration = getVideo().duration;
    const total = Number.isFinite(duration) ? duration : 0;
    renderTimeline(data.lines, total || data.lines[data.lines.length - 1].end);
    paintPlayhead();
    wirePicks(box, data.lines.length, !data.readonly);

    if (data.readonly) {
      // A Perso dub starts as a read-only mirror of the server's script. The
      // bar's button fetches its parts (free) and unlocks local editing.
      box.querySelectorAll(".sc-dst").forEach((c) => c.removeAttribute("contenteditable"));
      box.querySelectorAll(".sc-wave, .sc-undo").forEach((b) => b.remove());
      const bar = document.createElement("div");
      bar.className = "script-empty";
      // The box lays rows out as a grid: without spanning every column the bar
      // gets crushed into the first one and looks like nothing happened.
      bar.style.gridColumn = "1 / -1";
      const note = document.createElement("span");
      note.textContent = t("This Perso dubbing is read-only.") + " ";
      // NIGHTINGALE: Perso cannot remake one of its lines, and fetching it for
      // editing ended in Perso's HTTP 500 every time (Windows, 2026-10-06).
      if (nightingale) {
        note.textContent = t("Nightingale dubbings cannot be edited line by line.");
        bar.append(note);
      } else {
        bar.append(note, editableButton(jobId, note));
      }
      box.prepend(bar);
    } else {
      paintActs(jobId);
    }
    // The lines whose voice could not be made, under the cut-off notice: a
    // line of words, the No sound under each such row being the per-line mark.
    const mute = voicedJob ? data.lines.filter((l) => !l.untranslated && l.audio_sec == null).length : 0;
    if (mute) silentNotice(box, mute);
    // Above everything else (prepended last, so it lands first): the lines cut
    // short by assembly, point 3. One line, not one per row -- the red pill on
    // each row's own verdict is already the per-line mark.
    if (clipped.length) clippedNotice(box, clipped);
    box.querySelectorAll(".sc-dst[contenteditable]").forEach((cell) => {
      const before = cell.textContent;
      // Enter commits rather than opening a second line: a script line has one
      // slot of time and cannot grow a row.
      cell.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); cell.blur(); }
        if (e.key === "Escape") { cell.textContent = before; cell.blur(); }
      });
      cell.addEventListener("blur", async () => {
        const text = cell.textContent.trim();
        // Only this cell's own revert drops this cell's edit -- a revert pressed
        // on another line is that line's business, and this one still saves.
        const reverting = revertPressedLine === cell.dataset.line;
        if (!text || text === before || reverting) { cell.textContent = before; return; }
        await saveLine(jobId, cell.dataset.line, text);
      });
    });

    box.querySelectorAll("[data-undo]").forEach((b) => {
      b.addEventListener("mousedown", () => { revertPressedLine = b.dataset.undo; });
      b.addEventListener("click", () => revertLine(jobId, b.dataset.undo));
    });

    // The play button plays the line inside the finished video, so the user sees
    // the mouth move with the words. Hearing a line on its own cannot tell you
    // whether it lands on the lips.
    // Always the dub, whatever the player was last left showing -- a bar on the
    // strip's bottom row can have swapped it to the original since, and this
    // button's whole point is the dubbed mouth moving with the dubbed words.
    box.querySelectorAll("[data-play]").forEach((b) => {
      const row = b.closest(".sc-row");
      b.addEventListener("click", () => {
        const start = +row.dataset.start;
        const end = +row.dataset.end;
        showVideoSource("dubbed")
          .then(() => playRange(getVideo(), start, end))
          .catch(() => {});
      });
    });

    box.querySelectorAll("[data-voice]").forEach((b) => {
      b.addEventListener("click", () => remakeLine(jobId, b.dataset.voice, b));
    });

    // The speaker chip, on a Perso dub only (point 4): press it to give that
    // one line a new voice, on Perso's own side.
    box.querySelectorAll("[data-speaker]").forEach((b) => {
      b.addEventListener("click", () => changeSpeaker(jobId, b.dataset.speaker, b));
    });
  }

  // The read-only bar's button: fetch the Perso dub's parts and draw it again.
  function editableButton(jobId, note) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "keys-link";
    btn.textContent = t("Make it editable");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      note.textContent = t("Fetching from Perso…") + " ";
      try {
        const r = await fetch(`/api/dub/jobs/${jobId}/perso/materialize`, { method: "POST" });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          note.textContent = String(d.detail || t("Could not fetch it.") + " ");
          btn.disabled = false;
          return;
        }
        await renderScript(jobId);
      } catch {
        note.textContent = t("Could not fetch it. Is {app} running?") + " ";
        btn.disabled = false;
      }
    });
    return btn;
  }

  // One line above the table: how many lines the assembly step had to cut
  // short, and a way to jump to the first of them. `cut` is job.result.clipped
  // -- {line, cut_s} -- never empty here (renderScript only calls this when it
  // is not).
  function clippedNotice(box, cut) {
    const bar = document.createElement("div");
    bar.className = "sc-clipped";
    bar.style.gridColumn = "1 / -1";
    bar.tabIndex = 0;
    const n = cut.length;
    bar.innerHTML = `${lucide("triangle-alert", 14)}<span>${n === 1
      ? t("1 line is cut off before it ends. Shorten it, then remake the voice.")
      : t("{n} lines are cut off before they end. Shorten them, then remake the voice.", { n })}</span>`;
    const jump = () => {
      const row = box.querySelector(`.sc-row[data-line="${cut[0].line}"]`);
      row?.scrollIntoView?.({ block: "center" });
    };
    bar.addEventListener("click", jump);
    bar.addEventListener("keydown", (e) => { if (e.key === "Enter") jump(); });
    box.prepend(bar);
  }

  // One line above the table: how many lines have no voice, so are silent in
  // the video, and that each one's own voice button makes it. Words only.
  function silentNotice(box, n) {
    const bar = document.createElement("div");
    bar.className = "sc-clipped sc-silent";
    bar.style.gridColumn = "1 / -1";
    bar.innerHTML = `${lucide("volume-x", 14)}<span>${n === 1
      ? t("1 line has no sound because its voice could not be made. Press that line's voice button to make it again.")
      : t("{n} lines have no sound because their voices could not be made. Press each line's voice button to make it again.", { n })}</span>`;
    box.prepend(bar);
  }

  // Lines whose words were rewritten and not voiced since: the ones Remake
  // voices does. Except on a NIGHTINGALE dub (whose new words ride along with
  // All at once), Perso does not know those words yet, so All at once would
  // throw them away: Remake voices sends them first.
  function unvoiced(lines) {
    return lines.filter((l) => l.voice_stale && (l.text || "").trim()).map((l) => l.line);
  }

  // The pane head's three buttons and the strip under them, for the script
  // just drawn: Remake voices counts the changed lines and rests at none, All
  // at once is a Perso project's alone.
  function paintActs(jobId) {
    const waiting = unvoiced(shown);
    const n = waiting.length;
    const perso = viaPerso();
    const remake = $("remakeVoicesBtn");
    remake.disabled = !n;
    remake.title = n
      ? t("Makes new voices for the lines whose words changed and puts them in the video. The other lines stay as they are.")
      : t("You can press it after you change a line's words or translate again.");
    remake.classList.remove(n ? "btn-outline" : "btn-primary");
    remake.classList.add(n ? "btn-primary" : "btn-outline");
    $("remakeVoicesCount").textContent = n ? ` (${n})` : "";
    const all = $("allAtOnceBtn");
    all.disabled = !perso || !!persoEdit.working;
    all.title = perso ? t("Perso makes the translation and voice of every line again.")
      : t("Only for projects dubbed with the Perso API.");
    const strip = $("scriptChanged");
    strip.hidden = !n;
    strip.innerHTML = !n ? "" : `<b>${n === 1 ? t("1 line changed.") : t("{n} lines changed.", { n })}</b> ${perso
      ? t("Remake voices when you are done.")
      : n === 1 ? t("Press Remake voices to hear it in the video.") : t("Press Remake voices to hear them in the video.")}`;
    if (!perso) return;
    if (persoEdit.working === "proofread") watchAll(jobId);
    else if (persoEdit.unfetched) scriptSaving(persoEdit.reason);
    // Whether Perso has anything to redo, asked behind the drawn table.
    else if (persoEdit.available) askAhead(jobId, waiting);
  }

  // Remake voices: every changed line's voice, in one press. On this computer
  // the app speaks them and rebuilds the video once; on a Perso project each
  // goes to Perso in turn, which is also what sends Perso the new words --
  // pressed twice there, it may spend credits. Perso names no price for a
  // line's voice, so none is said.
  async function remakeVoices(jobId) {
    const waiting = unvoiced(shown);
    if (!jobId || left(jobId) || !waiting.length) return;
    const perso = viaPerso();
    const n = waiting.length;
    if (perso && nightingale) {
      scriptSaving(t("This Perso voice remakes every line together. Use All at once."));
      return;
    }
    if (perso && !pressedTwice(`voices:${jobId}`)) {
      scriptSaving(n === 1 ? t("Perso makes a new voice for 1 line. It may use credits. Press again to go ahead.")
        : t("Perso makes new voices for {n} lines. It may use credits. Press again to go ahead.", { n }));
      return;
    }
    const btn = $("remakeVoicesBtn");
    btn.disabled = true;
    let made = 0;
    let credits = 0;
    try {
      if (perso) {
        for (const line of waiting) {
          scriptSaving(t("Remaking line {line} ({i} of {total})…", { line, i: made + 1, total: waiting.length }));
          const r = await fetch(`/api/dub/jobs/${jobId}/perso/script/${line}/voice`, {
            ...CONFIRMED, body: JSON.stringify({ confirm: true, changed_only: true }) });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data.detail || t("Could not remake line {line}.", { line }));
          freshLines.add(`${jobId}:${line}`);
          credits += data.credits || 0;
          made += 1;
        }
      } else {
        scriptSaving(n === 1 ? t("Remaking 1 line…") : t("Remaking {n} lines…", { n }));
        const r = await fetch(`/api/dub/jobs/${jobId}/voices/stale`, { method: "POST" });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.detail || t("Could not remake the voices."));
        (data.remade || []).forEach((line) => freshLines.add(`${jobId}:${line}`));
        made = waiting.length;
      }
      if (left(jobId)) return;
      scriptSaving(credits
        ? (n === 1 ? t("1 line remade. {credits} credits used.", { credits }) : t("{n} lines remade. {credits} credits used.", { n, credits }))
        : (n === 1 ? t("1 line remade") : t("{n} lines remade", { n })));
      await refreshAfterVoices(jobId);
      clearSoon(2000);
    } catch (e) {
      if (left(jobId)) return;
      // The lines Perso did voice before it stopped are drawn as made.
      if (made) await refreshAfterVoices(jobId);
      else btn.disabled = false;
      scriptSaving(errorText(e));
    }
  }

  // What Perso said when this project's script was opened, kept a few
  // minutes so a table drawn again does not ask again. Two free reads and
  // the price. A line edited, remade or reverted forgets it (forgetLive).
  const LIVE_KEEP_MS = 3 * 60 * 1000;
  const liveKnown = new Map();   // jobId -> { at, asked: Promise<live or null> }
  const livePrice = new Map();   // jobId -> credits All at once takes
  function forgetLive(jobId) {
    liveKnown.delete(jobId);
    livePrice.delete(jobId);
  }
  // "Free." or "Uses N credits." when Perso named the price, else as before.
  function priceText(jobId) {
    const n = livePrice.get(jobId);
    if (typeof n !== "number") return t("Uses credits.");
    if (n === 0) return t("Free.");
    const shown = Math.round(n * 10) / 10;
    return shown === 1 ? t("Uses 1 credit.") : t("Uses {n} credits.", { n: shown });
  }
  // Never in the way of the table: it is drawn first, and an answer that
  // does not come leaves the button as it was (the press still checks).
  function askAhead(jobId, waiting) {
    let known = liveKnown.get(jobId);
    if (!known || Date.now() - known.at > LIVE_KEEP_MS) {
      known = { at: Date.now(), asked: fetch(`/api/dub/jobs/${jobId}/perso/edit?price=1`)
        .then((r) => (r.ok ? r.json() : null)).catch(() => null) };
      liveKnown.set(jobId, known);
    }
    known.asked.then((live) => {
      // A failed ask is not kept: the next drawing asks once more.
      if (!live) { if (liveKnown.get(jobId) === known) liveKnown.delete(jobId); return; }
      if (liveKnown.get(jobId) !== known) return;
      if (typeof live.proofread_price === "number") livePrice.set(jobId, live.proofread_price);
      if (left(jobId)) return;
      if (typeof live.nightingale === "boolean") nightingale = live.nightingale;
      // Only the button as it was drawn: not one a press has since taken over.
      const btn = $("allAtOnceBtn");
      if (btn.disabled || live.working || live.unfetched || !live.available) return;
      // Perso has nothing to redo: the button rests.
      if (!live.retranslate_available && !(live.nightingale && waiting.length)) btn.disabled = true;
    });
  }

  async function persoLive(jobId) {
    const r = await fetch(`/api/dub/jobs/${jobId}/perso/edit`);
    const live = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(live.detail || t("Could not reach Perso."));
    return live;
  }

  // All at once: Perso translates every line again and remakes every voice.
  async function allAtOnce(jobId) {
    if (!jobId || left(jobId)) return;
    const btn = $("allAtOnceBtn");
    const waiting = unvoiced(shown);
    btn.disabled = true;
    try {
      const live = await persoLive(jobId);
      if (left(jobId)) return;
      if (!live.working) {
        // One that was asked for and never fetched costs nothing to fetch.
        if (!live.unfetched) {
          // Rewritten lines Perso has not voiced: it would refuse (or lose
          // them), so the press says what to do first.
          if (waiting.length && !live.nightingale) {
            scriptSaving(waiting.length === 1 ? t("1 line changed. Remake voices first.")
              : t("{n} lines changed. Remake voices first.", { n: waiting.length }));
            btn.disabled = false;
            return;
          }
          // A NIGHTINGALE dub's new words go along, so whether Perso takes
          // it is only known once it is asked.
          if (!live.retranslate_available && !live.nightingale) {
            scriptSaving(t("Perso has nothing to redo yet."));
            btn.disabled = false;
            return;
          }
          if (!pressedTwice(`all:${jobId}`)) {
            const known = typeof livePrice.get(jobId) === "number";
            scriptSaving(live.nightingale && !known
              ? t("Perso redoes every line. The first time is free. Press again.")
              : t("Perso redoes every line. {price} Press again.", { price: priceText(jobId) }));
            btn.disabled = false;
            return;
          }
        }
        const r = await fetch(`/api/dub/jobs/${jobId}/perso/proofread`, CONFIRMED);
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.detail || t("Could not start it."));
      }
      await watchAll(jobId);
    } catch (e) {
      if (left(jobId)) return;
      scriptSaving(errorText(e));
      btn.disabled = false;
    }
  }

  // Ask until Perso is done and its version is home, then draw it. Stops
  // asking when another job is opened: that one's screen is not this one's.
  // And when the table is drawn again meanwhile: that drawing starts its own
  // watch, and two of them would draw the result twice.
  let watch = 0;
  async function watchAll(jobId) {
    const mine = ++watch;
    const btn = $("allAtOnceBtn");
    btn.disabled = true;
    scriptSaving(t("Perso is redoing every line…"));
    try {
      for (;;) {
        await new Promise((done) => setTimeout(done, persoPollMs));
        if (scriptJobId !== jobId || mine !== watch) return;
        const live = await persoLive(jobId);
        if (live.working) continue;
        if (live.error) throw new Error(live.error);
        break;
      }
      scriptSaving("");
      await refreshAfterVoices(jobId);
    } catch (e) {
      if (left(jobId)) return;
      scriptSaving(errorText(e));
      btn.disabled = false;
    }
  }

  // Translate again: the ticked lines, or the lines that do not fit when none
  // is ticked (owner, 2026-10-23), translated once more -- by Perso on a Perso
  // project, on any other by the translator it was dubbed with, or the one
  // picked when ChatGPT stopped it. Words only: the voices wait for Remake
  // voices. With nothing ticked and nothing that does not fit, it rests.
  let lineCount = 0;
  function paintPicks() {
    const n = picked.size;
    $("scriptPickCount").textContent = n ? t("{n} selected", { n }) : "";
    const btn = $("retranslateBtn");
    btn.disabled = retranslating === scriptJobId || (!n && !unfit.length);
    // What it does, and to which lines, before it is pressed.
    btn.title = `${t("Translates again with the same translator, so each line fits the time it has. The voices stay as they are.")} ${
      n === 1 ? t("Only the selected line is translated again.")
        : n ? t("Only the {n} selected lines are translated again.", { n })
        : unfit.length ? t("With no line selected, only the lines whose length does not fit (marked red) are translated again.")
        : t("No line's length is off (marked red). Select the lines you want translated again.")}`;
    const all = $("scriptBox").querySelector('[data-pick="all"]');
    if (all) all.checked = n > 0 && n === lineCount;
  }
  function wirePicks(box, count, editable) {
    lineCount = count;
    $("scriptActs").hidden = !editable;
    if (!editable) $("scriptChanged").hidden = true;
    box.querySelectorAll(".sc-pick").forEach((b) => { b.hidden = !editable; });
    if (!editable) { picked.clear(); $("scriptPickCount").textContent = ""; return; }
    box.querySelectorAll(".sc-pick").forEach((b) => b.addEventListener("change", () => {
      if (b.dataset.pick === "all") {
        picked.clear();
        box.querySelectorAll(".sc-pick[data-pick]").forEach((o) => {
          if (o.dataset.pick === "all") return;
          o.checked = b.checked;
          o.closest(".sc-row").classList.toggle("sc-picked", b.checked);
          if (b.checked) picked.add(+o.dataset.pick);
        });
      } else {
        if (b.checked) picked.add(+b.dataset.pick); else picked.delete(+b.dataset.pick);
        b.closest(".sc-row").classList.toggle("sc-picked", b.checked);
      }
      paintPicks();
    }));
    paintPicks();
  }
  $("retranslateBtn").addEventListener("click", () => retranslate(
    scriptJobId, picked.size ? [...picked].sort((a, b) => a - b) : [...unfit]));
  $("remakeVoicesBtn").addEventListener("click", () => remakeVoices(scriptJobId));
  $("allAtOnceBtn").addEventListener("click", () => allAtOnce(scriptJobId));
  // `asked`: the same press carried on from a popup or the download dialog,
  // whose hand-edited lines were already asked about.
  async function retranslate(jobId, lines, translator = null, asked = false) {
    if (!jobId || left(jobId)) return;
    // Words somebody wrote by hand are not written over without a second press.
    const byHand = shown.filter((l) => l.edited && (!lines || lines.includes(l.line))
      && !translated.has(`${jobId}:${l.line}`)).length;
    if (byHand && !asked && !pressedTwice(`retranslate:${jobId}`)) {
      scriptSaving(byHand === 1 ? t("1 line you edited will be replaced by the new translation too. Press again to go ahead.")
        : t("{n} lines you edited will be replaced by the new translation too. Press again to go ahead.", { n: byHand }));
      return;
    }
    const btn = $("retranslateBtn");
    retranslating = jobId;
    btn.disabled = true;
    const job = getJob();
    const by = withTranslator(viaPerso() ? "perso" : (translator || (job && job.id === jobId && job.translator)));
    const many = lines ? lines.length : 0;
    scriptSaving(by
      ? (!lines ? t("Translating all lines {with}…", { with: by }) : many === 1 ? t("Translating 1 line {with}…", { with: by })
        : t("Translating {n} lines {with}…", { n: many, with: by }))
      : (!lines ? t("Translating all lines…") : many === 1 ? t("Translating 1 line…") : t("Translating {n} lines…", { n: many })));
    try {
      const r = await fetch(`/api/dub/jobs/${jobId}/retranslate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(translator ? { lines, translator } : { lines }),
      });
      const data = await r.json().catch(() => ({}));
      // Another project was opened meanwhile: the new words are on the
      // server, and this screen is no longer the one to draw them on.
      if (left(jobId)) return;
      // ChatGPT stopped it (its limit, or signed out): the dubbing's own
      // popup, and a translator picked there translates these same lines.
      const signedOut = r.status === 422 && /Sign in to ChatGPT/.test(data.detail || "");
      if (r.status === 429 || signedOut) {
        scriptSaving("");
        askTranslator({ type: signedOut ? "chatgpt_signed_out" : "chatgpt_limit", message: data.detail || "" },
                      (picked) => retranslate(jobId, lines, picked, true));
        return;
      }
      // The translator's model is not downloaded: the same dialog a dub
      // start opens, and this translation goes on once it is.
      if (r.status === 409 && data.detail && data.detail.missing) {
        scriptSaving("");
        needModels(data.detail, () => retranslate(jobId, lines, translator, true));
        return;
      }
      if (!r.ok) throw new Error(data.detail || t("Could not translate those lines again."));
      const changed = data.changed || [];
      changed.forEach((c) => translated.add(`${jobId}:${c.line}`));
      picked.clear();
      scriptSaving(!changed.length ? t("Same words. Nothing changed.")
        : changed.length === 1 ? t("1 line translated again. Press Remake voices to hear it.")
        : t("{n} lines translated again. Press Remake voices to hear them.", { n: changed.length }));
      forgetLive(jobId);
      await renderScript(jobId);
      clearSoon(4000);
    } catch (e) {
      if (!left(jobId)) scriptSaving(errorText(e));
    } finally {
      if (retranslating === jobId) retranslating = null;
      paintPicks();
    }
  }

  function scriptSaving(text) {
    const el = $("scriptSaving");
    if (el) el.textContent = text || "";
  }
  // A done message goes after a while -- but only if it is still the one
  // showing: a later press's "Translating…" stays while it works (sweep
  // D7, 2026-10-24: a "Saved" from just before wiped it).
  function clearSoon(ms) {
    const el = $("scriptSaving");
    const was = el ? el.textContent : "";
    setTimeout(() => { if (el && el.textContent === was) scriptSaving(""); }, ms);
  }

  async function saveLine(jobId, line, text) {
    freshLines.delete(`${jobId}:${line}`);
    translated.delete(`${jobId}:${line}`);
    forgetLive(jobId);
    scriptSaving(t("Saving…"));
    try {
      const r = await fetch(`/api/dub/jobs/${jobId}/script/${line}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (left(jobId)) return;
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || t("Could not save"));
      scriptSaving(t("Saved"));
      await renderScript(jobId); // the slot check has to be recomputed
      clearSoon(1500);
    } catch (e) {
      if (!left(jobId)) scriptSaving(errorText(e));
    }
  }

  // Everything the screen has to do once a voice has been made again, whoever
  // asked for it -- the wave button here or the assistant below. The video was
  // rebuilt in place, under the same job, so the player is pointed at the same
  // address with a new version mark; the table and the timeline are drawn again
  // from the server's script, which is also what takes the filled "stale" marks
  // off the lines that were re-spoken (`voice_stale` comes back false for them).
  async function refreshAfterVoices(jobId) {
    forgetLive(jobId);
    if (left(jobId)) return;
    reloadVideo();
    // The new voice has its own length, and the button its own look.
    await renderScript(jobId);
  }

  // Re-speak one line and rebuild the video around it (the row's own button:
  // a Perso project has none, see remakeVoices). Everything else -- the
  // other lines' audio, the background, the cloned voice -- is reused, so this
  // costs seconds where a whole remake costs minutes.
  async function remakeLine(jobId, line, btn) {
    btn.disabled = true;
    // Whatever the button showed before (the green tick of a voice already
    // made, the red ring of changed words), while the voice is being made it
    // is the arrow that turns -- a spinning tick read as an error.
    btn.classList.remove("fresh", "stale");
    btn.innerHTML = WAVE_ICON;
    scriptSaving(t("Remaking line {line}…", { line }));
    try {
      const r = await fetch(`/api/dub/jobs/${jobId}/script/${line}/voice`, { method: "POST" });
      const data = await r.json().catch(() => ({}));
      if (left(jobId)) return;
      if (!r.ok) throw new Error(data.detail || t("Could not remake that line."));
      scriptSaving(t("Line {line} done", { line }));
      freshLines.add(`${jobId}:${line}`);
      await refreshAfterVoices(jobId);
      clearSoon(2000);
    } catch (e) {
      if (!left(jobId)) scriptSaving(errorText(e));
      btn.disabled = false;
    }
  }

  async function revertLine(jobId, line) {
    freshLines.delete(`${jobId}:${line}`);
    forgetLive(jobId);
    scriptSaving(t("Reverting…"));
    const r = await fetch(`/api/dub/jobs/${jobId}/script/${line}/revert`, { method: "POST" })
      .catch(() => null);
    if (left(jobId)) return;
    // A revert that did not happen says so; the table is drawn again either
    // way, so the words on screen are the ones the server has.
    scriptSaving(r && r.ok ? "" : t("Could not revert line {line}. Try again.", { line }));
    await renderScript(jobId);
  }

  // Give one line of a Perso dub a new speaker, on Perso's own side (point 4,
  // user 2026-09-29): the same route the agent's change_speaker tool calls
  // (app/api/script.py POST .../perso/speaker), behind the same two-press
  // confirmation the rest of this file uses for Perso spending.
  async function changeSpeaker(jobId, line, btn) {
    if (!pressedTwice(`speaker:${jobId}:${line}`)) {
      scriptSaving(t("Perso gives line {line} a new voice. Uses credits. Press again.", { line }));
      return;
    }
    btn.disabled = true;
    scriptSaving(t("Changing line {line}'s speaker…", { line }));
    try {
      const r = await fetch(`/api/dub/jobs/${jobId}/perso/speaker`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line: +line }),
      });
      const data = await r.json().catch(() => ({}));
      if (left(jobId)) return;
      if (!r.ok) throw new Error(data.detail || t("Could not change that line's speaker."));
      scriptSaving(t("Line {line} done", { line }));
      await refreshAfterVoices(jobId);
      clearSoon(2000);
    } catch (e) {
      if (!left(jobId)) scriptSaving(errorText(e));
      btn.disabled = false;
    }
  }

  // Starting a fresh job: the table is emptied, its status line goes quiet and
  // it forgets which job it was showing. The set of lines re-spoken in this
  // sitting is keyed by job id, so it is left alone -- another job's marks
  // cannot show up under this one.
  function reset() {
    $("scriptBox").innerHTML = "";
    scriptSaving("");
    scriptJobId = null;
    persoEdit = null;
    nightingale = null;
    shown = [];
    armed = null;
    picked.clear();
    $("scriptPickCount").textContent = "";
    if ($("scriptCount")) $("scriptCount").textContent = "";
    if ($("scriptModel")) $("scriptModel").textContent = "";
    $("scriptActs").hidden = true;
    $("scriptChanged").hidden = true;
  }

  // How many lines are still wearing the "Words changed" mark. The
  // assistant's remake counts them before and after its redraw: the marks that
  // are gone are the lines it re-spoke, and there is no second way of telling.
  function countStale() {
    // The mark as the rows wrote it, in the language they were drawn in.
    return $("scriptBox").querySelectorAll(`.sc-dst[data-note="${t("Words changed")}"]`).length;
  }

  // retranslate: reached from its button above; returned for the tests.
  // linesOf: the lines on screen when they are that job's, else null (+ Add
  // language prices a Perso dubbing by where they are spoken).
  return { renderScript, refreshAfterVoices, setSaving: scriptSaving, reset, retranslate,
           getJobId: () => scriptJobId, countStale, getStamp: () => drawnStamp,
           linesOf: (jobId) => (jobId === scriptJobId ? shown : null) };
}
