import { test } from "node:test";
import assert from "node:assert/strict";
import { uniqueName } from "./downloadPath.js";

test("leaves the first download alone", () => {
  assert.equal(uniqueName("dub_en.mp4", () => false), "dub_en.mp4");
});

test("counts up from 001 when the name is taken", () => {
  const taken = new Set(["dub_en.mp4"]);
  assert.equal(uniqueName("dub_en.mp4", (n) => taken.has(n)), "dub_en_001.mp4");
});

test("skips over numbers already used", () => {
  const taken = new Set(["dub_en.mp4", "dub_en_001.mp4", "dub_en_002.mp4"]);
  assert.equal(uniqueName("dub_en.mp4", (n) => taken.has(n)), "dub_en_003.mp4");
});

test("numbers a name that has no extension", () => {
  const taken = new Set(["org"]);
  assert.equal(uniqueName("org", (n) => taken.has(n)), "org_001");
});

test("keeps a dotfile whole rather than treating it as an extension", () => {
  const taken = new Set([".srt"]);
  assert.equal(uniqueName(".srt", (n) => taken.has(n)), ".srt_001");
});

test("gives up after three digits so Electron can name it", () => {
  assert.equal(uniqueName("dub_en.mp4", () => true), null);
});
