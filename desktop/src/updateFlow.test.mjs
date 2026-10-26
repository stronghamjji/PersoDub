// The update check's wiring before it reaches electron-updater.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createUpdater } from "./updateFlow.js";

test("a production build made without an update address checks nothing and says so once in shell.log", async () => {
  const lines = [];
  const { startUpdater } = createUpdater({ app: { isPackaged: true }, ctx: {}, shellLog: (l) => lines.push(l),
                                           edition: "production", built: {} });
  await startUpdater({ isDestroyed: () => false }, null);
  assert.deepEqual(lines, ["UPDATE CHECK OFF: this production build has no update address (PERSODUB_UPDATE_URL was not set when it was built)"]);
});
