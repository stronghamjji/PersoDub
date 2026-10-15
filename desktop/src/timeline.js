import { readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readFileEnd } from "./fileEnd.js";
import { errorText } from "./errorText.js";

// timeline.log: the one file to read first. shell.log, the engine's
// persodub.log and every job's log in the logs folder, merged in time order.
// Each line already names its source ("shell", "persodub.jobs",
// "job-ab12cd34"), so nothing is added to it.

// The stamp a line of all three begins with (logLine.js, and the engine's
// Python logging in the same shape). Fixed width, so it sorts as text.
const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3} - /;
const STAMP_LENGTH = "2026-10-15 22:31:05,494".length;
const MAX_BYTES = 2 * 1024 * 1024;   // of each log, its end, as the failure report reads them

/**
 * texts: [{name, text}], in the order equal stamps keep. A stamped line begins
 * an entry, and the lines after it with no stamp (a traceback, a tool's
 * output) stay with it. Lines before a file's first stamp are dropped, and so
 * is all of a log in the old format, which has none.
 */
export function mergeTimeline(texts) {
  const entries = [];
  for (const { text } of texts) {
    const lines = String(text ?? "").split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();   // the file's last newline ends a line; it is not a blank one
    let entry = null;
    for (const line of lines) {
      if (STAMP.test(line)) entries.push(entry = { stamp: line.slice(0, STAMP_LENGTH), lines: [line] });
      else if (entry) entry.lines.push(line);
    }
  }
  // A stable sort: equal stamps keep the order the texts came in.
  entries.sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0));
  return entries.map((e) => e.lines.join("\n")).join("\n") + (entries.length ? "\n" : "");
}

// A folder that cannot be written is said once a run, not every five minutes.
const RECENT_JOB_MS = 7 * 24 * 60 * 60 * 1000;
let warned = false;

/** Rewrite <logDir>/timeline.log from the logs beside it. Never throws. */
export function writeTimeline(logDir, log = () => {}) {
  try {
    // Job logs pile up at one per dub; only the last week's go in, so the
    // merge stays a few dozen files however long the app has been used.
    const recent = Date.now() - RECENT_JOB_MS;
    const jobs = readdirSync(logDir).filter((f) => f.startsWith("job-") && f.endsWith(".log"))
      .filter((f) => { try { return statSync(join(logDir, f)).mtimeMs >= recent; } catch { return false; } }).sort();
    const texts = ["shell.log", "persodub.log", ...jobs].map((name) => ({ name, text: readFileEnd(join(logDir, name), MAX_BYTES) }));
    const path = join(logDir, "timeline.log");
    // Written aside and renamed into place, so a reader never meets half a file.
    writeFileSync(`${path}.tmp`, mergeTimeline(texts));
    renameSync(`${path}.tmp`, path);
  } catch (err) {
    if (!warned) log(`PERSODUB_TIMELINE not written: ${errorText(err)}`);
    warned = true;
  }
}
