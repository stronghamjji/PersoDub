import { gzipSync } from "node:zlib";

// The whole logs, not just their ends. The issue body carries 200-line tails
// (report.js) because that is what a person reads first; this is the archive
// behind them -- the three logs in full, masked, the engines' console logs
// (their last 2 MB, reporting.js), and the diagnostics of a probed failure
// (diagnostics.js), packed into one .tar.gz the relay stores and the issue
// links to.
//
// A tar rather than three uploads: the three files come back out named, which
// is the only thing that made the format worth thirty lines of header code.
// Nothing here reaches the network and nothing masks: reporting.js masks the text
// with report.js's rules before it ever gets here.

export const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;
// The uncompressed budget the three logs share before the first attempt. Text
// logs gzip at roughly ten to one, so this normally lands well inside the cap
// and the halving loop below never runs.
export const START_BUDGET_BYTES = 24 * 1024 * 1024;

/**
 * The last maxBytes of a log, cut at a line boundary, with a line on top
 * saying what was dropped. Oldest lines go first: a log's last page is the
 * one that says what happened.
 */
export function truncateLog(text, maxBytes) {
  const body = String(text ?? "");
  if (Buffer.byteLength(body, "utf8") <= maxBytes) return body;
  const lines = body.split("\n");
  // Walk back from the end, taking lines while they fit.
  let size = 0;
  let start = lines.length;
  while (start > 0) {
    const next = Buffer.byteLength(lines[start - 1], "utf8") + 1;
    if (size + next > maxBytes) break;
    size += next;
    start -= 1;
  }
  const dropped = start;
  return `[truncated ${dropped} lines]\n${lines.slice(start).join("\n")}`;
}

// --- tar (ustar), just enough of it ------------------------------------

const BLOCK = 512;

function writeField(header, offset, value, length) {
  header.write(String(value).slice(0, length - 1), offset, length - 1, "utf8");
}

function headerFor(name, size, mtime) {
  const h = Buffer.alloc(BLOCK);
  writeField(h, 0, name, 100);
  writeField(h, 100, "0000644", 8);       // mode
  writeField(h, 108, "0000000", 8);       // uid
  writeField(h, 116, "0000000", 8);       // gid
  writeField(h, 124, size.toString(8).padStart(11, "0"), 12);
  writeField(h, 136, Math.floor(mtime / 1000).toString(8).padStart(11, "0"), 12);
  h.write("        ", 148, 8, "utf8");    // checksum placeholder: eight spaces
  h.write("0", 156, 1, "utf8");           // type: a plain file
  // The ustar stamp: the magic at 257 (six bytes, the sixth a NUL the buffer
  // already has) and the version "00" right after it. Written as two fields
  // rather than one eight-byte string, so no source file here has to hold a
  // literal NUL -- one did, and git stopped showing this file as text.
  h.write("ustar", 257, 5, "utf8");
  h.write("00", 263, 2, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  // Six octal digits, then a NUL and a space -- the checksum field's own
  // layout. The NUL is written as an escape, never as a raw byte in this file.
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf8");
  return h;
}

function pad(size) {
  const rest = size % BLOCK;
  return rest === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rest);
}

/** A tar archive of {name, text} entries. Two empty blocks end it, as the
 *  format requires -- without them tar reports an unexpected end of file. */
export function tar(entries, { mtime = Date.now() } = {}) {
  const parts = [];
  for (const { name, text } of entries) {
    const data = Buffer.from(String(text ?? ""), "utf8");
    parts.push(headerFor(name, data.length, mtime), data, pad(data.length));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/**
 * The three logs as one gzipped tar, inside the size the relay accepts.
 *
 * The budget is shared equally and halved until the compressed archive fits,
 * rather than guessed from a compression ratio: a log of repeated stack traces
 * compresses fifty to one and a log of base64 hardly at all, and the only way
 * to know which one arrived is to compress it.
 */
export function buildLogArchive(logs = {}, {
  maxBytes = MAX_ARCHIVE_BYTES,
  budget = START_BUDGET_BYTES,
  mtime = Date.now(),
} = {}) {
  const named = [
    ["shell.log", logs.shell],
    ["persodub.log", logs.app],
    ["job.log", logs.job],
    ["backend.log", logs.backend],
    ["sidecar.log", logs.sidecar],
    ["ollama.log", logs.ollama],
    ["diagnostics.json", logs.diagnostics],
  ].filter(([, text]) => String(text ?? "").trim() !== "");
  if (!named.length) return null;
  let share = Math.floor(budget / named.length);
  while (share >= 1024) {
    const gz = gzipSync(tar(named.map(([name, text]) => ({ name, text: truncateLog(text, share) })), { mtime }));
    if (gz.length <= maxBytes) return gz;
    share = Math.floor(share / 2);
  }
  // Even a kilobyte apiece would not compress under the cap. Nothing is sent:
  // the issue still carries the 200-line tails, which is the part anyone reads.
  return null;
}
