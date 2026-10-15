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

// What a tool or an engine said when it failed, as the lines under its FAILED
// line: its last `max` lines that have anything on them, each indented two
// spaces and cut at 300 characters, so a pip transcript cannot bury the log.
export function detailLines(text, max = 20) {
  return String(text ?? "").split(/\r?\n/).filter((l) => l.trim()).slice(-max).map((l) => `  ${l.slice(0, 300)}`);
}
