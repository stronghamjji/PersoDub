// Windows pre-flight for "Restart to update". The NSIS updater replaces every
// file in the install directory and, if any single rename fails, aborts with a
// dialog blaming the app ("PersoDub cannot be closed") -- when the actual
// culprit is some OTHER program holding a file open (seen in the field: an
// editor pinning resources\app.asar; antivirus and backup tools do the same).
// By the time that dialog shows, the app has already quit and can't explain
// anything. So the check runs BEFORE quitting, via the Windows Restart Manager
// (the official "who is holding these files" API), and names the culprit while
// there is still a window to say it in.
//
// Everything here fails open: a broken probe returns "no lockers", because a
// safety check must never be the thing that blocks an update.
import { execFile } from "node:child_process";
import { basename } from "node:path";

// The Restart Manager lives behind a C API (rstrtmgr.dll); Node can't reach it
// without a native module, so the probe is a PowerShell script using P/Invoke.
// It prints a JSON array of {pid, name, exe} for every process holding any
// file under the install dir, or [] on any failure. The script is passed via
// -EncodedCommand, so nothing touches disk and no shell quoting applies -- the
// only interpolated value is the install dir inside a single-quoted PowerShell
// literal, with ' doubled per PowerShell's escape rule.
export function lockProbeScript(installDir) {
  const dir = String(installDir).replace(/'/g, "''");
  return `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RmProbe {
  [StructLayout(LayoutKind.Sequential)]
  public struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType;
    public uint AppStatus;
    public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] public static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);
  [DllImport("rstrtmgr.dll")] public static extern int RmEndSession(uint pSessionHandle);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] public static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);
  [DllImport("rstrtmgr.dll")] public static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);
}
'@
  $files = @(Get-ChildItem -LiteralPath '${dir}' -Recurse -File | ForEach-Object { $_.FullName })
  if ($files.Count -eq 0) { [Console]::Out.Write('[]'); exit 0 }
  $session = [uint32]0
  if ([RmProbe]::RmStartSession([ref]$session, 0, [Guid]::NewGuid().ToString()) -ne 0) { [Console]::Out.Write('[]'); exit 0 }
  try {
    if ([RmProbe]::RmRegisterResources($session, $files.Count, $files, 0, $null, 0, $null) -ne 0) { [Console]::Out.Write('[]'); exit 0 }
    $needed = [uint32]0; $count = [uint32]0; $reasons = [uint32]0
    $rc = [RmProbe]::RmGetList($session, [ref]$needed, [ref]$count, $null, [ref]$reasons)
    $result = @()
    if ($rc -eq 234 -and $needed -gt 0) {
      $count = $needed
      $apps = New-Object 'RmProbe+RM_PROCESS_INFO[]' $count
      $rc = [RmProbe]::RmGetList($session, [ref]$needed, [ref]$count, $apps, [ref]$reasons)
      if ($rc -eq 0 -and $count -gt 0) {
        $result = foreach ($a in $apps[0..($count - 1)]) {
          $procId = $a.Process.dwProcessId
          $exe = ''
          $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
          if ($p -and $p.Path) { $exe = Split-Path -Leaf $p.Path } elseif ($p) { $exe = $p.ProcessName + '.exe' }
          [pscustomobject]@{ pid = $procId; name = $a.strAppName; exe = $exe }
        }
      }
    }
    [Console]::Out.Write((ConvertTo-Json -InputObject @($result) -Compress))
  } finally { [void][RmProbe]::RmEndSession($session) }
} catch { [Console]::Out.Write('[]') }
`;
}

// The probe's stdout may carry Add-Type noise before the JSON, and
// PowerShell's ConvertTo-Json can hand back a bare object for one element.
// Anything unparseable means "probe broke", which fails open to [].
export function parseLockers(stdout) {
  if (typeof stdout !== "string") return [];
  const text = stdout.trim();
  for (const candidate of [text, text.slice(text.indexOf("["))]) {
    try {
      const parsed = JSON.parse(candidate);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list
        .filter((e) => e && typeof e === "object")
        .map((e) => ({ pid: Number(e.pid) || 0, name: String(e.name ?? ""), exe: String(e.exe ?? "") }));
    } catch { /* try the next candidate */ }
  }
  return [];
}

// The running app holds its own app.asar open -- a lock that resolves itself
// the moment the app quits, so only OTHER programs are worth warning about.
// Electron runs several processes (main, renderer, gpu) from the same exe;
// match on exe name, case-insensitively, since Windows paths aren't
// case-sensitive.
export function foreignLockers(lockers, ownExePath) {
  const own = basename(String(ownExePath)).toLowerCase();
  return lockers.filter((l) => l.exe.toLowerCase() !== own);
}

// -EncodedCommand sidesteps every quoting layer, -NoProfile keeps user
// profiles from slowing down or breaking the probe, and windowsHide avoids
// exactly the console-flash users already complained about at app start.
function runPowerShell(script, timeoutMs) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

export async function findForeignLockers({ installDir, ownExePath, run, timeoutMs = 15000 }) {
  try {
    const probe = run ?? ((script) => runPowerShell(script, timeoutMs));
    const stdout = await probe(lockProbeScript(installDir));
    return foreignLockers(parseLockers(stdout), ownExePath);
  } catch (err) {
    // Fail open -- never let the check itself block an update -- but say why,
    // or a broken probe is indistinguishable from a clean install dir.
    console.warn("PERSODUB_UPDATE lock check failed:", String((err && err.message) || err));
    return [];
  }
}
