import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readRuntime, writeRuntime, clearRuntime } from "./runtimeFile.js";

function kit() {
  return mkdtempSync(join(tmpdir(), "odruntime-"));
}

test("no runtime.json yet reads as the bare default", () => {
  assert.deepEqual(readRuntime(kit()), { version: 1 });
});

test("a broken runtime.json also reads as the bare default", () => {
  const d = kit();
  writeFileSync(join(d, "runtime.json"), "{not json");
  assert.deepEqual(readRuntime(d), { version: 1 });
});

test("write merges into what is already there", () => {
  const d = kit();
  writeRuntime(d, { ollama_url: "http://127.0.0.1:1111" });
  writeRuntime(d, { tts_url: "http://127.0.0.1:2222" });
  assert.deepEqual(readRuntime(d), {
    version: 1,
    ollama_url: "http://127.0.0.1:1111",
    tts_url: "http://127.0.0.1:2222",
  });
});

test("write overwrites an existing key rather than duplicating it", () => {
  const d = kit();
  writeRuntime(d, { ollama_url: "http://127.0.0.1:1111" });
  writeRuntime(d, { ollama_url: "http://127.0.0.1:9999" });
  assert.equal(readRuntime(d).ollama_url, "http://127.0.0.1:9999");
});

test("clear removes just the named keys", () => {
  const d = kit();
  writeRuntime(d, { ollama_url: "http://127.0.0.1:1111", tts_url: "http://127.0.0.1:2222" });
  clearRuntime(d, ["ollama_url"]);
  assert.deepEqual(readRuntime(d), { version: 1, tts_url: "http://127.0.0.1:2222" });
});

test("clearing a key that was never set is not an error", () => {
  const d = kit();
  clearRuntime(d, ["ollama_url"]);
  assert.deepEqual(readRuntime(d), { version: 1 });
});

test("the write is atomic: no leftover temp file after writing", () => {
  const d = kit();
  writeRuntime(d, { ollama_url: "http://127.0.0.1:1111" });
  const body = JSON.parse(readFileSync(join(d, "runtime.json"), "utf8"));
  assert.equal(body.ollama_url, "http://127.0.0.1:1111");
});
