import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { totalmem } from "node:os";
import { buildSteps, bytesStillNeeded, packSteps, packInstalled, packInstallingMarker, syncEraserKitEnv, PACKS, PACK_DIRS } from "./installSpec.js";
import { runInstall, packPercent, downloadInterrupted, lastReason, downloadInterruptedReason, missingVcRuntime, vcRuntimeFailure, vcRuntimeMissingReason, VC_RUNTIME_URL } from "./installer.js";
import { notEnoughSpace, notEnoughMemory, freeSpaceAt } from "./config.js";
import { cancelCurrent } from "./exec.js";
import { readRuntime } from "./runtimeFile.js";
import { errorText } from "./errorText.js";
import { classifyError } from "./analytics.js";
import { openExternally } from "./windowFactory.js";
import { t } from "./i18n.js";

// Packs: the heavy bundles (the engines venv with Demucs, the Ollama
// runtime) the first install leaves out. The page asks for one when a dub
// needs it; the install runs the pack's own steps from the table the boot
// install uses, reports on the same progress channel tagged with the pack,
// then starts the pack's process -- so dubbing goes on without a restart.
// ctx.installCtx, ctx.engines, ctx.win and ctx.bootedKitDir are read at the
// moment each is needed, as boot sets them.
export function registerPackIpc({ ipcMain, dialog, shell, ctx, shellLog }) {
  let packCancelled = false;
  let packInFlight = null;   // one pack at a time: two at once shared one progress and one Cancel
  // No Visual C++ runtime (installer.js missingVcRuntime): the page's pack
  // error is plain text, so the Download button rides on a box of its own,
  // the way the update's lock warning asks. Not awaited: the page shows the
  // same sentence at once.
  const offerVcRuntime = () => {
    if (!ctx.win.isDestroyed()) {
      dialog.showMessageBox(ctx.win, {
        type: "warning", title: "PersoDub", message: vcRuntimeMissingReason(),
        buttons: [t("Download"), t("Not now")], defaultId: 0, cancelId: 1,
      }).then(({ response }) => { if (response === 0) openExternally(shell, VC_RUNTIME_URL); }).catch(() => {});
    }
    return { ok: false, reason: vcRuntimeMissingReason() };
  };
  ipcMain.handle("shell:install-pack", async (_e, id) => {
    if (!PACKS.some((p) => p.id === id)) return { ok: false, reason: t("Unknown pack: {id}", { id }) };
    if (!ctx.installCtx) return { ok: false, reason: t("This build carries no bundled files to install from.") };
    if (packInFlight) return { ok: false, reason: t("{pack} is still installing. Wait for it to finish.", { pack: packInFlight }) };
    // Before a byte, and again on every press, so installing the runtime and
    // pressing Download and Start once more goes straight on.
    if (id === "engine") {
      const missing = missingVcRuntime();
      if (missing.length) {
        shellLog(`PERSODUB_PACK engine: Visual C++ runtime missing (${missing.join(", ")})`);
        return offerVcRuntime();
      }
    }
    const steps = packSteps(buildSteps(ctx.installCtx), id);
    const noRoom = notEnoughSpace(await bytesStillNeeded(steps), await freeSpaceAt(ctx.installCtx.kitDir));
    if (noRoom) return { ok: false, reason: noRoom };
    // The engine pack is what dubs on this computer: gigabytes spent on one
    // that cannot run it help nobody.
    const noMemory = id === "engine" ? notEnoughMemory(totalmem()) : null;
    if (noMemory) return { ok: false, reason: noMemory };
    packCancelled = false;
    packInFlight = id;
    const marker = packInstallingMarker(ctx.installCtx.kitDir, id);
    try {
      mkdirSync(join(ctx.installCtx.kitDir, ".install"), { recursive: true });
      writeFileSync(marker, new Date().toISOString());
      shellLog(`PERSODUB_PACK install ${id}: ${steps.map((s) => s.id).join(", ")}`);
      // The page gets the pack's overall percent on every event (installer.js
      // packPercent), not the running step's own -- a pip step has none.
      const done = new Set();
      // No figure (null) until a byte counts: making the venv, its trust hook,
      // the pip upgrade and pip's resolving count none, and the 0% they held
      // for seconds read as stuck; the page says "Getting ready…" (Windows C2).
      let lastPct = null;
      try {
        await runInstall(steps, {
          stop: () => packCancelled,
          // Each step's lines say which pack they are for; the banner stays bare.
          log: (line, level) => shellLog(line.startsWith("#") ? line : `pack ${id} ${line}`, level),
          onProgress: (p) => {
            if (p.state === "done" || p.state === "skipped") done.add(p.stepId);
            // A progress line without a percent (unpacking, a pip line) keeps
            // the pack's last one: the dialog fell back to 0% for those (2026-09-08).
            let pct = p.state === "progress" && p.pct == null
              ? lastPct
              : packPercent(steps, done, p.stepId, p.state === "progress" ? p.pct : null);
            if (lastPct == null && !pct) pct = null;
            lastPct = pct;
            if (!ctx.win.isDestroyed()) ctx.win.webContents.send("shell:install-progress", { ...p, pack: id, pct });
          },
        });
      } catch (err) {
        const full = errorText(err);
        shellLog(`PERSODUB_PACK install ${id} failed: ${full}`);
        if (!packCancelled && vcRuntimeFailure(full)) return offerVcRuntime();
        if (packCancelled) return { ok: false, reason: t("Cancelled.") };
        // A refused certificate reads as a dropped download too, but pressing
        // Resume on the same network only fails again: it says to change it.
        // A download's fetch names it only in its cause ("fetch failed").
        if (classifyError([full, err?.cause?.message].filter(Boolean).join(": ")) === "certificate") {
          return { ok: false, reason: t("A company network or security program blocked the connection. Connect to another Wi-Fi or a hotspot, then press Resume.") };
        }
        return { ok: false, reason: downloadInterrupted(full) ? downloadInterruptedReason() : lastReason(full) };
      }
      if (ctx.engines && ctx.engines.startPack) {
        // The last step's line would sit in the dialog for the ~40 s the
        // process takes to answer; say what is happening instead.
        if (!ctx.win.isDestroyed()) ctx.win.webContents.send("shell:install-progress", { pack: id, stepId: "start", title: t("Installed. Starting it up"), state: "progress", pct: 100 });
        try {
          await ctx.engines.startPack(id);
          shellLog(`PERSODUB_PACK ${id} process up: ${JSON.stringify(readRuntime(ctx.installCtx.kitDir))}`);
        } catch (err) {
          shellLog(`PERSODUB_PACK ${id} installed but did not start: ${errorText(err)}`);
          return { ok: false, reason: t("Installed, but it could not start: {why}", { why: lastReason(errorText(err)) }) };
        }
      }
      shellLog(`PERSODUB_PACK install ${id} ok`);
      return { ok: true };
    } finally {
      packInFlight = null;
      rmSync(marker, { force: true });
    }
  });
  ipcMain.handle("shell:cancel-pack", async () => {
    packCancelled = true;
    cancelCurrent();   // the step's process dies, runInstall rejects, install-pack answers Cancelled
  });
  ipcMain.handle("shell:remove-pack", async (_e, id) => {
    const pack = PACKS.find((p) => p.id === id);
    const kitDir = ctx.installCtx ? ctx.installCtx.kitDir : ctx.bootedKitDir;
    if (!pack) return { ok: false, reason: t("Unknown pack: {id}", { id }) };
    if (!kitDir) return { ok: false, reason: t("No kit to remove it from.") };
    if (ctx.engines && ctx.engines.stopPack) ctx.engines.stopPack(id);
    // The pack's folders and its steps' done-stamps, so a later install runs
    // the steps again rather than skipping them on a stale stamp. Models
    // pulled through Ollama stay: they are listed and removed as models.
    const dirs = PACK_DIRS[id] || [];
    try {
      for (const d of dirs) rmSync(join(kitDir, d), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      for (const step of pack.steps) rmSync(join(kitDir, ".install", `${step}.ok`), { force: true });
    } catch (err) {
      return { ok: false, reason: errorText(err) };
    }
    // The eraser's two keys go with its files: the app judges the pack by
    // whether kit.env carries them, so a leftover key would point the app at
    // a python that is no longer there.
    if (id === "subtitle-eraser") syncEraserKitEnv(kitDir);
    return { ok: true };
  });
  ipcMain.handle("shell:pack-status", async () => {
    const kitDir = ctx.installCtx ? ctx.installCtx.kitDir : ctx.bootedKitDir;
    return Object.fromEntries(PACKS.map((p) => [p.id, kitDir && packInstalled(kitDir, p.id) ? "ready" : "missing"]));
  });
}
