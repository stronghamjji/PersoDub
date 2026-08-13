import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "./exec.js";

test("captures lines and resolves on success", async () => {
  const lines = [];
  await run([process.execPath, "-e", "console.log('a');console.error('b')"], { onLine: (l) => lines.push(l) });
  assert.ok(lines.includes("a") && lines.includes("b"));
});

test("terminal control codes never reach the caller", async () => {
  // `ollama pull` draws its progress bar with erase-line and cursor codes. A
  // terminal consumes them; the installer screen printed them as text, so the
  // last line of the setup screen read "2h13m[K[?25h[?2026l".
  const lines = [];
  await run(
    [process.execPath, "-e",
     "process.stdout.write('153 MB/8.1 GB 999 KB/s 2h13m\\u001b[K\\u001b[?25h\\u001b[?2026l\\n')"],
    { onLine: (l) => lines.push(l) },
  );
  assert.deepEqual(lines, ["153 MB/8.1 GB 999 KB/s 2h13m"]);
});

test("a carriage-return progress redraw is one line per update", async () => {
  // Ollama rewrites the same line with \r. Splitting on \n alone glued every
  // update into one ever-growing line.
  const lines = [];
  await run(
    [process.execPath, "-e", "process.stdout.write('pulling: 1%\\rpulling: 2%\\rpulling: 3%\\n')"],
    { onLine: (l) => lines.push(l) },
  );
  assert.deepEqual(lines, ["pulling: 1%", "pulling: 2%", "pulling: 3%"]);
});

test("rejects with code and recent output on failure", async () => {
  await assert.rejects(
    run([process.execPath, "-e", "console.log('boom');process.exit(3)"], {}),
    (err) => err.message.includes("exit 3") && err.message.includes("boom"),
  );
});
