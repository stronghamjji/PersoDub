// shell.log's memory line (src/memoryLine.js), with each platform's process
// listing fed in: nothing here runs ps or PowerShell. Each named process is
// counted with all its descendants, the way app/memline.py counts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryLine } from "./memoryLine.js";

const PROCESSES = [{ name: "backend", pid: 101 }, { name: "engine", pid: 202 }, { name: "ollama-runtime", pid: 303 }];
const HEAD = String.raw`^Mem\[Host total \d+M free \d+M \| shell \d+M`;
// [pid, parent pid, MiB]. backend 101 (200M) has a child 102 (100M) with a
// child 103 (50M) of its own; 104 is the backend's sibling under the same
// parent and counts for nobody; engine 202 (50M) has no children;
// ollama-runtime 303 is not in the listing.
const TREE = [[1, 0, 1], [100, 1, 1], [101, 100, 200], [102, 101, 100], [103, 102, 50], [104, 100, 999], [202, 100, 50]];
const EXPECTED = new RegExp(`${HEAD} \\| backend 350M \\| engine 50M \\| ollama-runtime \\?M\\]$`);

test("macOS and Linux: one ps of every process, each named one summed with its descendants, KiB to MiB", async () => {
  const calls = [];
  const listing = TREE.map(([pid, ppid, mib]) => `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${mib * 1024}`).join("\n");
  const exec = async (file, args) => { calls.push([file, ...args]); return `${listing}\n`; };
  assert.match(await memoryLine(PROCESSES, { platform: "darwin", exec }), EXPECTED);
  assert.deepEqual(calls, [["ps", "-axo", "pid=,ppid=,rss="]]);
});

test("Windows: one PowerShell listing in bytes, the same sums, and a parent id that loops is counted once", async () => {
  const calls = [];
  // 500 and 501 name each other as parent: Windows reuses a dead parent's id.
  const rows = [...TREE, [500, 501, 1], [501, 500, 1]];
  const listing = rows.map(([pid, ppid, mib]) => `${pid} ${ppid} ${mib * 1024 * 1024}`).join("\r\n");
  const exec = async (file, args) => { calls.push([file, ...args]); return `${listing}\r\n`; };
  assert.match(await memoryLine(PROCESSES, { platform: "win32", exec }), EXPECTED);
  assert.match(await memoryLine([{ name: "loop", pid: 500 }], { platform: "win32", exec }), new RegExp(`${HEAD} \\| loop 2M\\]$`));
  assert.equal(calls[0][0], "powershell.exe");
  assert.deepEqual(calls[0].slice(1, 4), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.match(calls[0][4], /Get-CimInstance Win32_Process .*ProcessId.*ParentProcessId.*WorkingSetSize/);
});

test("a listing that fails leaves every process unmeasured, and no processes is the host and the shell", async () => {
  const fail = async () => { throw new Error("ps: not found"); };
  assert.match(await memoryLine(PROCESSES.slice(0, 1), { platform: "linux", exec: fail }), new RegExp(`${HEAD} \\| backend \\?M\\]$`));
  assert.match(await memoryLine(PROCESSES.slice(0, 1), { platform: "win32", exec: fail }), new RegExp(`${HEAD} \\| backend \\?M\\]$`));
  assert.match(await memoryLine([], { exec: fail }), new RegExp(`${HEAD}\\]$`));
});
