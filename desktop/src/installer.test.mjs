import { test } from "node:test";
import assert from "node:assert/strict";
import { runInstall } from "./installer.js";

function step(id, { done = false, fail = false, completes = true } = {}, log) {
  let ran = false;
  return {
    id,
    title: id,
    isDone: () => done || (ran && completes),
    run: async (report) => {
      ran = true;
      log.push(`run:${id}`);
      report(50, "halfway");
      if (fail) throw new Error(`${id} blew up`);
    },
  };
}

test("runs steps in order, skipping completed ones", async () => {
  const log = [];
  const events = [];
  await runInstall(
    [step("a", { done: true }, log), step("b", {}, log), step("c", {}, log)],
    { onProgress: (e) => events.push(`${e.stepId}:${e.state}`) },
  );
  assert.deepEqual(log, ["run:b", "run:c"]);
  assert.ok(events.includes("a:skipped"));
  assert.ok(events.includes("b:start") && events.includes("b:progress") && events.includes("b:done"));
  assert.ok(events.indexOf("b:done") < events.indexOf("c:start"));
});

test("failing step emits error and halts", async () => {
  const log = [];
  const events = [];
  await assert.rejects(
    runInstall([step("a", { fail: true }, log), step("b", {}, log)], { onProgress: (e) => events.push(`${e.stepId}:${e.state}`) }),
    /blew up/,
  );
  assert.deepEqual(log, ["run:a"]);
  assert.ok(events.includes("a:error"));
  assert.ok(!events.includes("b:start"));
});

test("step whose run finishes but isDone stays false throws", async () => {
  const log = [];
  await assert.rejects(
    runInstall([step("a", { completes: false }, log)], {}),
    /did not complete/,
  );
});

test("every progress event carries the step's bytes, so the screen can add up what it has received", async () => {
  const log = [];
  const events = [];
  const a = step("a", { done: true }, log);
  a.bytes = 5;
  const b = step("b", {}, log);
  b.bytes = 7;
  await runInstall([a, b], { onProgress: (e) => events.push(e) });
  assert.ok(events.length > 0);
  for (const e of events) {
    assert.equal(e.bytes, e.stepId === "a" ? 5 : 7);
  }
});

// A kit can pass the boot check (files present, version matching) with an
// install still open: the payload step writes KIT_VERSION first, and a venv
// step interrupted after it left the engines half-built (Windows, 2026-09-04).
// The step markers are the truth; this is what boot asks before skipping the
// installer.
import { openSteps } from "./installer.js";

test("openSteps names the steps still to run, ignoring housekeeping ones", async () => {
  const steps = [
    { id: "payload", isDone: () => true },
    { id: "venv-engines", isDone: async () => false },
    { id: "cleanup", verify: false, isDone: () => false },
    { id: "kit-env", isDone: () => true },
  ];
  assert.deepEqual((await openSteps(steps)).map((s) => s.id), ["venv-engines"]);
});

test("openSteps is empty for a finished kit", async () => {
  assert.deepEqual(await openSteps([{ id: "a", isDone: () => true }]), []);
});
