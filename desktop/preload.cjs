// Electron preload (CommonJS — sandboxed preloads cannot use ESM).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("persodubShell", {
  retry: () => ipcRenderer.send("shell:retry"),
  // Settings' "Restart now" button. Keys/workspace only apply on the next
  // start, and asking a non-technical user to quit and reopen by hand was
  // the step that silently didn't happen.
  relaunch: () => ipcRenderer.send("shell:relaunch"),
  onInstallProgress: (cb) => ipcRenderer.on("shell:install-progress", (_e, p) => cb(p)),
  // Auto-update: main.js announces a downloaded update; the page shows the
  // banner and the button hands control back here to apply it.
  onUpdateReady: (cb) => ipcRenderer.on("shell:update-ready", (_e, info) => cb(info)),
  restartToUpdate: () => ipcRenderer.send("shell:restart-to-update"),
  // Usage counts for finished dubs. The page hands over the raw log tail
  // because it cannot classify it -- main.js turns that into one published
  // word and drops the text. Nothing here reaches the network.
  countDub: (status, detail) => ipcRenderer.send("shell:count-dub", { status, detail }),
});
