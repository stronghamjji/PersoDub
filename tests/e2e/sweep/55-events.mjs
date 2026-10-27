// The sweep's button events: Settings > Privacy's "Share App Analytics"
// switch turned on, two presses, and the shell's own count of what it kept
// (persodubShell.sendEvents([]) only asks: {on, kept, sent, recent}); then
// the switch off, two more presses, and nothing more kept. The switch is put
// back as it was. On a computer with PERSODUB_NO_ANALYTICS=1 (the owner's
// test kits) the shell keeps and counts them but sends nothing, so `sent` is
// reported, not checked.
import { isClosed, isOpen, onHome, sleep, Skip } from "../lib/cdp.mjs";

export const area = "events";

const status = (app) => app.inPage(() => window.persodubShell.sendEvents([]));
// What the page holds goes to the shell now, as when the window goes away.
const handOver = async (app) => { await app.inPage(() => { window.dispatchEvent(new Event("pagehide")); return true; }); await sleep(800); };

async function setSwitch(app, on) {
  await app.click("#homeNavSettings");
  await app.waitFor("the Settings dialog", 10000, isOpen, "#settingsOverlay");
  await app.click("#settingsTab-privacy");
  await app.waitFor("the Privacy tab", 5000, () => !document.querySelector("#settingsPanel-privacy").hidden);
  if ((await app.inPage(() => document.querySelector("#eventsToggle").checked)) !== on) {
    await app.click("#eventsToggle");
    await app.click("#settingsSaveBtn");
  } else {
    await app.click("#settingsCancelBtn");
  }
  await app.waitFor("the Settings dialog to close", 10000, isClosed, "#settingsOverlay");
  if ((await app.api("/api/settings")).events_enabled !== on) throw new Error(`events_enabled did not become ${on}`);
  await sleep(500);
}

// Two presses: Settings from Home, its About tab; then Cancel back to Home.
async function pressTwo(app) {
  await app.click("#homeNavSettings");
  await app.waitFor("the Settings dialog", 10000, isOpen, "#settingsOverlay");
  await app.click("#settingsTab-about");
  await app.click("#settingsCancelBtn");
  await app.waitFor("the Settings dialog to close", 10000, isClosed, "#settingsOverlay");
}

export const steps = [
  { name: "switch on: two presses kept by the shell; switch off: none", looks: ["#settingsPanel-privacy"],
    async run(app) {
      if (!(await app.inPage(() => !!window.persodubShell?.sendEvents))) throw new Skip("not inside the desktop shell");
      if (!(await app.inPage(onHome))) throw new Error("not on Home");
      const was = (await app.api("/api/settings")).events_enabled;
      try {
        await setSwitch(app, true);
        const before = await status(app);
        if (!before.on) throw new Error("the switch is on and the shell says recording is off");
        await pressTwo(app);
        await handOver(app);
        const after = await status(app);
        const missing = ["home_nav_settings", "settings_tab_about"].filter((n) => !after.recent.includes(n));
        if (after.kept - before.kept < 2 || missing.length) {
          throw new Error(`on: the shell kept ${after.kept - before.kept}, missing ${missing.join(", ") || "none"}`);
        }
        await setSwitch(app, false);
        const off = await status(app);
        if (off.on) throw new Error("the switch is off and the shell says recording is on");
        await pressTwo(app);
        await handOver(app);
        const end = await status(app);
        if (end.kept !== off.kept) throw new Error(`off: the shell kept ${end.kept - off.kept} more`);
        return `on: kept +${after.kept - before.kept} (${after.recent.slice(-4).join(", ")}), sent so far ${after.sent}; `
          + `off: kept +0 after two presses`;
      } finally {
        if ((await app.api("/api/settings")).events_enabled !== was) {
          await app.api("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events_enabled: was }) });
        }
      }
    } },
];
