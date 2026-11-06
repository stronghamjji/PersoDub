// The keys a browser answers with its own chrome, which this window has none
// of, and which still did their work here: Cmd/Ctrl+W closed the only window,
// which quit the app with no warning; Cmd/Ctrl+R started the page over; the
// developer tools opened over the page; the zoom keys shrank it (a dubbing
// room colleague "pressed something and the app hung", 2026-11-05, and both
// systems were pressed through key by key). The page's own keys -- copy,
// paste, undo in a text field -- are not here and still reach it.
const FUNCTION_KEYS = new Set(["f5", "f11", "f12"]);
const ZOOM_KEYS = new Set(["=", "+", "-", "_", "0"]);

/** True for a key the window must swallow: the shell's before-input-event
 *  calls event.preventDefault() on it, which also stops the menu shortcut
 *  behind it (the Mac's View menu has Reload and the zoom items). */
export function blockedKey(input, platform = process.platform) {
  if (input.type !== "keyDown") return false;
  const key = String(input.key || "").toLowerCase();
  if (FUNCTION_KEYS.has(key)) return true;
  const mod = platform === "darwin" ? input.meta : input.control;
  if (!mod) return false;
  if (key === "w" || key === "r") return true;
  if (key === "i" && (input.shift || input.alt)) return true;
  if (ZOOM_KEYS.has(key)) return true;
  // Ctrl+Cmd+F, the Mac's full screen (F11 is Windows').
  return platform === "darwin" && key === "f" && input.control;
}
