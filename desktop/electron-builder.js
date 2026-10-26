// electron-builder's settings, for the edition the collected payload carries
// (scripts/collect-payload.mjs writes its EDITION file; src/edition.js): the
// app is named after the edition it ships, whatever this command's own
// environment says. The production edition is PersoDubbing, with its own
// app id, installer names and data folders (src/edition.js PRODUCTS), so it
// installs beside the open-source PersoDub rather than over it.
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCTS, PRODUCTION_UPDATE_URL, readEdition } from "./src/edition.js";

const PAYLOAD = join(dirname(fileURLToPath(import.meta.url)), "resources", "payload");

export function builderConfig(edition, productionUrl = PRODUCTION_UPDATE_URL) {
  const { name, appId, pkg } = PRODUCTS[edition];
  return {
    appId,
    productName: name,
    // Electron names the app's data folder (userData) after the packaged
    // package.json's name.
    extraMetadata: { name: pkg },
    copyright: "Copyright © 2026 ESTsoft corp.",
    directories: { output: "dist" },
    files: ["main.js", "preload.cjs", "src/**", "screens/**", "i18n/**", "fake/**", "config.json"],
    extraResources: [
      { from: "resources/payload", to: "payload" },
      { from: "../LICENSE", to: "LICENSE" },
      { from: "../NOTICE", to: "NOTICE" },
    ],
    mac: {
      hardenedRuntime: true,
      entitlements: "entitlements.mac.plist",
      entitlementsInherit: "entitlements.mac.plist",
      notarize: true,
    },
    win: {
      target: [{ target: "nsis", arch: ["x64"] }],
      artifactName: "${productName}-Setup-${version}.${ext}",
    },
    nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true },
    // Where latest.yml and app-update.yml say the updates are: the public
    // releases for the open-source build, the production build's own address
    // (src/edition.js PRODUCTION_UPDATE_URL), and none while that is empty.
    publish: edition === "production"
      ? (productionUrl ? [{ provider: "generic", url: productionUrl }] : null)
      : [{ provider: "github", owner: "stronghamjji", repo: "PersoDub" }],
    // The dmg again as <name>-mac.dmg, the name with no version in it that a
    // download button links to.
    afterAllArtifactBuild: ({ artifactPaths }) => artifactPaths.filter((p) => p.endsWith("-arm64.dmg")).map((p) => {
      const to = join(dirname(p), `${name}-mac.dmg`);
      copyFileSync(p, to);
      return to;
    }),
  };
}

export default builderConfig(readEdition({ payloadDir: PAYLOAD, env: process.env }));
