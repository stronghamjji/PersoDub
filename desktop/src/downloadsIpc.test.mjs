// Run with: node --test desktop/src/downloadsIpc.test.mjs
// Electron's download item, the system file window and the folder picker are
// stand-ins; the Downloads folder, the kit and the folder picked are temp folders.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerDownloadIpc } from "./downloadsIpc.js";

// `kitEnv`: the kit's kit.env, when the test wants a kit. `picks`: what the
// folder picker answers, one press of Change after another.
function setup({ kitEnv = null, picks = [] } = {}) {
  const downloads = mkdtempSync(join(tmpdir(), "oddownloads-"));
  const on = {};
  const handle = {};
  const shown = [];
  const logged = [];
  const opened = [];
  const ctx = { bootedKitDir: null, win: { id: "the window" } };
  if (kitEnv !== null) {
    ctx.bootedKitDir = mkdtempSync(join(tmpdir(), "odkit-"));
    writeFileSync(join(ctx.bootedKitDir, "kit.env"), kitEnv);
  }
  const { willDownload } = registerDownloadIpc({
    app: { getPath: (name) => (name === "downloads" ? downloads : null) },
    ipcMain: { on: (channel, fn) => { on[channel] = fn; }, handle: (channel, fn) => { handle[channel] = fn; } },
    shell: { showItemInFolder: (path) => shown.push(path) },
    dialog: { showOpenDialog: async (win, options) => {
      opened.push([win, options]);
      return picks.shift() || { canceled: true, filePaths: [] };
    } },
    ctx, shellLog: (line) => logged.push(line),
  });
  const kitEnvNow = () => readFileSync(join(ctx.bootedKitDir, "kit.env"), "utf8");
  return { downloads, on, handle, shown, logged, opened, ctx, willDownload, kitEnvNow };
}

// A download as Electron hands it over, saved at `savePath` unless renamed.
function item(url, filename, savePath) {
  return {
    savePath,
    getURL: () => url,
    getFilename: () => filename,
    setSavePath(path) { this.savePath = path; },
    getSavePath() { return this.savePath; },
    once(_event, fn) { this.done = fn; },
  };
}

test("a finished job's file lands in Downloads/<day>/<project> without overwriting, and the page hears where", () => {
  const s = setup();
  s.on["shell:remember-job"]({}, { id: "abc123", project: "Ep 1", day: "2026-10-10" });
  const folder = join(s.downloads, "2026-10-10", "Ep 1");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "dub_en.mp4"), "an earlier export");
  const dub = item("http://127.0.0.1:5001/api/dub/jobs/abc123/download", "dub_en.mp4", join(s.downloads, "dub_en.mp4"));
  const told = [];
  s.willDownload({}, dub, { isDestroyed: () => false, send: (channel, info) => told.push([channel, info]) });
  assert.equal(dub.getSavePath(), join(folder, "dub_en_001.mp4"));
  dub.done({}, "completed");
  assert.deepEqual(told, [["shell:download-done",
    { state: "completed", path: join(folder, "dub_en_001.mp4"), filename: "dub_en_001.mp4", folder }]]);
});

// The separated sounds are not a job the page described: they go loose in the
// download folder, under their own name and never over another file.
test("a download the page never described goes loose in the download folder, and still reports", () => {
  const s = setup();
  writeFileSync(join(s.downloads, "x.mp4"), "an earlier one");
  const plain = item("http://127.0.0.1:5001/api/dub/result/ffffff/stem/voice", "x.mp4", join(s.downloads, "x.mp4"));
  const told = [];
  s.willDownload({}, plain, { isDestroyed: () => false, send: (_channel, info) => told.push(info.path) });
  assert.equal(plain.getSavePath(), join(s.downloads, "x_001.mp4"));
  plain.done({}, "cancelled");
  assert.deepEqual(told, [join(s.downloads, "x_001.mp4")]);
});

test("only a file inside Downloads or the kit is shown; anything else is refused and logged", () => {
  const s = setup();
  s.ctx.bootedKitDir = mkdtempSync(join(tmpdir(), "odkit-"));
  assert.deepEqual(s.handle["shell:reveal"]({}, join(s.downloads, "a.mp4")), { ok: true });
  assert.deepEqual(s.handle["shell:reveal"]({}, join(s.ctx.bootedKitDir, "logs", "x.log")), { ok: true });
  assert.deepEqual(s.handle["shell:reveal"]({}, "/etc/hosts"), { ok: false });
  assert.deepEqual(s.shown, [join(s.downloads, "a.mp4"), join(s.ctx.bootedKitDir, "logs", "x.log")]);
  assert.deepEqual(s.logged, ["PERSODUB_REVEAL refused: /etc/hosts"]);
});

// ---- the folder Change picks in the Download dialog (owner, 2026-10-22) ----

const KIT_ENV = "PERSODUB_KIT_DIR=/k\nPERSO_API_KEY=secret-value\n";

test("Change keeps the folder picked in kit.env, Use default empties it, and each answers where downloads go", async () => {
  const picked = mkdtempSync(join(tmpdir(), "odpicked-"));
  const s = setup({ kitEnv: KIT_ENV, picks: [{ canceled: false, filePaths: [picked] }, { canceled: true, filePaths: [] }] });
  assert.deepEqual(await s.handle["shell:download-folder"](), { folder: s.downloads, chosen: "", missing: false });
  assert.deepEqual(await s.handle["shell:pick-download-folder"](), { folder: picked, chosen: picked, missing: false });
  // The computer's own picker, over the window, for a folder (a new one may be
  // made in it), open on the folder in use.
  assert.deepEqual(s.opened, [[s.ctx.win, { properties: ["openDirectory", "createDirectory"], defaultPath: s.downloads }]]);
  // The one line, the user's keys as they were, and the file as it was kept beside it.
  assert.equal(s.kitEnvNow(), `${KIT_ENV}PERSODUB_DOWNLOAD_DIR=${picked}\n`);
  assert.equal(readFileSync(join(s.ctx.bootedKitDir, "kit.env.bak"), "utf8"), KIT_ENV);
  // The picker closed without a folder: nothing changes, and it opened on the one in use.
  assert.deepEqual(await s.handle["shell:pick-download-folder"](), { folder: picked, chosen: picked, missing: false });
  assert.equal(s.opened[1][1].defaultPath, picked);
  // Use default: an empty line rather than none, which outranks the folder the
  // engine started with in its environment (app/settings_env.py current_value).
  assert.deepEqual(await s.handle["shell:reset-download-folder"](), { folder: s.downloads, chosen: "", missing: false });
  assert.equal(s.kitEnvNow(), `${KIT_ENV}PERSODUB_DOWNLOAD_DIR=\n`);
  // The log says what changed and never the folder: shell.log goes out with failure reports.
  assert.deepEqual(s.logged, ["PERSODUB_DOWNLOAD_FOLDER picked", "PERSODUB_DOWNLOAD_FOLDER back to Downloads"]);
});

test("a finished job's files land in <picked>/<day>/<project>, and a download the page never described loose in it", () => {
  const picked = mkdtempSync(join(tmpdir(), "odpicked-"));
  const s = setup({ kitEnv: `${KIT_ENV}PERSODUB_DOWNLOAD_DIR=${picked}\n` });
  s.on["shell:remember-job"]({}, { id: "abc123", project: "Ep 1", day: "2026-10-22" });
  const folder = join(picked, "2026-10-22", "Ep 1");
  const send = { isDestroyed: () => false, send: () => {} };
  const first = item("http://127.0.0.1:5001/api/dub/result/abc123/audio?format=mp3", "dub_en.mp3", join(s.downloads, "dub_en.mp3"));
  s.willDownload({}, first, send);
  assert.equal(first.getSavePath(), join(folder, "dub_en.mp3"), "the dated folders are made inside the one picked");
  writeFileSync(first.getSavePath(), "the first export");
  const again = item("http://127.0.0.1:5001/api/dub/result/abc123/audio?format=mp3", "dub_en.mp3", join(s.downloads, "dub_en.mp3"));
  s.willDownload({}, again, send);
  assert.equal(again.getSavePath(), join(folder, "dub_en_001.mp3"), "never over the first");
  const stem = item("http://127.0.0.1:5001/api/dub/result/s9/stem/voice?format=mp3", "clip_voice.mp3", join(s.downloads, "clip_voice.mp3"));
  s.willDownload({}, stem, send);
  assert.equal(stem.getSavePath(), join(picked, "clip_voice.mp3"));
  // Show opens a file in the folder picked, and still nothing outside the folders the app writes into.
  assert.deepEqual(s.handle["shell:reveal"]({}, join(folder, "dub_en.mp3")), { ok: true });
  assert.deepEqual(s.handle["shell:reveal"]({}, "/etc/hosts"), { ok: false });
});

test("a picked folder that is gone (a drive taken out) is said, and the files go to Downloads meanwhile", async () => {
  const picked = mkdtempSync(join(tmpdir(), "odpicked-"));
  const s = setup({ kitEnv: `${KIT_ENV}PERSODUB_DOWNLOAD_DIR=${picked}\n` });
  rmSync(picked, { recursive: true });
  assert.deepEqual(await s.handle["shell:download-folder"](), { folder: s.downloads, chosen: picked, missing: true });
  s.on["shell:remember-job"]({}, { id: "abc123", project: "Ep 1", day: "2026-10-22" });
  const dub = item("http://127.0.0.1:5001/api/dub/jobs/abc123/download", "dub_en.mp4", join(s.downloads, "dub_en.mp4"));
  s.willDownload({}, dub, { isDestroyed: () => false, send: () => {} });
  assert.equal(dub.getSavePath(), join(s.downloads, "2026-10-22", "Ep 1", "dub_en.mp4"));
  // Kept, not forgotten: back in, the files go there again.
  mkdirSync(picked);
  assert.deepEqual(await s.handle["shell:download-folder"](), { folder: picked, chosen: picked, missing: false });
});

test("a folder that would not be one line in kit.env, or a kit without kit.env, is not kept, and says so", async () => {
  const s = setup({ kitEnv: KIT_ENV, picks: [{ canceled: false, filePaths: ["/Volumes/odd\nPERSO_API_KEY=stolen"] }] });
  assert.deepEqual(await s.handle["shell:pick-download-folder"](), { folder: s.downloads, chosen: "", missing: false });
  assert.equal(s.kitEnvNow(), KIT_ENV, "no line of the picker's making in the engine's settings");
  assert.deepEqual(s.logged, ["PERSODUB_DOWNLOAD_FOLDER not kept (refused)"]);
  // No kit.env at all (a run from source without a kit): the same, quietly to the page.
  const bare = setup({ picks: [{ canceled: false, filePaths: [mkdtempSync(join(tmpdir(), "odpicked-"))] }] });
  bare.ctx.bootedKitDir = mkdtempSync(join(tmpdir(), "odkit-"));
  assert.deepEqual(await bare.handle["shell:pick-download-folder"](), { folder: bare.downloads, chosen: "", missing: false });
  assert.deepEqual(bare.logged, ["PERSODUB_DOWNLOAD_FOLDER not kept (ENOENT)"]);
});
