import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KIT_ENV, parseEnvFile } from "./kitEnv.js";

// One codebase, two builds, one repository. Both editions read their updates
// from the public repository, and open the page's GitHub links, Help
// documents and release notes there. What the edition decides is where a dub
// runs when nothing is chosen: this computer for the open-source edition (the
// default), the Perso API for the production edition, the company's build
// (app/setup.py; orchestrator.js startEngines hands it to the backend).
//
// The packager picks the edition with PERSODUB_EDITION when the payload is
// collected (scripts/collect-payload.mjs writes it into the payload's EDITION
// file), so a packaged app carries its edition and the environment it runs in
// cannot change it. A run with no payload (npm start) reads PERSODUB_EDITION
// from its own environment. The kit remembers the edition it first ran as
// (rememberedEdition below), and that is the one a dub follows.
//
// package.json's build.publish entry stays only so electron-builder writes
// latest.yml and app-update.yml; the feed itself is set at run time from the
// edition (updater.js resolveFeed).
export const EDITIONS = {
  opensource: "stronghamjji/PersoDub",
  production: "stronghamjji/PersoDub",
};
const DEFAULT_EDITION = "opensource";

// The build's edition. An unknown name stops the build, so a typo never ships
// an app that updates from the wrong repository; unset or empty is the default.
export function buildEdition(env) {
  const name = env.PERSODUB_EDITION;
  if (!name) return DEFAULT_EDITION;
  if (!Object.hasOwn(EDITIONS, name)) {
    throw new Error(`PERSODUB_EDITION="${name}" is not an edition. Use one of: ${Object.keys(EDITIONS).join(", ")}.`);
  }
  return name;
}

// The running app's edition: the installer's EDITION mark in the app's user
// data folder when there is one, else the payload's EDITION file, else the
// environment. An unknown name is the default, since a running app has no
// build to stop.
//
// The mark: one signed Windows installer serves both editions. A copy of it
// whose file name ends in "-production.exe" writes the mark as it installs
// (desktop/build/installer.nsh), so the company hands out that copy and the
// public release carries the plain name, and the file is signed once.
export function readEdition({ payloadDir, env, userDataDir }) {
  let name = env.PERSODUB_EDITION;
  if (payloadDir) {
    try { name = readFileSync(join(payloadDir, "EDITION"), "utf8").trim(); } catch { /* no EDITION file: the environment's */ }
  }
  if (userDataDir) {
    try { name = readFileSync(join(userDataDir, "EDITION"), "utf8").trim(); } catch { /* no mark: the build's */ }
  }
  return Object.hasOwn(EDITIONS, name) ? name : DEFAULT_EDITION;
}

// electron-updater's feed for an edition's GitHub Releases.
export function editionFeed(edition) {
  const [owner, repo] = EDITIONS[edition].split("/");
  return { provider: "github", owner, repo };
}

// The edition a kit runs as. Every packaged app updates from the public
// releases, which are the open-source build, so a production install turned
// into an open-source one at its first update (2026-10-14). The kit now
// remembers the edition it first ran as in kit.env, next to the user's other
// settings, and that wins over the build's from then on. A kit.env without
// the key takes the running build's edition and keeps it.
export function rememberedEdition(kitDir, build) {
  const path = kitDir ? join(kitDir, KIT_ENV) : null;
  if (!path || !existsSync(path)) return build;
  const text = readFileSync(path, "utf8");
  const name = parseEnvFile(text).PERSODUB_EDITION;
  if (Object.hasOwn(EDITIONS, name)) return name;
  const sep = text === "" || text.endsWith("\n") ? "" : "\n";
  appendFileSync(path, `${sep}# The edition this kit first ran as. Updates do not change it.\nPERSODUB_EDITION=${build}\n`);
  return build;
}
