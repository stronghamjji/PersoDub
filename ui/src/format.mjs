// The page's general-purpose formatters and escapers: clocks, file sizes,
// HTML escaping and the one place a server error is turned into a sentence.
// Pure functions only -- no DOM, no fetch -- so both inline modules in
// static/index.html (the app and the Dub Agent strip) can share the same
// copy. ui/src/format.test.mjs pins the behaviour, edge cases included.

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
 * for a path that is not under Downloads at all. Either kind of slash.
 */
export function downloadsLabel(path) {
  const parts = String(path || "").split(/[\\/]+/);
  const i = parts.indexOf("Downloads");
  if (i < 0) return "";
  return ["Downloads", ...parts.slice(i + 1, -1)].join(" / ");
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Server errors arrive as the raw response body, so a FastAPI detail shows up
// as JSON unless it is unwrapped here.
export function errorText(e) {
  const raw = String((e && e.message) || e || "");
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.detail) return String(parsed.detail);
  } catch { /* not JSON, use it as it is */ }
  return raw;
}
