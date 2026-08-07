import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { getFreePort } from "./freePort.js";
import { download, fileSha256 } from "./download.js";

const BODY = Buffer.from("hello-persodub");
const SHA = createHash("sha256").update(BODY).digest("hex");

async function serve() {
  const port = await getFreePort();
  const srv = createServer((req, res) => { res.writeHead(200, { "content-length": BODY.length }); res.end(BODY); });
  await new Promise((r) => srv.listen(port, "127.0.0.1", r));
  return { srv, url: `http://127.0.0.1:${port}/f` };
}

test("downloads, reports progress, verifies sha", async () => {
  const { srv, url } = await serve();
  const dest = join(mkdtempSync(join(tmpdir(), "oddl-")), "f.bin");
  const seen = [];
  await download(url, dest, { sha256: SHA, onProgress: (p) => seen.push(p.received) });
  assert.equal(readFileSync(dest).toString(), "hello-persodub");
  assert.ok(seen.length >= 1 && seen.at(-1) === BODY.length);
  assert.ok(!existsSync(dest + ".part"));
  srv.close();
});

test("skips when dest already valid; re-downloads when sha differs", async () => {
  const { srv, url } = await serve();
  const dest = join(mkdtempSync(join(tmpdir(), "oddl-")), "f.bin");
  writeFileSync(dest, BODY);
  let hit = false;
  srv.on("request", () => { hit = true; });
  await download(url, dest, { sha256: SHA });
  assert.equal(hit, false, "valid file must not be re-fetched");
  writeFileSync(dest, "corrupted");
  await download(url, dest, { sha256: SHA });
  assert.equal(readFileSync(dest).toString(), "hello-persodub");
  srv.close();
});

test("sha mismatch rejects and removes file", async () => {
  const { srv, url } = await serve();
  const dest = join(mkdtempSync(join(tmpdir(), "oddl-")), "f.bin");
  await assert.rejects(download(url, dest, { sha256: "0".repeat(64) }), /sha256/i);
  assert.ok(!existsSync(dest));
  srv.close();
});

test("fileSha256 computes the digest", async () => {
  const dest = join(mkdtempSync(join(tmpdir(), "oddl-")), "x");
  writeFileSync(dest, BODY);
  assert.equal(await fileSha256(dest), SHA);
});
