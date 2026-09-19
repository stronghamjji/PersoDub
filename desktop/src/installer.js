// Step runner: skips steps whose isDone() is already true (resume), streams
// progress events, and verifies each step actually produced its artifacts.
export async function runInstall(steps, { onProgress = () => {} } = {}) {
  for (const step of steps) {
    // bytes rides along on every event -- the screen adds it up as steps
    // finish, to show how much of the total it has received.
    if (await step.isDone()) {
      onProgress({ stepId: step.id, title: step.title, state: "skipped", bytes: step.bytes });
      continue;
    }
    onProgress({ stepId: step.id, title: step.title, state: "start", bytes: step.bytes });
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
    } catch (err) {
      onProgress({ stepId: step.id, title: step.title, state: "error", detail: String((err && err.message) || err), bytes: step.bytes });
      throw err;
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

// Windows without Microsoft's Visual C++ runtime (issues #45, #47, #101,
// #103): torch's first import died with "[WinError 126] ... c10.dll", numpy's
// with "DLL load failed while importing _multiarray_umath". The app ships none
// of Microsoft's files; it says what to install and links to it. The x64
// permalink is the one Microsoft Learn lists as the latest supported
// (learn.microsoft.com/cpp/windows/latest-supported-vc-redist, 2026-09-19).
import { existsSync } from "node:fs";
import { win32 } from "node:path";
export const VC_RUNTIME_URL = "https://aka.ms/vc14/vc_redist.x64.exe";
export const VC_RUNTIME_MISSING = "Windows needs Microsoft Visual C++ to run the AI engine. Install it, then try again.";
const VC_RUNTIME_MARKS = /Visual C\+\+ Redistributable|WinError 126|WinError 1114|c10\.dll|DLL load failed/;
export function vcRuntimeFailure(message) {
  return VC_RUNTIME_MARKS.test(String(message || ""));
}
// The check before the engine pack: the three files the x64 Redistributable
// puts in System32, the ones c10.dll links against. Looking for the files
// rather than loading them with the kit's Python: no process to start or time
// out, and a PC that has the runtime always has them there. The app is x64
// only, so System32 is the 64-bit folder (WOW64 redirects 32-bit processes
// alone). Returns the missing names, and none on Mac and Linux or when the
// Windows folder cannot be found: a check that cannot run never blocks.
const VC_RUNTIME_DLLS = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];
export function missingVcRuntime({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (platform !== "win32") return [];
  const root = env.SystemRoot || env.windir;
  if (!root || !exists(win32.join(root, "System32"))) return [];
  return VC_RUNTIME_DLLS.filter((f) => !exists(win32.join(root, "System32", f)));
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
