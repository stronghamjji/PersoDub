import { createWriteStream, createReadStream, existsSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export function fileSha256(path) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

export async function download(url, dest, { sha256, onProgress = () => {} } = {}) {
  if (existsSync(dest)) {
    if (!sha256 || (await fileSha256(dest)) === sha256) return;
    rmSync(dest);
  }
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`);
  const total = Number(res.headers.get("content-length")) || null;
  let received = 0;
  const part = dest + ".part";
  const counter = async function* (src) {
    for await (const chunk of src) {
      received += chunk.length;
      onProgress({ received, total });
      yield chunk;
    }
  };
  await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(part));
  if (sha256) {
    const got = await fileSha256(part);
    if (got !== sha256) {
      rmSync(part, { force: true });
      throw new Error(`sha256 mismatch for ${url}: got ${got}`);
    }
  }
  renameSync(part, dest);
}
