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
