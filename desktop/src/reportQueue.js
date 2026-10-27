// A report that could not be sent -- the machine was offline, the relay was
// down, the laptop lid closed mid-request -- waits in <kit>/reports and goes
// out on the next launch. The failure that matters most is the one that
// happens on a machine with no network at that moment, so "we tried once" is
// not good enough.
//
// Two files share one base name, "<key>-<milliseconds>": twelve hex
// characters and the moment of the failure. The key was the report's
// fingerprint until a failure began to be written down before its report is
// built (0.8.8); it is random now, and only keeps two names apart.
//   <base>.json     {failure, at} -- the failure alone (kind, code, step,
//                                    message, job), written before anything
//                                    is gathered: a launch that ends first
//                                    leaves it for the next to build and send;
//                                    a finished job's record (code "ok") the
//                                    same, with its timing
//                   {report, id}  -- id is null until the relay has taken it
//                   {inquiry, id} -- a Service inquiry (0.9.2), id null until
//                                    the support web app has it; its logs go
//                                    inside it, so there is no second half
//   <base>.tar.gz   the full logs, when there are any
// The pair is deleted once both halves have landed. Keeping the id in the
// json is what lets a delivered report whose LOG upload failed retry only the
// upload, instead of opening the issue a second time.
//
// Everything here is a pure function over names and clocks, so the retry rules
// can be tested without a disk, a clock or a network.

export const REPORT_EXT = ".json";
export const ARCHIVE_EXT = ".tar.gz";
// After a week a crash report is history: the app has been updated, the user
// has moved on, and nobody would act on it. It is deleted rather than kept.
export const MAX_AGE_DAYS = 7;

const NAME = /^([0-9a-f]{12})-(\d{10,16})$/;

/** The base name for one queued report. */
export function queueBase(key, at) {
  return `${key}-${at}`;
}

/** {key, at} out of a queue file's name, or null when it is not one.
 *  A stray file in the folder must never be read, sent or deleted. */
export function parseQueueName(name) {
  const file = String(name || "");
  if (!file.endsWith(REPORT_EXT)) return null;
  const m = NAME.exec(file.slice(0, -REPORT_EXT.length));
  return m ? { base: file.slice(0, -REPORT_EXT.length), key: m[1], at: Number(m[2]) } : null;
}

/**
 * What to do with the folder's contents on this launch: send what is still
 * fresh, delete what is not. Oldest first, so a backlog goes out in the order
 * it happened.
 */
export function partitionQueue(names, { now = Date.now(), maxAgeDays = MAX_AGE_DAYS } = {}) {
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  const entries = names.map(parseQueueName).filter(Boolean).sort((a, b) => a.at - b.at);
  return {
    retry: entries.filter((e) => e.at >= cutoff).map((e) => e.base),
    expired: entries.filter((e) => e.at < cutoff).map((e) => e.base),
  };
}

/**
 * What is left to do for one queued item, given what its json says.
 *  - "collect": only the failure was written down; build its report, then send.
 *  - "send":   the relay has never seen it.
 *  - "logs":   the issue exists; only the archive did not land.
 *  - "done":   nothing left -- delete the pair.
 * A file that holds neither a report nor a failure is "done" too: unreadable
 * is not a reason to keep retrying, and it is certainly not a reason to send garbage.
 */
export function pendingWork(entry, { hasArchive = false } = {}) {
  if (!entry || typeof entry !== "object") return "done";
  // An inquiry is sent whole, its logs with it, so once it has an id nothing is left.
  if (entry.inquiry) return entry.id ? "done" : "send";
  if (!entry.report) return entry.failure && typeof entry.failure === "object" ? "collect" : "done";
  if (!entry.id) return "send";
  return hasArchive ? "logs" : "done";
}
