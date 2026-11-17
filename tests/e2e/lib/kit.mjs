// What a sweep step asks before it turns Settings > Privacy's switch: could
// this app really send? "Share usage data" on writes PERSODUB_NO_ANALYTICS=0,
// PERSODUB_NO_REPORTS=0 and PERSODUB_EVENTS=1 into kit.env, and kit.env
// outranks the environment the app was started with (desktop/src/kitEnv.js
// envWithKit), so on a packaged test kit a test's usage counts, failure
// reports and button events would leave the computer. Three more kit.env
// lines make each sender print what it would send instead of sending it
// (desktop/src/analytics.js, report.js, events.js), and the switch is turned
// only on a kit that has all three.
//
// The sweep is not told which kit the app on the control port runs from, so
// the run names it the way the app itself is told: PERSODUB_KIT_DIR. With no
// kit named, or a folder without a kit.env, the step is skipped.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KIT_ENV, parseEnvFile } from "../../../desktop/src/kitEnv.js";
import { Skip } from "./cdp.mjs";

const PREVIEW_KEYS = ["PERSODUB_ANALYTICS_DEBUG", "PERSODUB_REPORTS_DEBUG", "PERSODUB_EVENTS_DEBUG"];

/** Whether a kit with this kit.env keeps everything on the computer with the
 *  switch on. PERSODUB_EVENTS_SEND=1 sends button events whatever else is set. */
export function keepsItHome(env) {
  return env.PERSODUB_EVENTS_SEND !== "1" && PREVIEW_KEYS.every((k) => env[k] === "1");
}

/** Throws Skip unless the kit PERSODUB_KIT_DIR names keeps everything home. */
export function needQuietKit() {
  const kit = process.env.PERSODUB_KIT_DIR;
  let env = {};
  // kit.env read the way the shell reads it: the last line for a key counts.
  if (kit) try { env = parseEnvFile(readFileSync(join(kit, KIT_ENV), "utf8")); } catch { /* no kit.env there: not a kit */ }
  if (keepsItHome(env)) return;
  throw new Skip(`the Share usage data switch is left as it is: PERSODUB_KIT_DIR must name this app's kit and its kit.env must have `
    + `${PREVIEW_KEYS.map((k) => `${k}=1`).join(", ")} (and no PERSODUB_EVENTS_SEND=1), `
    + "or turning the switch on would really send usage counts, failure reports and button events");
}
