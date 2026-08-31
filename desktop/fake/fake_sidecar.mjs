// Fake Qwen3-TTS sidecar for tests: /health -> {"status": str, "model_loaded": bool}
// usage: node fake_sidecar.mjs <port> [--never-ready] [--no-model]
import { createServer } from "node:http";

const port = Number(process.argv[2]);
const neverReady = process.argv.includes("--never-ready");
// Mirrors the real sidecar when the voice model is not on disk yet: status
// stays "ok" with model_loaded false (it lazy-loads on first /synthesize).
const noModel = process.argv.includes("--no-model");
const started = Date.now();

createServer((req, res) => {
  const up = !neverReady && Date.now() - started > 200;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: up ? "ok" : "starting", model_loaded: up && !noModel }));
}).listen(port, "127.0.0.1");
