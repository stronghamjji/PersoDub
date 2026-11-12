import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnvFile } from "./kitEnv.js";

// What this build is: PersoDub, the open-source app. It reads its updates
// from the public repository's releases, and the page's GitHub links, Help
// documents and release notes open there.
//
// electron-builder.js's publish entry stays only so electron-builder writes
// latest.yml and app-update.yml; the feed itself is set at run time
// (updater.js resolveFeed).
export const REPO = "stronghamjji/PersoDub";

// The name this build goes by in what it sends (the usage counts, the button
// events, the failure reports, an inquiry) and in shell.log.
export const EDITION = "opensource";

// What the app is called, and so where it keeps its files: `name` is what the
// user sees the app called (the window title, the boot screens, every
// sentence's {app}, the dock and taskbar, the installer, About) and the kit's
// folder (config.js defaultKitDir). The app's own data folder (userData:
// logs, ports.json) is named after package.json's name.
export const PRODUCT = { name: "PersoDub", appId: "com.persodub.desktop" };

// What a build takes from the packager's environment, which the packaged app
// cannot read again: the support web app that Send feedback's inquiries go
// to. Nothing in the repository names it; scripts/collect-payload.mjs writes
// it, when set, into the payload's build.env (docs/development.md).
export const BUILD_ENV = "build.env";
export const BUILD_KEYS = ["PERSODUB_INQUIRY_URL"];

/** build.env's text: the build's set values, one KEY=value a line. */
export function buildEnvText(env) {
  return BUILD_KEYS.filter((k) => env[k]).map((k) => `${k}=${env[k]}\n`).join("");
}

/** The running app's build values: the payload's build.env, or, with no
 *  payload (npm start), the same keys from the environment. */
export function readBuildEnv({ payloadDir, env }) {
  if (!payloadDir) return Object.fromEntries(BUILD_KEYS.filter((k) => env[k]).map((k) => [k, env[k]]));
  try { return parseEnvFile(readFileSync(join(payloadDir, BUILD_ENV), "utf8")); } catch { return {}; }
}

// Packaged builds carry the payload under Resources/; a dev checkout may have
// one at desktop/resources/payload after running collect-payload. The boot
// installs from it, and main.js reads the build's values from it.
export function findPayloadDir(appDir) {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, "payload") : null,
    join(appDir, "resources", "payload"),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(join(p, "app-repo"))) ?? null;
}

// electron-updater's feed: the repository's GitHub Releases.
export function updateFeed() {
  const [owner, repo] = REPO.split("/");
  return { provider: "github", owner, repo };
}
