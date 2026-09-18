/** Has this job already been counted and reported?
 *
 * The screen draws a finished job every time it is opened -- from the list,
 * from the back arrow, as the last screen restored at launch -- and each draw
 * sent the shell another count and another failure report. Nine pairs of
 * duplicate GitHub issues came of it, and the second of each pair was empty:
 * a job's log is deliberately not saved to disk (app/jobs.py SAVED_FIELDS), so
 * a job reopened after a restart has nothing left to send, and a blank message
 * fingerprints differently from the real one, so the relay files it as a
 * failure nobody had seen before (2026-09-18).
 *
 * The shell keeps its own guard for the life of the app; this one is what
 * survives a restart, which is the case that produced the empty reports.
 *
 * Storage is per-viewer and may be missing or refuse to write (a private
 * window, cleared site data). Every read and write is guarded, and a store
 * that is not there means "not counted yet" -- the same behaviour the app had
 * before, one report per draw, which is the safe direction to fail in: a
 * duplicate is noise, a silent loss is a failure nobody hears about.
 */
const KEY = "persodub.countedJobs";
// Enough for a long-lived install's recent history without letting one key
// grow without bound; the oldest ids fall off the front.
const MAX = 400;

function read() {
  try {
    const raw = window.localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function write(list) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX)));
  } catch {
    /* a store that will not take it changes nothing */
  }
}

/** True when this job was counted before. Marks it as counted when it was not.
 *
 * A job without an id is never remembered -- there is nothing to remember it
 * by -- and answers false, so it still gets counted exactly as it did before.
 */
export function countedOnce(jobId) {
  if (!jobId || typeof jobId !== "string") return false;
  const list = read();
  if (list.includes(jobId)) return true;
  list.push(jobId);
  write(list);
  return false;
}

/** Test seam: forget everything this has remembered. */
export function forgetCounted() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to forget */
  }
}
