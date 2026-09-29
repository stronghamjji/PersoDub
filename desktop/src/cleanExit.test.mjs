import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markCleanExit, takeCleanExit } from "./cleanExit.js";

test("a quit leaves a note the next launch reads once", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "pd-exit-")), "logs");
  markCleanExit(dir);
  assert.equal(takeCleanExit(dir), true);
  assert.equal(takeCleanExit(dir), false);
});

test("a run that never quit normally leaves nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "pd-exit-"));
  assert.equal(takeCleanExit(dir), false);
});
