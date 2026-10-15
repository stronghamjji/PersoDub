// shell.log's line shape (src/logLine.js). The dates are built from local
// parts, so the test reads the same in every time zone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { logLine, BANNER, secondsSince } from "./logLine.js";

test("a line is the local time, the source, the level and the message", () => {
  assert.equal(logLine("shell", "INFO", "PERSODUB_VERSION 0.8.5", new Date(2026, 9, 15, 22, 31, 5, 494)),
    "2026-10-15 22:31:05,494 - shell - INFO - PERSODUB_VERSION 0.8.5");
  assert.equal(logLine("shell", "ERROR", "x", new Date(2026, 0, 2, 3, 4, 5, 6)),
    "2026-01-02 03:04:05,006 - shell - ERROR - x");
});

test("the banner is thirty hashes, and seconds have one decimal", () => {
  assert.equal(BANNER, "##############################");
  assert.equal(secondsSince(1000, 13400), "12.4");
  assert.equal(secondsSince(5, 5), "0.0");
});
