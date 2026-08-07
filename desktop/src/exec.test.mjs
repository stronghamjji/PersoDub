import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "./exec.js";

test("captures lines and resolves on success", async () => {
  const lines = [];
  await run([process.execPath, "-e", "console.log('a');console.error('b')"], { onLine: (l) => lines.push(l) });
  assert.ok(lines.includes("a") && lines.includes("b"));
});

test("rejects with code and recent output on failure", async () => {
  await assert.rejects(
    run([process.execPath, "-e", "console.log('boom');process.exit(3)"], {}),
    (err) => err.message.includes("exit 3") && err.message.includes("boom"),
  );
});
