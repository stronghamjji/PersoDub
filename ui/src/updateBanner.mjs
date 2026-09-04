// The update pill's words for one shell-reported state. The shell announces
// an update twice -- when it is found (and downloading) and when the file is
// on disk -- and this decides what each step says and whether the restart
// button is offered. Pure: the page draws whatever this returns.
export function updateBannerView(state) {
  if (!state?.version) return null;
  if (state.phase === "ready") {
    return { text: `PersoDub ${state.version} is ready.`, button: "Restart to update" };
  }
  const pct = state.pct > 0 ? ` · ${state.pct}%` : "";
  return { text: `Downloading PersoDub ${state.version}${pct}`, button: null };
}
