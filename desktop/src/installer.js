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
export async function openSteps(steps) {
  const open = [];
  for (const step of steps) {
    if (step.verify === false) continue;
    if (!(await step.isDone())) open.push(step);
  }
  return open;
}
