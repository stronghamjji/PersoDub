// timeline.log (src/timeline.js): the shell's, the engine's and every job's
// log merged by time, each line as it was written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mergeTimeline, writeTimeline } from "./timeline.js";

const at = (seconds, source, message, level = "INFO") => `2026-10-15 22:31:${seconds} - ${source} - ${level} - ${message}`;
const file = (...lines) => `${lines.join("\n")}\n`;

const SHELL = file(at("01,000", "shell", "ENGINES START"), at("05,000", "shell", "ENGINES ALL READY (4.0s)"));
const PERSODUB = file(at("02,500", "persodub.jobs", "job ab12cd34 started"), at("06,000", "persodub.jobs", "job ab12cd34 failed"));
const JOB = file(
  at("03,000", "job-ab12cd34", "[Step 1/6] separate START"),
  at("04,000", "job-ab12cd34", "Traceback (most recent call last):", "ERROR"),
  '  File "app/pipeline.py", line 3, in run',
  "ValueError: y",
  at("07,000", "job-ab12cd34", "JOB FAILED at step 1/6 separate (4.0s): ValueError: y", "ERROR"),
);

test("three logs are merged by time, a traceback staying under the line it belongs to", () => {
  const out = mergeTimeline([{ name: "shell.log", text: SHELL }, { name: "persodub.log", text: PERSODUB }, { name: "job-ab12cd34.log", text: JOB }]);
  assert.equal(out, file(
    at("01,000", "shell", "ENGINES START"),
    at("02,500", "persodub.jobs", "job ab12cd34 started"),
    at("03,000", "job-ab12cd34", "[Step 1/6] separate START"),
    at("04,000", "job-ab12cd34", "Traceback (most recent call last):", "ERROR"),
    '  File "app/pipeline.py", line 3, in run',
    "ValueError: y",
    at("05,000", "shell", "ENGINES ALL READY (4.0s)"),
    at("06,000", "persodub.jobs", "job ab12cd34 failed"),
    at("07,000", "job-ab12cd34", "JOB FAILED at step 1/6 separate (4.0s): ValueError: y", "ERROR"),
  ));
});

test("equal stamps keep the order the logs came in: shell, then persodub, then the job", () => {
  const same = "09,123";
  const out = mergeTimeline([
    { name: "shell.log", text: file(at(same, "shell", "QUIT: stopping engines")) },
    { name: "persodub.log", text: file(at(same, "persodub.jobs", "shutting down")) },
    { name: "job-ab12cd34.log", text: file(at(same, "job-ab12cd34", "JOB CANCELLED (1.0s)")) },
  ]);
  assert.deepEqual(out.trim().split("\n").map((l) => l.split(" - ")[1]), ["shell", "persodub.jobs", "job-ab12cd34"]);
});

test("a log in the old format, with no stamps, is left out, and so is anything above a log's first stamp", () => {
  const old = file("2026-10-10T00:00:00.000Z PERSODUB_VERSION 0.7.1", "1/6 Separating…");
  const out = mergeTimeline([{ name: "shell.log", text: `half a line cut by the 2 MB read\n${SHELL}` }, { name: "job-old.log", text: old }]);
  assert.equal(out, SHELL);
  assert.equal(mergeTimeline([{ name: "job-old.log", text: old }]), "");
});

test("writeTimeline writes the merged file into the folder, without a persodub.log, and leaves nothing half-written", () => {
  const dir = mkdtempSync(join(tmpdir(), "odtimeline-"));
  writeFileSync(join(dir, "shell.log"), SHELL);
  writeFileSync(join(dir, "job-ab12cd34.log"), JOB);
  writeFileSync(join(dir, "backend.log"), "INFO: not one of the three\n");
  const said = [];
  writeTimeline(dir, (line) => said.push(line));
  const out = readFileSync(join(dir, "timeline.log"), "utf8");
  assert.equal(out.split("\n")[0], at("01,000", "shell", "ENGINES START"));
  assert.ok(out.includes("ValueError: y") && !out.includes("not one of the three"));
  assert.ok(!existsSync(join(dir, "timeline.log.tmp")));
  assert.deepEqual(said, []);
  // Rewritten whole each time, never appended to.
  writeTimeline(dir);
  assert.equal(readFileSync(join(dir, "timeline.log"), "utf8"), out);
});

test("a folder that cannot be read is said once, and never throws", () => {
  const said = [];
  const missing = join(tmpdir(), "odtimeline-no-such-folder", "logs");
  writeTimeline(missing, (line) => said.push(line));
  writeTimeline(missing, (line) => said.push(line));
  assert.equal(said.length, 1, said.join("\n"));
  assert.match(said[0], /^PERSODUB_TIMELINE not written: ENOENT/);
});

test("a job's lines copied into persodub.log are left out when the job's own log is merged", () => {
  const persodub = file(
    at("02,000", "persodub.main", "PersoDub 0.8.5 starting up"),
    at("03,000", "persodub.jobs", "job-ab12cd34: [Step 1/6] separate START"),
    at("04,000", "persodub.jobs", "job-ab12cd34: Traceback (most recent call last):", "ERROR"),
    "ValueError: y",
    at("05,000", "persodub.jobs", "job-ffff0000: JOB START (dub)"),
  );
  const job = file(at("03,000", "job-ab12cd34", "[Step 1/6] separate START"));
  const out = mergeTimeline([{ name: "persodub.log", text: persodub }, { name: "job-ab12cd34.log", text: job }]);
  assert.equal(out, file(
    at("02,000", "persodub.main", "PersoDub 0.8.5 starting up"),
    at("03,000", "job-ab12cd34", "[Step 1/6] separate START"),
    // A job whose own log is not in the merge keeps its copy.
    at("05,000", "persodub.jobs", "job-ffff0000: JOB START (dub)"),
  ));
});
