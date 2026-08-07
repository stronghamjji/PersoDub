// Pulls an Ollama model into a kit-owned models dir. `ollama pull` is only
// a client, so a temporary `ollama serve` runs on a free port for the
// duration of the pull and is killed right after -- the app-lifetime server
// is orchestrator.js's job, this one exists only so the install step works.
import { spawn } from "node:child_process";
import { run } from "./exec.js";
import { getFreePort } from "./freePort.js";

export async function pullOllamaModel({ bin, modelsDir, model, onLine = () => {} }) {
  const port = await getFreePort();
  const env = { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_MODELS: modelsDir };
  const server = spawn(bin, ["serve"], { env, stdio: "ignore" });
  try {
    await waitReady(bin, env);
    await run([bin, "pull", model], { env, onLine });
  } finally {
    server.kill("SIGTERM");
  }
}

async function waitReady(bin, env) {
  // `ollama list` succeeds only once the server answers; ~1s typical.
  for (let i = 0; i < 30; i++) {
    try { await run([bin, "list"], { env }); return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("ollama serve did not become ready");
}
