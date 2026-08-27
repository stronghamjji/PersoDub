// The desktop shell is a GUI process, so on Windows every console program it
// spawns (taskkill, tar, pip, ollama...) pops up a console window unless the
// spawn passes windowsHide: true. Those windows flashed on the user's screen at
// every launch and quit before the option was added everywhere. The option is
// ignored on other platforms, so there is never a reason to omit it -- this
// test reads the shell's sources and fails on any spawn call that does.
//
// Run with: node --test desktop/src/windowsHide.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const SHELL_FILES = [
  join(SRC_DIR, "..", "main.js"),
  ...readdirSync(SRC_DIR)
    .filter((f) => f.endsWith(".js"))
    .map((f) => join(SRC_DIR, f)),
];

// The full argument list of one spawn()/spawnSync() call, found by walking to
// the parenthesis that closes the call -- the options object with windowsHide
// sits inside it, usually a couple of lines below the opening line.
function spawnCalls(code) {
  const calls = [];
  for (const m of code.matchAll(/\b(spawn|spawnSync)\s*\(/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < code.length && depth > 0) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")") depth--;
      i++;
    }
    calls.push({
      text: code.slice(m.index, i),
      line: code.slice(0, m.index).split("\n").length,
    });
  }
  return calls;
}

test("every spawn in the desktop shell hides its console window", () => {
  let seen = 0;
  for (const file of SHELL_FILES) {
    const code = readFileSync(file, "utf8");
    for (const { text, line } of spawnCalls(code)) {
      seen++;
      assert.ok(
        text.includes("windowsHide"),
        `${file}:${line} spawns without windowsHide: true -- on Windows this flashes a console window:\n${text}`,
      );
    }
  }
  // Were the shell ever refactored away from child_process, an empty scan
  // would pass forever without checking anything -- fail loudly instead.
  assert.ok(seen >= 3, `expected the shell's spawn calls, found ${seen}`);
});
