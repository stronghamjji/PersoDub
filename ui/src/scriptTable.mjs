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
// lineOverBy is exported on its own, without init: the timeline colours its
// bars by the same rule, and one rule for "too long" said in two places is how
// the two would come to disagree.
//
// The elements this file touches: #scriptBox, #scriptSaving and #scriptCount --
// the count beside the pane's own name -- all three inside the script pane. It
// never reaches the top bar, the timeline or `state`.
import { escapeHtml, fmtClockTenths, errorText } from "./format.mjs";
import { CHECK_ICON, REMAKE_ICON } from "./icons.mjs";
import { numberSpeakers, speakerLetter } from "./speakers.mjs";

// A hair over the slot is not "too long" -- the assembly step lets a line spill
// that much into the silence after it.
const OVER_TOLERANCE = 0.05;

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

// Sized by the stylesheet, not here: the narrow table takes both buttons down
// a size, and an inline width would be the one thing it could not reach.
// A triangle's weight is on its flat side, so its box centre is not its optical centre: drawn from 7.5 the shape sits 0.75 units right of the middle of a 24 box, and the margin-left that used to be here pushed it further the same way. Drawn from 6.75 it is centred on the box, and the nudge is gone (user, 2026-09-11).
const PLAY_ICON = '<svg viewBox="0 0 24 24" style="fill:currentColor;stroke:currentColor;stroke-width:3;stroke-linejoin:round"><path d="M6.75 5.5v13l10.5-6.5z"/></svg>';
// The "revert" arrow beside an edited line (renderScript): a curled-back
// arrow, drawn like the rest of the app's icons.
const UNDO_ICON = '<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>';

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
 * @returns the operations the rest of the page calls.
 */
export function initScriptTableUi({ $, scriptLangNames, isPersoJob, renderTimeline,
                                    paintPlayhead, getVideo, showVideoSource,
                                    playRange, reloadVideo }) {
  // Which job's script is on screen. The page reads it back (getJobId) because
  // the assistant's events arrive with no job attached to them.
  let scriptJobId = null;
  // The lines whose voice was made again in this sitting, keyed `job:line`.
  // Kept here rather than asked of the server, because the table is redrawn
  // after every remake and the green tick has to survive the redraw.
  const freshLines = new Set();

  function scriptRow(l, speakers) {
    const n = speakers.get(l.speaker);
    // The name is a title as well as words, so a chip the narrow table has
    // squeezed still says who is speaking on hover.
    const chip = n
      ? `<span class="spk-chip" title="Speaker ${n}" aria-label="Speaker ${n}"><b>${speakerLetter(n)}</b></span>` : "";
    const over = lineOverBy(l);
    // "1.6s / 0.2s · +1.4s": how long the voice is, how long the slot is, and
    // the difference in one glance -- red when it runs over, grey when it is
    // well short, green "fits" otherwise (user decision 2026-08-28).
    const under = l.slot - lineLength(l);
    const verdict = over ? `<span class="sc-over">+${over.toFixed(1)}s</span>`
      : under > 0.3 ? `<span class="sc-under">−${under.toFixed(1)}s</span>`
      : `<span class="sc-fit">fits</span>`;
    // The verdict is the answer; the two numbers behind it are the working.
    // A narrow table drops the working (the stylesheet hides .sc-num) and keeps
    // the answer, so the row still says whether the line fits.
    const lengthCell = `<span class="sc-num"><b>${lineLength(l).toFixed(1)}s</b> / ${l.slot.toFixed(1)}s · </span>${verdict}`;
    // Filled means "the words changed and the voice has not caught up". Both
    // halves are needed: `edited` is per line, and `voice_stale` (a file older
    // than the script) is what says the remake has not happened since.
    const stale = l.edited && l.voice_stale;
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
         title="Revert to the original translation" aria-label="Revert to the original translation">${UNDO_ICON}</button>` : "<span></span>";
    return `<div class="sc-row" data-start="${l.start}" data-end="${l.end}">
    <div class="sc-n">${l.line}</div>
    <div>${chip}</div>
    <div class="sc-time"><span class="sc-t-a">${escapeHtml(fmtClockTenths(l.start))}</span><span
      class="sc-t-b"> – ${escapeHtml(fmtClockTenths(l.end))}</span></div>
    <div class="sc-src">${escapeHtml(l.source || "—")}</div>
    <button class="sc-listen" data-play="${l.line}" type="button"
      title="Play this line in the video">${PLAY_ICON}</button>
    <div class="sc-dst" contenteditable="plaintext-only" spellcheck="false"
      data-line="${l.line}">${escapeHtml(l.text)}</div>
    <div class="sc-tools"><span class="sc-len">${lengthCell}</span>${undo}<button class="sc-wave${stale ? " stale" : fresh ? " fresh" : ""}" data-voice="${l.line}"
        type="button" title="${stale ? "The words changed - make the voice again" : fresh ? "Voice made - press to make it again" : "Make this line's voice again"}">${fresh && !stale ? CHECK_ICON : REMAKE_ICON}</button></div>
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

  async function renderScript(jobId) {
    const box = $("scriptBox");
    if (!box) return;
    scriptJobId = jobId;
    const data = await fetch(`/api/dub/jobs/${jobId}/script`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    // Beside the pane's name: how much script there is. Empty when there is
    // none, so the label reads as "Script" alone.
    const count = $("scriptCount");
    if (count) count.textContent = data && data.lines && data.lines.length
      ? `${data.lines.length} lines` : "";
    if (!data || !data.lines || !data.lines.length) {
      const perso = isPersoJob();
      box.innerHTML = `<div class="script-empty">${perso
        ? "Perso dubbing arrives as a finished video, so this job has no script."
        : "No script was recorded for this job."}</div>`;
      renderTimeline([], 0);
      return;
    }

    const { source: sourceName, target: targetName } = scriptLangNames();
    const speakers = numberSpeakers(data.lines);
    // Same rule as scriptRow: what follows the backtick is output, so it keeps
    // the column it had inline rather than stepping in with this file.
    box.innerHTML = `
    <div class="sc-row head">
      <div class="sc-h-n">#</div><div class="sc-h-spk">Who</div><div class="sc-h-t">Time</div><div>${escapeHtml(sourceName)}</div>
      <div class="sc-h-play"></div><div>${escapeHtml(targetName)}</div>
      <div class="sc-tools"><span>Length</span><span></span><span class="sc-h-voice">Voice</span></div>
    </div>
    ${data.lines.map((l) => scriptRow(l, speakers)).join("")}`;
    // The timeline draws the same lines, under the table, to the video's real
    // length -- or to the last line's end until the browser has the metadata,
    // which paintPlayhead redraws for the moment it lands.
    const duration = getVideo().duration;
    const total = Number.isFinite(duration) ? duration : 0;
    renderTimeline(data.lines, total || data.lines[data.lines.length - 1].end);
    paintPlayhead();

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
      note.textContent = "This Perso dubbing is read-only. ";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "keys-link";
      btn.textContent = "Make it editable";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        note.textContent = "Fetching from Perso… ";
        try {
          const r = await fetch(`/api/dub/jobs/${jobId}/perso/materialize`, { method: "POST" });
          if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            note.textContent = String(d.detail || "Could not fetch it. ");
            btn.disabled = false;
            return;
          }
          await renderScript(jobId);
        } catch {
          note.textContent = "Could not fetch it. Is the engine running? ";
          btn.disabled = false;
        }
      });
      bar.append(note, btn);
      box.prepend(bar);
    }
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
  }

  function scriptSaving(text) {
    const el = $("scriptSaving");
    if (el) el.textContent = text || "";
  }

  async function saveLine(jobId, line, text) {
    freshLines.delete(`${jobId}:${line}`);
    scriptSaving("Saving…");
    try {
      const r = await fetch(`/api/dub/jobs/${jobId}/script/${line}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "Could not save");
      scriptSaving("Saved");
      await renderScript(jobId); // the slot check has to be recomputed
      setTimeout(() => scriptSaving(""), 1500);
    } catch (e) {
      scriptSaving(String(e.message || e));
    }
  }

  // Everything the screen has to do once a voice has been made again, whoever
  // asked for it -- the wave button here or the assistant below. The video was
  // rebuilt in place, under the same job, so the player is pointed at the same
  // address with a new version mark; the table and the timeline are drawn again
  // from the server's script, which is also what takes the filled "stale" marks
  // off the lines that were re-spoken (`voice_stale` comes back false for them).
  async function refreshAfterVoices(jobId) {
    reloadVideo();
    // The new voice has its own length, and the button its own look.
    await renderScript(jobId);
  }

  // Re-speak one line and rebuild the video around it. Everything else -- the
  // other lines' audio, the background, the cloned voice -- is reused, so this
  // costs seconds where a whole remake costs minutes.
  async function remakeLine(jobId, line, btn) {
    btn.disabled = true;
    // Whatever the button showed before (the green tick of a voice already
    // made, the red ring of changed words), while the voice is being made it
    // is the arrow that turns -- a spinning tick read as an error.
    btn.classList.remove("fresh", "stale");
    btn.innerHTML = REMAKE_ICON;
    scriptSaving(`Remaking line ${line}…`);
    try {
      const r = await fetch(`/api/dub/jobs/${jobId}/script/${line}/voice`, { method: "POST" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.detail || "Could not remake that line.");
      scriptSaving(`Line ${line} done`);
      freshLines.add(`${jobId}:${line}`);
      await refreshAfterVoices(jobId);
      setTimeout(() => scriptSaving(""), 2000);
    } catch (e) {
      scriptSaving(errorText(e));
      btn.disabled = false;
    }
  }

  async function revertLine(jobId, line) {
    freshLines.delete(`${jobId}:${line}`);
    scriptSaving("Reverting…");
    await fetch(`/api/dub/jobs/${jobId}/script/${line}/revert`, { method: "POST" })
      .catch(() => null);
    scriptSaving("");
    await renderScript(jobId);
  }

  // Starting a fresh job: the table is emptied, its status line goes quiet and
  // it forgets which job it was showing. The set of lines re-spoken in this
  // sitting is keyed by job id, so it is left alone -- another job's marks
  // cannot show up under this one.
  function reset() {
    $("scriptBox").innerHTML = "";
    scriptSaving("");
    scriptJobId = null;
  }

  // How many lines are still wearing the filled "the words changed" mark. The
  // assistant's remake counts them before and after its redraw: the marks that
  // are gone are the lines it re-spoke, and there is no second way of telling.
  function countStale() {
    return $("scriptBox").querySelectorAll(".sc-wave.stale").length;
  }

  return { renderScript, refreshAfterVoices, setSaving: scriptSaving, reset,
           getJobId: () => scriptJobId, countStale };
}
