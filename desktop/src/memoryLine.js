import { execFile } from "node:child_process";
import { freemem, totalmem } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MiB = 1024 * 1024;

// windowsHide: ps and PowerShell are console programs and the shell a GUI
// process (windowsHide.test.mjs says why that matters).
async function runCommand(file, args) {
  const { stdout } = await execFileAsync(file, args, { windowsHide: true, timeout: 10000 });
  return stdout;
}

// Every process on the computer, one "<pid> <parent pid> <size>" a line, and
// the size's unit in bytes: ps gives the resident size in KiB, Windows the
// working set in bytes. The format operator keeps the script free of double
// quotes, which would have to survive the command line's own quoting.
const PS_LISTING = ["ps", ["-axo", "pid=,ppid=,rss="], 1024];
const WIN_LISTING = ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.WorkingSetSize }"], 1];

/**
 * One line of memory figures for shell.log, in MiB:
 * "Mem[Host total 24576M free 3120M | shell 142M | backend 310M | engine 2875M]".
 * bootFlow.js logs it once the engines are up, every five minutes after and
 * whenever a process ends: a leak shows as a figure that only grows, and a
 * process the system killed for memory next to the figures before it.
 * processes: [{name, pid}], each counted with all its descendants; one the
 * listing does not have reads "?".
 */
export async function memoryLine(processes, { platform = process.platform, exec = runCommand } = {}) {
  const bytes = await treeBytes(processes.map((p) => p.pid), platform, exec);
  const mib = (n) => Math.round(n / MiB);
  return `Mem[${[
    `Host total ${mib(totalmem())}M free ${mib(freemem())}M`,
    `shell ${mib(process.memoryUsage().rss)}M`,
    ...processes.map((p, i) => `${p.name} ${bytes[i] == null ? "?" : mib(bytes[i])}M`),
  ].join(" | ")}]`;
}

// Each pid's size together with all its descendants', in bytes; null for a
// pid the listing does not have. The memory often sits in a child: the voice
// engine under the uvicorn.exe launcher on Windows, Ollama's model runner, the
// backend's Demucs and Whisper workers. app/memline.py counts the same way, so
// the engine's line and this one agree. A parent id Windows has since handed
// to another process can close a loop, which `seen` cuts.
async function treeBytes(pids, platform, exec) {
  if (!pids.length) return [];
  const [file, args, unit] = platform === "win32" ? WIN_LISTING : PS_LISTING;
  let out = "";
  try { out = String(await exec(file, args)); } catch { /* nothing measured: every one "?" */ }
  const size = new Map();
  const kids = new Map();
  for (const line of out.split(/\r?\n/)) {
    const row = line.trim().split(/\s+/).map(Number);
    if (row.length !== 3 || !row.every(Number.isFinite)) continue;
    const [pid, ppid, n] = row;
    size.set(pid, n * unit);
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  const total = (pid, seen) => {
    if (seen.has(pid)) return 0;
    seen.add(pid);
    return size.get(pid) + (kids.get(pid) || []).reduce((n, kid) => n + total(kid, seen), 0);
  };
  return pids.map((pid) => (size.has(pid) ? total(pid, new Set()) : null));
}
