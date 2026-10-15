// Fake PersoDub backend for tests: /health ok, /env echoes the identity vars, / -> HTML page
// usage: node fake_backend.mjs <port>
import { createServer } from "node:http";

const port = Number(process.argv[2]);

createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  // Lets a test assert what the shell actually handed the backend. The real backend reads
  // these to tell Perso it is the desktop app and which version (app/perso_client.py), the
  // edition to pick where a dub runs by default (app/setup.py), and where to write its logs.
  if (req.url === "/env") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      PERSODUB_CLIENT: process.env.PERSODUB_CLIENT ?? null,
      PERSODUB_APP_VERSION: process.env.PERSODUB_APP_VERSION ?? null,
      PERSODUB_LOCALE: process.env.PERSODUB_LOCALE ?? null,
      PERSODUB_EDITION: process.env.PERSODUB_EDITION ?? null,
      PERSODUB_LOG_DIR: process.env.PERSODUB_LOG_DIR ?? null,
    }));
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><title>PersoDub</title><h1>fake backend</h1>");
}).listen(port, "127.0.0.1");
