// Run with: node --test desktop/src/packIpc.test.mjs
// Electron, the engines and the downloader are stand-ins; the kit is a temp
// folder. Nothing here starts a process or reaches the network.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerPackIpc } from "./packIpc.js";
import { buildSteps, packSteps } from "./installSpec.js";
import { freeSpaceAt, notEnoughSpace } from "./config.js";
import { exeName } from "./platform.js";

function setup({ installCtx = true, engines = {}, download = async () => {} } = {}) {
  const base = mkdtempSync(join(tmpdir(), "odpack-"));
  const kitDir = join(base, "kit");
  mkdirSync(kitDir, { recursive: true });
  const handlers = {};
  const ipcMain = { handle: (channel, fn) => { handlers[channel] = fn; } };
  const sent = [];
  const win = { isDestroyed: () => false, webContents: { send: (channel, value) => sent.push([channel, value]) } };
  const logged = [];
  const ctx = {
    win, engines, bootedKitDir: null,
    installCtx: installCtx
      ? { kitDir, payloadDir: join(base, "payload"), download, extract: async () => {}, run: async () => {} }
      : null,
  };
  registerPackIpc({ ipcMain, dialog: {}, shell: {}, ctx, shellLog: (line) => logged.push(line) });
  const ask = (channel, ...args) => handlers[channel]({}, ...args);
  return { kitDir, ctx, handlers, ask, sent, logged };
}

// The ollama-runtime pack's one step is done once its binary is on disk.
function placeOllama(kitDir) {
  mkdirSync(join(kitDir, "ollama"), { recursive: true });
  writeFileSync(join(kitDir, "ollama", exeName("ollama")), "");
}

const until = async (cond) => { while (!cond()) await new Promise((r) => setTimeout(r, 5)); };

test("the page's four pack channels are answered", () => {
  assert.deepEqual(Object.keys(setup().handlers),
    ["shell:install-pack", "shell:cancel-pack", "shell:remove-pack", "shell:pack-status"]);
});

test("an unknown pack, or a build with nothing to install from, is refused before anything runs", async () => {
  const s = setup();
  assert.deepEqual(await s.ask("shell:install-pack", "nope"), { ok: false, reason: "Unknown pack: nope" });
  const bare = setup({ installCtx: false });
  assert.deepEqual(await bare.ask("shell:install-pack", "engine"),
    { ok: false, reason: "This build carries no bundled files to install from." });
  assert.deepEqual([...s.sent, ...bare.sent, ...s.logged, ...bare.logged], []);
});

test("an install runs the pack's steps, reports the pack's percent, starts its process and clears its stamp", async () => {
  const marker = (s) => join(s.kitDir, ".install", "ollama-runtime.installing");
  const stampedWhileStarting = [];
  const s = setup({ engines: { startPack: async (id) => { stampedWhileStarting.push(id, existsSync(marker(s))); } } });
  placeOllama(s.kitDir);
  assert.deepEqual(await s.ask("shell:install-pack", "ollama-runtime"), { ok: true });

  assert.deepEqual(stampedWhileStarting, ["ollama-runtime", true], "started once, while the backend was told it was installing");
  assert.equal(existsSync(marker(s)), false);
  const [[channel, step], starting] = s.sent;
  assert.equal(channel, "shell:install-progress");
  assert.equal(step.stepId, "ollama-runtime");
  assert.equal(step.state, "skipped");
  assert.equal(step.pack, "ollama-runtime");
  assert.equal(step.pct, 100);
  assert.deepEqual(starting, ["shell:install-progress",
    { pack: "ollama-runtime", stepId: "start", title: "Installed. Starting it up", state: "progress", pct: 100 }]);
  assert.deepEqual(s.logged, [
    "PERSODUB_PACK install ollama-runtime: ollama-runtime",
    "pack ollama-runtime [Step 1/1] ollama-runtime SKIPPED (already done)",
    'PERSODUB_PACK ollama-runtime process up: {"version":1}',
    "PERSODUB_PACK install ollama-runtime ok",
  ]);
});

test("one pack installs at a time", async () => {
  let release = null;
  const s = setup({ engines: { startPack: () => new Promise((r) => { release = r; }) } });
  placeOllama(s.kitDir);
  const first = s.ask("shell:install-pack", "ollama-runtime");
  await until(() => release);
  assert.deepEqual(await s.ask("shell:install-pack", "subtitle-eraser"),
    { ok: false, reason: "ollama-runtime is still installing. Wait for it to finish." });
  release();
  assert.deepEqual(await first, { ok: true });
});

test("a pack that installed but would not start says why, in one line", async () => {
  const s = setup({ engines: { startPack: async () => {
    throw new Error('Traceback (most recent call last):\n  File "x.py", line 1\nOSError: [WinError 126] c10.dll');
  } } });
  placeOllama(s.kitDir);
  assert.deepEqual(await s.ask("shell:install-pack", "ollama-runtime"),
    { ok: false, reason: "Installed, but it could not start: OSError: [WinError 126] c10.dll" });
  assert.match(s.logged.at(-1), /^PERSODUB_PACK ollama-runtime installed but did not start: Traceback/);
  assert.equal(existsSync(join(s.kitDir, ".install", "ollama-runtime.installing")), false);
});

test("a cancelled install answers Cancelled, and a failed download names its own last line", async (t) => {
  let fail = null;
  const s = setup({ download: () => new Promise((_resolve, reject) => { fail = reject; }) });
  // The step really runs here, so the pack's disk preflight has to pass first.
  const bytes = packSteps(buildSteps(s.ctx.installCtx), "ollama-runtime")[0].bytes;
  if (notEnoughSpace(bytes, await freeSpaceAt(s.kitDir))) return t.skip("not enough free disk for the pack's preflight");

  const cancelled = s.ask("shell:install-pack", "ollama-runtime");
  await until(() => fail);
  await s.ask("shell:cancel-pack");
  // A killed download reads like a network error; a cancel must not retry it.
  fail(new Error("ECONNRESET"));
  assert.deepEqual(await cancelled, { ok: false, reason: "Cancelled." });
  // shell.log: the banner bare, the step's own lines named for the pack.
  assert.ok(s.logged.includes("##############################"), s.logged.join("\n"));
  assert.ok(s.logged.includes("pack ollama-runtime [Step 1/1] ollama-runtime START"), s.logged.join("\n"));
  assert.ok(s.logged.some((l) => /^pack ollama-runtime \[Step 1\/1\] ollama-runtime FAILED \(\d+\.\ds\): ECONNRESET$/.test(l)), s.logged.join("\n"));

  fail = null;
  const broken = s.ask("shell:install-pack", "ollama-runtime");
  await until(() => fail);
  fail(new Error("download failed 404: https://example.com/ollama.tgz"));
  assert.deepEqual(await broken, { ok: false, reason: "download failed 404: https://example.com/ollama.tgz" });
  assert.equal(existsSync(join(s.kitDir, ".install", "ollama-runtime.installing")), false);
});

test("pack status is read from the kit's disk, the booted kit's when nothing is being installed", async () => {
  const s = setup({ installCtx: false });
  assert.deepEqual(await s.ask("shell:pack-status"),
    { engine: "missing", "ollama-runtime": "missing", "subtitle-eraser": "missing" });
  s.ctx.bootedKitDir = s.kitDir;
  mkdirSync(join(s.kitDir, ".install"), { recursive: true });
  writeFileSync(join(s.kitDir, ".install", "venv-eraser.ok"), "");
  assert.deepEqual(await s.ask("shell:pack-status"),
    { engine: "missing", "ollama-runtime": "missing", "subtitle-eraser": "ready" });
});

test("removing a pack stops its process and takes its folders and done-stamps", async () => {
  const stopped = [];
  const s = setup({ engines: { stopPack: (id) => stopped.push(id) } });
  placeOllama(s.kitDir);
  mkdirSync(join(s.kitDir, ".install"), { recursive: true });
  writeFileSync(join(s.kitDir, ".install", "ollama-runtime.ok"), "");
  assert.deepEqual(await s.ask("shell:remove-pack", "ollama-runtime"), { ok: true });
  assert.deepEqual(stopped, ["ollama-runtime"]);
  assert.equal(existsSync(join(s.kitDir, "ollama")), false);
  assert.equal(existsSync(join(s.kitDir, ".install", "ollama-runtime.ok")), false);
  assert.deepEqual(await s.ask("shell:remove-pack", "nope"), { ok: false, reason: "Unknown pack: nope" });
  assert.deepEqual(await setup({ installCtx: false }).ask("shell:remove-pack", "engine"),
    { ok: false, reason: "No kit to remove it from." });
});
