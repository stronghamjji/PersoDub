// The Export dialog, called Download on screen (owner, 2026-10-22; the ids
// and names in the code kept "export"): the one way to save anything out of
// a project. Download, at the right end of the video panel's tab row, opens
// it on whatever is on screen, and its rows are what that has to hand back:
//
//   a draft            Video (the kept parts joined), Audio only
//   a finished dubbing under three headings (owner, 2026-10-22): Video --
//                      Dubbed video, Dubbed video with subtitles, Original
//                      video; Subtitles & script -- Subtitles (.srt), Script
//                      (.xlsx); Audio -- Dubbed audio, Original voice,
//                      Background -- each only when there is one
//   an erased video    Video, Audio only
//   a video and its    Video with subtitles (the look picked burned in),
//   own subtitles      Subtitles (.srt) -- a Burn in subtitles project
//
// Every row has a checkbox; the foot's Download saves each ticked row in turn
// (owner, 2026-09-30). The ticks are remembered for each of the three kinds,
// and the first row is ticked until the user says otherwise. A saved row shows
// a check at its right end and the line under the rows says where it went.
//
// Before a save that line says where the files go, and in the desktop shell
// it ends in Change, which opens the computer's own folder picker, and Use
// default once a folder is picked (owner, 2026-10-22). The shell keeps the
// folder for every download after it, and the app's own saves go there too.
//
// A dubbing's rows are links the browser (or the desktop shell) downloads; a
// draft's and an erased video's are written by the app itself into Downloads.
// Every sound row carries the MP3 / WAV switch, one pick for all of them,
// remembered.
//
// A finished dubbing has three sounds, so none of them is called "Audio only"
// there: Dubbed audio is the new voices over the background, Original voice is
// the speech the separation stage took out of the source video, Background is
// what was left of it (music and effects).
//
// Every row that is the project's video is written in the shape the player's
// Ratio button is on (ui/src/ratio.mjs, app/ratio.py): black around the
// picture, as the player shows it. The sound, the subtitles file and the
// original video are what they are, whatever the ratio.
//
// The elements this file touches: #exportOverlay, #exportList, #exportWhere,
// #exportFolder (Change, #exportFolderPick, and Use default, #exportFolderReset
// in #exportFolderResetWrap), #exportCloseX, #exportCloseBtn (Cancel),
// #exportGoBtn (Download).
import { downloadsLabel, escapeHtml, errorText, folderName } from "./format.mjs";
import { withRatio } from "./ratio.mjs";
import { t } from "./i18n.mjs";

export const AUDIO_KEY = "persodub.exportAudio";
export const TICKS_KEY = "persodub.exportTicks";

/** "mp3" unless what was remembered is "wav". */
export function audioFormat(stored) {
  return stored === "wav" ? "wav" : "mp3";
}

/**
 * The rows ticked when the dialog opens: the ones remembered for this kind
 * that are here now, or the first row when nothing was remembered (or none of
 * it is here). Remembered as nothing ticked stays nothing ticked.
 *
 * @param {string|null} stored  the TICKS_KEY value: {"dub": ["video", ...], ...}
 * @param {string} kind
 * @param {string[]} ids  the rows on screen, in order
 * @returns {string[]}
 */
export function ticksFor(stored, kind, ids) {
  const fresh = ids.slice(0, 1);
  let kept = null;
  try { kept = (JSON.parse(stored || "{}") || {})[kind]; } catch { /* not ours */ }
  if (!Array.isArray(kept)) return fresh;
  const here = ids.filter((id) => kept.includes(id));
  return here.length || !kept.length ? here : fresh;
}

const svg = (body, cls = "icon") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
// What the row hands over, drawn beside its checkbox: a strip of film for a
// video, a captioned frame for the subtitles, sound for audio.
const ICONS = {
  film: svg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>'),
  subs: svg('<rect width="18" height="14" x="3" y="5" rx="2" ry="2"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/>'),
  audio: svg('<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>'),
};
const CHECK = '<path d="M5 12l5 5 9-10"/>';
const SAVED_ICON = svg(CHECK, "icon icon-sm");
// What the two separated sounds are, on the "?" beside each (owner,
// 2026-10-09): the words are the dubbing trade's, where "background" is the
// M&E track, not a music app's "instrumental".
// Getters, so a tip is read in the page's language when the row is made.
const STEM_TIPS = {
  get voice() { return t("Only the speech."); },
  get background() { return t("Everything except speech: music, effects, noise."); },
};
// The headings a dubbing's rows stand under (owner, 2026-10-22): as one list
// of seven the subtitles file was the sixth row, and people did not find it.
// The script's spreadsheet stands beside the subtitles file, and the heading
// names both.
const GROUPS = {
  get video() { return t("Video"); },
  get subtitles() { return t("Subtitles & script"); },
  get audio() { return t("Audio"); },
};

/**
 * The rows for what is on screen.
 *
 * @param {object} ctx
 * @param {"draft"|"dub"|"erase"|"captions"} ctx.kind
 * @param {string} [ctx.jobId]      a dub or a burn-in project: the job
 * @param {string} [ctx.target]     a dub: its language code, in the file names
 * @param {string} [ctx.videoHref]  a dub: the URL the player is on
 * @param {string} [ctx.mark]       a dub: "&v=3" after a remake, so a download
 *        is never the old video out of the browser's cache
 * @param {{href: string, name: string}|null} [ctx.subtitled]  a dub with
 *        subtitles: the subtitled video in the look the player shows
 * @param {boolean} [ctx.hasSrt]
 * @param {boolean} [ctx.hasScript]  a dub: whether it has a script, handed back
 *        as the spreadsheet Perso's web app downloads
 * @param {string} [ctx.title]    a dub: the project's name as the screens show it
 * @param {string} [ctx.source]   a dub: its original's language code, when known
 * @param {{voice?: boolean, background?: boolean}} [ctx.stems]  a dub: which of
 *        the original's two separated sounds the job still has
 * @param {string} [ctx.project]   a dub: the project's folder name, in the
 *        names of those two files
 * @param {boolean} [ctx.fromLink]  only a link job has an original to hand back
 *        -- unless the dialog was opened for it (Save video, ctx.only)
 * @param {string[]} [ctx.only]  the rows asked for, the rest left out
 * @param {string} [ctx.ratio]     the shape the player shows the project in:
 *        "original" (or nothing) or "9:16", "16:9", "1:1", "4:5"
 * @param {"mp3"|"wav"} fmt
 * @returns {Array<{id: string, icon: string, label: string, href?: string,
 *   name?: string, audio?: boolean, group?: string}>}  a row with an href is
 *   downloaded; one without is saved by the app (ctx.save). A dubbing's rows
 *   carry the heading they stand under (GROUPS), in that order.
 */
export function exportRows(ctx, fmt) {
  const all = allRows(ctx, fmt);
  return ctx.only ? all.filter((r) => ctx.only.includes(r.id)) : all;
}
function allRows(ctx, fmt) {
  const audio = { id: "audio", icon: "audio", label: t("Audio only"), audio: true };
  // The original video, asked for by name (Save video): served whatever the
  // project came from, where a link's alone is offered among the rest.
  const original = (ctx.only || []).includes("original");
  if (ctx.kind === "captions") {
    return [{ id: "subtitled", icon: "film", label: t("Video with subtitles"),
              href: withRatio(ctx.subtitled.href, ctx.ratio), name: ctx.subtitled.name },
            { id: "srt", icon: "subs", label: t("Subtitles (.srt)"),
              href: `/api/dub/result/${ctx.jobId}/srt?download=1`, name: "video.srt" },
            original && { id: "original", icon: "film", label: t("Original video"),
                          href: `/api/dub/result/${ctx.jobId}/original`, name: "org.mp4" }].filter(Boolean);
  }
  if (ctx.kind !== "dub") {
    return [{ id: "video", icon: "film", label: t("Video") }, audio];
  }
  const base = `/api/dub/result/${ctx.jobId}`;
  const mark = ctx.mark || "";
  return [
    { id: "video", group: "video", icon: "film", label: t("Dubbed video"),
      href: withRatio(ctx.videoHref, ctx.ratio), name: `dub_${ctx.target}.mp4` },
    // There whenever the project has subtitles (owner, 2026-09-30).
    ctx.hasSrt && ctx.subtitled && { id: "subtitled", group: "video", icon: "film", label: t("Dubbed video with subtitles"),
                                     href: withRatio(ctx.subtitled.href, ctx.ratio),
                                     name: ctx.subtitled.name },
    // A local file is already on the machine it would be saved to.
    (ctx.fromLink || original) && { id: "original", group: "video", icon: "film", label: t("Original video"),
                                    href: `${base}/original${ctx.fromLink ? "?download=1" : ""}`, name: "org.mp4" },
    ctx.hasSrt && { id: "srt", group: "subtitles", icon: "subs", label: t("Subtitles (.srt)"),
                    href: `${base}/srt?download=1`, name: `dub_${ctx.target}.srt` },
    // Perso's own name for the file. The route sends the same name, with what
    // a file name cannot hold swapped (app/api/script.py), and that names the
    // saved file.
    ctx.hasScript && { id: "script", group: "subtitles", icon: "subs", label: t("Script (original + translation, .xlsx)"),
                       href: `/api/dub/jobs/${ctx.jobId}/script.xlsx`,
                       name: `${ctx.title}_${(ctx.source || "auto").toUpperCase()}to${ctx.target.toUpperCase()}`
                         + "_OriginalTranslatedScript.xlsx" },
    { ...audio, group: "audio", label: t("Dubbed audio"),
      href: `${base}/audio?format=${fmt}&download=1${mark}`, name: `dub_${ctx.target}.${fmt}` },
    ...[["voice", t("Original voice")], ["background", t("Background")]].map(([which, label]) =>
      (ctx.stems || {})[which] && { id: which, group: "audio", icon: "audio", label, audio: true, tip: STEM_TIPS[which],
                                    href: `${base}/stem/${which}?format=${fmt}`,
                                    name: `${ctx.project || "project"}_${which}.${fmt}` }),
  ].filter(Boolean);
}

/**
 * The rows as the dialog draws them: a checkbox, the icon, the name, a "?"
 * with what the file is on a row that has a tip (the two separated sounds),
 * the MP3 / WAV switch on a sound row, and the place the saved check appears.
 * A row that starts a group has its heading over it.
 *
 * @param {Array} rows   exportRows' answer
 * @param {"mp3"|"wav"} fmt
 * @param {string[]} [ticked]  ids of the ticked rows
 * @param {string[]} [saved]   ids of the rows saved since the dialog opened
 */
export function rowsHtml(rows, fmt, ticked = [], saved = []) {
  const seg = `<span class="export-seg" role="radiogroup" aria-label="${t("Audio format")}">`
    + ["mp3", "wav"].map((f) => `<span role="radio" tabindex="0" data-fmt="${f}" aria-checked="${f === fmt}"`
      + `${f === fmt ? ' class="on"' : ""}>${f.toUpperCase()}</span>`).join("") + "</span>";
  return rows.map((r, i) => {
    const done = saved.includes(r.id);
    const head = r.group && r.group !== rows[i - 1]?.group
      ? `<div class="export-group">${escapeHtml(GROUPS[r.group])}</div>` : "";
    return `${head}<a href="#" role="checkbox" aria-checked="${ticked.includes(r.id)}" data-row="${r.id}"`
      + `${r.name ? ` data-name="${escapeHtml(r.name)}"` : ""}${done ? ' class="saved"' : ""}>`
      + `<span class="export-check">${svg(CHECK, "icon")}</span>`
      + `${ICONS[r.icon]}${escapeHtml(r.label)}`
      // The same hover-or-focus tip the timeline's tools carry ([data-tip]).
      + (r.tip ? `<span class="export-help" data-tip="${escapeHtml(r.tip)}" tabindex="0" role="img" aria-label="${escapeHtml(r.tip)}">?</span>` : "")
      + `${r.audio ? seg : ""}`
      + `<span class="export-state">${done ? SAVED_ICON : ""}</span></a>`;
  }).join("");
}

/**
 * The line under the rows before a save, in the desktop shell: where the files
 * go. A folder picked with Change is named by its own name, with a dubbing's
 * dated folder under it, the way `ctx.where` names Downloads. A picked folder
 * that is gone (a drive taken out) is said once, ahead of that Downloads line:
 * the files go there instead.
 *
 * @param {{where?: string, day?: string, project?: string}} ctx  the dialog's
 *        context: the Downloads line, and a dubbing's day and project
 * @param {{chosen: string, missing: boolean}} folder  the shell's answer
 */
export function whereLine(ctx, { chosen, missing }) {
  if (!chosen) return ctx.where || "";
  const name = folderName(chosen);
  if (missing) return `${t("Cannot find {folder}.", { folder: name })} ${ctx.where || ""}`.trim();
  return ctx.day && ctx.project
    ? t("Saved in {folder} / {day} / {project}", { folder: name, day: ctx.day, project: ctx.project })
    : t("Saved in {folder}", { folder: name });
}

/** "clip.mp3" out of a path with either kind of slash. */
function baseName(path) {
  return String(path || "").split(/[\\/]+/).pop();
}

// The browser's own way of saving a link: a link with `download`, clicked.
function followLink(href, name) {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.hidden = true;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * @param {object} deps
 * @param {(id: string) => any} deps.$
 * @param {() => Promise<object|null>} deps.getContext  what is on screen, as
 *        exportRows reads it, plus `where` (the line under the rows, naming
 *        Downloads), for a dubbing `day` (its files' dated folder, with
 *        `project`) and, for a draft or an erased video,
 *        `save({audio} | {ratio}) => Promise<path>`; null when there is
 *        nothing to export
 * @param {{getItem: Function, setItem: Function}} [deps.storage]
 * @param {object} [deps.shell]  the desktop shell (window.persodubShell): it
 *        saves a link without a word, then reports the file it wrote; and it
 *        keeps the folder downloads go into (downloadFolder, pickDownloadFolder,
 *        resetDownloadFolder, each answering {folder, chosen, missing})
 * @param {(href: string, init?: object) => Promise<Response>} [deps.fetchFn]
 * @param {(href: string, name: string) => void} [deps.follow]  hand a link to
 *        the browser to download
 * @returns {{ open: (tick?: string[], only?: string[]) => Promise<void>, close: () => void }}
 */
export function initExportDialog({ $, getContext, storage = null, shell = null,
                                   fetchFn = (...a) => fetch(...a), follow = followLink }) {
  const list = $("exportList");
  const where = $("exportWhere");
  const go = $("exportGoBtn");
  let ctx = null;
  let fmt = "mp3";
  try { fmt = audioFormat(storage && storage.getItem(AUDIO_KEY)); } catch { /* private window */ }
  let ticked = [];
  let saved = [];
  let saving = false;
  // The shell's report of the download the Export button is waiting on.
  let landed = null;
  // Where the files go, as the shell said it ({folder, chosen, missing}):
  // asked each time the dialog opens and after each save, since a drive can be
  // taken out in between. Null in a browser, which saves where it is set to.
  let folder = null;

  const rows = () => exportRows(ctx, fmt);
  const whereText = () => (folder ? whereLine(ctx, folder) : ctx.where || "");
  function paint() {
    list.innerHTML = rowsHtml(rows(), fmt, ticked, saved);
    go.disabled = saving || !ticked.length;
    $("exportCloseBtn").disabled = saving;
    // Change, and Use default once a folder is picked; not while files go out.
    $("exportFolder").hidden = saving || !folder;
    $("exportFolderResetWrap").hidden = !(folder && folder.chosen);
  }

  function pickFormat(f) {
    if (saving) return;
    fmt = audioFormat(f);
    try { if (storage) storage.setItem(AUDIO_KEY, fmt); } catch { /* private window */ }
    // A sound row saved as the other format is not saved as this one.
    saved = saved.filter((id) => !rows().find((r) => r.id === id).audio);
    paint();
  }

  function toggle(id) {
    if (saving) return;
    // Kept in the rows' order: that is the order they are saved in.
    ticked = rows().map((r) => r.id).filter((r) => (r === id) !== ticked.includes(r));
    try {
      // A dialog cut down to some rows remembers nothing for the whole one.
      if (storage && !ctx.only) {
        let all = {};
        try { all = JSON.parse(storage.getItem(TICKS_KEY) || "{}") || {}; } catch { /* not ours */ }
        storage.setItem(TICKS_KEY, JSON.stringify({ ...all, [ctx.kind]: ticked }));
      }
    } catch { /* private window */ }
    paint();
  }

  // One row out. A draft's or an erased video's: the app writes the file and
  // answers with its path. A dubbing's: the file is asked for first, so it is
  // made (a subtitled video, an mp3) before the download starts and a refusal
  // is read here as words; then the link is handed over, and in the desktop
  // shell its report is waited for. Returns the path when one is known.
  async function saveOne(row) {
    if (!row.href) {
      // The video goes out in the project's ratio; the sound has no picture.
      return ctx.save(row.audio ? { audio: fmt } : ctx.ratio ? { ratio: ctx.ratio } : {});
    }
    const stop = new AbortController();
    const r = await fetchFn(row.href, { signal: stop.signal });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.detail || t("Could not download this file"));
    }
    stop.abort();   // it is there; the download itself reads it
    const report = shell && shell.onDownloadDone
      ? new Promise((resolve) => { landed = resolve; }) : null;
    follow(row.href, row.name);
    if (!report) return "";
    const info = await report;
    if (!info || info.state !== "completed") throw new Error(t("Download failed - try again"));
    return info.path;
  }

  async function exportTicked() {
    if (saving || !ticked.length) return;
    saving = true;
    const todo = rows().filter((r) => ticked.includes(r.id));
    saved = saved.filter((id) => !ticked.includes(id));
    paint();
    let last = "";
    try {
      for (const [i, row] of todo.entries()) {
        where.textContent = t("Downloading {i} of {n}…", { i: i + 1, n: todo.length });
        last = await saveOne(row);
        saved.push(row.id);
        paint();
      }
      // Asked again: the files went wherever the folder was just now.
      if (folder) folder = await shell.downloadFolder().catch(() => folder);
      const label = downloadsLabel(last, folder ? folder.chosen : "") || t("Downloads");
      const said = !last ? whereText()
        : todo.length > 1 ? t("Saved {n} files to {folder}", { n: todo.length, folder: label })
        : t("Saved {name} to {folder}", { name: baseName(last), folder: label });
      // A picked folder that was gone is said once, ahead of where the files went.
      where.textContent = last && folder && folder.missing
        ? `${t("Cannot find {folder}.", { folder: folderName(folder.chosen) })} ${said}` : said;
    } catch (e) {
      where.textContent = errorText(e);
    } finally {
      saving = false;
      landed = null;
      paint();
    }
  }

  list.addEventListener("click", (e) => {
    const f = e.target.closest("[data-fmt]");
    if (f) { e.preventDefault(); pickFormat(f.dataset.fmt); return; }
    const a = e.target.closest("a");
    if (!a) return;
    e.preventDefault();
    toggle(a.dataset.row);
  });
  list.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const f = e.target.closest("[data-fmt]");
    if (f) { e.preventDefault(); pickFormat(f.dataset.fmt); return; }
    // Enter already clicks a link; Space is how a checkbox is ticked.
    const a = e.key === " " && e.target.closest("a");
    if (a) { e.preventDefault(); toggle(a.dataset.row); }
  });
  go.addEventListener("click", exportTicked);

  // Change: the computer's own folder picker, through the shell, which keeps
  // the folder for this download and every one after it. Use default: back to
  // Downloads. Either way the line says the new place at once.
  async function changeFolder(ask) {
    if (saving || !folder) return;
    folder = await ask().catch(() => folder);
    where.textContent = whereText();
    paint();
  }
  $("exportFolderPick").addEventListener("click", () => changeFolder(() => shell.pickDownloadFolder()));
  $("exportFolderReset").addEventListener("click", () => changeFolder(() => shell.resetDownloadFolder()));

  if (shell && shell.onDownloadDone) shell.onDownloadDone((info) => {
    if (landed) { const tell = landed; landed = null; tell(info); }
  });

  // Not while it is working: the files still to come would be left unsaid.
  function close() { if (!saving) $("exportOverlay").classList.remove("open"); }
  $("exportCloseX").addEventListener("click", close);
  $("exportCloseBtn").addEventListener("click", close);
  // The backdrop, the same way out the other dialogs give.
  $("exportOverlay").addEventListener("click", (e) => {
    if (e.target === $("exportOverlay")) close();
  });

  // `tick`: the rows to tick this time in place of the remembered ones (Save
  // video's own opening ticks Video), remembering nothing. `only`: the rows
  // to offer, the rest left out (the Save video tab's original).
  async function open(tick = null, only = null) {
    const next = await getContext();
    if (!next) return;
    ctx = only ? { ...next, only } : next;
    folder = shell && shell.downloadFolder ? await shell.downloadFolder().catch(() => null) : null;
    saved = [];
    let kept = null;
    try { kept = storage && storage.getItem(TICKS_KEY); } catch { /* private window */ }
    const ids = rows().map((r) => r.id);
    ticked = tick ? ids.filter((id) => tick.includes(id)) : ticksFor(kept, ctx.kind, ids);
    paint();
    where.textContent = whereText();
    $("exportOverlay").classList.add("open");
  }

  return { open, close };
}
