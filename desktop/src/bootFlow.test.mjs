import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
const { createBoot } = await import("./bootFlow.js");

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

// The first install step that fails names itself on the error screen, which
// points at the folder shell.log is in; shell.log tells the run, numbered, from
// what it was given to where it stopped. A payload with no kit-src fails the
// payload step at once, before a byte is downloaded.
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
  assert.equal(error.query.title, "The install stopped at Copying bundled files");
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
