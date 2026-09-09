import { test } from "node:test";
import assert from "node:assert/strict";
import { revealAllowed, isInside } from "./revealPolicy.js";

const DOWNLOADS = "/Users/someone/Downloads";
const KIT = "/Users/someone/Library/Application Support/PersoDub/kit";
const FOLDERS = [DOWNLOADS, KIT];

test("a file the app just saved is shown", () => {
  assert.equal(revealAllowed(`${DOWNLOADS}/clip10 (no subtitles).mp4`, FOLDERS), true);
  assert.equal(revealAllowed(`${DOWNLOADS}/2026-09-09/talk/dub_en.mp4`, FOLDERS), true);
  assert.equal(revealAllowed(`${KIT}/workspace/job/erased.mp4`, FOLDERS), true);
});

test("the folder itself counts as inside itself", () => {
  assert.equal(revealAllowed(DOWNLOADS, FOLDERS), true);
  assert.equal(isInside(`${DOWNLOADS}/`, DOWNLOADS), true);
});

test("anything else on the disk is refused", () => {
  assert.equal(revealAllowed("/Users/someone/.ssh/id_rsa", FOLDERS), false);
  assert.equal(revealAllowed("/etc/passwd", FOLDERS), false);
  // A name that only starts the same way is not inside it.
  assert.equal(revealAllowed("/Users/someone/Downloads-old/secret.mp4", FOLDERS), false);
});

test("climbing back out with .. is refused", () => {
  assert.equal(revealAllowed(`${DOWNLOADS}/../.ssh/id_rsa`, FOLDERS), false);
  // ...and a path that climbs out and back in again is where it lands.
  assert.equal(revealAllowed(`${DOWNLOADS}/../Downloads/clip.mp4`, FOLDERS), true);
});

test("nothing to show is not something to show", () => {
  for (const bad of ["", "   ", null, undefined, 42, {}, `${DOWNLOADS}/clip\0.mp4`]) {
    assert.equal(revealAllowed(bad, FOLDERS), false, `${String(bad)} was allowed`);
  }
  // No folders known yet (the app has not booted its kit) allows nothing.
  assert.equal(revealAllowed(`${DOWNLOADS}/clip.mp4`, []), false);
  assert.equal(revealAllowed(`${DOWNLOADS}/clip.mp4`, [null, ""]), false);
});
