// The one answer two screens share: who is speaking, and what that voice is
// called where there is no room for a name.
import test from "node:test";
import assert from "node:assert/strict";

import { numberSpeakers, speakerLetter } from "./speakers.mjs";

test("speakers are numbered in the order they first say something", () => {
  const map = numberSpeakers([
    { speaker: "SPEAKER_01" },
    { speaker: "SPEAKER_00" },
    { speaker: "SPEAKER_01" },
    { speaker: "SPEAKER_02" },
  ]);
  assert.equal(map.get("SPEAKER_01"), 1);
  assert.equal(map.get("SPEAKER_00"), 2);
  assert.equal(map.get("SPEAKER_02"), 3);
  assert.equal(map.size, 3);
});

test("a script nobody is labelled in has no speakers to count", () => {
  assert.equal(numberSpeakers([{ text: "hi" }, { speaker: "" }]).size, 0);
});

test("a speaker's number is written as a letter, and past Z it doubles up", () => {
  assert.equal(speakerLetter(1), "A");
  assert.equal(speakerLetter(2), "B");
  assert.equal(speakerLetter(26), "Z");
  // 27 is where a single letter runs out. AA, not A1 or Z+1.
  assert.equal(speakerLetter(27), "AA");
  assert.equal(speakerLetter(28), "AB");
  assert.equal(speakerLetter(52), "AZ");
  assert.equal(speakerLetter(53), "BA");
  // Nothing to write for a number that is not one.
  assert.equal(speakerLetter(0), "");
  assert.equal(speakerLetter(-3), "");
  assert.equal(speakerLetter(1.5), "");
  assert.equal(speakerLetter(undefined), "");
});
