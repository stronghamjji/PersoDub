// Step runner: skips steps whose isDone() is already true (resume), streams
// progress events, and verifies each step actually produced its artifacts.
// A network error that passes on its own (Hugging Face resetting a download,
// GitHub's file host answering 503 "Backend is unhealthy", issues #89 #92)
// gets the step tried again after these waits; anything else fails at once.
// stop() is true once the person cancelled: the killed process's last lines
// can read like a network error, and a cancel must not come back as a retry.
const RETRY_DELAYS_MS = [5000, 20000];
const SERVER_BUSY = /\b50[0-4] Server Error|HTTP Error 50[0-4]|download failed 50[0-4]\b/;
export function worthRetrying(message) {
  return downloadInterrupted(message) || SERVER_BUSY.test(String(message || ""));
}

export async function runInstall(steps, {
  onProgress = () => {}, stop = () => false, retryDelaysMs = RETRY_DELAYS_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  for (const step of steps) {
    // bytes rides along on every event -- the screen adds it up as steps
    // finish, to show how much of the total it has received.
    if (await step.isDone()) {
      onProgress({ stepId: step.id, title: step.title, state: "skipped", bytes: step.bytes });
      continue;
    }
    onProgress({ stepId: step.id, title: step.title, state: "start", bytes: step.bytes });
    for (let attempt = 1; ; attempt++) {
      try {
        await step.run((pct, detail) => {
          onProgress({ stepId: step.id, title: step.title, state: "progress", pct, detail, bytes: step.bytes });
        });
        // verify:false is for steps whose work is housekeeping, not an
        // artifact: cleanup deletes leftovers, and a file Windows will not
        // release must leave the kit tidy-ish, never fail an install.
        if (step.verify !== false && !(await step.isDone())) {
          throw new Error(`step "${step.id}" ran but did not complete its artifacts`);
        }
        break;
      } catch (err) {
        const detail = String((err && err.message) || err);
        const retry = attempt <= retryDelaysMs.length && worthRetrying(detail) && !stop();
        if (retry) {
          onProgress({ stepId: step.id, title: step.title, state: "progress", pct: null, detail: `Connection problem, retrying (${attempt + 1}/${retryDelaysMs.length + 1})`, bytes: step.bytes });
          await sleep(retryDelaysMs[attempt - 1]);
        }
        // A cancel during the wait ends it here too, not with one more try.
        if (!retry || stop()) {
          onProgress({ stepId: step.id, title: step.title, state: "error", detail, bytes: step.bytes });
          throw err;
        }
      }
    }
    onProgress({ stepId: step.id, title: step.title, state: "done", bytes: step.bytes });
  }
}

// The steps a kit still has to run -- not counting housekeeping steps
// (verify:false), whose leftovers must never reopen the installer on every
// launch. Boot asks this even when checkKit passes: that check sees files and
// a version, not whether the step that produces them finished.
// The whole pack's percent from its steps' sizes: steps already done count in
// full, the running one by its own percent (a pip install reports none, so
// it counts as 0 until it finishes -- the percent still moves from step to
// step). This is the number the page shows for a pack, the way it shows a
// model's, because "Downloading AI engine…" with no figure read as stuck.
// A pack step's failure text as the dialog should show it. A download that
// broke mid-way (Hugging Face reset it twice on a slow office line,
// 2026-09-08) surfaced as a Python exception with byte counts; the person
// only needs to know that pressing Download and Start resumes it. Anything
// else keeps the tool's own last line (main.js lastReason).
export const DOWNLOAD_INTERRUPTED = "The download was interrupted. Click Download and Start to pick up where it left off.";
const NETWORK_MARKS = /IncompleteRead|ChunkedEncodingError|Connection broken|ConnectionResetError|ConnectionError|ReadTimeout|timed out|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|getaddrinfo|Network is unreachable|RemoteDisconnected|ProtocolError|Max retries exceeded/;
export function downloadInterrupted(message) {
  return NETWORK_MARKS.test(String(message || ""));
}

export function packPercent(steps, doneIds, currentId, currentPct) {
  const total = steps.reduce((n, s) => n + (s.bytes || 0), 0);
  if (!total) return null;
  let got = 0;
  for (const s of steps) {
    if (doneIds.has(s.id)) got += s.bytes || 0;
    else if (s.id === currentId && currentPct != null) got += (s.bytes || 0) * (currentPct / 100);
  }
  return Math.min(100, Math.round((100 * got) / total));
}

export async function openSteps(steps) {
  const open = [];
  for (const step of steps) {
    if (step.verify === false) continue;
    if (!(await step.isDone())) open.push(step);
  }
  return open;
}
