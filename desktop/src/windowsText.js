import { execFileSync } from "node:child_process";

// The code page Windows writes its own messages in: 949 on a Korean Windows,
// 932 Japanese, 1251 Russian, 1252 Western European. Read once from the
// registry; 0 off Windows or when it cannot be read.
let cached;
export function ansiCodePage() {
  if (cached !== undefined) return cached;
  cached = 0;
  if (process.platform === "win32") {
    try {
      const out = execFileSync("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage", "/v", "ACP"],
                               { encoding: "utf8", windowsHide: true });
      cached = Number(/ACP\s+REG_SZ\s+(\d+)/.exec(out)?.[1]) || 0;
    } catch {}
  }
  return cached;
}

// The names TextDecoder knows the code pages by; the rest are "windows-NNNN".
const LABELS = { 874: "windows-874", 932: "shift_jis", 936: "gbk", 949: "euc-kr", 950: "big5", 65001: "utf-8" };

// A message Windows wrote in the computer's own language reaches node's copy
// functions as bytes of that code page, and node reads each byte as one
// character: Korean "파일" arrives as "ÆÄÀÏ". When every non-ASCII character
// is such a byte, read the bytes again in the computer's code page. Text that
// is not bytes of that page -- or already real characters -- is left alone.
export function readWindowsText(text, codePage = ansiCodePage()) {
  if (!codePage || !/[\u0080-\u00ff]/.test(text) || /[^\u0000-\u00ff]/.test(text)) return text;
  try {
    return new TextDecoder(LABELS[codePage] || `windows-${codePage}`, { fatal: true }).decode(Buffer.from(text, "latin1"));
  } catch {
    return text;
  }
}
