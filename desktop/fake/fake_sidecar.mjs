// Fake Qwen3-TTS sidecar for tests: /health -> {"status": str, "model_loaded": bool}
// usage: node fake_sidecar.mjs <port> [--never-ready] [--no-model] [--loading=<ms>] [--die] [--die-out-of-memory]
import { createServer } from "node:http";

const port = Number(process.argv[2]);
const neverReady = process.argv.includes("--never-ready");
// Mirrors the real sidecar when the voice model is not on disk yet: status
// stays "ok" with model_loaded false (it lazy-loads on first /synthesize).
const noModel = process.argv.includes("--no-model");
// Mirrors the real sidecar loading its model: "loading" for this long, then "ok".
const loadingArg = process.argv.find((a) => a.startsWith("--loading="));
const loadingMs = loadingArg ? Number(loadingArg.split("=")[1]) : 0;
const started = Date.now();

// Mirrors a sidecar whose start fails (a missing library, no memory): a
// traceback on stderr, then exit.
if (process.argv.includes("--die")) {
  process.stderr.write(`Traceback (most recent call last):\nRuntimeError: fake engine could not load (${process.env.HOME || "home"}/secret)\n`);
  setTimeout(() => process.exit(3), 100);
}

// Mirrors issue #187: Windows out of paging file while the engine loaded.
// The line as the log kept it, the system's own words mojibake around the code.
if (process.argv.includes("--die-out-of-memory")) {
  process.stderr.write("Traceback (most recent call last):\nOSError: �� �۾��� �Ϸ��ϱ� ���� ����¡ ������ �ʹ� �۽��ϴ�. (os error 1455)\n");
  setTimeout(() => process.exit(1), 100);
}

createServer((req, res) => {
  // Mirrors the real sidecar's POST /restart: answer, then exit with the code
  // the shell starts the engine again on.
  if (req.method === "POST" && req.url === "/restart") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ restarting: true }));
    setTimeout(() => process.exit(75), 50);
    return;
  }
  const age = Date.now() - started;
  const up = !neverReady && age > 200 + loadingMs;
  const status = up ? "ok" : (loadingMs && age > 200 && !neverReady ? "loading" : "starting");
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status, model_loaded: up && !noModel }));
}).listen(port, "127.0.0.1");
