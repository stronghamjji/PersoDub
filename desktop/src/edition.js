import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KIT_ENV, parseEnvFile } from "./kitEnv.js";

// One codebase, two builds, one repository. The open-source edition reads its
// updates from the public repository, and opens the page's GitHub links, Help
// documents and release notes there. The production edition, the company's
// build, has no repository: its updates come only from its own address
// (PRODUCTION_UPDATE_URL below; updater.js resolveFeed), never from the public
// releases, which once turned a production install into an open-source one
// (0.8.3). The edition also decides where a dub runs when nothing is chosen:
// this computer for the open-source edition (the default), the Perso API for
// the production edition (app/setup.py; orchestrator.js startEngines hands it
// to the backend), and what the app is called (PRODUCTS below).
//
// The packager picks the edition with PERSODUB_EDITION when the payload is
// collected (scripts/collect-payload.mjs writes it into the payload's EDITION
// file), so a packaged app carries its edition and the environment it runs in
// cannot change it. A run with no payload (npm start) reads PERSODUB_EDITION
// from its own environment. The kit remembers the edition it first ran as
// (rememberedEdition below), and that is the one a dub follows.
//
// electron-builder.js's publish entry stays only so electron-builder writes
// latest.yml and app-update.yml; the feed itself is set at run time from the
// edition (updater.js resolveFeed).
export const EDITIONS = {
  opensource: "stronghamjji/PersoDub",
  production: "",
};

// What each edition is called, and so where it keeps its files: `name` is
// what the user sees the app called (the window title, the sign-in screen, the
// boot screens, the browser's page after a sign-in, every sentence's {app},
// the dock and taskbar, the installer, About) and the kit's folder (config.js
// defaultKitDir); `pkg` is the name Electron gives the app's own data folder
// (userData: logs, ports.json). Each edition has its own, so both can be
// installed on one computer (owner, 2026-10-26).
export const PRODUCTS = {
  opensource: { name: "PersoDub", appId: "com.persodub.desktop", pkg: "persodub-desktop-shell" },
  production: { name: "PersoDubbing", appId: "ai.perso.desktopapp", pkg: "perso-desktopapp-shell" },
};
const DEFAULT_EDITION = "opensource";

/** The name on screen for an edition; the open-source one's for an unknown name. */
export const displayName = (edition) => (PRODUCTS[edition] || PRODUCTS[DEFAULT_EDITION]).name;

// What a production build takes from the packager's environment, which the
// packaged app cannot read again: the support web app Customer support's
// inquiries go to. Nothing in the repository names it; scripts/collect-payload.mjs
// writes it, when set, into the payload's build.env, and the open-source build
// carries none (docs/development.md).
export const BUILD_ENV = "build.env";
export const BUILD_KEYS = ["PERSODUB_INQUIRY_URL"];

/** build.env's text for an edition: the production build's set values, one KEY=value a line. */
export function buildEnvText(edition, env) {
  if (edition !== "production") return "";
  return BUILD_KEYS.filter((k) => env[k]).map((k) => `${k}=${env[k]}\n`).join("");
}

/** The running app's build values: the payload's build.env, or, with no
 *  payload (npm start), the same keys from the environment. */
export function readBuildEnv({ payloadDir, env }) {
  if (!payloadDir) return Object.fromEntries(BUILD_KEYS.filter((k) => env[k]).map((k) => [k, env[k]]));
  try { return parseEnvFile(readFileSync(join(payloadDir, BUILD_ENV), "utf8")); } catch { return {}; }
}

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

// Packaged builds carry the payload under Resources/; a dev checkout may have
// one at desktop/resources/payload after running collect-payload. The boot
// installs from it, and main.js and config.js read the build's edition from it.
export function findPayloadDir(appDir) {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, "payload") : null,
    join(appDir, "resources", "payload"),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(join(p, "app-repo"))) ?? null;
}

// The running app's edition: the payload's EDITION file when there is one,
// otherwise the environment. An unknown name is the default, since a running
// app has no build to stop.
export function readEdition({ payloadDir, env }) {
  let name = env.PERSODUB_EDITION;
  if (payloadDir) {
    try { name = readFileSync(join(payloadDir, "EDITION"), "utf8").trim(); } catch { /* no EDITION file: the environment's */ }
  }
  return Object.hasOwn(EDITIONS, name) ? name : DEFAULT_EDITION;
}

// The HTTPS folder the production edition updates from (electron-updater's
// generic provider): Perso's static host, holding latest-mac.yml, latest.yml
// and the production build's own files they name (PersoDubbing-*, never the
// open-source PersoDub-* builds, which carry another app id). Ends with "/".
// Empty, the production edition does not check for updates at all (0.8.3;
// updater.js resolveFeed).
export const PRODUCTION_UPDATE_URL = "https://portal-static.perso.ai/public/app/desktop/";

// electron-updater's feed for an edition: the production edition's folder
// once it is filled in, else the edition's GitHub Releases; null for an
// edition with neither.
export function editionFeed(edition, productionUrl = PRODUCTION_UPDATE_URL) {
  if (edition === "production" && productionUrl) return { provider: "generic", url: productionUrl };
  if (!EDITIONS[edition]) return null;
  const [owner, repo] = EDITIONS[edition].split("/");
  return { provider: "github", owner, repo };
}

// The edition a kit runs as. Every packaged app updated from the public
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

// The kit's remembered edition, read only: null while kit.env has none (a
// kit's first run, before rememberedEdition writes it) or names no edition.
export function kitEdition(kitDir) {
  const path = kitDir ? join(kitDir, KIT_ENV) : null;
  if (!path || !existsSync(path)) return null;
  const name = parseEnvFile(readFileSync(path, "utf8")).PERSODUB_EDITION;
  return Object.hasOwn(EDITIONS, name) ? name : null;
}

// shell.log's EDITION line: the edition this kit runs as, what that decides
// (where a dub runs when nothing is chosen, app/setup.py), and where it came
// from -- `how` -- beside the edition this app file was built as.
export function editionLine(runEdition, build, how) {
  const dubs = runEdition === "production" ? "the Perso API" : "this computer";
  return `EDITION ${runEdition}: dubs default to ${dubs} (${how}; app file: ${build} build)`;
}
