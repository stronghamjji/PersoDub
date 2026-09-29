import test from "node:test";
import assert from "node:assert/strict";
import { setupText, setupPercent, watchSetup } from "./chatgptSetup.mjs";

test("the line is two words and a percent", () => {
  assert.equal(setupText({ stage: "download", got: 60e6, total: 133e6 }), "First-time setup 45%");
  assert.equal(setupText({ stage: "download", got: 12e6, total: 0 }), "First-time setup");
  assert.equal(setupText({ stage: "unpack", got: 133e6, total: 133e6 }), "First-time setup 100%");
  assert.equal(setupText({ stage: "", got: 0, total: 0 }), "");
});

test("the bar follows the bytes and is full while unpacking", () => {
  assert.equal(Math.round(setupPercent({ stage: "download", got: 50, total: 200 })), 25);
  assert.equal(setupPercent({ stage: "download", got: 5, total: 0 }), null);
  assert.equal(setupPercent({ stage: "unpack", got: 1, total: 1 }), 100);
});

test("watching stops when asked", async () => {
  const seen = [];
  const stop = watchSetup((p) => seen.push(p), async () => ({ json: async () => ({ stage: "download", got: 1, total: 2 }) }));
  await new Promise((r) => setTimeout(r, 20));
  stop();
  const n = seen.length;
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(n, 1);
  assert.equal(seen.length, 1);
});
