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

// The backend's port used to be a fresh free one every launch, which made
// every launch a new browser origin: localStorage (the "Updated to" notice's
// seen-version, timeline state, pane sizes) came up empty each time. The
// shell now asks for last launch's port first and only falls back to a
// free one when something else holds it.
import { getPreferredPort } from "./freePort.js";

test("a free preferred port is returned as is", async () => {
  const preferred = await getFreePort();
  assert.equal(await getPreferredPort(preferred), preferred);
});

test("a busy preferred port yields a different, bindable port", async () => {
  const busy = await getFreePort();
  const holder = createServer();
  await new Promise((resolve) => holder.listen(busy, "127.0.0.1", resolve));
  try {
    const port = await getPreferredPort(busy);
    assert.notEqual(port, busy);
    await new Promise((resolve, reject) => {
      const srv = createServer();
      srv.listen(port, "127.0.0.1", () => srv.close(resolve));
      srv.on("error", reject);
    });
  } finally {
    await new Promise((resolve) => holder.close(resolve));
  }
});

test("no or nonsense preference just means a free port", async () => {
  for (const bad of [undefined, null, 0, -1, 80, "abc", 70000]) {
    const port = await getPreferredPort(bad);
    assert.ok(Number.isInteger(port) && port > 1024, `got ${port} for ${bad}`);
  }
});
