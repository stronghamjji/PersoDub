// Every IPC channel has three halves that must agree: the preload exposes it,
// the main process answers it (or announces on it), and the page uses it. A
// channel renamed in one half and not another fails silently -- an invoke that
// nothing handles leaves the page's promise waiting forever, an announcement
// nobody listens for just disappears -- so this reads all three and fails on
// any channel that is not wired the whole way through.
//
// Run with: node --test desktop/src/preloadContract.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(SRC_DIR, "..");
const REPO = join(DESKTOP, "..");
const read = (file) => readFileSync(file, "utf8");
const filesIn = (dir, keep) => readdirSync(dir).filter(keep).map((f) => join(dir, f));

// Wired in the preload and in the main process, and used by no page. Listed
// rather than removed: unused today, kept until the owner decides.
const UNUSED_BY_PAGE = new Set(["shell:relaunch", "shell:pack-status", "shell:last-report", "shell:report-sent"]);

// The preload: each exposed function's name, its channel, and how it uses it.
const preload = read(join(DESKTOP, "preload.cjs"));
const exposed = [...preload.matchAll(/^\s*(\w+):\s*\([^)]*\)\s*=>\s*ipcRenderer\.(invoke|send|on)\(\s*"([^"]+)"/gm)]
  .map(([, name, how, channel]) => ({ name, how, channel }));

// The main process: main.js and the modules beside it, wherever a handler is
// registered. Each way the preload can use a channel has its own answer.
const mainCode = [join(DESKTOP, "main.js"), ...filesIn(SRC_DIR, (f) => f.endsWith(".js"))].map(read).join("\n");
const channels = (re) => new Set([...mainCode.matchAll(re)].map((m) => m[1]));
const answered = {
  invoke: channels(/ipcMain\.handle\(\s*"([^"]+)"/g),   // ipcRenderer.invoke -> ipcMain.handle
  send: channels(/ipcMain\.on\(\s*"([^"]+)"/g),         // ipcRenderer.send   -> ipcMain.on
  on: channels(/webContents\.send\(\s*"([^"]+)"/g),     // ipcRenderer.on     <- webContents.send
};

// The page: the app's page and its modules, and the shell's own screens.
const pageCode = [
  join(REPO, "static", "index.html"),
  ...filesIn(join(REPO, "ui", "src"), (f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs")),
  ...filesIn(join(DESKTOP, "screens"), (f) => f.endsWith(".html")),
].map(read).join("\n");
const pageUses = (name) => new RegExp(`\\.${name}\\b`).test(pageCode);

test("the preload's functions were all read", () => {
  // One exposed function per ipcRenderer call: a line this test could not
  // parse would otherwise drop out of every check below without a word.
  assert.equal(exposed.length, preload.match(/ipcRenderer\.(invoke|send|on)\(/g).length);
  assert.ok(exposed.length >= 15, `found ${exposed.length}`);
});

test("every channel the preload exposes is answered by the main process, the same way", () => {
  for (const { name, how, channel } of exposed) {
    assert.ok(answered[how].has(channel),
      `${name} uses ipcRenderer.${how}("${channel}"), which the main process does not answer that way`);
  }
});

test("every channel the main process answers or announces is exposed by the preload", () => {
  for (const [how, wired] of Object.entries(answered)) {
    for (const channel of wired) {
      assert.ok(exposed.some((e) => e.how === how && e.channel === channel),
        `the main process wires "${channel}", which the preload does not expose through ipcRenderer.${how}`);
    }
  }
});

test("the page uses every function the preload exposes, apart from the ones listed as unused", () => {
  for (const { name, channel } of exposed) {
    if (UNUSED_BY_PAGE.has(channel)) {
      assert.ok(!pageUses(name), `the page uses ${name} now: take "${channel}" off UNUSED_BY_PAGE`);
    } else {
      assert.ok(pageUses(name), `no page uses ${name} ("${channel}")`);
    }
  }
  for (const channel of UNUSED_BY_PAGE) {
    assert.ok(exposed.some((e) => e.channel === channel), `"${channel}" is listed as unused, but the preload no longer has it`);
  }
});

// The repository the build points at is a value, not a channel, with three
// halves of its own: the main process puts it on the window's command line,
// the preload reads it back as `repo`, and the page builds its GitHub links
// from it. A flag spelled differently on the two sides would leave every
// build's links on the public repository without a word.
test("the build's repository goes from the window's arguments through the preload's repo to the page", () => {
  const flag = preload.match(/const REPO_ARG = "([^"]+)";/)?.[1];
  assert.ok(flag, "the preload no longer names the flag it reads the repository from");
  assert.match(preload, /^\s*repo: process\.argv\.find\(\(a\) => a\.startsWith\(REPO_ARG\)\)/m);
  assert.ok(mainCode.includes(`additionalArguments: [\`${flag}`), `the main process does not pass ${flag} to the window`);
  assert.match(pageCode, /window\.persodubShell\?\.repo\b/, "no page reads persodubShell.repo");
});

// The computer's language the same way: the window passes it, the preload reads
// it back as `locale`, and the page asks for it when the setting is Auto.
test("the computer's language goes from the window's arguments through the preload's locale to the page", () => {
  const flag = preload.match(/const LOCALE_ARG = "([^"]+)";/)?.[1];
  assert.ok(flag, "the preload no longer names the flag it reads the locale from");
  assert.match(preload, /^\s*locale: process\.argv\.find\(\(a\) => a\.startsWith\(LOCALE_ARG\)\)/m);
  assert.ok(mainCode.includes(`\`${flag}\${locale}\``), `the main process does not pass ${flag} to the window`);
  assert.match(pageCode, /window\?\.persodubShell\?\.locale\b/, "no page reads persodubShell.locale");
});
