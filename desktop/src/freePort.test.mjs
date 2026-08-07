import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { getFreePort } from "./freePort.js";

test("returned port is bindable", async () => {
  const port = await getFreePort();
  assert.ok(Number.isInteger(port) && port > 0);
  await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(port, "127.0.0.1", () => srv.close(resolve));
    srv.on("error", reject);
  });
});
