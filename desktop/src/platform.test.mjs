import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { IS_WIN, hasNvidiaGpu, TORCH_VARIANT } from "./platform.js";

// hasNvidiaGpu takes fake exists/env so it can be tested on any host, the
// same way the rest of this file's helpers are pure functions of their
// inputs -- no real filesystem or environment needed.

test("hasNvidiaGpu is true when nvidia-smi.exe is under SystemRoot\\System32", () => {
  const env = { SystemRoot: "C:\\Windows" };
  const exists = (p) => p === join("C:\\Windows", "System32", "nvidia-smi.exe");
  assert.equal(hasNvidiaGpu({ exists, env }), true);
});

test("hasNvidiaGpu is true when nvidia-smi.exe is on PATH", () => {
  const env = { SystemRoot: "C:\\Windows", PATH: "C:\\nvidia\\bin;C:\\other\\bin" };
  const exists = (p) => p === join("C:\\nvidia\\bin", "nvidia-smi.exe");
  assert.equal(hasNvidiaGpu({ exists, env }), true);
});

test("hasNvidiaGpu is false when nvidia-smi.exe is nowhere", () => {
  const env = { SystemRoot: "C:\\Windows", PATH: "C:\\other\\bin" };
  const exists = () => false;
  assert.equal(hasNvidiaGpu({ exists, env }), false);
});

test("hasNvidiaGpu defaults to the real fs and process.env when not given either", () => {
  // Smoke test for the default parameters -- must not throw, and this
  // machine (whatever it is) plainly has no nvidia-smi.exe.
  assert.equal(typeof hasNvidiaGpu(), "boolean");
});

test("TORCH_VARIANT is mps off Windows, cpu or cu128 on it", () => {
  // Written to pass on whichever platform CI runs it on, the way this file's
  // other IS_WIN-conditioned tests already do.
  if (!IS_WIN) assert.equal(TORCH_VARIANT, "mps");
  else assert.ok(["cpu", "cu128"].includes(TORCH_VARIANT), TORCH_VARIANT);
});
