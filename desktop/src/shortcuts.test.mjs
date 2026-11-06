// Run with: node --test desktop/src/shortcuts.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { blockedKey } from "./shortcuts.js";

const down = (key, mods = {}) => ({ type: "keyDown", key, control: false, meta: false, shift: false, alt: false, ...mods });

test("the keys that closed, reloaded, zoomed or opened the tools are swallowed on each system", () => {
  for (const key of ["w", "W", "r", "R", "=", "+", "-", "_", "0"]) {
    assert.equal(blockedKey(down(key, { meta: true }), "darwin"), true, `Cmd+${key}`);
    assert.equal(blockedKey(down(key, { control: true }), "win32"), true, `Ctrl+${key}`);
  }
  assert.equal(blockedKey(down("r", { meta: true, shift: true }), "darwin"), true, "Cmd+Shift+R");
  assert.equal(blockedKey(down("i", { meta: true, alt: true }), "darwin"), true, "Cmd+Alt+I");
  assert.equal(blockedKey(down("i", { control: true, shift: true }), "win32"), true, "Ctrl+Shift+I");
  assert.equal(blockedKey(down("f", { meta: true, control: true }), "darwin"), true, "Ctrl+Cmd+F");
  for (const key of ["F5", "F11", "F12"]) {
    assert.equal(blockedKey(down(key), "win32"), true, key);
    assert.equal(blockedKey(down(key), "darwin"), true, key);
  }
});

test("the page's own keys and the other system's modifier go through", () => {
  for (const key of ["c", "v", "z", "a", "s", "i", "f"]) {
    assert.equal(blockedKey(down(key, { meta: true }), "darwin"), false, `Cmd+${key}`);
    assert.equal(blockedKey(down(key, { control: true }), "win32"), false, `Ctrl+${key}`);
  }
  assert.equal(blockedKey(down("w", { control: true }), "darwin"), false, "Ctrl+W on a Mac is not the close key");
  assert.equal(blockedKey(down("w", { meta: true }), "win32"), false, "Win+W is not the close key");
  assert.equal(blockedKey(down("w"), "win32"), false, "a bare w types");
  assert.equal(blockedKey(down("Backspace"), "win32"), false);
  assert.equal(blockedKey(down("Escape"), "darwin"), false);
  assert.equal(blockedKey(down("ArrowLeft", { alt: true }), "win32"), false, "Alt+Left never navigated here");
  assert.equal(blockedKey({ type: "keyUp", key: "w", meta: true }, "darwin"), false, "only the press is swallowed");
});
