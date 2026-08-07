// Step runner: skips steps whose isDone() is already true (resume), streams
// progress events, and verifies each step actually produced its artifacts.
export async function runInstall(steps, { onProgress = () => {} } = {}) {
  for (const step of steps) {
    if (await step.isDone()) {
      onProgress({ stepId: step.id, title: step.title, state: "skipped" });
      continue;
    }
    onProgress({ stepId: step.id, title: step.title, state: "start" });
    try {
      await step.run((pct, detail) => {
        onProgress({ stepId: step.id, title: step.title, state: "progress", pct, detail });
      });
      if (!(await step.isDone())) {
        throw new Error(`step "${step.id}" ran but did not complete its artifacts`);
      }
    } catch (err) {
      onProgress({ stepId: step.id, title: step.title, state: "error", detail: String((err && err.message) || err) });
      throw err;
    }
    onProgress({ stepId: step.id, title: step.title, state: "done" });
  }
}
