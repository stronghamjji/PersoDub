// What is open is a video or sound alone, and which files each tool takes:
// the one place the page asks either.
//
// Run with: node --test ui/src/mediaKind.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAudio, fileKind, dubFormatProblem, videoFormatProblem } from "./mediaKind.mjs";

test("a job, a draft or a held upload marked audio is an audio project; unmarked is a video", () => {
  assert.equal(isAudio({ id: "j1", media: "audio" }), true);
  assert.equal(isAudio({ downloadId: "0a1b2c3d", media: "audio" }), true);
  // Every project made before audio came in has no mark at all.
  assert.equal(isAudio({ id: "j1" }), false);
  assert.equal(isAudio({ id: "j1", media: "video" }), false);
  // Nothing open is not an audio project either.
  assert.equal(isAudio(null), false);
  assert.equal(isAudio(undefined), false);
});

test("a file is a video or audio by the end of its name, in any case, and nothing else is either", () => {
  for (const name of ["a.mp4", "b.MOV", "My clip.final.Mp4"]) assert.equal(fileKind(name), "video", name);
  for (const name of ["a.wav", "b.FLAC", "c.mp3", "d.m4a"]) assert.equal(fileKind(name), "audio", name);
  for (const name of ["a.ogg", "b.mkv", "c.srt", "mp4", "d.mp4.txt", "", null, undefined]) {
    assert.equal(fileKind(name), "", String(name));
  }
});

test("dubbing takes the six kinds and refuses anything else in the one sentence", () => {
  for (const name of ["a.mp4", "a.mov", "a.wav", "a.flac", "a.mp3", "a.m4a"]) {
    assert.equal(dubFormatProblem({ name }), null, name);
  }
  for (const name of ["a.ogg", "a.txt", "a"]) {
    assert.equal(dubFormatProblem({ name }), "Only MP4 or MOV video and WAV, FLAC, MP3 or M4A audio can be used.", name);
  }
});

test("a tool that works on the picture takes video alone, and says so to an audio file", () => {
  assert.equal(videoFormatProblem({ name: "a.mp4" }), null);
  assert.equal(videoFormatProblem({ name: "a.MOV" }), null);
  for (const name of ["a.wav", "a.flac", "a.mp3", "a.m4a"]) {
    assert.equal(videoFormatProblem({ name }), "This tool takes video files only.", name);
  }
  // Neither a video nor audio: the sentence these tools always had.
  assert.equal(videoFormatProblem({ name: "a.txt" }), "Please choose an MP4 or MOV video file.");
});
