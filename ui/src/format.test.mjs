// Plain node:test unit tests for the page's shared formatters (ui/src/format.mjs).
// Both inline modules in static/index.html import these, so a change here is a
// change to the app screens AND to the Dub Agent strip.
//
// Run with: node --test ui/src/format.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { modKey, plainFailure, rawLogLines, restartFailure, fmtLength, videoCard, videoCardHtml } from "./format.mjs";
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
  assert.equal(errorText(new Error("Unsupported target language: xx")), "Unsupported target language: xx");
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


import { downloadsLabel } from "./format.mjs";

test("downloadsLabel names the folders under Downloads, on either kind of slash", () => {
  assert.equal(downloadsLabel("/Users/x/Downloads/2026-09-10/clip/clip (no subtitles).mp4"),
    "Downloads / 2026-09-10 / clip");
  assert.equal(downloadsLabel("C:\\Users\\x\\Downloads\\2026-09-10\\clip\\dub_ko.mp4"),
    "Downloads / 2026-09-10 / clip");
  // A file loose in Downloads, and a file somewhere else entirely.
  assert.equal(downloadsLabel("/Users/x/Downloads/clip.mp4"), "Downloads");
  assert.equal(downloadsLabel("/elsewhere/clip.mp4"), "");
  assert.equal(downloadsLabel(""), "");
});

import { statusParts } from "./format.mjs";

test("statusParts cuts a top-bar status into the pieces its chips are made of", () => {
  // The finished screen's "Done · Fast mode · Whisper · Hunyuan 1.8B · Qwen3-TTS"
  // read as one grey sentence; each part is a chip now (2026-09-17).
  assert.deepEqual(statusParts("Done · Fast mode · Whisper"), ["Done", "Fast mode", "Whisper"]);
  // One part is a plain label, not a chip: "Local dubbing", "Erase subtitles".
  assert.deepEqual(statusParts("Local dubbing"), ["Local dubbing"]);
  assert.deepEqual(statusParts(""), []);
  assert.deepEqual(statusParts(undefined), []);
  // A stray separator does not make an empty chip.
  assert.deepEqual(statusParts("Working ·  · English"), ["Working", "English"]);
});

test("errorText turns a request that never reached the app into what to do about it", () => {
  const told = "PersoDub is not running. Restart the app.";
  assert.equal(errorText(new TypeError("Failed to fetch")), told);
  assert.equal(errorText(new TypeError("Load failed")), told);
  assert.equal(errorText(new TypeError("NetworkError when attempting to fetch resource.")), told);
  assert.equal(errorText(new Error("network error")), told);
  assert.equal(errorText("TypeError: Failed to fetch"), told);
  // A sentence that only mentions fetching is somebody's own words and stays.
  assert.equal(errorText(new Error("Failed to fetch the video from that link.")), "Failed to fetch the video from that link.");
});

test("errorText never shows a list of field errors or a page of HTML", () => {
  const body = JSON.stringify({ detail: [{ loc: ["body", "file"], msg: "field required", type: "value_error.missing" }] });
  assert.equal(errorText(new Error(body)), "That did not work. Try again.");
  assert.equal(errorText(new Error('{"detail": {"code": 3}}')), "That did not work. Try again.");
  assert.equal(errorText(new Error("<!DOCTYPE html><html><body>500</body></html>")), "That did not work. Try again.");
});

test("shortcut tips say Cmd on a Mac and Ctrl everywhere else", () => {
  assert.equal(modKey("MacIntel"), "Cmd");
  assert.equal(modKey("Win32"), "Ctrl");
  assert.equal(modKey("Linux x86_64"), "Ctrl");
  assert.equal(modKey(""), "Ctrl");
});

test("a failure's plain sentence is shown, and a program's own words are not", () => {
  // A sentence the server wrote for a person stays as it is.
  assert.equal(plainFailure("No dialogue lines were found in this video."), "No dialogue lines were found in this video.");
  // What happened, without the program's last line after it.
  assert.equal(plainFailure("Could not look for subtitles in this video (RuntimeError: CUDA out of memory)"),
    "Could not look for subtitles in this video.");
  assert.equal(plainFailure("local STT reported an error ([Errno 2] No such file)"), "Local STT reported an error.");
  assert.equal(plainFailure("Qwen dub mux failed: Conversion failed! /tmp/x.mp4"), "Qwen dub mux failed.");
  // A menu path is a person's words; the path in parentheses is not.
  assert.equal(plainFailure("내 컴퓨터에서 받아쓰기에 실패했어요. 받아쓰기에 쓰는 Whisper 파일이 없거나 손상됐어요. 설정 > 모델에서 Whisper를 다시 받아 주세요. "
    + "(local STT script missing: /Users/x/kit/app/scripts/whisper_transcribe.py)"),
    "내 컴퓨터에서 받아쓰기에 실패했어요. 받아쓰기에 쓰는 Whisper 파일이 없거나 손상됐어요. 설정 > 모델에서 Whisper를 다시 받아 주세요.");
  assert.equal(plainFailure("Could not run x->y"), "");
  // A program's words through and through: nothing for the screen.
  assert.equal(plainFailure("[Errno 28] No space left on device: '/Users/x/y'"), "");
  assert.equal(plainFailure("Traceback (most recent call last):"), "");
  assert.equal(plainFailure("KeyError: 'segments'"), "");
  assert.equal(plainFailure("'NoneType' object has no attribute 'get'"), "");
  assert.equal(plainFailure("interrupted"), "");
  assert.equal(plainFailure(""), "");
});

test("why the voice engine did not start again is said in plain words, never the engine's own line", () => {
  // Issue #187's engine, as the shell hands it back (desktop/src/packIpc.js).
  assert.equal(restartFailure("Installed, but it could not start: OSError: �� �۾��� �Ϸ��ϱ� ���� ����¡ ������ �ʹ� �۽��ϴ�. (os error 1455)"),
    "Starting it again did not work: this computer ran out of memory.");
  assert.equal(restartFailure("Installed, but it could not start: Health check timed out after 300000ms: http://127.0.0.1:5/health"),
    "Starting it again did not work: it took too long to start.");
  // The shell's own sentence is said as it is.
  assert.equal(restartFailure("Windows needs Microsoft Visual C++ to run Python + PyTorch. Install it, then try again."),
    "Starting it again did not work. Windows needs Microsoft Visual C++ to run Python + PyTorch. Install it, then try again.");
  // A program's words, or nothing at all: only that it did not work.
  assert.equal(restartFailure("Installed, but it could not start: RuntimeError: boom"), "Starting it again did not work.");
  assert.equal(restartFailure(undefined), "Starting it again did not work.");
});

test("Raw log holds the failure's own text when the screen did not show it whole", () => {
  assert.deepEqual(rawLogLines(["a", "b"], "No dialogue lines were found in this video."), ["a", "b"]);
  assert.deepEqual(rawLogLines(["a"], "KeyError: 'segments'"), ["a", "KeyError: 'segments'"]);
  assert.deepEqual(rawLogLines(["boom KeyError: 'segments'"], "KeyError: 'segments'"), ["boom KeyError: 'segments'"]);
  assert.deepEqual(rawLogLines(null, "interrupted"), []);
});

// How LONG something is: minutes and seconds with leading zeros, everywhere a
// length is shown (owner, 2026-09-30). A position keeps fmtClock.
test("fmtLength is mm:ss with leading zeros, and the hour in front once there is one", () => {
  assert.equal(fmtLength(0), "00:00");
  assert.equal(fmtLength(39.7), "00:39");
  assert.equal(fmtLength(60), "01:00");
  assert.equal(fmtLength(728), "12:08");
  assert.equal(fmtLength(3730), "1:02:10");
  assert.equal(fmtLength(-3), "00:00");
  assert.equal(fmtLength("x"), "00:00");
});

test("the Video card: its label, the file name and the kept length, with what was cut only when something was", () => {
  assert.deepEqual(videoCard({ name: "quiz.mp4", kept: 39.7, total: 39.7 }),
    { label: "Video", name: "quiz.mp4", length: "00:39", cut: "" });
  assert.deepEqual(videoCard({ name: "quiz.mp4", kept: 29.7, total: 39.7 }),
    { label: "Video", name: "quiz.mp4", length: "00:29", cut: "00:10 cut" });
  // Less than a second gone is not said.
  assert.equal(videoCard({ name: "a", kept: 9.6, total: 10 }).cut, "");
  // A length that is not known is not made up.
  assert.deepEqual(videoCard({ name: "Street food", kept: 0, total: 0 }),
    { label: "Video", name: "Street food", length: "", cut: "" });
  assert.equal(videoCardHtml({ name: "a<b>.mp4", kept: 29.7, total: 39.7 }),
    '<div class="k">Video</div><div class="m vc-name" title="a&lt;b&gt;.mp4">a&lt;b&gt;.mp4</div>'
    + '<div class="s vc-len">00:29<span class="vc-cut">00:10 cut</span></div>');
  assert.equal(videoCardHtml({ name: "a.mp4", kept: 10, total: 10 }),
    '<div class="k">Video</div><div class="m vc-name" title="a.mp4">a.mp4</div><div class="s vc-len">00:10</div>');
});
