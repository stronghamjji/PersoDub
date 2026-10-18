import { homedir } from "node:os";

// One line of shell.log: "2026-10-15 22:31:05,494 - shell - INFO - PERSODUB_VERSION 0.8.5".
// The time is the computer's own, in Python logging's asctime shape -- the one
// the backend's persodub.log is stamped with -- so the two logs read side by
// side.
const pad = (n, width = 2) => String(n).padStart(width, "0");

export function logLine(source, level, message, now = new Date()) {
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())},${pad(now.getMilliseconds(), 3)}`;
  return `${day} ${time} - ${source} - ${level} - ${message}`;
}

// The line above every step or engine that starts, so each start stands out
// in a long log.
export const BANNER = "#".repeat(30);

// Seconds since `from` (a Date.now()), to one decimal: the "(12.3s)" of a
// DONE or READY line.
export function secondsSince(from, now = Date.now()) {
  return ((now - from) / 1000).toFixed(1);
}

// A size as a DOWNLOAD line writes it: "1.2 kB", "94 kB", "17.2 MB", "1.3 GB".
// pip's own format (decimal units) with gigabytes added, so the sizes the
// lines copy out of pip's output read the same as the ones measured here.
export function sizeText(bytes) {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes > 1e4) return `${Math.floor(bytes / 1e3)} kB`;
  if (bytes > 1e3) return `${(bytes / 1e3).toFixed(1)} kB`;
  return `${bytes} B`;
}

// Every web address in a text, as a DOWNLOAD line writes it: whole, but for a
// query string, which becomes "?…" because a signed link carries its token
// there, and a user:password before the host. Paths stay whole: the failure
// report masks the home folder when it leaves (report.js).
export function urlText(text) {
  return String(text ?? "")
    .replace(/\b(https?:\/\/)[^\s/@?#"']+@/g, "$1…@")
    .replace(/(\bhttps?:\/\/[^\s?"'<>)\]}]*)\?[^\s"'<>)\]}]*/g, "$1?…");
}

// What a tool or an engine said when it failed, as the lines under its FAILED
// line: its last `max` lines that have anything on them, each indented two
// spaces and cut at 300 characters, so a pip transcript cannot bury the log.
export function detailLines(text, max = 20) {
  return String(text ?? "").split(/\r?\n/).filter((l) => l.trim()).slice(-max).map((l) => `  ${l.slice(0, 300)}`);
}

// The home folder in a text as "~", the way an update's FILE line writes the
// file it saved: the folder carries the computer's user name, which a log line
// has no need of. Only a whole folder name matches (/Users/kim, not
// /Users/kimberly), in any case, as the Mac and Windows disks read names.
export function homeText(text, home = homedir()) {
  const s = String(text ?? "");
  if (!home) return s;
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return s.replace(new RegExp(`${escaped}(?=[\\\\/]|$|[^\\w.-])`, "gi"), "~");
}
