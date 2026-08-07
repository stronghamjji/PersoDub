// Fake Qwen3-TTS sidecar for tests: /health -> {"model_loaded": bool}
// usage: node fake_sidecar.mjs <port> [--never-ready]
import { createServer } from "node:http";

const port = Number(process.argv[2]);
const neverReady = process.argv.includes("--never-ready");
const started = Date.now();

createServer((req, res) => {
  const ready = !neverReady && Date.now() - started > 200;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ model_loaded: ready }));
}).listen(port, "127.0.0.1");
