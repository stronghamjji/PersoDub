import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { getFreePort } from "./freePort.js";
import { waitForHealth } from "./health.js";

function serveJson(port, handler) {
  const srv = createServer((req, res) => {
    const body = handler();
    res.writeHead(body === null ? 503 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? {}));
  });
  return new Promise((resolve) => srv.listen(port, "127.0.0.1", () => resolve(srv)));
}

test("resolves once predicate is satisfied", async () => {
  const port = await getFreePort();
  let calls = 0;
  const srv = await serveJson(port, () => (++calls >= 3 ? { model_loaded: true } : { model_loaded: false }));
  const body = await waitForHealth(`http://127.0.0.1:${port}/health`, {
    timeoutMs: 5000, intervalMs: 50, predicate: (b) => b.model_loaded === true,
  });
  assert.equal(body.model_loaded, true);
  srv.close();
});

test("rejects after timeout when server never becomes healthy", async () => {
  const port = await getFreePort();
  await assert.rejects(
    waitForHealth(`http://127.0.0.1:${port}/health`, { timeoutMs: 300, intervalMs: 50 }),
    (err) => err.message.includes(String(port)),
  );
});
