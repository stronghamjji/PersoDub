// Run with: node --test desktop/src/diagnostics.test.mjs
// The machine is a stand-in: no connection is opened and no command is run.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { probesFor, runProbes } from "./diagnostics.js";

// ---- which probes a failure asks for ----------------------------------

test("a failure on the wire asks about the network and the proxy", () => {
  for (const code of ["certificate", "network", "model-download", "perso-failed"]) {
    assert.deepEqual(probesFor(code, ""), ["network", "proxy"], code);
  }
});

test("a timeout asks about the network only when it was waiting on one", () => {
  assert.deepEqual(probesFor("timeout", "download of model.bin timed out"), ["network", "proxy"]);
  assert.deepEqual(probesFor("timeout", "local separation timed out after 900 seconds"), []);
});

test("a blocked write asks about the security product and the kit folder", () => {
  assert.deepEqual(probesFor("permission", "EACCES"), ["antivirus", "kitWritable"]);
});

test("an engine that would not run asks about the runtime and the GPU, and a locked file adds the security product", () => {
  for (const code of ["engine-start", "engine-crash", "step-failed"]) {
    assert.deepEqual(probesFor(code, "python exit 1"), ["vcRuntime", "gpu"], code);
  }
  assert.deepEqual(probesFor("engine-crash", "OSError: [WinError 126] The specified module could not be found"),
    ["vcRuntime", "gpu", "antivirus"]);
  assert.deepEqual(probesFor("step-failed", "PermissionError: [WinError 32] in use"), ["vcRuntime", "gpu", "antivirus"]);
});

test("out of memory asks about memory, and everything else asks nothing", () => {
  assert.deepEqual(probesFor("out-of-memory", ""), ["memory"]);
  for (const code of ["unknown", "disk-full", "translate-parse", undefined]) {
    assert.deepEqual(probesFor(code, "anything"), [], String(code));
  }
});

// ---- the network probe -------------------------------------------------

// A chain the way an HTTPS inspector presents it: the leaf signed by the
// product's own root, which is its own issuer.
const ROOT = { subject: { O: "ALYac Web Security", CN: "ALYac Root CA" }, issuer: { O: "ALYac Web Security" } };
ROOT.issuerCertificate = ROOT;
const LEAF = { subject: { CN: "pypi.org" }, issuer: { O: "ALYac Web Security" }, issuerCertificate: ROOT };

// tls.connect stand-in: every host answers with the chain above except the
// ones named in `fail`, which error with that errno.
function fakeTls(fail = {}) {
  return ({ host }) => {
    const socket = new EventEmitter();
    socket.setTimeout = () => {};
    socket.destroy = () => {};
    socket.getPeerCertificate = () => LEAF;
    setImmediate(() => {
      if (fail[host]) socket.emit("error", Object.assign(new Error(`getaddrinfo ${fail[host]} ${host}`), { code: fail[host] }));
      else socket.emit("secureConnect");
    });
    return socket;
  };
}

test("the network probe names who signed each host's certificate", async () => {
  const { network } = await runProbes(["network"], { deps: { tlsConnect: fakeTls({ "api.perso.ai": "ENOTFOUND" }) } });
  assert.deepEqual(network["pypi.org"], { reachable: true, issuer: "ALYac Web Security", root: "ALYac Web Security", chainLength: 2 });
  assert.deepEqual(network["api.perso.ai"], { reachable: false, error: "ENOTFOUND" });
  assert.deepEqual(Object.keys(network), ["pypi.org", "files.pythonhosted.org", "huggingface.co", "github.com", "api.perso.ai"]);
});

// ---- the time limit and failures ---------------------------------------

test("a probe that hangs is cut off, and the others still answer", async () => {
  const started = Date.now();
  const out = await runProbes(["gpu", "memory"], {
    timeoutMs: 50,
    deps: { run: () => new Promise(() => {}), os: { totalmem: () => 16 * 1024 ** 3, freemem: () => 3.26 * 1024 ** 3 } },
  });
  assert.deepEqual(out.gpu, { error: "timeout" });
  assert.deepEqual(out.memory, { totalGB: 16, freeGB: 3.3 });
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
});

test("a probe that fails becomes its errno, never a rejection", async () => {
  const missing = () => Promise.reject(Object.assign(new Error("spawn powershell ENOENT"), { code: "ENOENT" }));
  const out = await runProbes(["antivirus", "gpu", "kitWritable", "made-up"], {
    kitDir: "/kit",
    deps: {
      platform: "win32", run: missing,
      fs: { writeFileSync: () => { throw Object.assign(new Error("EACCES: /Users/jane/kit"), { code: "EACCES" }); }, rmSync() {} },
    },
  });
  assert.deepEqual(out, {
    antivirus: { error: "ENOENT" },
    gpu: { nvidia: null, error: "ENOENT" },
    kitWritable: { writable: false, error: "EACCES" },
  });
});

// ---- the Windows-only probes -------------------------------------------

test("the security products are read one per line, and none off Windows", async () => {
  const run = async () => "\uFEFFWindows Defender\r\nALYac\r\n";
  assert.deepEqual((await runProbes(["antivirus"], { deps: { platform: "win32", run } })).antivirus,
    { products: ["Windows Defender", "ALYac"] });
  assert.deepEqual((await runProbes(["antivirus"], { deps: { platform: "darwin", run } })).antivirus, { products: [] });
});

test("the proxy probe says whether one is set, never where", async () => {
  const env = { HTTPS_PROXY: "http://jane:pw@10.0.0.1:8080" };
  const key = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n";
  const win = await runProbes(["proxy"], {
    deps: { platform: "win32", env, run: async () => `${key}    ProxyEnable    REG_DWORD    0x0\r\n    ProxyServer    REG_SZ    10.0.0.1:8080\r\n` },
  });
  assert.deepEqual(win.proxy, { env: true, system: "direct" });
  const winOn = await runProbes(["proxy"], {
    deps: { platform: "win32", env: {}, run: async () => `${key}    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    10.0.0.1:8080\r\n` },
  });
  assert.deepEqual(winOn.proxy, { env: false, system: "proxy" });
  const winPac = await runProbes(["proxy"], {
    deps: { platform: "win32", env: {}, run: async () => `${key}    ProxyEnable    REG_DWORD    0x0\r\n    AutoConfigURL    REG_SZ    http://proxy.corp/wpad.dat\r\n` },
  });
  assert.deepEqual(winPac.proxy, { env: false, system: "proxy" });
  const mac = await runProbes(["proxy"], {
    deps: { platform: "darwin", env: {}, run: async () => "<dictionary> {\n  HTTPEnable : 0\n  HTTPSEnable : 1\n  HTTPSProxy : 10.0.0.1\n}" },
  });
  assert.deepEqual(mac.proxy, { env: false, system: "proxy" });
});

test("the runtime probe names the Visual C++ files that are missing, and says nothing off Windows", async () => {
  const fs = { existsSync: (p) => !p.endsWith("vcruntime140_1.dll") };
  const env = { SystemRoot: "C:\\Windows" };
  assert.deepEqual((await runProbes(["vcRuntime"], { deps: { platform: "win32", env, fs } })).vcRuntime,
    { missing: ["vcruntime140_1.dll"] });
  assert.deepEqual((await runProbes(["vcRuntime"], { deps: { platform: "darwin", env, fs } })).vcRuntime, {});
});

test("the GPU probe keeps the first line nvidia-smi prints", async () => {
  const run = async () => "NVIDIA GeForce RTX 3080, 560.94, 10240 MiB\n";
  assert.deepEqual((await runProbes(["gpu"], { deps: { run } })).gpu, { nvidia: "NVIDIA GeForce RTX 3080, 560.94, 10240 MiB" });
});
