import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { MAX_ARCHIVE_BYTES, buildLogArchive, tar, truncateLog } from "./reportLogs.js";

// Reads a tar back without a library: enough of the format to prove the one we
// write is the one a developer can open.
function untar(buf) {
  const out = [];
  for (let off = 0; off + 512 <= buf.length; ) {
    const name = buf.slice(off, off + 100).toString("utf8").replace(/\0.*$/, "");
    if (!name) break;
    const size = parseInt(buf.slice(off + 124, off + 135).toString("utf8").replace(/\0/g, "").trim(), 8);
    out.push({ name, text: buf.slice(off + 512, off + 512 + size).toString("utf8") });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

test("a log that already fits comes back untouched", () => {
  assert.equal(truncateLog("one\ntwo\n", 1000), "one\ntwo\n");
});

test("truncating drops the oldest lines and says how many", () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const cut = truncateLog(text, 60);
  assert.match(cut, /^\[truncated \d+ lines\]\n/);
  assert.ok(cut.endsWith("line 99"));
  assert.ok(!cut.includes("line 0\n"));
});

test("a truncated log keeps whole lines", () => {
  const cut = truncateLog("aaaa\nbbbb\ncccc", 6);
  assert.equal(cut, "[truncated 2 lines]\ncccc");
});

test("the archive holds the three logs under their own names", () => {
  const gz = buildLogArchive({ shell: "shell line", app: "app line", job: "job line" });
  const entries = untar(gunzipSync(gz));
  assert.deepEqual(entries.map((e) => e.name), ["shell.log", "persodub.log", "job.log"]);
  assert.equal(entries[1].text, "app line");
});

test("a log that is not there is not an empty file in the archive", () => {
  const entries = untar(gunzipSync(buildLogArchive({ shell: "only this", app: "", job: "   " })));
  assert.deepEqual(entries.map((e) => e.name), ["shell.log"]);
});

test("no logs at all means no archive", () => {
  assert.equal(buildLogArchive({}), null);
});

test("a huge log is cut until the archive fits the cap", () => {
  // Random-ish text so gzip cannot make it disappear: 40 MB of it, well over
  // the 5 MB the relay accepts.
  let line = "";
  for (let i = 0; i < 64; i += 1) line += Math.random().toString(36).slice(2);
  const huge = Array.from({ length: 40000 }, (_, i) => `${i} ${line}${i}`).join("\n");
  const gz = buildLogArchive({ shell: huge, app: huge, job: huge });
  assert.ok(gz.length <= MAX_ARCHIVE_BYTES, `${gz.length} bytes`);
  const entries = untar(gunzipSync(gz));
  assert.equal(entries.length, 3);
  for (const e of entries) assert.match(e.text, /^\[truncated \d+ lines\]/);
});

test("the tar ends with the two empty blocks the format requires", () => {
  const buf = tar([{ name: "a.log", text: "x" }]);
  assert.ok(buf.slice(-1024).every((b) => b === 0));
});
