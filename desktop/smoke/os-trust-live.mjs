// Live check of the OS trust hook (vendor/truststore): runs the real installer
// steps payload -> python -> venv-app into a scratch kit with every child
// process sent through an HTTPS-inspecting proxy, then calls the Perso API
// and pip from the new venv the same way. Not part of `npm test` -- it needs
// the network, a collected payload (scripts/collect-payload.mjs) and a proxy
// whose certificate this computer trusts, such as mitmproxy with its CA in the
// Windows store or the macOS keychain:
//
//   PERSODUB_PROXY=http://127.0.0.1:8081 node smoke/os-trust-live.mjs
//
// Every step must finish and both checks must print "ok".
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildSteps } from "../src/installSpec.js";
import { run } from "../src/exec.js";
import { download } from "../src/download.js";
import { extractTarGz } from "../src/extract.js";
import { venvBin } from "../src/platform.js";

const proxy = process.env.PERSODUB_PROXY;
if (!proxy) throw new Error("Set PERSODUB_PROXY to the inspecting proxy, e.g. http://127.0.0.1:8081");
const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const kitDir = process.env.PERSODUB_KIT_DIR || join(tmpdir(), "persodub-os-trust-live");
const env = { ...process.env, HTTPS_PROXY: proxy, HTTP_PROXY: proxy };
const ctx = { kitDir, payloadDir: join(desktop, "resources", "payload"), download, extract: extractTarGz,
              run: (argv, o = {}) => run(argv, { ...o, env }) };

const steps = buildSteps(ctx);
for (const id of ["payload", "python", "venv-app"]) {
  const step = steps.find((s) => s.id === id);
  console.log(`== ${id}${(await step.isDone()) ? " (already done)" : ""}`);
  if (!(await step.isDone())) await step.run((_pct, line) => { if (line && !/Progress \d+ of/.test(line)) console.log("   " + line.slice(0, 110)); });
}
const py = venvBin(join(kitDir, "app_venv"), "python");
await ctx.run([py, "-c", "import httpx; r = httpx.get('https://api.perso.ai/', timeout=20); print('perso api ok', r.status_code)"],
              { onLine: (l) => console.log("   " + l) });
await ctx.run([py, "-m", "pip", "install", "--no-cache-dir", "--retries", "0", "--timeout", "20", "six"], { onLine: () => {} });
console.log("   pip through proxy ok");
