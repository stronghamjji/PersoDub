// Electron preload (CommonJS — sandboxed preloads cannot use ESM).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("persodubShell", {
  retry: () => ipcRenderer.send("shell:retry"),
  // Settings' "Restart now" button. Keys/workspace only apply on the next
  // start, and asking a non-technical user to quit and reopen by hand was
  // the step that silently didn't happen.
  relaunch: () => ipcRenderer.send("shell:relaunch"),
  onInstallProgress: (cb) => ipcRenderer.on("shell:install-progress", (_e, p) => cb(p)),
});
