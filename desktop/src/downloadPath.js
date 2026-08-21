// Naming a finished download when something with that name is already there.
//
// Free of fs and electron so the node:test unit tests run with nothing else
// present -- the caller passes `exists` (see desktop/main.js).
export const MAX_COUNTER = 999;

export function uniqueName(filename, exists) {
  if (!exists(filename)) return filename;
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : "";
  for (let n = 1; n <= MAX_COUNTER; n++) {
    const candidate = `${stem}_${String(n).padStart(3, "0")}${ext}`;
    if (!exists(candidate)) return candidate;
  }
  // 999 copies of one file means something is wrong; let Electron name it.
  return null;
}
