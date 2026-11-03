// Run with: node --test desktop/src/errorText.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { errorText } from "./errorText.js";

test("an error reads as its message, anything else as itself", () => {
  assert.equal(errorText(new Error("disk full")), "disk full");
  assert.equal(errorText("exit 1"), "exit 1");
  assert.equal(errorText(undefined), "undefined");
  // An empty message is no use: the error's own text stands in for it.
  assert.equal(errorText(new Error("")), "Error");
});

test("a system error's code and path join a message that lacks them", () => {
  // A spawn error names the code and nothing else; an fs error already holds both.
  assert.equal(errorText(Object.assign(new Error("spawn failed"), { code: "ENOENT", path: "C:\\x\\app" })), "spawn failed [ENOENT C:\\x\\app]");
  assert.equal(errorText(Object.assign(new Error("EACCES: permission denied, mkdir '/k/app'"), { code: "EACCES", path: "/k/app" })),
    "EACCES: permission denied, mkdir '/k/app'");
});
