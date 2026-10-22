import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { getFreePort } from "./freePort.js";
import { download, fileSha256 } from "./download.js";
import { worthRetrying } from "./installer.js";

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

test("a server error's message is one the installer tries again", async () => {
  const port = await getFreePort();
  const srv = createServer((req, res) => { res.writeHead(503); res.end("Backend is unhealthy"); });
  await new Promise((r) => srv.listen(port, "127.0.0.1", r));
  const dest = join(mkdtempSync(join(tmpdir(), "oddl-")), "f.bin");
  await assert.rejects(download(`http://127.0.0.1:${port}/f`, dest), (err) => worthRetrying(err.message));
  srv.close();
});

// shell.log's lines for one download (log gets each line and its level; the
// level is left out for INFO). A second local server redirects to the first,
// so the host that answered differs from the one asked.
const logInto = (lines) => (line, level = "INFO") => lines.push(`${level} ${line}`);

test("a download says where from and where to, who answered after the redirect, and that its sha256 was checked", async () => {
  const { srv, url } = await serve();
  const port = await getFreePort();
  const hop = createServer((req, res) => { res.writeHead(302, { location: url }); res.end(); });
  await new Promise((r) => hop.listen(port, "127.0.0.1", r));
  const dest = join(mkdtempSync(join(tmpdir(), "oddl-")), "f.bin");
  const lines = [];
  await download(`http://127.0.0.1:${port}/f?token=secret`, dest, { sha256: SHA, what: "python", log: logInto(lines) });
  assert.equal(lines.length, 3, lines.join("\n"));
  assert.equal(lines[0], `INFO DOWNLOAD START python from http://127.0.0.1:${port}/f?… to ${dest}`);
  assert.equal(lines[1], `INFO DOWNLOAD CONNECTED python: HTTP 200 from ${new URL(url).host}, 14 B`);
  assert.match(lines[2], /^INFO DOWNLOAD DONE python: 14 B in \d+\.\ds \(\d+\.\d MB\/s\), sha256 ok$/);
  srv.close();
  hop.close();
});

test("a download without a sha256 says it was not checked, and a file already there says so", async () => {
  const { srv, url } = await serve();
  const dest = join(mkdtempSync(join(tmpdir(), "oddl-")), "f.bin");
  const lines = [];
  await download(url, dest, { what: "campplus", log: logInto(lines) });
  assert.match(lines.at(-1), /^INFO DOWNLOAD DONE campplus: 14 B in \d+\.\ds \(\d+\.\d MB\/s\), not checked$/);
  await download(url, dest, { sha256: SHA, what: "campplus", log: logInto(lines) });
  assert.match(lines.at(-1), /^INFO DOWNLOAD DONE campplus: 14 B in \d+\.\ds \(already on disk\), sha256 ok$/);
  srv.close();
});

test("a sha256 that does not match is a FAILED line at ERROR, with the host", async () => {
  const { srv, url } = await serve();
  const dest = join(mkdtempSync(join(tmpdir(), "oddl-")), "f.bin");
  const lines = [];
  await assert.rejects(download(url, dest, { sha256: "0".repeat(64), what: "eraser-src", log: logInto(lines) }), /sha256/i);
  assert.equal(lines.length, 3, lines.join("\n"));
  assert.ok(lines[2].startsWith("ERROR DOWNLOAD FAILED eraser-src after "), lines[2]);
  assert.ok(lines[2].includes(`sha256 mismatch for ${url}: got ${SHA}`), lines[2]);
  assert.ok(lines[2].endsWith(` (${new URL(url).host})`), lines[2]);
  srv.close();
});

test("a server error is a FAILED line with the status and the host, and no CONNECTED line", async () => {
  const port = await getFreePort();
  const srv = createServer((req, res) => { res.writeHead(503); res.end("Backend is unhealthy"); });
  await new Promise((r) => srv.listen(port, "127.0.0.1", r));
  const dest = join(mkdtempSync(join(tmpdir(), "oddl-")), "f.bin");
  const lines = [];
  await assert.rejects(download(`http://127.0.0.1:${port}/f`, dest, { what: "ollama-runtime", log: logInto(lines) }),
    (err) => worthRetrying(err.message));
  assert.equal(lines.length, 2, lines.join("\n"));
  assert.equal(lines[0], `INFO DOWNLOAD START ollama-runtime from http://127.0.0.1:${port}/f to ${dest}`);
  assert.match(lines[1], new RegExp(String.raw`^ERROR DOWNLOAD FAILED ollama-runtime after \d+\.\ds: HTTP 503 Service Unavailable \(127\.0\.0\.1:${port}\)$`));
  srv.close();
});

test("fileSha256 computes the digest", async () => {
  const dest = join(mkdtempSync(join(tmpdir(), "oddl-")), "x");
  writeFileSync(dest, BODY);
  assert.equal(await fileSha256(dest), SHA);
});

// A cut line part-way through an archive used to start it over from the first
// byte: the .part was opened fresh on every try (owner, 2026-10-22, 1-3).
// This server answers a Range request the way GitHub's file host does.
async function serveRanges(body = BODY) {
  const port = await getFreePort();
  const asked = [];
  const srv = createServer((req, res) => {
    asked.push(req.headers.range || "");
    const m = /^bytes=(\d+)-$/.exec(req.headers.range || "");
    if (!m) { res.writeHead(200, { "content-length": body.length }); res.end(body); return; }
    const from = Number(m[1]);
    if (from >= body.length) { res.writeHead(416, { "content-range": `bytes */${body.length}` }); res.end(); return; }
    res.writeHead(206, { "content-length": body.length - from, "content-range": `bytes ${from}-${body.length - 1}/${body.length}` });
    res.end(body.subarray(from));
  });
  await new Promise((r) => srv.listen(port, "127.0.0.1", r));
  return { srv, url: `http://127.0.0.1:${port}/f`, asked };
}

test("a download cut off part-way asks only for the rest, and the joined file passes its sha256", async () => {
  const { srv, url, asked } = await serveRanges();
  const dest = join(mkdtempSync(join(tmpdir(), "oddl-")), "f.bin");
  writeFileSync(dest + ".part", BODY.subarray(0, 6));
  const lines = [];
  const seen = [];
  await download(url, dest, { sha256: SHA, what: "ollama-runtime", log: logInto(lines),
                              onProgress: (p) => seen.push([p.received, p.total]) });
  assert.deepEqual(asked, ["bytes=6-"]);
  assert.equal(readFileSync(dest).toString(), "hello-persodub");
  assert.ok(!existsSync(dest + ".part"));
  assert.deepEqual(seen.at(-1), [BODY.length, BODY.length], "the percent counts what was already there");
  assert.match(lines[1], /^INFO DOWNLOAD CONNECTED ollama-runtime: HTTP 206 from .*, 14 B, resuming at 6 B$/);
  srv.close();
});

test("a piece that is not this file fails its sha256 once, and the next try fetches the whole file", async () => {
  const { srv, url, asked } = await serveRanges();
  const dest = join(mkdtempSync(join(tmpdir(), "oddl-")), "f.bin");
  writeFileSync(dest + ".part", "WRONG!");
  await assert.rejects(download(url, dest, { sha256: SHA }), /sha256/i);
  assert.ok(!existsSync(dest + ".part"), "the bad piece goes");
  await download(url, dest, { sha256: SHA });
  assert.deepEqual(asked, ["bytes=6-", ""]);
  assert.equal(readFileSync(dest).toString(), "hello-persodub");
  srv.close();
});

test("a piece longer than the file, or a server that sends it all again, starts the file over", async () => {
  const ranges = await serveRanges();
  const dest = join(mkdtempSync(join(tmpdir(), "oddl-")), "f.bin");
  writeFileSync(dest + ".part", "x".repeat(40));
  await download(ranges.url, dest, { sha256: SHA });
  assert.deepEqual(ranges.asked, ["bytes=40-", ""], "416, then the whole file");
  assert.equal(readFileSync(dest).toString(), "hello-persodub");
  ranges.srv.close();

  const { srv, url } = await serve();   // no Range: always 200 and the whole body
  const dest2 = join(mkdtempSync(join(tmpdir(), "oddl-")), "f.bin");
  writeFileSync(dest2 + ".part", "hello");
  await download(url, dest2, { sha256: SHA });
  assert.equal(readFileSync(dest2).toString(), "hello-persodub", "written over, not added to");
  srv.close();
});

test("without a sha256 to prove it by, a piece is never picked up", async () => {
  const { srv, url, asked } = await serveRanges();
  const dest = join(mkdtempSync(join(tmpdir(), "oddl-")), "f.bin");
  writeFileSync(dest + ".part", "hello");
  await download(url, dest);
  assert.deepEqual(asked, [""]);
  assert.equal(readFileSync(dest).toString(), "hello-persodub");
  srv.close();
});
