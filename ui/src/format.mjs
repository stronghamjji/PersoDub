// The page's general-purpose formatters and escapers: clocks, file sizes,
// HTML escaping and the one place a server error is turned into a sentence.
// Pure functions only -- no DOM, no fetch -- so both inline modules in
// static/index.html (the app and the Dub Agent strip) can share the same
// copy. ui/src/format.test.mjs pins the behaviour, edge cases included.
import { t } from "./i18n.mjs";

// 00:00:10 -- hours, minutes, seconds, two digits each.
// Anything that is not a number, and anything below zero, reads as 00:00:00.
export function fmtClock(sec) {
  const t = Math.max(0, Math.floor(Number(sec) || 0));
  return [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60]
    .map((n) => String(n).padStart(2, "0")).join(":");
}

// 00:00:02.0 -- the same clock plus tenths, which is the unit the trim bar
// works in (its sliders step by 0.1 s).
export function fmtClockTenths(sec) {
  // Counted in whole tenths first: 0.3 is really 0.29999... in binary, and
  // taking the fraction apart by hand would print it as 0.2.
  const tenths = Math.round(Math.max(0, Number(sec) || 0) * 10);
  return `${fmtClock(Math.floor(tenths / 10))}.${tenths % 10}`;
}

// 00:39, 12:08, 1:02:10 -- how LONG something is (a video, the part that is
// kept, what was separated or erased): minutes and seconds with leading zeros,
// the hour in front only once there is one. Every length on screen is said
// this way; a POSITION (the player, the timeline, a script line) keeps
// fmtClock / fmtClockTenths.
export function fmtLength(sec) {
  const t = Math.max(0, Math.floor(Number(sec) || 0));
  const mm = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const ss = String(t % 60).padStart(2, "0");
  return t >= 3600 ? `${Math.floor(t / 3600)}:${mm}:${ss}` : `${mm}:${ss}`;
}

// The first card of the Dubbing, Audio and Erase tabs: which video this is
// and how much of it is kept. The one place its words are made, so changing
// the card is a change here. `cut` is "" for a video nothing was cut from.
export function videoCard({ name = "", kept = 0, total = 0 } = {}) {
  // A hair added first: 39.7 - 29.7 must not come out a whisker under 10.
  const cut = Math.floor((Number(total) || 0) - (Number(kept) || 0) + 1e-6);
  return { label: t("Video"), name: String(name || ""),
           length: Number(total) > 0 ? fmtLength(kept) : "",
           cut: cut >= 1 ? t("{length} cut", { length: fmtLength(cut) }) : "" };
}

/** That card's three lines as markup, for an element with class "video-card". */
export function videoCardHtml(info) {
  const c = videoCard(info);
  return `<div class="k">${c.label}</div>`
    + `<div class="m vc-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</div>`
    + `<div class="s vc-len">${c.length}${c.cut ? `<span class="vc-cut">${c.cut}</span>` : ""}</div>`;
}

// A file size for the upload zone: B under a kilobyte, KB under a megabyte,
// MB above that. It is only ever handed a File.size, so it trusts its input --
// a number below zero prints as it is, and a non-number ends up "NaN MB".
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// All five of &<>"' -- the quotes included, so the same call is safe both
// between tags and inside an attribute (the page interpolates it into both).
/**
 * "Downloads / 2026-09-10 / clip" out of a saved file's path: the folders
 * under Downloads, without the file. "Downloads" for a file loose in it, ""
 * for a path that is not under Downloads at all. Either kind of slash. The
 * folder is named in the page's language, the way Finder and Explorer name it;
 * in Korean as a folder (다운로드 폴더의 …), since under the Download dialog's
 * title 다운로드 / … read as the title said twice (owner, 2026-10-22).
 *
 * `picked` is the folder the Download dialog's Change picked: a file inside
 * it is named from that folder's own name the same way ("Work SSD /
 * 2026-10-22 / clip", in Korean 작업용 SSD의 …), a file loose in it by the
 * name alone.
 */
export function downloadsLabel(path, picked = "") {
  if (insideFolder(path, picked)) {
    const folders = slashed(path).slice(slashed(picked).length + 1).split("/").slice(0, -1);
    return folders.length ? t("{folder} / {folders}", { folder: folderName(picked), folders: folders.join(" / ") })
      : folderName(picked);
  }
  const parts = String(path || "").split(/[\\/]+/);
  const i = parts.indexOf("Downloads");
  if (i < 0) return "";
  const folders = parts.slice(i + 1, -1);
  return folders.length ? t("Downloads / {folders}", { folders: folders.join(" / ") }) : t("Downloads");
}

// A path written with one kind of slash and none at its end, so two can be compared.
const slashed = (path) => String(path || "").replace(/[\\/]+/g, "/").replace(/\/$/, "");

/** Is `path` inside `folder`? Compared as written, either kind of slash. */
export function insideFolder(path, folder) {
  const top = slashed(folder);
  return top !== "" && slashed(path).startsWith(`${top}/`);
}

/** A folder's own name: the last part of its path ("D:" for a whole drive). */
export function folderName(path) {
  return slashed(path).split("/").pop();
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// What a request says when it never reached the app at all: the browser's own
// words for it ("Failed to fetch" in the desktop shell, the other two in
// Safari and Firefox, "network error" for an answer cut off halfway). None of
// them tells a person what to do, so the screen says this instead, in the
// page's language.
const notRunning = () => t("The connection to {app} dropped for a moment. If it stays this way, quit and reopen {app}.");
const NETWORK_FAILURE = /^(TypeError: )?(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?|network error)$/i;
// An answer the screen has no sentence for: a list of field errors, or a page
// of HTML where a sentence was expected.
const noSentence = () => t("Something went wrong in {app}. Try again, and if it happens again, quit and reopen {app}.");

// Server errors arrive as the raw response body, so a FastAPI detail shows up
// as JSON unless it is unwrapped here. Every error line on screen goes through
// errorText, so nobody is shown the browser's or the server's raw words.
//
// serverText is the sentence as the server sent it, for the code that knows a
// refusal by its words ("Select a Perso workspace", "ChatGPT sign-in"): the
// engine keeps those few in English on purpose (app/api/_launch.py,
// app/engines_status.py, app/api/separate.py, app/api/script.py), and
// errorText says them in the page's language, from keys added to
// static/i18n/ui.*.json by hand. Any other sentence the engine already said
// in the user's language has no entry and reads as it came.
export function serverText(e) {
  const raw = String((e && e.message) || e || "").trim();
  if (NETWORK_FAILURE.test(raw)) return notRunning();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.detail) {
      // A sentence (or a bare number) is shown as it is; FastAPI's own list of
      // field errors is for a programmer, not for the screen.
      return typeof parsed.detail === "object" ? noSentence() : String(parsed.detail);
    }
  } catch { /* not JSON, use it as it is */ }
  if (/^<(!doctype|html)/i.test(raw)) return noSentence();
  return raw;
}

export function errorText(e) {
  return t(serverText(e));
}

// The top bar's status, cut where it is joined: "Done · Fast mode · Whisper".
// Two or more parts are drawn as chips (ui/src/app.mjs setTopbar); a single
// part stays the plain label it always was.
export function statusParts(subtitle) {
  return String(subtitle ?? "").split(" · ").map((s) => s.trim()).filter(Boolean);
}

/** The key a shortcut tip names: Cmd on a Mac, Ctrl on Windows and Linux. */
export function modKey(platform = (globalThis.navigator || {}).platform || "") {
  return /mac|iphone|ipad/i.test(platform) ? "Cmd" : "Ctrl";
}

// What a program says when it breaks, as opposed to what a person would say:
// an exception's name, a path, a file and line, a status code, code punctuation.
// A ">" with a space on both sides is a person's: "Settings > Models".
const RAW_TEXT = /Traceback|\b\w*(Error|Exception)\b|Errno|\.py\b|\bline \d+|0x[0-9a-f]+|HTTP \d|exit(ed)? (code|status)|[{}\[\]<_=\\]|\S>|>\S|\/\w+\//;

/**
 * The plain sentence in a failure's text, for the screen: "" when there is
 * none. A reason the server wrote as "What happened (the program's own last
 * line)" or "What happened: the program's words" keeps only what happened;
 * text that is a program's through and through gives "", and the caller says
 * its own sentence. The whole text belongs in Raw log either way (rawLogLines).
 */
export function plainFailure(text) {
  const all = String(text ?? "").trim();
  let head = all.replace(/\s*\([^]*\)\.?$/, "");
  const colon = head.indexOf(": ");
  if (colon > 0) head = head.slice(0, colon);
  head = head.trim();
  // A letter first: English, or Korean when the engine speaks it (app/i18n.py).
  if (!head || head.length > 140 || !/^[A-Za-z가-힣]/.test(head) || !head.includes(" ") || RAW_TEXT.test(head)) return "";
  head = head[0].toUpperCase() + head.slice(1);
  return /[.!?]$/.test(head) ? head : head + ".";
}

/**
 * Why the voice engine did not come back when the page asked the desktop app
 * to start it again (persodubShell.installPack's reason), as one plain line.
 * The reason is the shell's: a sentence of its own (no room, no Visual C++),
 * or "Installed, but it could not start: <the engine's own last line>", whose
 * second half is a program's and stays in shell.log. The memory words are the
 * shell's own list (desktop/src/orchestrator.js OUT_OF_MEMORY).
 */
export function restartFailure(reason) {
  const text = String(reason ?? "").trim();
  if (restartRanOutOfMemory(text)) {
    return t("Starting it again did not work because there is still not enough memory. Close more programs or restart your computer. Dubbing with the Perso API uses almost no memory.");
  }
  if (/timed out/i.test(text)) return t("Starting it again did not work: it took too long to start.");
  const plain = plainFailure(text);
  return plain && plain === text ? `${t("Starting it again did not work.")} ${plain}` : t("Starting it again did not work.");
}

/** Whether restartFailure's reason is the memory running out: its line then
 * says all of it, what to close and the Perso API, and is said on its own. */
export function restartRanOutOfMemory(reason) {
  return /os error 1455|paging file|out of memory|not enough memory|MemoryError|DefaultCPUAllocator/i.test(String(reason ?? ""));
}

/** A job's log lines for Raw log, with its failure text added at the end when
    the screen did not show it whole and the log does not hold it already. */
export function rawLogLines(logs, error) {
  const lines = [...(logs || [])];
  const raw = String(error ?? "").trim();
  if (raw && raw.includes(" ") && plainFailure(raw) !== raw && !lines.some((l) => l.includes(raw))) lines.push(raw);
  return lines;
}
