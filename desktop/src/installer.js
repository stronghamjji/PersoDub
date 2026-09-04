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
      if (!(await step.isDone())) {
        throw new Error(`step "${step.id}" ran but did not complete its artifacts`);
      }
    } catch (err) {
      onProgress({ stepId: step.id, title: step.title, state: "error", detail: String((err && err.message) || err), bytes: step.bytes });
      throw err;
    }
    onProgress({ stepId: step.id, title: step.title, state: "done", bytes: step.bytes });
  }
}
