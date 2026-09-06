// Plain node:test unit tests for the page's shared formatters (ui/src/format.mjs).
// Both inline modules in static/index.html import these, so a change here is a
// change to the app screens AND to the Dub Agent strip.
//
// Run with: node --test ui/src/format.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  fmtClock,
  fmtClockTenths,
  formatBytes,
  escapeHtml,
  errorText,
} from "./format.mjs";

test("fmtClock prints hh:mm:ss with two digits each", () => {
  assert.equal(fmtClock(0), "00:00:00");
  assert.equal(fmtClock(9), "00:00:09");
  assert.equal(fmtClock(61), "00:01:01");
  assert.equal(fmtClock(3600), "01:00:00");
  assert.equal(fmtClock(3661), "01:01:01");
  // Past a day it keeps counting hours rather than rolling over.
  assert.equal(fmtClock(90000), "25:00:00");
});

test("fmtClock floors the seconds and treats junk as zero", () => {
  assert.equal(fmtClock(9.9), "00:00:09");
  // Original behaviour, kept: Math.max(0, ...) means below zero reads as 0,
  // and Number(x) || 0 means NaN/null/undefined/"" all read as 0 too.
  assert.equal(fmtClock(-5), "00:00:00");
  assert.equal(fmtClock(NaN), "00:00:00");
  assert.equal(fmtClock(undefined), "00:00:00");
  assert.equal(fmtClock(null), "00:00:00");
  assert.equal(fmtClock("banana"), "00:00:00");
  // A numeric string still counts -- Number() does the work.
  assert.equal(fmtClock("75"), "00:01:15");
});

test("fmtClockTenths adds the tenth the trim bar steps by", () => {
  assert.equal(fmtClockTenths(0), "00:00:00.0");
  assert.equal(fmtClockTenths(2), "00:00:02.0");
  assert.equal(fmtClockTenths(61.5), "00:01:01.5");
  // The whole reason it counts in tenths: 0.3 is 0.29999... in binary, and
  // pulling the fraction apart by hand would print .2 here.
  assert.equal(fmtClockTenths(0.3), "00:00:00.3");
  assert.equal(fmtClockTenths(59.95), "00:01:00.0");
  assert.equal(fmtClockTenths(-1), "00:00:00.0");
  assert.equal(fmtClockTenths(NaN), "00:00:00.0");
});

test("formatBytes picks B, KB or MB", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(999), "999 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1024 * 1024 - 1), "1024.0 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(2.5 * 1024 * 1024), "2.5 MB");
  // It is only ever handed a File.size, so it has never guarded its input.
  // Documenting the original behaviour rather than changing it: a negative
  // falls in the "B" branch, and a non-number fails every comparison and
  // drops through to MB.
  assert.equal(formatBytes(-5), "-5 B");
  assert.equal(formatBytes(NaN), "NaN MB");
});

test("escapeHtml escapes all five characters, quotes included", () => {
  assert.equal(escapeHtml("&"), "&amp;");
  assert.equal(escapeHtml("<"), "&lt;");
  assert.equal(escapeHtml(">"), "&gt;");
  assert.equal(escapeHtml('"'), "&quot;");
  assert.equal(escapeHtml("'"), "&#39;");
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

test("escapeHtml is attribute-safe: a quote cannot break out of title=\"...\"", () => {
  // The page interpolates it inside attributes (title="${escapeHtml(...)}"),
  // which is why the five-character version is the one that survived the
  // merge of the two old copies.
  const attacked = `" onmouseover="alert(1)`;
  assert.equal(
    escapeHtml(attacked),
    "&quot; onmouseover=&quot;alert(1)",
  );
  assert.ok(!escapeHtml(attacked).includes('"'));
});

test("escapeHtml leaves ordinary text alone and takes non-strings", () => {
  assert.equal(escapeHtml(""), "");
  assert.equal(escapeHtml("Hello, 안녕 — no marks here"), "Hello, 안녕 — no marks here");
  assert.equal(escapeHtml("<script>alert(1)</script>"),
    "&lt;script&gt;alert(1)&lt;/script&gt;");
  // String() first: the agent strip used to pass raw text only, the app passes
  // whatever a job record holds.
  assert.equal(escapeHtml(42), "42");
  assert.equal(escapeHtml(null), "null");
  assert.equal(escapeHtml(undefined), "undefined");
});

test("errorText unwraps a FastAPI detail out of the raw response body", () => {
  assert.equal(errorText(new Error('{"detail": "No space left on device"}')),
    "No space left on device");
  // A detail that is not a string still comes back as one.
  assert.equal(errorText(new Error('{"detail": 404}')), "404");
});

test("errorText passes anything that is not JSON straight through", () => {
  assert.equal(errorText(new Error("Failed to fetch")), "Failed to fetch");
  assert.equal(errorText("plain string"), "plain string");
  // Valid JSON without a detail is not a server error envelope: use it as it is.
  assert.equal(errorText(new Error('{"other": 1}')), '{"other": 1}');
});

test("errorText survives an empty or missing error", () => {
  assert.equal(errorText(null), "");
  assert.equal(errorText(undefined), "");
  assert.equal(errorText(""), "");
  // Original behaviour, kept: an Error with an empty message is falsy at
  // `e.message`, so the fallback stringifies the Error itself -- "Error",
  // not "". Nothing ever throws one of those; pinned so it stays deliberate.
  assert.equal(errorText(new Error("")), "Error");
});
