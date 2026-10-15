import { closeSync, fstatSync, openSync, readSync } from "node:fs";

// The last maxBytes of a file, as text; empty when there is no file. Read from
// the end: an engine's console log is appended to at every launch and never
// cut, and one had grown past 20 MB (2026-10-15). The failure report
// (reporting.js) and the merged timeline (timeline.js) both read this way.
export function readFileEnd(path, maxBytes = 8 * 1024 * 1024) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, maxBytes));
    readSync(fd, buf, 0, buf.length, size - buf.length);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
