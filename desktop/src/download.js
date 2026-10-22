import { createWriteStream, createReadStream, existsSync, renameSync, rmSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { errorText } from "./errorText.js";
import { secondsSince, sizeText, urlText } from "./logLine.js";

export function fileSha256(path) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

// log(line, level) gets the download's lines for shell.log, named by `what`:
// START with where from and where to, CONNECTED with the server's answer and
// the host after any redirect (where the bytes really come from), DONE with
// the size, the time, the speed and whether a sha256 was checked, FAILED at
// ERROR with the reason and that host. No RETRY line comes from here: this
// tries once, and installer.js tries a failed step again whole, which logs
// its own RETRY and then a new START.
//
// What an earlier try left in dest.part is picked up where it stopped (an
// HTTP Range request) instead of fetched again from the first byte: a cut
// line at 1.4 GB of Ollama's 1.5 GB Windows archive started it over (owner,
// 2026-10-22, 1-3). Only for a file with a sha256, which proves the joined
// whole; a server that sends the whole file again (200) starts it over.
export async function download(url, dest, { sha256, onProgress = () => {}, what, log = () => {} } = {}) {
  const from = Date.now();
  const check = sha256 ? "sha256 ok" : "not checked";
  let host = new URL(url).host;
  let why = null;   // the server's answer, when that is what failed
  log(`DOWNLOAD START ${what} from ${urlText(url)} to ${dest}`);
  try {
    if (existsSync(dest)) {
      if (!sha256 || (await fileSha256(dest)) === sha256) {
        log(`DOWNLOAD DONE ${what}: ${sizeText(statSync(dest).size)} in ${secondsSince(from)}s (already on disk), ${check}`);
        return;
      }
      rmSync(dest);
    }
    mkdirSync(dirname(dest), { recursive: true });
    const part = dest + ".part";
    let had = sha256 && existsSync(part) ? statSync(part).size : 0;
    let res = await fetch(url, { redirect: "follow", ...(had ? { headers: { Range: `bytes=${had}-` } } : {}) });
    if (res.status === 416) {
      // Nothing after what is there: the piece is not this file. From the start.
      await res.body?.cancel();
      rmSync(part, { force: true });
      had = 0;
      res = await fetch(url, { redirect: "follow" });
    }
    host = new URL(res.url).host;
    if (!res.ok) {
      why = `HTTP ${res.status} ${res.statusText}`.trim();
      throw new Error(`download failed ${res.status}: ${url}`);
    }
    const offset = res.status === 206 ? had : 0;
    const rest = Number(res.headers.get("content-length")) || null;
    const total = rest && offset + rest;
    log(`DOWNLOAD CONNECTED ${what}: HTTP ${res.status} from ${host}, ${total ? sizeText(total) : "size unknown"}`
      + (offset ? `, resuming at ${sizeText(offset)}` : ""));
    let received = offset;
    const counter = async function* (src) {
      for await (const chunk of src) {
        received += chunk.length;
        onProgress({ received, total });
        yield chunk;
      }
    };
    await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(part, { flags: offset ? "a" : "w" }));
    if (sha256) {
      const got = await fileSha256(part);
      if (got !== sha256) {
        rmSync(part, { force: true });
        throw new Error(`sha256 mismatch for ${url}: got ${got}`);
      }
    }
    renameSync(part, dest);
    const secs = (Date.now() - from) / 1000;
    log(`DOWNLOAD DONE ${what}: ${sizeText(received)} in ${secs.toFixed(1)}s (${((received - offset) / 1e6 / Math.max(secs, 0.001)).toFixed(1)} MB/s), ${check}`);
  } catch (err) {
    // fetch's own words are only "fetch failed"; the reason is its cause.
    why ??= [errorText(err), err?.cause?.message].filter(Boolean).join(": ");
    log(`DOWNLOAD FAILED ${what} after ${secondsSince(from)}s: ${urlText(why)} (${host})`, "ERROR");
    throw err;
  }
}
