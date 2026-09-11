// Pre-flight check before "Restart to update" on Windows: which OTHER
// programs hold files inside the install directory open. The NSIS updater
// dies with a misleading "cannot be closed" dialog when e.g. an editor or
// antivirus holds resources\app.asar -- this module names the culprit BEFORE
// the app quits, while there is still a UI to say it in. Kept pure/injectable
// so it tests without PowerShell or Electron.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lockProbeScript, parseLockers, foreignLockers, findForeignLockers } from "./lockCheck.js";

test("parseLockers reads the probe's JSON array", () => {
  const out = '[{"pid":7644,"name":"Visual Studio Code","exe":"Code.exe"}]';
  assert.deepEqual(parseLockers(out), [{ pid: 7644, name: "Visual Studio Code", exe: "Code.exe" }]);
});

test("parseLockers wraps a single-object result in an array", () => {
  // PowerShell's ConvertTo-Json drops the array wrapper for one element, so
  // a single locker arrives as a bare object, not a one-element array.
  const out = '{"pid":7644,"name":"Visual Studio Code","exe":"Code.exe"}';
  assert.deepEqual(parseLockers(out), [{ pid: 7644, name: "Visual Studio Code", exe: "Code.exe" }]);
});

test("parseLockers turns garbage or empty output into no lockers", () => {
  // Fail open: a broken probe must never block an update.
  assert.deepEqual(parseLockers(""), []);
  assert.deepEqual(parseLockers("Add-Type : error CS0234 ..."), []);
  assert.deepEqual(parseLockers(null), []);
});

test("foreignLockers drops the app's own processes, keeps others", () => {
  // The running app holds its own app.asar open -- that lock resolves itself
  // when the app quits, so only OTHER programs are worth warning about.
  // Electron spawns several processes from the same exe; match by exe name,
  // case-insensitively (Windows paths are case-preserving, not case-sensitive).
  const lockers = [
    { pid: 100, name: "PersoDub", exe: "PersoDub.exe" },
    { pid: 101, name: "PersoDub", exe: "persodub.exe" },
    { pid: 7644, name: "Visual Studio Code", exe: "Code.exe" },
  ];
  assert.deepEqual(
    foreignLockers(lockers, "C:\\Users\\x\\AppData\\Local\\Programs\\PersoDub\\PersoDub.exe"),
    [{ pid: 7644, name: "Visual Studio Code", exe: "Code.exe" }],
  );
});

test("lockProbeScript embeds the install dir literally, apostrophes escaped", () => {
  // The dir is spliced into a single-quoted PowerShell string; ' doubles to ''.
  // Anything else injected verbatim would let a hostile path run as code.
  const script = lockProbeScript("C:\\Users\\o'brien\\AppData\\Local\\Programs\\PersoDub");
  assert.ok(script.includes("'C:\\Users\\o''brien\\AppData\\Local\\Programs\\PersoDub'"));
});

test("findForeignLockers reports foreign holders via an injected runner", async () => {
  const run = async () => '[{"pid":7644,"name":"Visual Studio Code","exe":"Code.exe"},{"pid":1,"name":"PersoDub","exe":"PersoDub.exe"}]';
  const got = await findForeignLockers({
    installDir: "C:\\apps\\PersoDub",
    ownExePath: "C:\\apps\\PersoDub\\PersoDub.exe",
    run,
  });
  assert.deepEqual(got, [{ pid: 7644, name: "Visual Studio Code", exe: "Code.exe" }]);
});

test("findForeignLockers fails open when the probe blows up", async () => {
  // An update must never be blocked by the safety check itself.
  const run = async () => { throw new Error("powershell missing"); };
  const got = await findForeignLockers({
    installDir: "C:\\apps\\PersoDub",
    ownExePath: "C:\\apps\\PersoDub\\PersoDub.exe",
    run,
  });
  assert.deepEqual(got, []);
});

test("lockProbeScript makes PowerShell answer in UTF-8, so Korean app names survive", () => {
  // The dialog showed "Close Microsoft Defender ������ first" on a Korean
  // Windows (2026-09-08): stdout came out in the console code page.
  const script = lockProbeScript("C:\\x");
  const enc = script.indexOf("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8");
  assert.ok(enc > 0);
  assert.ok(enc < script.indexOf("Add-Type"), "set before anything prints");
});

// ---- holders nobody can close -------------------------------------------

test("Windows Defender is not reported as something to close", () => {
  // It has a hand in the install folder on every Windows there is, the
  // service cannot be closed, and the update goes through anyway: nine
  // seconds, once the user found the button (Windows, 2026-09-11). A warning
  // that is always there and always wrong is not a warning.
  const lockers = [
    { pid: 1, name: "Microsoft Defender 바이러스 백신 서비스", exe: "MsMpEng.exe" },
    { pid: 2, name: "Antimalware Service Executable", exe: "MsMpEng.exe" },
    { pid: 3, name: "Windows Defender SmartScreen", exe: "smartscreen.exe" },
  ];
  assert.deepEqual(foreignLockers(lockers, "C:\\Apps\\PersoDub\\PersoDub.exe"), []);
});

test("a real holder is still named", () => {
  const lockers = [
    { pid: 1, name: "Microsoft Defender 바이러스 백신 서비스", exe: "MsMpEng.exe" },
    { pid: 2, name: "Visual Studio Code", exe: "Code.exe" },
  ];
  const left = foreignLockers(lockers, "C:\\Apps\\PersoDub\\PersoDub.exe");
  assert.equal(left.length, 1);
  assert.equal(left[0].exe, "Code.exe");
});
