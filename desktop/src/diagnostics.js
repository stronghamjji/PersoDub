import { execFile } from "node:child_process";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";
import { missingVcRuntime } from "./installer.js";

// What the failing machine can say about itself, asked at the moment a
// failure report is built (reporting.js) and chosen by the failure's code.
// A report used to name the code and stop: two Windows laptops failed pip
// with "self-signed certificate in certificate chain", the reports said
// "step-failed", and nothing in them could say which security product had
// put its own certificate in the way (2026-10-15).
//
// Every value is a product name, a yes or no, an errno or a number -- never a
// user name, a path under home, an address or a proxy URL. report.js holds
// what arrives here to that again before anything leaves.

const NETWORK_CODES = new Set(["certificate", "network", "model-download", "perso-failed"]);
const ENGINE_CODES = new Set(["engine-start", "engine-crash", "step-failed"]);
// A program that could not open its own files, which is what a security
// product that quarantined or locked one leaves behind.
const LOCKED_FILE = /WinError (5|32|126)\b|Access is denied|PermissionError|could not be found/i;

/** Which probes say something about this failure. None for most. */
export function probesFor(code, message = "") {
  const text = String(message ?? "");
  if (NETWORK_CODES.has(code)) return ["network", "proxy"];
  // Only a stage that was waiting on the network; a slow machine is not news
  // about the connection.
  if (code === "timeout") return /download|connect|fetch|http/i.test(text) ? ["network", "proxy"] : [];
  if (code === "permission") return ["antivirus", "kitWritable"];
  if (ENGINE_CODES.has(code)) return LOCKED_FILE.test(text) ? ["vcRuntime", "gpu", "antivirus"] : ["vcRuntime", "gpu"];
  if (code === "out-of-memory") return ["memory"];
  return [];
}

// The hosts an install and a dub reach.
const HOSTS = ["pypi.org", "files.pythonhosted.org", "huggingface.co", "github.com", "api.perso.ai"];

const nameOf = (who) => String((who && (who.O || who.CN)) || "");

// Who signed the certificate this host presents. Verification is off on
// purpose: the certificate a check would refuse is the one worth naming, and
// nothing is sent over the connection. Under an HTTPS inspector the issuer
// and the root name the product.
function tlsCheck(host, tlsConnect) {
  return new Promise((resolve) => {
    const socket = tlsConnect({ host, port: 443, servername: host, rejectUnauthorized: false });
    const done = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(3000, () => done({ reachable: false, error: "ETIMEDOUT" }));
    socket.on("error", (err) => done({ reachable: false, error: err.code || "error" }));
    socket.once("secureConnect", () => {
      const leaf = socket.getPeerCertificate(true);
      let last = leaf;
      let chainLength = 1;
      // Node ends a chain with a certificate that is its own issuer.
      while (last.issuerCertificate && last.issuerCertificate !== last && chainLength < 10) {
        last = last.issuerCertificate;
        chainLength += 1;
      }
      done({ reachable: true, issuer: nameOf(leaf.issuer), root: nameOf(last.subject), chainLength });
    });
  });
}

const lines = (out) => String(out).split(/\r?\n/).map((l) => l.replace(/^﻿/, "").trim()).filter(Boolean);
// The errno or the exit, never the message: a message carries the path.
const reasonOf = (err) => String((err && (err.code ?? err.signal)) || "failed");
const gb = (bytes) => Math.round((bytes / 1024 ** 3) * 10) / 10;

const PROBES = {
  async network({ tlsConnect }) {
    const results = await Promise.all(HOSTS.map((host) => tlsCheck(host, tlsConnect)));
    return Object.fromEntries(HOSTS.map((host, i) => [host, results[i]]));
  },

  // Whether one is set, never where it points.
  async proxy({ run, platform, env }) {
    const set = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"].some((k) => env[k]);
    let system = "unknown";
    if (platform === "win32") {
      // The Internet Settings key is the proxy Python and pip follow
      // (urllib reads it), and its value names never change with the
      // language -- netsh prints its answer in the console's own.
      const out = await run(["reg", "query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"]);
      system = /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(out) || /AutoConfigURL\s+REG_SZ\s+\S/i.test(out) ? "proxy" : "direct";
    } else if (platform === "darwin") {
      const out = await run(["scutil", "--proxy"]);
      system = /HTTPS?Enable : 1|ProxyAutoConfigEnable : 1/.test(out) ? "proxy" : "direct";
    }
    return { env: set, system };
  },

  async antivirus({ run, platform }) {
    if (platform !== "win32") return { products: [] };
    // UTF-8 out: a Korean Windows names its products in Korean, and
    // PowerShell otherwise writes the console's code page.
    const out = await run(["powershell", "-NoProfile", "-Command",
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8; "
      + "Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | Select-Object -ExpandProperty displayName"]);
    return { products: lines(out).slice(0, 10) };
  },

  kitWritable({ kitDir, fs }) {
    const file = join(kitDir, `.write-check-${process.pid}`);
    try {
      fs.writeFileSync(file, "ok");
      fs.rmSync(file, { force: true });
      return { writable: true };
    } catch (err) {
      return { writable: false, error: reasonOf(err) };
    }
  },

  // The same check the engine pack makes before it installs (installer.js).
  vcRuntime({ platform, env, fs }) {
    if (platform !== "win32") return {};
    return { missing: missingVcRuntime({ platform, env, exists: fs.existsSync }) };
  },

  async gpu({ run }) {
    try {
      const out = await run(["nvidia-smi", "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"]);
      return { nvidia: lines(out)[0] || null };
    } catch (err) {
      return { nvidia: null, error: reasonOf(err) };
    }
  },

  memory({ os }) {
    return { totalGB: gb(os.totalmem()), freeGB: gb(os.freemem()) };
  },
};

export const PROBE_NAMES = Object.keys(PROBES);

// A command's output, killed at the time limit. Not exec.js's run: that one
// is the installer's, keeps the process it drives for Cancel to kill, and
// has no time limit.
function runCommand(argv, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(argv[0], argv.slice(1), { timeout: timeoutMs, windowsHide: true, encoding: "utf8" },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/**
 * Run the named probes side by side, each cut off at `timeoutMs`, so the
 * whole takes no longer than that. Never rejects: a probe that fails or hangs
 * is `{ error }` under its own name. `deps` replaces the machine in tests.
 */
export async function runProbes(names, { kitDir, timeoutMs = 4000, deps = {} } = {}) {
  const ctx = {
    kitDir, tlsConnect: connect, fs: nodeFs, os: nodeOs, platform: process.platform, env: process.env,
    run: (argv) => runCommand(argv, timeoutMs), ...deps,
  };
  const entries = await Promise.all(names.filter((n) => Object.hasOwn(PROBES, n)).map(async (name) => {
    let timer;
    const cut = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs, { error: "timeout" }); });
    try {
      return [name, await Promise.race([PROBES[name](ctx), cut])];
    } catch (err) {
      return [name, { error: reasonOf(err) }];
    } finally {
      clearTimeout(timer);
    }
  }));
  return Object.fromEntries(entries);
}
