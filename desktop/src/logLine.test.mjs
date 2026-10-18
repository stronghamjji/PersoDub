// shell.log's line shape (src/logLine.js). The dates are built from local
// parts, so the test reads the same in every time zone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { logLine, BANNER, detailLines, secondsSince, sizeText, urlText, homeText } from "./logLine.js";

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

test("a failure's own lines go under it indented: the last twenty that say something, each cut at 300", () => {
  assert.deepEqual(detailLines("python exit 1\n\nERROR: No space left on device\r\n"),
    ["  python exit 1", "  ERROR: No space left on device"]);
  const many = Array.from({ length: 25 }, (_, i) => `line ${i}`).join("\n");
  assert.deepEqual(detailLines(many), Array.from({ length: 20 }, (_, i) => `  line ${i + 5}`));
  assert.equal(detailLines("x".repeat(500))[0].length, 302);
  assert.deepEqual(detailLines(""), []);
});

// A DOWNLOAD line's sizes are pip's own (decimal units), with gigabytes added.
test("sizes read the way pip prints them, up to gigabytes", () => {
  assert.equal(sizeText(14), "14 B");
  assert.equal(sizeText(1234), "1.2 kB");
  assert.equal(sizeText(94_321), "94 kB");
  assert.equal(sizeText(17_234_567), "17.2 MB");
  assert.equal(sizeText(1_312_000_000), "1.3 GB");
});

// A signed link carries its token in the query, so a DOWNLOAD line keeps the
// address and the path and drops the query; a password before the host goes too.
test("an address keeps everything but its query and a password", () => {
  assert.equal(urlText("https://github.com/o/r/releases/download/v1/a.tar.gz"),
    "https://github.com/o/r/releases/download/v1/a.tar.gz");
  assert.equal(urlText("https://objects.githubusercontent.com/x/a.zip?X-Amz-Signature=abc&X-Amz-Date=1"),
    "https://objects.githubusercontent.com/x/a.zip?…");
  assert.equal(urlText("403 Forbidden for url: https://cas-bridge.xethub.hf.co/a?sig=1 (try again)"),
    "403 Forbidden for url: https://cas-bridge.xethub.hf.co/a?… (try again)");
  assert.equal(urlText("https://me:s3cret@pypi.corp.example/simple"), "https://…@pypi.corp.example/simple");
  assert.equal(urlText("/Users/x/kit/downloads/python.tar.gz"), "/Users/x/kit/downloads/python.tar.gz");
});

test("the home folder in a path reads as ~, and only a whole folder name matches", () => {
  const mac = "/Users/kim";
  assert.equal(homeText("/Users/kim/Library/Caches/x-updater/pending/PersoDub.zip 163 MB", mac),
    "~/Library/Caches/x-updater/pending/PersoDub.zip 163 MB");
  assert.equal(homeText("/Users/kimberly/a and /users/KIM/b", mac), "/Users/kimberly/a and ~/b");
  assert.equal(homeText("C:\\Users\\Kim\\AppData\\Local\\x.exe", "C:\\Users\\Kim"), "~\\AppData\\Local\\x.exe");
  assert.equal(homeText("/Users/kim", mac), "~");
  assert.equal(homeText("nothing here", mac), "nothing here");
  assert.equal(homeText("/Users/kim/a", ""), "/Users/kim/a", "no home known, nothing changed");
});
