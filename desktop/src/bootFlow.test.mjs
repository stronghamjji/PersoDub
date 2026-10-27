import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

// Boot looks for an old settings file in the default kit folder, which
// config.js works out from the home folder as it loads. So everything boot can
// reach points into a throwaway folder before bootFlow.js is imported: the
// kit, the home folder (HOME on macOS and Linux, USERPROFILE on Windows) and
// Windows' local app data.
const base = mkdtempSync(join(tmpdir(), "odboot-"));
for (const name of ["HOME", "USERPROFILE", "LOCALAPPDATA"]) process.env[name] = base;
process.env.PERSODUB_KIT_DIR = join(base, "kit");
delete process.env.PERSODUB_FAKE;   // the fake engines skip the install entirely
delete process.env.PERSODUB_LANG;   // the screens' words below are the English ones
const { createBoot, installStopText, startStopText } = await import("./bootFlow.js");

test("the install screen is handed the version, as every other screen is", async () => {
  // A first install: a bundled payload and an empty kit folder.
  const appDir = join(base, "app");
  mkdirSync(join(appDir, "resources", "payload", "app-repo"), { recursive: true });
  writeFileSync(join(appDir, "resources", "payload", "KIT_VERSION"), "9.9.9+test");
  const loads = [];
  const stop = new Error("stop before the install copies or downloads anything");
  const win = {
    loadFile: async (path, { query }) => {
      loads.push({ path, query });
      if (path.endsWith("installing.html")) throw stop;
    },
  };
  const app = { getVersion: () => "1.2.3", getPath: () => join(base, "userData") };
  const boot = createBoot({
    app, ctx: {}, appDir, shellLog: () => {}, countUsage: () => {}, sendReport: () => {},
    flushReports: async () => {}, startUpdater: () => {},
  });
  await assert.rejects(boot(win), (err) => err === stop);
  const installing = loads.find((l) => l.path.endsWith("installing.html"));
  assert.ok(installing, `boot showed ${loads.map((l) => l.path).join(", ")}`);
  assert.equal(installing.query.v, "1.2.3");
  assert.equal(installing.query.mode, "install");
  assert.ok(Number(installing.query.bytes) > 0);
});

// Every file the install downloads gets its DOWNLOAD lines in shell.log: the
// steps are handed shellLog through the install context, which the pack IPC
// builds a pack's steps from as well.
test("the install context hands the steps shell.log for their downloads", async () => {
  const appDir = join(base, "app-logs");
  mkdirSync(join(appDir, "resources", "payload", "app-repo"), { recursive: true });
  writeFileSync(join(appDir, "resources", "payload", "KIT_VERSION"), "9.9.9+test");
  const stop = new Error("stop before the install copies or downloads anything");
  const win = { loadFile: async (path) => { if (path.endsWith("installing.html")) throw stop; } };
  const app = { getVersion: () => "1.2.3", getPath: () => join(base, "userData") };
  const ctx = {};
  const shellLog = () => {};
  const boot = createBoot({
    app, ctx, appDir, shellLog, countUsage: () => {}, sendReport: () => {},
    flushReports: async () => {}, startUpdater: () => {},
  });
  await assert.rejects(boot(win), (err) => err === stop);
  assert.equal(ctx.installCtx.log, shellLog);
});

// The first install step that fails names itself on the error screen, under
// the title, with the sentence for its cause and the tool's own words folded
// under Details; the screen points at the folder shell.log is in, and
// shell.log tells the run, numbered, from what it was given to where it
// stopped. A payload with no kit-src fails the payload step at once, before a
// byte is downloaded.
test("an install that stops names its step on the error screen, and shell.log tells the run", async (t) => {
  const appDir = join(base, "app-stops");
  mkdirSync(join(appDir, "resources", "payload", "app-repo"), { recursive: true });
  writeFileSync(join(appDir, "resources", "payload", "KIT_VERSION"), "9.9.9+test");
  const kitBefore = process.env.PERSODUB_KIT_DIR;
  process.env.PERSODUB_KIT_DIR = join(base, "kit-stops");
  t.after(() => { process.env.PERSODUB_KIT_DIR = kitBefore; });
  const loads = [];
  const win = { loadFile: async (path, { query }) => { loads.push({ path, query }); }, webContents: { send: () => {} } };
  const lines = [];
  const app = { getVersion: () => "1.2.3", getPath: () => join(base, "userData") };
  const boot = createBoot({
    app, ctx: {}, appDir, edition: "opensource", shellLog: (line, level = "INFO") => lines.push(`${level} ${line}`),
    countUsage: () => {}, sendReport: () => {}, flushReports: async () => {}, startUpdater: () => {},
  });
  await boot(win);

  const error = loads.find((l) => l.path.endsWith("error.html"));
  assert.ok(error, `boot showed ${loads.map((l) => l.path).join(", ")}`);
  assert.equal(error.query.title, "The install stopped");
  assert.equal(error.query.where, "Where it stopped · Copying bundled files");
  assert.equal(error.query.message,
    "Press Try again to go on from where it stopped. If it stops again, restart your computer, then open PersoDub.");
  assert.equal(error.query.note, undefined, "a note only for a certificate");
  assert.match(error.query.details, /^ENOENT: no such file or directory/);
  assert.equal(error.query.logDir, join(base, "userData", "logs"));

  const start = lines.find((l) => l.startsWith("INFO INSTALL START"));
  assert.match(start, /^INFO INSTALL START \(install\): \d+ steps, \d+\.\d GB to download$/);
  const n = Number(start.match(/: (\d+) steps/)[1]);
  const inputs = JSON.parse(lines.find((l) => l.startsWith("INFO Inputs: ")).slice("INFO Inputs: ".length));
  assert.deepEqual(inputs, {
    kitDir: join(base, "kit-stops"), edition: "opensource", appVersion: "1.2.3", kitVersion: "9.9.9+test",
    platform: `${process.platform}-${process.arch}`, steps: inputs.steps,
  });
  assert.equal(inputs.steps.length, n);
  assert.equal(inputs.steps[0], "payload");
  assert.ok(lines.includes(`INFO [Step 1/${n}] payload START`), lines.join("\n"));
  assert.ok(!lines.some((l) => l.includes("Copying bundled files")), "the screen's title stays out of the log");
  assert.ok(lines.some((l) => new RegExp(String.raw`^ERROR \[Step 1/${n}\] payload FAILED \(\d+\.\ds\): `).test(l)), lines.join("\n"));
  const failed = lines.findIndex((l) => l.startsWith("ERROR INSTALL FAILED"));
  assert.match(lines[failed], new RegExp(String.raw`^ERROR INSTALL FAILED at step 1/${n} payload \(\d+\.\ds\): \S+$`));
  // Under it, what the step's own error said, indented: here the missing folder.
  assert.match(lines[failed + 1], /^ERROR {3}ENOENT: no such file or directory, lstat '.*kit-src.sidecar'$/);
  assert.equal(failed + 2, lines.length, lines.join("\n"));
});

// The install is a step of its own in the charts (events.js track): it
// started, how big it was, how it ended and the error screen it left.
test("an install that stops records its start, its end with the reason, and the error screen", async (t) => {
  const appDir = join(base, "app-steps");
  mkdirSync(join(appDir, "resources", "payload", "app-repo"), { recursive: true });
  writeFileSync(join(appDir, "resources", "payload", "KIT_VERSION"), "9.9.9+test");
  const kitBefore = process.env.PERSODUB_KIT_DIR;
  process.env.PERSODUB_KIT_DIR = join(base, "kit-steps");
  t.after(() => { process.env.PERSODUB_KIT_DIR = kitBefore; });
  const steps = [];
  const win = { loadFile: async () => {}, webContents: { send: () => {} } };
  const app = { getVersion: () => "1.2.3", getPath: () => join(base, "userData") };
  const boot = createBoot({
    app, ctx: {}, appDir, edition: "production", shellLog: () => {}, countUsage: () => {}, sendReport: () => {},
    flushReports: async () => {}, startUpdater: () => {}, track: (name, props) => steps.push([name, props]),
  });
  await boot(win);
  assert.deepEqual(steps.map(([name]) => name), ["kit_install_started", "kit_install_finished", "error_shown"]);
  assert.equal(steps[0][1].mode, "install");
  assert.ok(Number.isInteger(steps[0][1].gigabytes));
  const [, end] = steps[1];
  assert.deepEqual({ ...end, seconds: 0 }, { outcome: "failed", reason: end.reason, seconds: 0 });
  assert.ok(Number.isInteger(end.seconds));
  assert.deepEqual(steps[2][1], { code: end.reason, where: "install" });
});

// A computer whose install keeps failing never reached the flush after the
// page is up, so the reports it kept never left. The queue is flushed as the
// launch starts, before the install, and again once an install that stopped
// has its screen up -- neither one waited on.
test("the report queue is flushed before the install and again once a stopped install is on screen", async (t) => {
  const appDir = join(base, "app-flush");
  mkdirSync(join(appDir, "resources", "payload", "app-repo"), { recursive: true });
  writeFileSync(join(appDir, "resources", "payload", "KIT_VERSION"), "9.9.9+test");
  const kitBefore = process.env.PERSODUB_KIT_DIR;
  const kit = join(base, "kit-flush");
  process.env.PERSODUB_KIT_DIR = kit;
  t.after(() => { process.env.PERSODUB_KIT_DIR = kitBefore; });
  const seen = [];
  const win = { loadFile: async (path) => { seen.push(basename(path)); }, webContents: { send: () => {} } };
  const app = { getVersion: () => "1.2.3", getPath: () => join(base, "userData") };
  const boot = createBoot({
    app, ctx: {}, appDir, shellLog: () => {}, countUsage: () => {},
    sendReport: (r) => seen.push(`report ${r.kind} ${r.step}`),
    // Never settles: a boot that waited on the queue would stop right here.
    flushReports: (kitDir) => { seen.push(`flush ${kitDir}`); return new Promise(() => {}); },
    startUpdater: () => {},
  });
  await boot(win);
  assert.deepEqual(seen, [`flush ${kit}`, "installing.html", "report install payload", "error.html", `flush ${kit}`]);
});

// An install that stopped says its cause in a sentence and what to press --
// the cause as the report sorts it, never a guess -- and a start that failed
// says whether it took too long or stopped on the way up.
test("an install that stopped is told by its cause, and the unknown by what to press", () => {
  const [cert, note] = installStopText("[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed");
  assert.match(cert, /^A company network or security program blocked the download\./);
  assert.match(note, /open these addresses\.\npypi\.org · files\.pythonhosted\.org · download\.pytorch\.org · /);
  // A download's fetch names the certificate only in its cause, which boot adds.
  assert.equal(installStopText("fetch failed: self-signed certificate in certificate chain")[0], cert);
  assert.match(installStopText("OSError: [Errno 28] No space left on device")[0], /^There is not enough storage space\./);
  assert.match(installStopText("EPERM: operation not permitted, rename")[0], /^Another program is using PersoDub's files\./);
  assert.match(installStopText("download failed 503: https://example.test/x")[0], /^The internet connection dropped\./);
  // A dropped connection the report has no word for is still the internet.
  assert.match(installStopText("ConnectionResetError: [Errno 54] Connection reset by peer")[0],
    /^The internet connection dropped\./);
  for (const said of ["Command failed: pip install ... exit 1", "MemoryError", ""]) {
    const [sentence, other] = installStopText(said);
    assert.match(sentence, /^Press Try again to go on from where it stopped\./, said);
    assert.equal(other, "", said);
  }
});

test("a start that failed is told by how it ended", () => {
  assert.match(startStopText("Health check timed out after 60000ms: http://127.0.0.1:5/health (last error: x)"),
    /^Getting ready took too long\./);
  assert.match(startStopText("The process stopped before it answered: http://127.0.0.1:5/health"),
    /^It stopped while starting\./);
  assert.match(startStopText("ENOENT: no such file or directory, open 'kit.env'"), /^It stopped while starting\./);
});
